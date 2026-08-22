# packages/core — working notes

Shared domain logic: ticker universe, Yahoo client, optimizer, preset-range
math, date utils. Read this before re-investigating something below — if a
fact here turns out to be stale, fix the fact here too, not just the code.

## Data source: Yahoo Finance, not Stooq — don't reintroduce Stooq

The original plan (see issue #3) was Stooq. **Stooq now actively blocks
programmatic access**: `robots.txt` disallows all bots except
Google/Bing, plus a site-wide JS proof-of-work anti-bot challenge on
every page, verified live. Don't build a client that solves that
challenge — that's circumventing an explicit anti-bot protection, not
just an inconvenience.

Using **Yahoo Finance's unofficial chart endpoint** instead
(`src/yahoo-client.ts`). Facts verified empirically, not from docs
(Yahoo has none):

- Requires a browser-like `User-Agent` header. Without one, requests get
  a misleading "Too Many Requests" response regardless of actual volume
  — it's UA-fingerprint filtering, not real rate limiting.
- Dot-class share symbols use a hyphen on Yahoo, not a dot: `BRK.B` ->
  `BRK-B`, `BF.B` -> `BF-B`. Handled by `toYahooSymbol()`.
- An invalid/delisted symbol returns HTTP 200 with
  `{ chart: { result: null, error: {...} } }`, not an HTTP error status.
  A genuinely nonexistent symbol returns HTTP 404.
- **A legitimately empty date range (e.g. a weekend-only window) omits
  `timestamp` entirely and returns `quote: [{}]` / `adjclose: [{}]`** —
  no `close`/`adjclose` key at all, not even an empty array. This shape
  is easy to get wrong by guessing instead of checking live (it crashed
  the client once during development — see git history on
  `yahoo-client.ts` if the exact shape ever needs re-verifying).
- Daily bars are timestamped near market open (mid-morning local time),
  not midnight, so a naive inclusive-end-date range needs the internal
  day-padding on `period2` that's already in the client — don't remove it.
- No official ToS backs this endpoint (it's what `yfinance` and most
  OSS finance tooling has quietly relied on for years) — it could change
  or start blocking without notice. If it ever does, re-run the same
  empirical research process from issue #3 rather than assuming Stooq
  is fine again.

## Internal imports: no `.js` extension on relative specifiers

`src/*.ts` files import each other with plain extensionless relative
specifiers (`from "./date-utils"`, not `from "./date-utils.js"`) -
consistent with `tsconfig.base.json`'s `moduleResolution: "Bundler"`,
which doesn't need or want the NodeNext-style `.js`-pointing-at-`.ts`
convention. Don't add `.js` back onto these: `apps/web` (issue #7)
imports this package directly by its `@hadiknowntrades/core` package
specifier (a pnpm workspace symlink into `src`, not a compiled `dist`),
and empirically, Turbopack's `next build` fails to resolve a `.js`
specifier against a sibling `.ts` file once resolution crosses into a
package reached through `node_modules` (even a workspace symlink) -
`Module not found: Can't resolve './date-utils.js'`, even though tsc and
vitest both resolve it fine. Not documented anywhere in Next.js's own
docs; found by bisecting a real `next build` failure. Reintroducing `.js`
here will silently break `apps/web`'s build the same way.

## Optimizer algorithm

`src/optimizer.ts` — a backward DP generalizing "best time to buy/sell
stock IV" across many tickers instead of one. Full derivation is in the
file's own header comment; don't re-derive it, read that first.

- O(days × tickers × maxTrades). Benchmarked (not estimated): ~330ms for
  the full S&P 500 over a 21-year ("Max") window on realistic synthetic
  data. Real S&P 500 data will vary but this isn't a performance risk at
  the target scale.
- Deterministic tie-break when two tickers achieve an identical best
  ratio: alphabetically-first ticker symbol wins (plain `<`/`>`
  comparison, not `localeCompare` — locale-dependent sorting isn't
  simple ASCII order and was a real bug once).
- Known, accepted limitation: `unixToLocalDateString`'s date derivation
  uses the exchange's _current_ UTC offset for every timestamp in a
  range, not the historically-correct per-date offset, so a range
  spanning a DST transition is technically imprecise. Inert in practice
  for daily bars (market-open timestamps never sit near a day boundary,
  so this never flips a calendar date) — documented in the code. See
  "60-minute intraday bars" below for what this same limitation actually
  does once intraday data is involved (verified live, issue #28) -- it's
  no longer purely theoretical, though the specific failure mode it
  causes there still doesn't break day-bucketing.
- The optimizer has its own input validation (`OptimizerInputError`) and
  is defensive against malformed caller input (non-finite prices,
  invalid `maxTrades`/`startingCapital`) — it does not trust this
  package's own Yahoo client to have already sanitized everything, by
  design (defense in depth, see `is-valid-price.ts`).
- **Worst-case search (`optimizeWorstTrades`, issue #31)**: the same DP
  in the min direction, sharing 100% of `optimizeTrades`'s validation/
  calendar/reconstruction logic via a private `runOptimizer(...,
direction)` -- only `computeLevel`'s four comparison sites/sentinels are
  parameterized by `direction: "max" | "min"` (see that function's own
  doc comment for exactly which four, and why the "no price here"
  sentinel must flip to `+Infinity`, not stay `-Infinity`, for a min
  search). None of the three deterministic tie-break rules (cross-ticker
  alphabetical, cross-day earliest-wins, trade-vs-carry-forward strict
  inequality) needed inverting for "min" -- they're all about determinism
  given an otherwise-tied objective, not about maximizing, so the same
  rule falls out unchanged under inversion. Live-verified (real Yahoo
  data, full 503-ticker S&P 500 universe, all 5 ranges, no S3 write): 0
  invariant violations (`worst <= optimal` held everywhere), 0 non-finite
  results, and the "worst case still nets a gain" edge case (see that
  function's own doc comment) never triggered on real data -- 5Y's worst
  case came back $0.81 from $20, MAX's $0.02, both genuine losses. Full
  pipeline run (both directions, both paths, all 5 ranges, real network
  I/O) took ~34s for the full universe -- cheap either way, but see the
  next bullet for why "roughly doubles" was later tightened to "roughly
  1.6-1.7x" once the redundant per-direction calendar build below was
  fixed; confirms the intraday path's ~250-per-range separate
  `optimizeTrades` calls (now doubled to include `optimizeWorstTrades`)
  stay cheap too, not just the window path's single whole-window call.
- **Calendar/ticker-sort now shared across both directions, not rebuilt
  per call (code-review follow-up to issue #31, not part of its original
  scope)**: `buildCalendar` and the alphabetical ticker sort are a pure
  function of the input price data alone -- independent of `direction` --
  but every call site (`apps/pipeline`'s `buildWindowResults`,
  `optimizeIntradayDays`'s per-day loop) calls `optimizeTrades` then
  `optimizeWorstTrades` back-to-back on the _identical_ input, so the
  original `runOptimizer(..., direction)` design silently redid that work
  twice per range (and, for the intraday path, twice per _day_ -- up to
  ~252 extra redundant calendar builds for 1Y alone). Fixed by splitting
  `runOptimizer` into `buildOptimizerState` (builds the calendar + sorted
  ticker list once) and `runOptimizerForDirection` (runs the level-
  building loop/reconstruction for one direction off an already-built
  `OptimizerState`), plus a new exported `optimizeBothDirections` that
  calls the former once and the latter twice -- both call sites above now
  call `optimizeBothDirections` instead of the two separate functions.
  `optimizeTrades`/`optimizeWorstTrades` themselves are unchanged as a
  public API (still call `buildOptimizerState` + a single
  `runOptimizerForDirection`, for any caller that only wants one
  direction). Benchmarked (not estimated), same 503-ticker/21-year
  synthetic-data shape as the ~330ms figure above, maxTrades=3, averaged
  over 15 runs: the old "optimizeTrades then optimizeWorstTrades"
  back-to-back pattern took ~745ms total; `optimizeBothDirections` over
  the same input takes ~575ms -- about a 23% cut, consistent with
  eliminating one of the two calendar builds/ticker sorts (each direction
  alone still costs about the same ~330-370ms it always did; only the
  _second_ call's redundant setup work goes away). The doubled-cost
  intraday case (up to ~252 days x 2 for 1Y) benefits from this
  proportionally more, since its per-day calendars are far smaller and
  the fixed calendar-build/sort overhead was a proportionally larger
  slice of each call.
- **Fun/expected product quirk, not a bug**: the "Max" range genuinely
  produces astronomically large numbers (a 5-ticker demo run hit ~$716M
  from $20). That's real perfect-hindsight compounding over decades, not
  a calculation error — worth remembering when designing display/number
  formatting in `apps/web` (issue #8), since a naive `$` format will
  look absurd or broken to a first-time viewer without some framing.

## 60-minute intraday bars (issue #28)

`fetchIntradayBars` in `src/yahoo-client.ts` fetches `interval=60m` bars
from the same chart endpoint `fetchDailyCloses` uses, sharing its
retry/error-classification machinery via an extracted `fetchChartSeries`
helper. Facts below verified empirically against the real endpoint
during issue #28's implementation, not assumed from the daily-close
behavior:

- **730-day retention confirmed exactly as the issue's own research
  said**: a request 729 days back succeeds (thousands of bars returned);
  a request further back than 730 days gets a `422 Unprocessable Entity`
  with `chart.error.description` reading `"1h data not available for
startTime=... The requested range must be within the last 730 days."`
  -- a hard wall, not a soft limit.
- **`adjclose` is absent from real intraday responses** (`indicators`
  has no `adjclose` key at all for `interval=60m`, unlike daily) -- every
  intraday bar falls through `extractCloses`'s `?? quote?.close`
  fallback to the raw close. This is fine for this feature's purposes:
  split/dividend adjustment only matters across a holding period long
  enough for a corporate action to occur, and every intraday trade opens
  and closes within one day.
- **The DST-offset limitation on `unixToLocalDateString` (see above) is
  real and observable for intraday, not just theoretical**: verified by
  fetching a week straddling a real US DST "fall back" transition
  (2025-11-02). `meta.gmtoffset` is fixed at whatever the exchange's
  offset was _at request time_, applied uniformly to the whole requested
  range -- so bars on the far side of a DST transition from "now" get
  mapped to a _displayed_ local time-of-day that's off by up to 1 hour
  (observed concretely: the first bar of the trading day after the
  transition showed as `10:30:00` local instead of the real `09:30:00`
  market open). **This never crossed a calendar-date boundary in the
  verification run** (0 bars landed within 4 hours of local midnight,
  out of 50 checked spanning the transition) -- US market hours (9:30
  AM-4:00 PM local) sit with several hours of margin on both sides of
  midnight, so a 1-hour offset error is never enough to push a bar into
  the wrong trading day. Net effect: `optimizeIntradayDays`' day-grouping
  (which only depends on the calendar-date part) stays correct across a
  DST transition; the buy/sell _time-of-day_ shown to a user for a trade
  on the far side of a DST boundary from the pipeline's most recent run
  can be off by up to 1 hour. Accepted as-is (same reasoning as the
  daily-bar case: a real per-timestamp historical-offset table is more
  complexity than this is worth) -- but unlike the daily case, this one
  is a real, verified, user-visible (if minor) inaccuracy, not purely
  inert. Re-verify if this ever needs tightening.
- `IntradayBar`'s `date` field intentionally holds a full local datetime
  string (`unixToLocalDateTimeString`, "YYYY-MM-DDTHH:MM:SS"), not a
  plain calendar date -- same field name as `DailyClose.date` on purpose,
  so `IntradayBar[]` flows through `optimizeTrades`/`buildCalendar`
  unmodified (see "Per-day intraday optimizer" below). Don't rename this
  field to `datetime` or similar -- that was a real bug caught in this
  issue's Phase-1 plan review before any code was written (it would have
  broken the "no adapter shim needed" reuse the whole design depends on).

## 5-minute intraday bars (issue #30)

`fetchFiveMinuteBars` in `src/yahoo-client.ts` fetches `interval=5m` bars
from the same chart endpoint, upgrading the 3M range's most recent days
to finer granularity (see "Mixed-granularity 1M/3M assembly" below).
Shares `fetchChartSeries`/`parseIntradayChartResult` with
`fetchIntradayBars` -- same envelope, same single-request-no-chunking
shape, only the interval string differs. Facts below verified
empirically against the real endpoint, not assumed from the 60-minute
case:

- **Retention is a hard 60-day wall**, the same "N-1 succeeds, N fails"
  pattern as 60m's 730-day limit: a request 59 days back succeeds
  (thousands of bars), 60 days back gets `422 Unprocessable Entity`
  with `chart.error.description` reading `"5m data not available for
startTime=... The requested range must be within the last 60 days."`
- **The out-of-retention case never reaches the `chart.error` branch at
  all** -- verified live, and this is a real, previously-undocumented
  gap in `fetchChartSeries`'s own comment (which suggests `chart.error`
  is how an out-of-range request surfaces): the response's HTTP status
  is 422, which is `!response.ok` and not in `isRetryableStatus`, so
  `fetchChartSeries` throws `UnexpectedResponseError` from the
  status-code branch _before_ ever calling `response.json()` far enough
  to inspect `chart.error`. Concretely: an out-of-retention 5m request
  throws `UnexpectedResponseError`, not `TickerNotFoundError`. This
  matters operationally, not just academically -- `UnexpectedResponseError`
  is a systemic-abort signal to `apps/pipeline`'s `fetchUniverseHistory`
  (stops the whole fetch path, not just that one ticker), so a
  miscalculated `from` date that puts every ticker's request past the
  60-day wall would abort the entire 5-minute fetch, not just skip a
  few tickers. `apps/pipeline` avoids ever hitting this in practice by
  requesting a conservative 59-day-back window (one full day inside the
  verified boundary) -- see `apps/pipeline/CLAUDE.md`'s "Granularity
  overrides" section for why that's fine either way (the whole path
  degrades gracefully regardless of which error class trips it).
- `adjclose` is absent from real 5-minute responses too, same as 60m --
  not re-verified bar-by-bar here since the parsing path
  (`parseIntradayChartResult`/`extractCloses`) is shared code already
  covered by the 60m verification above.

## 1-minute intraday bars (issue #29)

`fetchIntraday1mBars` in `src/yahoo-client.ts` fetches `interval=1m`
bars, upgrading the 1M range's days to finer granularity -- same
`GranularityOverride`/best-effort pattern issue #30 established for 3M
(see "Mixed-granularity 1M/3M assembly" below), landed just after #30 in
this codebase's history. Shares `fetchChartSeries`/
`parseIntradayChartResult` with every other intraday fetch function, but
**unlike 60m/5m, needs internal chunking** -- `interval=1m` has two
independent limits, both verified live against the real endpoint
(2026-08-21), neither assumed from the 60m/5m cases:

- **Retention is a hard 30-day wall**, the same "N-1 succeeds, N fails"
  pattern as 5m's 60-day / 60m's 730-day limits: a request with
  `period1` 29 days back from the real request time succeeds (391 bars,
  a full trading day); one 30 days back fails with a 422
  (`chart.error.description`: `"1m data not available for startTime=...
The requested range must be within the last 30 days."`). Yahoo's own
  error text says "30 days" -- don't read that as "30 is safe"; the wall
  is _at_ 30, so 29 is the largest genuinely safe value.
  `apps/pipeline`'s `ONE_MINUTE_LOOKBACK_DAYS = 29` encodes this (one
  full day inside the verified boundary, same "N-1" convention as
  `FIVE_MINUTE_LOOKBACK_DAYS`). Same operational gotcha as 5m: this 422
  is `!response.ok`, so `fetchChartSeries` throws
  `UnexpectedResponseError` from the status-code branch, not
  `TickerNotFoundError` from `chart.error` -- see 5m's own bullet above
  for why that distinction matters and how the pipeline avoids ever
  depending on which one fires (the whole path degrades gracefully
  regardless).
- **A single request may span at most 8 calendar days**
  (`ONE_MINUTE_CHUNK_DAYS`, module-private -- unlike the retention
  window, chunking is an implementation detail no caller needs to know
  about), a _separate_ limit from retention: a request spanning exactly
  8 days succeeds (2,341 bars), one spanning 9 days fails with a
  _different_ 422 (`chart.error.description`: `"Only 8 days worth of 1m
granularity data are allowed to be fetched per request."`). Because of
  this, `fetchIntraday1mBars` is the only fetch function in this file
  that can issue **multiple HTTP requests for one logical call**: it
  splits the (already end-padded) total range into consecutive,
  non-overlapping <=8-day chunks and awaits them **sequentially**, not
  concurrently -- see `apps/pipeline/CLAUDE.md`'s "Granularity overrides"
  section (the "Per-override specifics" part) for why sequential
  chunking means this override doesn't need its own lower concurrency
  knob the way an earlier draft of this plan assumed it would. Only the
  conceptual _last_ chunk carries the padded
  end (the total range is padded once, then chunked, rather than padding
  every chunk independently, which would let chunk seams overlap and
  double-count a bar) -- a defensive dedup-by-`date` pass still runs
  when concatenating chunks regardless. A chunk that ultimately fails
  (after its own retries, or immediately for `BlockedError`/
  `TickerNotFoundError`/`UnexpectedResponseError`) discards that
  ticker's earlier chunks rather than returning a partial month --
  matches every other fetch function's all-or-nothing per-ticker
  contract, at the cost of each ticker's 1m fetch having ~4 independent
  chances to fail where 60m/5m have 1. Not yet observed to meaningfully
  raise 1M's `skippedTickers` in practice as of this issue's
  implementation -- worth watching after a real pipeline run.
- **Memory (corrected during this issue's plan review)**: the original
  draft plan's back-of-envelope estimate had an arithmetic error in its
  own component figures (its "~120-160 bytes/bar" assumption didn't
  match the ~24-32 + ~16-24 + ~35-40 byte components it listed, which
  sum to ~75-96 bytes/bar) -- corrected to **~350-450MB** of added
  memory for the 1-minute fetch specifically (not the draft's original
  ~618MB estimate). The qualitative conclusion held regardless: a real
  measured baseline of 903MB/1024MB (pre-#29, see
  `apps/pipeline/CLAUDE.md`) leaves only ~121MB of headroom, and even
  the corrected, smaller estimate is roughly 3-4x that headroom --
  hence the proactive `memorySize` bump to 2048MB in
  `infra/cdk/lib/hadiknowntrades-stack.ts` alongside this issue's code
  (not yet deployed -- see `infra/CLAUDE.md`). `optimizeIntradayDays`'s
  own per-ticker timestamp-array structures add further, unquantified
  memory beyond the raw fetched bars (~56x denser for 1-minute vs.
  60-minute data) -- flagged by the review as a real secondary
  contributor, not addressed by a code change here.

## Mixed-granularity 1M/3M assembly (issues #30, #29)

3M's and 1M's per-day results (`IntradayResult.days`) are each assembled
from **two separate `optimizeIntradayDays` calls, merged**, not from a
single mixed-granularity fetch or DP: one over the existing 60-minute-bar
history (shared across 1M/3M/1Y), one over a second, finer-granularity
fetch scoped to a shorter lookback (5-minute for 3M, last 59 days;
1-minute for 1M, last ~29 days -- see the "5-minute"/"1-minute intraday
bars" sections above for the exact retention walls behind each number).
`apps/pipeline`'s `buildIntradayResults` merges each range's two
day-result arrays keyed by date via the same, granularity-agnostic
`mergeDaysByGranularity`: for a date only one array covers, that one
wins by default; for a date **both** cover, it's NOT an unconditional
"finer granularity wins" -- it keeps whichever day's `endingBalance` is
actually higher (both solved with the same `startingCapital`, so
directly comparable). This matters because the two granularities'
fetches can see different ticker universes for the same day (a ticker's
finer-granularity fetch can fail for a day its 60-minute fetch succeeded
on), so the finer day can legitimately be the _worse_ one -- a real
correctness bug caught in #30's code review before this comparison
existed: unconditionally preferring the finer granularity regardless of
outcome could make a range's result strictly worse than what
60-minute-only data would have shown, which cuts against this app's
whole "best possible outcome" premise. 1Y is untouched by both issues --
it only ever reads the 60-minute day-result array.

- **1M's own window can genuinely outreach its finer-granularity
  fetch's lookback, unlike 3M's** -- a real, non-hypothetical
  consequence of the numbers involved, not just a theoretical edge case:
  1M's own start date (`presetRangeStartDate("1M", asOf)`) can land up
  to 31 calendar days back (a 31-day source month), one day past the
  1-minute fetch's ~29-day retention wall -- so it's normal, not a bug,
  for 1M's oldest day or two to have no 1-minute data at all and fall
  back to 60-minute via the same merge mechanism 3M's older (>59-day)
  days already use. 3M's own window (up to ~92 days) so comfortably
  exceeds its 5-minute fetch's 59-day lookback that this "does the
  override's own window fully cover the range's window" question never
  came up as sharply during #30 -- #29's plan review is what surfaced it
  explicitly, and the fix is: don't try to make the fetch's lookback
  match the range's window exactly, just clamp to the fetch's own safe
  retention limit and let the existing merge/fallback machinery handle
  the gap, exactly as it already does for 3M's older days.
- `IntradayDayResult.barIntervalMinutes` (stamped by
  `optimizeIntradayDays` from `OptimizeIntradayOptions.barIntervalMinutes`,
  required, not inferred) makes this visible **in the output itself**,
  per-day -- deliberately not left as something a reader has to infer
  from a day's date relative to "now," since issue #30's own text called
  that out explicitly as non-obvious. 1Y days always carry `60`; 3M's
  recent ~59 days carry `5` (older days carry `60`); 1M's days carry `1`
  wherever the 1-minute fetch reached, `60` for the day or two (if any)
  it didn't -- genuinely mixed within both 1M's and 3M's `days` arrays.
- **Both override paths are deliberately best-effort, not held to the
  same alerting standard as the window/intraday path split** (see
  `apps/pipeline/CLAUDE.md`'s "Two independent paths since issue #28"
  section for that standard): a 5-minute or 1-minute fetch that aborts
  or comes back empty makes that range's affected days silently fall
  back to 60-minute bars -- i.e. exactly that range's pre-#30/pre-#29
  behavior -- rather than failing the whole pipeline run. This was a
  deliberate judgment call for #30, not an oversight, and #29 follows
  the identical reasoning rather than re-litigating it: the
  window-vs-intraday split's strict "must still fail the run" rule
  exists because a silent failure there means a whole range serves
  frozen/stale JSON forever with nothing to notice it; a granularity-
  override failure instead means that range reverts to already-shipped,
  fully-correct (just coarser) 60-minute data -- qualitatively different
  from serving stale or broken output. Re-litigate this if
  finer-granularity data for either range ever becomes something the
  product depends on rather than a bonus precision upgrade.
- Per-ticker skips accumulated by a finer-granularity fetch are still
  merged into that range's own `skippedTickers` (and the pipeline-wide
  summary) even though that failure doesn't fail the run -- a ticker
  that fails only the finer-granularity fetch but succeeds the
  60-minute one can still be missing from a day it would otherwise have
  won on, since a day's winning granularity is picked wholesale (see the
  merge-correctness point above), not spliced per-ticker within a day --
  worth surfacing as a skip even though that ticker's other days/ranges
  are unaffected.
- Each range's `dataAsOf` folds in its own override fetch's freshness
  via `maxDateString`, not just the 60-minute fetch's -- a real bug
  caught in #30's code review, since a range's merged days can include
  one sourced only from its override fetch, and using only the
  60-minute fetch's `dataAsOf` could understate how fresh that range's
  data actually is, contradicting that field's own documented meaning
  ("the actual last trading date found in the fetched data" -- see
  `apps/pipeline/CLAUDE.md`). 1Y has no override and is unaffected.
- The per-range override (which extra history/skips/dataAsOf a range
  folds in beyond the base 60-minute data) is centralized in one
  `granularityOverrides: Map<PresetRange, GranularityOverride>` lookup
  in `buildIntradayResults`, not a hardcoded `range === "3M"`/
  `range === "1M"` branch -- #30's own code comment anticipated exactly
  this: "a future granularity override (e.g. issue #29's 1-minute bars
  for 1M) adds one map entry instead of a third bespoke branch," and
  #29 followed that instruction literally rather than reintroducing a
  parallel branch structure.
- `RESULTS_SCHEMA_VERSION` was **not** bumped for either issue --
  `barIntervalMinutes` is a purely additive field on an already-versioned
  shape (`IntradayDayResult`, introduced at schema version 2 by #28), and
  nothing in `apps/web` reads it yet. The version-bump criterion
  documented on `RESULTS_SCHEMA_VERSION` itself is "a shape change a
  reader needs to know about" -- an additive field no current reader
  depends on doesn't meet that bar. Revisit if `apps/web` ever starts
  branching on this field's presence.

## Write-time result self-validation (issue #47)

`src/results-schema.ts`'s `validatePrecomputedResult` is a runtime,
hand-rolled check that a `PrecomputedResult` actually satisfies its own
declared shape (`WindowResult`/`IntradayResult`, discriminated by
`model`) -- required fields present, `startingCapital`/`endingBalance`/
prices/day-balances finite numbers, `trades`/`days` arrays well-formed
-- throwing `ResultValidationError` (every problem found, not just the
first) if not. `apps/pipeline/src/pipeline.ts` calls it immediately
before each range's `putObject` (see `apps/pipeline/CLAUDE.md`).

- **Deliberately hand-rolled, not a schema library** (e.g. zod) --
  checked first per the issue's own scope note, and this package has no
  runtime-validation dependency today; the shape is small, stable, and
  cheaper to keep in sync by hand-reading it against the interfaces
  above than by maintaining a second, library-specific representation
  of the same shape. Revisit if the shape ever grows enough that
  hand-sync stops being the cheaper option.
- **Must treat its input as untrusted despite the `PrecomputedResult`
  compile-time parameter type** -- the whole point is catching a bug
  that produces a runtime value violating that type despite TypeScript
  (e.g. a `NaN` slipping through arithmetic, exactly optimizer.ts's own
  `OptimizerInputError` "computed a non-finite endingBalance" case, just
  on the _output_ side instead of input). Every field access inside the
  validator goes through an `unknown`/`Record<string, unknown>` cast and
  an explicit runtime check (`Number.isFinite`, `Array.isArray`, etc.) --
  never a bare property read trusted to have the declared type, which
  would silently defeat the check for exactly the bug class it exists to
  catch.
- Same "defense in depth" spirit as `optimizer.ts`'s own input
  validation (see above), just facing the opposite direction: that
  validates the optimizer's _inputs_ before use; this validates the
  pipeline's _output_ right before it becomes what `apps/web` reads --
  there's nothing further downstream to catch a bad value once this
  passes.
- **`schemaVersion` is checked for exact equality against
  `RESULTS_SCHEMA_VERSION`, not just "is it a non-negative integer."**
  An earlier version of `validateBase` only did the looser check --
  caught in code review as a real gap, not a nitpick: a stale or
  reverted `schemaVersion` (e.g. a rollback that regressed the constant
  without regenerating results, or a hand-crafted test fixture that
  forgot to bump it) is exactly the kind of self-inconsistency this
  validator exists to catch, and "any non-negative integer" would
  silently accept it.
- **`isPositiveFiniteNumber` (used for `startingCapital`/`endingBalance`/
  day balances/`buyPrice`/`sellPrice`) builds on `is-valid-price.ts`'s
  `isValidPrice`** (`typeof v === "number" && isValidPrice(v)`) rather
  than re-deriving `Number.isFinite(value) && value > 0` independently
  -- also caught in code review: `optimizer.ts` and `yahoo-client.ts`
  already centralize that exact predicate through `isValidPrice`
  specifically so "legitimate price" can't drift between call sites,
  and this validator had quietly re-implemented it a third time. The
  predicate is unchanged either way (both are `Number.isFinite(value) &&
value > 0`); this is a reuse fix, not a behavior change.

## Per-day intraday optimizer (issue #28)

`src/intraday-optimizer.ts`'s `optimizeIntradayDays` needs **no new DP**.
Every trading day is an independent sub-problem (a position must open
and close same-day), and `optimizeTrades` already treats its `date` keys
as opaque, sortable, unique strings with no calendar-day assumptions
baked in -- so this is a thin wrapper: group a window's `IntradayBar[]`
by calendar day (the date-part of each bar's `date`), then call
`optimizeTrades` once per day with just that day's bars, unmodified.

- **Starting capital resets every day -- does not compound across days.**
  This was the single biggest interpretive judgment call in this issue's
  planning phase (the issue text didn't say so explicitly); confirmed by
  the human user before implementation. `IntradayDayResult.startingCapital`
  is the same constant on every day.
- The wrapper never reuses `Trade`'s `buyDate`/`sellDate` fields as-is
  for its public output (`IntradayTrade`) -- `optimizeTrades` echoes back
  whatever date-string key it was given, which here is the full
  datetime, not a plain date. `IntradayTrade` splits that into explicit
  `date` + `buyTime`/`sellTime` fields instead, since `apps/web`'s
  existing `Trade` consumers (`TradeList`, `PortfolioChart`,
  `format-date.ts`) all assumed `buyDate`/`sellDate` were plain calendar
  dates -- silently reusing `Trade` unmodified here would have corrupted
  those call sites' date parsing rather than erroring.
- **Worst-case per day (issue #31)**: `optimizeIntradayDays`'s own
  `.map()` body is the one place this issue's design isn't a clean
  "leave the existing function untouched" mirror of `optimizer.ts`'s
  `optimizeTrades`/`optimizeWorstTrades` split -- there's no way to
  attach a `worstCase` field to a day's single returned
  `IntradayDayResult` object without touching this function's body, since
  `IntradayDayResult` is one combined per-day record, not two separate
  ones a caller merges. Fix: the per-day `.map()` callback also calls
  `optimizeWorstTrades(dayBars, ...)` and folds the result into
  `worstCase: { endingBalance, trades }` (`IntradayWorstCaseResult`) on
  the same object -- additive to this function's implementation, no
  change to any existing optimal-case value/behavior. `apps/pipeline`'s
  `pipeline.ts` needed **zero** changes for the intraday path as a
  result: it already treats `IntradayDayResult` as opaque everywhere
  (`sixtyMinuteDays`, `mergeDaysByGranularity`, the final `days` array),
  so `worstCase` flows through every one of those call sites for free
  once `IntradayDayResult` itself carries it.
