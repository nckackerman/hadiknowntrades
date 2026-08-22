# Plan: issue #29 - 1-minute intraday granularity for 1M (day-chunked fetch)

Status: reviewed, corrected, and **re-architected against a moved
`main`** (see addendum below) -- implemented. Originally written against
the repo at commit `b4ddb43` (post-#28/#40 merge); by the time this issue
was implemented, `main` had advanced to include issue #30 (5-minute bars
for 3M), which changed the target architecture this plan needs to land
on top of. The addendum documents both the independent review's
corrections (retention boundary, memory estimate) and the structural
rework needed to fit #30's `GranularityOverride` pattern -- read it
before the numbered sections below, several of which describe a design
(a hard, separately-must-succeed third pipeline path) that was
**superseded**, not just corrected, before landing.

## Addendum: post-review corrections, and a post-#30 re-architecture

### What actually shipped, in one paragraph

By the time this issue was implemented, issue #30 had already merged to
`main` and established a `GranularityOverride`/`mergeDaysByGranularity`
mechanism for exactly this kind of "upgrade one range's days to a finer
bar granularity, best-effort" problem (built for 3M's 5-minute bars, and
its own code comments explicitly anticipated this issue reusing it: "a
future granularity override, e.g. issue #29's 1-minute bars for 1M,
should add a map entry there rather than a parallel branch"). Rather than
implementing this plan's original design (a fourth "hard" pipeline path,
required to succeed or fail the whole run, with its own
`INTRADAY_1M_RANGES` group and a separate `oneMinuteFetchConcurrency`
knob), the actual implementation adds 1M as a new entry in that same
`granularityOverrides` map, exactly as #30's comment invited: best-effort
(a 1-minute fetch failure gracefully degrades 1M back to 60-minute bars,
not a pipeline failure), merged day-by-day via the existing
`mergeDaysByGranularity` (keeps whichever granularity's `endingBalance`
is actually higher for a given date, not "1-minute always wins"), with
no separate concurrency knob (see below for why one turned out to be
unnecessary). This is a better design than this plan's original one, not
just a different one forced by the conflict -- see the specific points
below.

### Corrections and decisions, in the order this plan's own sections raised them

- **Fix (real bug the independent review found, section 1's open
  question)**: this plan's §1 flagged that
  `presetRangeStartDate("1M", asOf)` can land up to 31 calendar days
  back (one day past the retention wall) and that the 1-minute fetch's
  `from` needs clamping, but left the exact safe boundary (`N`) open for
  live verification. **Live-verified (2026-08-21) against the real
  endpoint**: the wall bites at exactly 30 days back -- a request 29
  days back succeeds (391 bars), 30 days back fails with a 422. So
  **N = 29**, not 30 (Yahoo's own error text literally says "the last 30
  days," which reads as "30 is safe" -- it's actually the wall). The
  same live check also confirmed §1's 8-day chunk-cap boundary exactly
  as described: exactly 8 days succeeds, 9 fails with a distinct 422
  ("Only 8 days worth of 1m granularity data are allowed to be fetched
  per request.").
  - **How this was actually implemented differs from §1's own
    recommendation, and is simpler**: §1 proposed a reusable
    `clampToOneMinuteRetention(from, asOf)` helper exported from
    `packages/core`, clamping `presetRangeStartDate("1M", asOf)` up to
    the safe boundary. The shipped code doesn't need that function at
    all: it just requests `daysBeforeUtc(asOf, 29)` directly as the
    1-minute fetch's `from` (mirroring #30's own
    `FIVE_MINUTE_LOOKBACK_DAYS` pattern exactly), never touching
    `presetRangeStartDate("1M", asOf)` for this fetch in the first
    place. The bug §1 flagged is avoided by construction, not by
    clamping a value that was never computed here. This also sidesteps
    §1's implicit assumption that the 1-minute fetch's range should
    track 1M's own window -- it doesn't need to: 1M's window can
    legitimately extend a day or two past the 1-minute fetch's own
    lookback, and the merge/fallback mechanism below (borrowed from
    #30) already handles that gap correctly, the same way it already
    handles 3M's days older than the 5-minute fetch's own lookback.
- **Correction (arithmetic error in this plan's own §2 estimate, found
  by independent review)**: §2's ~618MB memory estimate used "~120-160
  bytes/bar" as its per-bar cost, but that plan's own listed components
  (~24-32 + ~16-24 + ~35-40 bytes) sum to ~75-96 bytes/bar, not
  ~120-160. Corrected estimate: **~350-450MB** of added memory for the
  1-minute fetch specifically, not ~618MB. The qualitative conclusion
  from §2 is unchanged and, per the review, robust to this correction:
  the Lambda's real measured baseline (903MB of 1024MB, pre-#29) leaves
  only ~121MB of headroom, and even the corrected, smaller estimate is
  roughly 3-4x that headroom. The review also flagged a secondary,
  unquantified contributor §2 didn't count: `optimizeIntradayDays`'s own
  per-ticker timestamp-array structures (dense, ~56x denser for
  1-minute vs. 60-minute data) add further memory beyond the raw fetched
  bars. No code change was required to address this by itself, just
  documented (see `packages/core/CLAUDE.md`) as a reason a real measured
  run could come in higher than even the corrected estimate.
- **Decision (user, real-AWS-needs-go-ahead policy applies)**: proceed
  with implementation now, and include a proactive `memorySize` bump
  (1024MB -> 2048MB) in `infra/cdk/lib/hadiknowntrades-stack.ts` as part
  of this issue's code -- **code only, not deployed**. Actual
  deployment/pipeline run stays gated behind the user's explicit
  go-ahead later, exactly like issue #28's still-pending AWS rollout
  (see `infra/CLAUDE.md`'s "Current deployment state" and
  `apps/pipeline/CLAUDE.md`).
- **§2's concurrency recommendation: superseded, not followed.** §2
  recommended a separate `oneMinuteFetchConcurrency` (default 5), lower
  than the shared `fetchConcurrency` (10), reasoning that adding a third
  concurrent full-universe fetch pool would otherwise silently raise
  peak simultaneous connections from 20 to 30. Two things changed this:
  first, #30 already added a third pool (5-minute) reusing the _same_
  `fetchConcurrency`, without a separate knob -- peak simultaneous
  connections were already at 30 before this issue touched anything, so
  the "20 -> 30 as an unexamined side effect" framing no longer applied
  even before considering #29's own fourth pool. Second, and more
  directly: `fetchIntraday1mBars`'s internal chunks are issued
  **sequentially** per ticker, not concurrently, so each worker still
  only ever has 1 request in flight at a time regardless of how many
  chunks that ticker's fetch needs -- concurrency still bounds peak
  simultaneous _tickers_-in-flight exactly the same way it does for
  every other path. The ~4x higher total request volume for this one
  path (from chunking) shows up as a longer wall-clock time for that
  pool to finish, not as a burst-risk increase concurrency tuning would
  address. Net: the shipped code reuses `fetchConcurrency` for the
  1-minute path too, with no separate knob, and documents this reasoning
  explicitly (see `apps/pipeline/CLAUDE.md`'s "1-minute path" section)
  rather than silently dropping §2's concern.
- **§3's structural recommendations (three-path split,
  `INTRADAY_1M_RANGES`, a hard "must succeed or fail the run" fourth
  path, `barIntervalMinutes` on `IntradayResult`) were superseded by
  #30's `GranularityOverride` mechanism, not implemented as written.**
  See "What actually shipped" above for the replacement design. Two
  specific corrections this implies:
  - §3 recommended adding `barIntervalMinutes: number` to
    `IntradayResult` (per-range) and bumping `RESULTS_SCHEMA_VERSION`.
    #30 had already solved the "which granularity produced this data"
    problem differently and _before_ this -- `barIntervalMinutes` lives
    on `IntradayDayResult` (per-day, since a single range's `days` can
    now genuinely mix granularities), stamped by `optimizeIntradayDays`
    itself, added as a purely additive field **without** a
    `RESULTS_SCHEMA_VERSION` bump (#30's own judgment call: additive,
    no current reader depends on it). This issue's 1M override reuses
    that existing per-day field (values `1` or `60`) rather than adding
    a second, range-level field alongside it -- a per-range scalar would
    have been actively wrong once a single range's days can carry mixed
    granularities, which is exactly 1M's normal case now (see below).
    `RESULTS_SCHEMA_VERSION` was **not** bumped for this issue, matching
    #30's own precedent and reasoning.
  - §3's "1M's own presetRangeStartDate can be clamped to cover the
    fetch's needs" framing turned out to have it backwards, in a way
    the post-#30 design surfaces more directly than this plan's original
    framing did: 1M's window is not always fully coverable by any safe
    1-minute request (the window can be up to 31 days, the safe
    lookback is 29) -- there is no clamp that makes the two match
    exactly. The correct fix isn't a tighter clamp, it's accepting the
    gap and letting the merge fall back to 60-minute bars for whichever
    day or two the 1-minute fetch didn't reach -- exactly 3M's own
    pre-existing older-day fallback, reused rather than reinvented.
- **§4's test coverage recommendations were followed in spirit, adapted
  to the shipped architecture**: chunk-boundary/count tests, the
  retention-boundary behavior, and per-chunk-position error propagation
  are all covered in `packages/core/src/yahoo-client.test.ts` largely as
  §4 described. The "three-way pipeline split" tests §4 anticipated
  became, instead, a new "1-minute path (1M, issue #29)" describe block
  in `apps/pipeline/src/pipeline.test.ts` mirroring #30's own "5-minute
  path" tests structurally (mixed-granularity-within-a-range, the
  better-outcome-wins merge, graceful degradation on abort, dataAsOf
  folding, per-ticker skip surfacing) -- a closer, more direct analogy
  to what actually needed testing than the original three-hard-paths
  framing would have produced.
- **§6 open questions**: question 1 (retention/chunk boundaries) and
  question 3 (concurrency default) are resolved above. Question 5
  (whether to add `barIntervalMinutes`) is resolved above (added, but at
  the per-day level #30 already established, not the per-range level
  this plan proposed, and without a schema version bump). Questions 2
  (real per-bar memory), 4 (increased per-ticker failure surface from
  chunking), and 6 (21-days/7-bars-per-day approximation accuracy)
  remain "watch during/after a real run," not resolved further here,
  exactly as this plan originally scoped them.

## 0. Summary of the core risk this issue calls out

Per the issue's own verified research: `interval=1m` is retained for only
the last **30 days** (vs 60m's 730 days) and a single request is capped at
**8 days** of `1m` data. Covering a ~30-day window therefore needs ~4
chunked requests per ticker instead of 1 -- roughly **4x the request
volume for the 1M fetch specifically** (~2,000 requests instead of ~500).
That's a real, quantified request-volume risk. This plan argues the
**memory** risk is actually larger and less obvious: 1-minute bars are not
just "4x more requests," they're **~56x more bars per trading day** than
60-minute bars (390 one-minute bars in a 6.5-hour session vs ~7 hourly
bars), and that ratio -- not the request count -- is what drives Lambda
memory pressure. Section 2 works this through with real numbers.

## 1. Day-chunked `interval=1m` fetching in `packages/core`

**Reuse, not duplicate** -- same principle issue #28 used for 60m.
`fetchChartSeries` (the shared request/retry/error-classification loop in
`packages/core/src/yahoo-client.ts`) already handles everything
interval-agnostic: UA header, timeout, backoff, `BlockedError`/
`TickerNotFoundError`/`UnexpectedResponseError`/`TransientFetchError`
classification, and the malformed-shape guards. None of that needs to
change. What's new is a chunking loop _around_ it.

- **New function, not a generalized `fetchIntradayBars(interval)`
  parameter.** `INTRADAY_INTERVAL = "60m"` is currently hardcoded in
  `yahoo-client.ts` with a comment explicitly anticipating #29/#30 as the
  point where this might become a real parameter. Recommend against that
  now: 60m fetching (`fetchIntradayBars`, used unchanged by 3M/1Y) needs
  no chunking at all, while 1m fetching always does -- folding both into
  one function means every call site carries a conditional chunking path
  that's dead code for the 60m case. A new, separate
  `fetchIntraday1mBars(symbol, from, to, options)` keeps each function's
  logic uniform and matches this codebase's stated preference (see
  issue-28-plan.md) for not pre-generalizing until there's a real second
  caller shape, not just a second interval string. `fetchChartSeries`
  itself needs no changes -- it's called once per chunk, exactly as
  `fetchIntradayBars` calls it once for the whole 60m range today.
- **No new bar type.** `IntradayBar` (`{ date: string; close: number }`)
  is already granularity-agnostic in shape; only its doc comment
  currently says "one 60-minute intraday price bar." Recommend
  generalizing that comment (not the type) to "one intraday price bar of
  some sub-daily granularity" so `fetchIntraday1mBars` can return
  `IntradayBar[]` directly -- no adapter, no second interface to keep in
  sync, same reasoning #28 used to make `IntradayBar` structurally
  identical to `DailyClose`.
- **Chunk boundary math**: split `[from, to]` into consecutive,
  **non-overlapping** windows of at most 8 calendar days each (`ceil(30 /

8. = 4`chunks for a full 30-day request: 8+8+8+6). Two boundary
  details need care, both because`fetchIntradayBars`/`fetchDailyCloses`  already pad`period2` by one day to fully cover the end date's market
   hours:

- **Only the final chunk should get that one-day end-padding.**
  Padding every intermediate chunk's end by a day would make it overlap
  the next chunk's start by up to a day, and Yahoo would return the
  same calendar day's bars twice across the seam -- a real duplicate-bar
  bug if not handled deliberately, not a hypothetical one, given the
  existing padding logic was written for a single whole-range request,
  not a chunked one.
- **Concatenation order**: chunks are already generated in ascending
  date order and Yahoo returns bars within a chunk in ascending
  timestamp order, so simple array concatenation preserves overall
  ordering -- no sort needed. Still worth a defensive dedup-by-`date`
  key when merging (cheap, and cheaply defends against the boundary
  case above ever regressing), even if the boundary math is written to
  make it unnecessary in the common case.
- **Per-ticker fetch composability, no changes needed in
  `apps/pipeline`'s `fetchUniverseHistory`.** `fetchUniverseHistory`
  only ever sees one promise per ticker (resolve = bars, reject = one of
  the four typed errors). Whether that promise resolves after 1 HTTP
  request (60m path) or up to 4 sequential chunk requests (1m path) is
  entirely internal to the fetch function passed in -- `fetchUniverseHistory`
  itself needs zero changes. This is a real, valuable consequence of #28's
  generic-over-`TBar` design, not a coincidence.
- **Chunk-level failure semantics -- recommend keeping "any chunk fails ->
  whole ticker is skipped," matching the existing all-or-nothing per-ticker
  philosophy** (`fetchDailyCloses`/`fetchIntradayBars` are already each a
  single all-or-nothing unit from `fetchUniverseHistory`'s point of view).
  Concretely: if chunk 3 of 4 exhausts its own retries and throws
  `TransientFetchError`, `fetchIntraday1mBars` should let that propagate
  (discarding chunks 1-2's already-fetched bars for that ticker) rather
  than silently returning a partial month. This is the simplest
  correct behavior and requires no new error-aggregation logic, but it
  does mean **each ticker's 1m fetch now has ~4 independent chances to
  fail** where before it had 1 -- if per-request transient failure rate is
  `p`, per-ticker failure probability is now roughly `1-(1-p)^4` instead
  of `p`. This will very likely raise `skippedTickers` counts for the 1M
  range specifically, even with zero real outages. Flagged as an open
  question in section 7 -- not a blocker, but worth watching in live
  verification and explicitly not conflating with a real blocking event
  if the skip count for 1M creeps up.
  - `BlockedError`/`UnexpectedResponseError` on any chunk should still
    propagate immediately (not retried, not chunk-isolated) -- identical
    to today's classification, no new behavior needed here.
- **A concrete, unresolved retention-boundary risk (see section 7 for why
  this isn't fully resolved here):** the 1M preset's own start-date math
  (`presetRangeStartDate("1M", asOf)`, `packages/core/src/preset-ranges.ts`)
  subtracts one _calendar_ month, clamped for day-of-month overflow --
  which is **31 calendar days** back whenever `asOf` falls after a
  31-day-long source month (e.g. `asOf = 2026-08-21` -> `2026-07-21`, 31
  days back). That's one day past the issue's confirmed 30-day `1m`
  retention ceiling, and this isn't a rare edge case -- it happens for a
  large fraction of `asOf` dates, not just a specific calendar corner. The
  client should not pass the 1M preset's own start date to
  `fetchIntraday1mBars` unclamped; it should request `max(1M start date,
asOf - N days)` for some `N` confirmed safely inside the 30-day
  ceiling. What `N` should be (29? 30? does Yahoo's "last 30 days" mean
  30 days back is still valid, or does the ceiling bite there too?) is
  not something this plan can answer from reading code -- it needs the
  same kind of live check the issue's own 8-day/30-day facts came from.

## 2. Concurrency and memory

### Memory: back-of-envelope estimate (the more important risk)

The issue asks whether this needs a real bytes/bar x bars x tickers
estimate before assuming today's 1024MB Lambda `memorySize` has headroom.
It does -- here's that estimate, order-of-magnitude, not a profiled number
(flagged in section 7 as needing real measurement before trusting it
precisely):

- **Trading days**: ~252/year, ~21/month (US market, rough averages).
- **Bars/day**: a 6.5-hour (390-minute) session gives ~7 bars at 60m
  granularity (matches the existing 60m path) vs. **390 bars at 1m
  granularity** -- roughly **56x denser per day**.
- **Existing 60m fetch** (1Y window, already covers 1M/3M/1Y today, `apps/pipeline/src/pipeline.ts`'s `intradayFrom`): `252 days x 7
bars/day x 503 tickers ~= 887,000 bars`.
- **New 1m fetch** (1M window only, ~30 days): `21 days x 390 bars/day x
503 tickers ~= 4,120,000 bars` -- **~4.6x more bars than the entire
  existing 60m fetch**, despite covering a ~12x shorter calendar window,
  because per-day density more than makes up the difference.
- **Per-bar memory**: each bar is `{ date: string (19-char datetime),
close: number }`. Rough V8 object cost: small-object header + 2
  properties (~24-32 bytes) + a boxed/heap number (~16-24 bytes) + a
  19-character Latin1 string with its own header (~35-40 bytes) ~=
  **~120-160 bytes/bar**. Using 150 bytes/bar as a round estimate:
  `4,120,000 bars x 150 bytes ~= ~618 MB` **added on top of** (not
  replacing any of) the existing fetch's memory footprint, since the 1m
  fetch is a wholly new third universe fetch, not a substitute for the
  60m one (3M/1Y still need the full 60m/1Y fetch exactly as today --
  removing 1M from its _output_ doesn't shrink its _input_ range at all).
- **Where this lands**: the pipeline's real, measured baseline is **903MB
  of the current 1024MB allocation** (`apps/pipeline/CLAUDE.md`, from a
  real Lambda invocation), already described in that file's own words as
  "closer to the ceiling than comfortable." Adding a ~618MB estimate on
  top of an already-903MB baseline is not a marginal increase -- it's
  order-of-magnitude larger than the remaining headroom (121MB) by
  itself, before counting: the transient memory of parsing each chunk's
  JSON response body, `Promise.all`-driven concurrent accumulation across
  many tickers, and normal V8 GC/fragmentation slack.

**Recommendation: increase the Lambda's `memorySize` (in
`infra/cdk/lib/hadiknowntrades-stack.ts`) as part of this issue's rollout,
proactively, not reactively after an observed OOM.** A rough estimate
like this shouldn't be trusted to the nearest 10%, but the gap between
"~618MB more, needed on top of an already-903MB/1024MB baseline" and "has
headroom" is large enough that no plausible correction to the per-bar
estimate closes it. This is a real-AWS/infra change and needs the user's
explicit go-ahead per this repo's working agreement, regardless of how
low-risk the CDK diff itself looks -- flagged here, not decided here. A
concrete starting point to propose: 2048MB (2x current), then confirm
against a real measured run rather than picking a number and trusting it
blind, matching how 903MB was itself established by a real invocation, not
an estimate.

**A structural alternative this plan does not recommend attempting within
#29's scope, but flags for awareness**: the memory cost above exists
because `buildIntradayResults` holds the _entire_ universe's raw bar
history in memory (`Map<string, IntradayBar[]>`) before running
`optimizeIntradayDays` once over all of it (a deliberate, previously
reviewed design choice from #28 -- see `apps/pipeline/CLAUDE.md`, "run
once, slice per range"). A per-ticker-streaming redesign (fetch one
ticker's bars, immediately fold into day-buckets, discard the raw array,
move to the next ticker) would meaningfully cut peak memory, but is a
real architectural change to a piece of code #28's review already settled
on, well beyond "add 1m fetching" -- not proposed as part of this issue.
If the memory estimate above turns out to be right and a `memorySize`
bump alone isn't enough (or gets expensive), this is the next lever,
called out here so it doesn't need to be rediscovered from scratch.

### Concurrency

Two somewhat separate questions:

1. **Should each ticker's ~4 chunk requests run sequentially or
   concurrently?** Recommend **sequentially** (chained awaits inside
   `fetchIntraday1mBars`, not `Promise.all`'d). Sequential chunking keeps
   the _peak number of simultaneous in-flight HTTP requests_ bounded by
   whatever the worker pool's `concurrency` is, exactly as today --
   firing all 4 chunks per ticker concurrently would let one worker slot
   spike to 4 simultaneous requests, multiplying peak connection burst by
   4x for no benefit (this fetch isn't latency-sensitive; it's a nightly
   batch job). The cost is that each 1m worker slot now takes ~4x longer
   per ticker than a 60m slot did -- a wall-clock cost, not a burst-risk
   one.
2. **Should the 1m path share the existing `fetchConcurrency` (default
   10), or get its own, separately-tunable value?** After #29, three
   independent universe fetches run concurrently under `Promise.all` in
   `runPipeline` (window/daily-close, 60m-intraday, and the new
   1m-intraday), each with its own worker pool. If the 1m path reuses the
   same default 10, peak simultaneous outbound connections from one
   Lambda invocation rises from today's 20 (10+10) to 30 (10+10+10) purely
   as a side effect of adding a third path, without anyone deciding that
   was the right number. **Recommend giving the 1m path its own
   concurrency knob** (e.g. `oneMinuteFetchConcurrency` on
   `RunPipelineOptions`, its own `DEFAULT_ONE_MINUTE_FETCH_CONCURRENCY`
   constant in `pipeline.ts`, matching the existing
   `DEFAULT_FETCH_CONCURRENCY` pattern), defaulting to something more
   conservative than 10 -- 5 is a reasonable starting point -- so total
   peak simultaneous connections stays closer to today's level rather
   than growing 50% as an unexamined side effect. This is a starting
   guess, explicitly meant to be revised based on the live-verification
   run the issue's own acceptance criteria requires (watching specifically
   for `BlockedError`/rate-limiting, not just "it worked once").

Total **request count** (not concurrency) for the 1m path is still ~4x
what it would be unchunked (~2,000 vs ~500) regardless of the concurrency
setting -- that's a function of the 8-day chunk cap, not something
concurrency tuning changes. The two are genuinely separate levers: lower
concurrency reduces burst risk and peak simultaneous connections, not
total request volume, and (worth stating plainly, since the issue phrases
these together) **concurrency does not reduce peak memory either** --
`fetchUniverseHistory`'s `history` map accumulates every ticker's fetched
bars regardless of how many fetches ran at once; concurrency only affects
wall-clock time and instantaneous connection count, not the eventual
total held in memory once the fetch completes.

**Should 1M be throttled differently than 3M/1Y's 60m path?** Yes, per
the above -- not because 1M is inherently riskier per request, but because
adding it as a _third_ concurrent path changes the aggregate load profile
of the whole run in a way that's worth deliberately re-tuning rather than
leaving on autopilot.

## 3. `apps/pipeline` wiring

The existing two-path structure in `pipeline.ts` (`WINDOW_RANGES` /
`INTRADAY_RANGES`, each range group getting its own `fetchPathHistory`
call, merged at the end via a `resultByRange` map keyed by `PresetRange`)
is already written generically enough to extend to a third path without
restructuring it -- this is the cleanest way to land #29's change.

- **Split `INTRADAY_RANGES` into two groups**: `INTRADAY_60M_RANGES =
["3M", "1Y"]` (1M removed) and `INTRADAY_1M_RANGES = ["1M"]`. Update
  the existing `pipeline.test.ts` test that checks "every `PresetRange`
  is covered by exactly one group" (mentioned in the module header
  comment) to check across all three groups instead of two.
- **`fetchPathHistory` needs no changes** -- it's already generic over
  `TBar`/`fetchFn`/`dateOf`, and the 1m path's bars are the same
  `IntradayBar` shape with the same "extract the calendar-date part"
  `dateOf` the 60m path already uses (`localDatePart`).
- **`runPipeline`'s `Promise.all` grows a third entry**: a
  `fetchPathHistory("one-minute", options.tickers, oneMinuteFrom, asOf,
options.fetchIntraday1mBars, oneMinuteFetchConcurrency, endDateString,
...)` call alongside the existing two, where `oneMinuteFrom` is the
  clamped-to-retention start date discussed in section 1 (not simply
  `presetRangeStartDate("1M", asOf)` unclamped).
- **`buildIntradayResults` needs to become two functions (or one
  parameterized by which range group + which history map + which
  concurrency-adjacent constants it's building for)**: today it takes one
  `history: Map<string, IntradayBar[]>` and produces results for all of
  `INTRADAY_RANGES` from one `optimizeIntradayDays` call. After #29,
  there are two independent `optimizeIntradayDays` calls -- one over the
  60m history for `INTRADAY_60M_RANGES`, one over the 1m history for
  `INTRADAY_1M_RANGES` -- each producing its own slice of
  `IntradayResult[]`, merged into `resultByRange` alongside
  `windowResults` exactly as `intradayResults` is today (that merge loop
  is already written generically -- `for (const result of xResults)
resultByRange.set(result.range, result)` -- and trivially extends to a
  third loop).
- **`RunPipelineOptions` gains a required `fetchIntraday1mBars` field**
  (mirroring `fetchDailyCloses`/`fetchIntradayBars`), threaded from
  `apps/pipeline/src/run.ts` (imports `fetchIntraday1mBars` from
  `@hadiknowntrades/core` alongside the existing two fetch functions) --
  no other change needed in `run.ts`, `index.ts`, or `lambda-handler.ts`.
- **Every existing `runPipeline(...)` call in `pipeline.test.ts` needs a
  `fetchIntraday1mBars` mock added** -- this is a mechanical but
  wide-reaching change (the file is 583 lines with many call sites per
  the earlier read of it), worth budgeting real time for, not a
  one-line addition.
- **Schema consideration, not strictly required by the acceptance
  criteria but recommended**: `IntradayResult` (`results-schema.ts`)
  currently has no field distinguishing which bar granularity produced a
  given range's result -- fine while every intraday range used 60m
  uniformly, but after #29, `model: "intraday-daily"` covers both a
  60m-based 3M/1Y result and a 1m-based 1M result with no on-disk way to
  tell them apart. Recommend adding an explicit field (e.g.
  `barIntervalMinutes: number`) to `IntradayResult`, matching the
  existing philosophy of not leaving a run parameter implicit
  (`maxTrades`/`maxTradesPerDay` were both made explicit in #28's schema
  for the same reason). This bumps `RESULTS_SCHEMA_VERSION` again and
  re-triggers the same "pipeline must write all 5 keys before/atomically
  with the next `apps/web` deploy" rollout hazard #28 already documented
  and handled once -- same playbook applies, not new complexity, just
  needs to be repeated deliberately.

## 4. Test coverage

- **`packages/core`**: new `fetchIntraday1mBars` tests in
  `yahoo-client.test.ts` (or a new `yahoo-client-1m.test.ts` if the
  existing file's 445 lines are getting unwieldy -- judgment call at
  implementation time), same mocked-`fetchImpl` style as the existing
  `fetchIntradayBars`/`fetchDailyCloses` tests:
  - Correct number of chunk requests issued for a full ~30-day range
    (expect 4 calls, not 1).
  - Each chunk request's `period1`/`period2` query params land on the
    right 8-day boundaries, with only the final chunk getting the
    existing one-day end-padding.
  - Chunks concatenate into correctly-ordered, non-duplicated output
    (a synthetic fixture with distinguishable timestamps per chunk is
    enough -- no need for real data here).
  - A `TickerNotFoundError`/`BlockedError`/`UnexpectedResponseError`
    thrown on any one chunk (test each position: first, middle, last)
    propagates immediately and stops further chunk requests for that
    ticker.
  - A `TransientFetchError` on one chunk (after that chunk's own
    `MAX_RETRIES` retries are exhausted) discards the ticker entirely --
    verifies the "no partial-month results" behavior decided in section 1.
  - The retention-clamping logic from section 1 (once its exact boundary
    is resolved -- see section 7) has its own explicit test rather than
    only being exercised incidentally through the chunk-boundary tests.
- **`apps/pipeline`**: extend `pipeline.test.ts`'s existing split-path
  tests (5Y/MAX vs. 1M/3M/1Y independent-failure tests, per #28) to a
  three-way version: each of the three paths (window, 60m-intraday,
  1m-intraday) failing independently should still let the other two
  write normally; only "all three empty" should refuse to write
  anything. Also: the "every `PresetRange` covered exactly once" test
  mentioned in section 3, updated for three groups.
- **Not attempted in unit tests (needs live verification instead, see
  below)**: real Yahoo retention/chunk-boundary edge behavior, real
  per-bar memory usage, real end-to-end run timing.

## 5. Live verification plan (not performed in this planning phase)

Per this issue's explicit acceptance criteria ("live-verified against a
real pipeline run... specifically watch for `BlockedError`/rate-limiting
at the higher request volume, not just that it works once") and this
repo's standing working agreement (verify live at least once per
feature):

- A real `fetchIntraday1mBars` call against Yahoo for a real symbol,
  confirming: the exact 8-day chunk cap's boundary behavior (does a
  request for exactly 8 days succeed? what does 9 days back return --
  truncated data, or the same misleading-as-`TickerNotFoundError`
  `chart.error` shape documented for the 730-day 60m boundary?), and the
  exact 30-day retention boundary (does 29 days back succeed, 30, 31? --
  resolves the open clamping question in section 1).
- A real, full pipeline run (the same `aws lambda invoke
--invocation-type Event` style already used for the #28/#40 real-run
  verification, per `apps/pipeline/CLAUDE.md`) specifically watching:
  CloudWatch-reported memory usage against whatever `memorySize` is set
  to at that point (confirms or corrects section 2's estimate), total
  run duration against the 15-minute timeout, and the `skippedTickers`
  count/contents for signs of either real blocking or the "one bad chunk
  skips a whole ticker" effect flagged in section 1 becoming a real,
  nontrivial skip rate rather than a theoretical one.
- This is a real-AWS action (invoking the deployed Lambda) and needs the
  user's explicit go-ahead per this repo's working agreement, same as the
  `memorySize` change in section 2 -- not performed as part of this plan.

## 6. Open questions (flagged, not guessed past)

1. **Exact 30-day retention boundary and 8-day chunk-cap boundary.** The
   issue's research confirms "30 days" and "8 days" as the retention/chunk
   ceilings, but not the precise fencepost behavior at those edges (is day
   30 back still valid, or does the wall start at day 30? is a request
   spanning exactly 8 days valid, or does it need to be 7 days plus
   padding?). Section 1's clamping logic and section 4's boundary tests
   both depend on this being resolved by a real request against the live
   endpoint, not inferred from the 60m/730-day case (which was itself
   confirmed empirically, not assumed to generalize).
2. **Real per-bar memory cost.** Section 2's ~150 bytes/bar and resulting
   ~618MB estimate is a V8-object-cost back-of-envelope calculation, not a
   profiled number -- explicitly flagged there as needing a real measured
   run (CloudWatch memory metrics on an actual invocation) before trusting
   it to more than order-of-magnitude precision. The _conclusion_
   (headroom is very likely insufficient without a `memorySize` increase)
   is probably robust to a fair amount of estimate error given how large
   the gap is, but the specific number to bump `memorySize` to should be
   confirmed against a real run, not locked in from this estimate alone.
3. **`oneMinuteFetchConcurrency` default (proposed: 5).** This is a
   starting guess based on keeping total peak simultaneous connections
   close to today's level, not a value derived from any documented Yahoo
   rate limit (none is documented -- this endpoint is unofficial, per
   `packages/core/CLAUDE.md`). Needs revision based on what the live
   verification run in section 5 actually observes.
4. **Whether the increased per-ticker failure surface from chunking
   (section 1's "~4 independent chances to fail per ticker") will produce
   a `skippedTickers` count for 1M that's noticeably higher than 3M/1Y's,
   even with zero real Yahoo-side problems.** If live verification shows
   this is a real, nontrivial effect (not just a theoretical one), it may
   be worth a follow-up issue considering partial-month tolerance (e.g.
   keep a ticker's successfully-fetched chunks even if one chunk
   ultimately fails) -- explicitly out of scope for this plan's
   recommended default behavior (section 1), which keeps the simpler
   all-or-nothing semantics, but noted here so the tradeoff isn't
   silently re-discovered later.
5. **Whether `IntradayResult` should gain a `barIntervalMinutes` (or
   similar) field (section 3).** Not required by the issue's acceptance
   criteria, but recommended for the same "don't leave a real run
   parameter implicit" reasoning #28 already applied to
   `maxTrades`/`maxTradesPerDay`. Flagged as a design call worth explicit
   confirmation before implementation, since it's an easy, low-risk
   addition now but a schema-version-bump-and-rollout-hazard exercise (per
   #28's precedent) to add later if skipped now.
6. **Whether 21 trading days/month and 7 bars/day (60m) are accurate
   enough approximations.** Both are round-number estimates for section
   2's math, not pulled from real S&P 500 trading-calendar data or a real
   observed 60m bar count per day. The conclusion (1m fetch is
   dramatically more bars than the existing 60m fetch) is not sensitive to
   modest error in either number, but neither has been checked against
   real data the way this codebase's other empirical claims have been.
