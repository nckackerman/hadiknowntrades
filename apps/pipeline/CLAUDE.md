# apps/pipeline — working notes

Nightly precompute job: fetch (via `packages/core`'s Yahoo client) ->
optimize (via `packages/core`'s optimizer) -> write results to S3, for
all 5 preset ranges. Read this before re-investigating something below —
if a fact here turns out to be stale, fix the fact here too, not just the
code.

- Fetches each ticker's **full** history once (from 1970, effectively
  "everything Yahoo has"), then slices that one fetch into the 5 preset
  windows locally — not 5x separate network fetches per ticker.
- Bounded concurrency (default 10 concurrent fetches).
- Error handling is deliberately asymmetric:
  - `TickerNotFoundError` / `TransientFetchError` on one ticker -> skip
    that ticker, log it, keep going.
  - `BlockedError` / `UnexpectedResponseError` -> **abort the entire
    run**. Both signal a systemic problem (we're blocked, or the API
    contract changed), not "this one ticker is weird" — continuing to
    fire off hundreds more requests would be pointless and risks
    masking a total outage as routine per-ticker noise.
  - If literally zero tickers succeed, the run throws rather than
    writing empty-but-schema-valid JSON — refuses to overwrite
    yesterday's good results with an empty run that "succeeded."
- Idempotent by design: fixed S3 key per range (`results/{RANGE}.json`),
  overwritten each run, not accumulated as dated copies.
- `dataAsOf` (the actual last trading date found in fetched data) and
  `endDate` (the requested boundary) are deliberately different fields —
  they can genuinely diverge (e.g. asOf lands on a weekend) and both are
  useful; don't collapse them back into one field.
- `S3ResultStore` (`src/s3-store.ts`) **has been run for real**, via a
  direct async invoke of the deployed `hadiknowntrades-pipeline` Lambda
  (`aws lambda invoke --function-name hadiknowntrades-pipeline
--invocation-type Event --payload '{}'`, see infra/CLAUDE.md's
  "Current deployment state" for the real bucket/function names) --
  not just a local/manual run. Real results: full run in ~37s, 0 of 503
  tickers skipped, all 5 range files written with the correct shape.
  Memory usage was 903MB of the Lambda's 1024MB allocation -- closer to
  the ceiling than "comfortable" (the stack's own comment says
  "comfortably needs more than the default"). This measurement predates
  issue #29 (1-minute bars for 1M), which is estimated to add another
  ~350-450MB on top -- `memorySize` has since been proactively bumped to
  2048MB in code as part of #29 (see "Granularity overrides" below), but that
  bump is not yet deployed; this 903MB/1024MB figure is the last real
  measured number until a post-#29 run confirms a new one.
- Two entry points, both thin wrappers around the shared
  `runNightlyPipeline()` in `src/run.ts` (kept DRY on purpose — same
  logic, different completion handling):
  - `src/index.ts` — local/manual CLI run, sets `process.exitCode` on
    failure.
  - `src/lambda-handler.ts` — the real AWS Lambda entry point, wired up
    by infra/cdk's EventBridge nightly schedule. Lets errors propagate
    to fail the Lambda invocation (no custom retry/alerting).

## Two independent paths since issue #28: window (5Y/MAX) vs. intraday (1M/3M/1Y)

`runPipeline` fetches and computes two paths concurrently, sharing the
same generalized `fetchUniverseHistory` worker pool (now generic over
bar type, not daily-close-specific):

- **Window path (5Y/MAX)**: unchanged from before #28 -- one daily-close
  fetch from `earliestDate`, sliced per range, run through
  `optimizeTrades`. Writes a `WindowResult`.
- **Intraday path (1M/3M/1Y)**: one 60-minute-bar fetch from the 1Y
  start date (`presetRangeStartDate("1Y", asOf)` -- reused rather than a
  second hand-maintained lookback constant; comfortably inside Yahoo's
  730-day retention), sliced per range, run through `optimizeIntradayDays`.
  Writes an `IntradayResult` (one entry per trading day found, see
  `packages/core/CLAUDE.md`).
- **The two paths fail independently for _writing_, but not for
  _alerting_** (refined during code review -- see below for why the
  first cut of this was a real bug): a systemic abort
  (`BlockedError`/`UnexpectedResponseError`) or zero usable data on
  _one_ path refuses to write only _that path's_ range keys -- the
  other path's ranges still write normally if its own fetch succeeded.
  But `runPipeline` still throws (after writing) if _either_ path
  failed, not only when _both_ end up with nothing -- see the next
  bullet for why. This was a deliberate design choice (see
  `docs/plans/issue-28-plan.md`), not an accident of the refactor -- the
  two paths hit the same Yahoo endpoint but are otherwise unrelated, and
  there's no reason a daily-close-specific failure should also block
  1M/3M/1Y (or vice versa) if the other fetch is fine.
- **Real bug caught in code review, since fixed**: an earlier version of
  this split only threw when _both_ paths came up empty, exactly
  mirroring the original pre-#28 "refuse to overwrite with an empty run"
  guarantee. That silently broke this system's only alerting mechanism
  (letting an error propagate is what fails the Lambda invocation --
  see "no custom retry/alerting" above): a persistent failure confined
  to just one path (e.g. Yahoo starts blocking `interval=60m`
  specifically while daily-close fetches keep working) would have let
  every nightly run "succeed" indefinitely while that path's ranges
  silently served increasingly stale data, with nothing beyond a
  `console.warn` buried in CloudWatch to notice. Fixed: `runPipeline`
  writes whatever succeeded, then still throws if _either_ path failed
  -- the thrown message includes both paths' status and the accumulated
  `skippedTickers`, so nothing operationally useful is lost by failing
  the invocation. Only when _both_ paths end up with nothing does it
  throw _without_ writing anything.
- `n` for the intraday path is `DEFAULT_MAX_TRADES_PER_DAY` in
  `pipeline.ts`, next to (but deliberately distinct from) the existing
  `DEFAULT_MAX_TRADES` -- both currently 3, but "trades across the whole
  window" and "trades within one day" are different knobs that could
  reasonably diverge later.
- `optimizeIntradayDays` is run **once**, over the full fetched intraday
  history (capped only at `endDateString`), and its output is _sliced_
  per range (1M/3M/1Y) afterward -- not re-run separately for each
  range. An earlier version did re-run it per range, which was a real,
  needless cost caught in code review: a given trading day's own result
  never depends on which range window it falls inside (range-slicing
  only ever drops whole out-of-range days, never bars within an
  in-range one), so re-solving the same day's DP up to 3 times (1M/3M/1Y
  are nested subsets of each other) was pure waste on a Lambda already
  documented above as running close to its memory ceiling.
- `fetchUniverseHistory`'s abort case (`BlockedError`/
  `UnexpectedResponseError`) returns `abortError` rather than throwing,
  specifically so the `skipped` array it had already accumulated (real
  per-ticker failures that happened _before_ the abort) survives even
  though the caller discards the untrusted partial `history` -- losing
  that bookkeeping used to not matter (pre-#28, any abort always failed
  the whole run and nothing downstream ever looked at partial data
  anyway), but matters now that a single path's failure can coexist with
  a written, partially-successful run.
- **Quadrupled Yahoo request volume risk (flagged during planning, not
  yet hit in practice)**: issue #28 doubled per-run request volume
  (window + intraday, each hitting the full ~503-ticker universe,
  running concurrently); issue #30's 5-minute fetch added a _third_
  concurrent full-universe pool on top of that (its per-ticker requests
  are smaller -- 59 days of 5-minute bars vs. the intraday fetch's ~365
  days of 60-minute bars -- but it's still up to ~503 more concurrent
  requests per run, at the same default concurrency of 10 as the other
  two pools); issue #29's 1-minute fetch added a _fourth_ pool, and its
  own per-ticker request count is itself ~4x higher than the other three
  pools' (day-chunked into up to 4 sequential requests per ticker, see
  "Granularity overrides" below) -- so while peak _simultaneous_ connections
  only grows by the same increment as #30's pool did (still concurrency
  10), _total_ request volume for a full run is meaningfully higher than
  either the #28 or #30 baseline. `packages/core/CLAUDE.md` already
  documents this endpoint as unofficial and liable to start blocking
  without notice; no throttling/rate-limiting or shared concurrency
  budget across the four pools was added to mitigate this, just flagged
  as something to watch if blocking behavior is ever observed in a real
  run (see "Current deployment state" in `infra/CLAUDE.md` for how a
  real run's memory/timing has been tracked before -- the same kind of
  real-run observation is worth doing here once this is deployed).
- `RESULTS_SCHEMA_VERSION` bumped to 2 for this issue (see
  `packages/core/src/results-schema.ts`) -- a global version number
  across a discriminated union (`WindowResult` | `IntradayResult`), not
  a per-range version. Concretely: 5Y/MAX are behaviorally unchanged by
  #28, but their _stored JSON_ still changes shape (gains `model:
"window"` and `maxTrades`) purely because the version number is
  shared. This means a pipeline run that writes the new schema must
  happen (rewriting _all 5_ range keys) before or atomically with
  deploying the schema-2-only `apps/web` -- otherwise every range,
  including the two untouched ones, 502s with `schema_mismatch` until
  the next nightly run. Real-AWS action, needs the user's go-ahead per
  this repo's standing working agreement -- not yet performed as of this
  issue's implementation; see the PR for issue #28.
- **Bumped again to 3 for issue #31** (worst-case contrast stat): every
  `WindowResult` and every `IntradayDayResult` gains a `worstCase` field
  (`{ endingBalance, trades }`), computed in `buildWindowResults` here
  via one `optimizeBothDirections` call per window range (not two
  separate `optimizeTrades`/`optimizeWorstTrades` calls -- a code-review
  follow-up fixed that redundancy, see `packages/core/CLAUDE.md`'s
  "Optimizer algorithm" section for the benchmark) and in
  `packages/core`'s `optimizeIntradayDays` itself for the intraday path
  (see that file's own CLAUDE.md note on why the intraday side needed no
  other change in this file). Same rollout hazard as the schema-2 bump
  above, same "needs the
  user's explicit go-ahead before/atomically with a real pipeline write"
  rule -- not yet performed as of this issue's implementation.
- **Bumped again to 5 for issue #13** (short-selling mode): every
  `WindowResult` and every `IntradayDayResult` gains a `longShort` field
  (mirroring `worstCase`'s own sibling-field shape, plus its own nested
  `worstCase`), computed in `buildWindowResults` here via one
  `optimizeAllVariants` call per window range (replacing the previous
  `optimizeBothDirections` call -- same one-shared-calendar-build
  principle, now sharing across all 4 direction x instrument-set
  combinations instead of 2) and in `packages/core`'s
  `optimizeIntradayDays` itself for the intraday path (same "no other
  change needed in this file" reasoning issue #31's own `worstCase`
  bullet above already established -- see `packages/core/CLAUDE.md`'s
  "Short-selling mode" section for the full design). `Trade`'s fields
  are also renamed in this same bump (`buyDate`/`buyPrice`/`sellDate`/
  `sellPrice` -> `openDate`/`openPrice`/`closeDate`/`closePrice`, plus a
  new `direction` field) -- every test fixture in this file's own
  `pipeline.test.ts` that builds a `Trade`/`IntradayTrade` literal, or
  asserts on one, needed updating for the rename, not just for the new
  field. Same rollout hazard as every prior schema bump -- needs the
  user's explicit go-ahead before/atomically with a real pipeline write,
  not yet performed as of this issue's implementation. **Live-verified**
  (real S&P 500 data, full 503-ticker universe, no S3 write) that the two
  new cross-checks (`longShort.endingBalance >= endingBalance`,
  `longShort.worstCase.endingBalance <= worstCase.endingBalance`) hold
  with 0 violations across all 5 window ranges and all 251 real trading
  days of the 1Y intraday window -- see `packages/core/CLAUDE.md`'s
  "Short-selling mode" section for the full numbers (including real
  timing/memory measurements, since this is the largest single per-run
  DP cost increase this optimizer has taken).

## Code review follow-up: issue #13 short-selling PR (mergeDaysByGranularity and per-range/day compute containment)

Two real bugs found in a post-merge review of issue #13's own PR, both
fixed in the same follow-up pass -- covered here rather than folded back
into the "Short-selling mode"/"Two independent paths" sections above so
the reasoning stays in one place instead of scattered across edits to
older prose.

### mergeDaysByGranularity and long+short

**The bug**: `mergeDaysByGranularity` (see "Granularity overrides" above)
picked a date's winning source day using only the long-only
`endingBalance` comparison, silently ignoring the parallel `longShort`
field this issue added. Whichever source won the long-only comparison
also had its `longShort` field carried along wholesale, even on a day
where the _other_ source's `longShort.endingBalance` was actually
higher -- a realistic split, not a hypothetical one: `IntradayDayResult.
longShort` is a genuinely independent search (see
`intraday-optimizer.ts`), and different granularities can see different
ticker universes for the same date, so nothing guarantees the same
source wins both comparisons. This silently violated the function's own
documented invariant ("keeps whichever day's outcome is actually
higher") for the long+short mode specifically.

**The fix, and why it's a full fix, not a documented partial one**: the
long-only bundle (`endingBalance`/`trades`/`worstCase`) and the long+short
bundle (the whole `longShort` field) are now picked _independently_, each
via its own endingBalance comparison -- see `mergeDayVariants` in
`pipeline.ts`. This is safe against "cherry-picking fields from two
unrelated computations" because each bundle's own fields were always
computed together, from the same source day's actual bars, by the same
`optimizeAllVariants` call -- `trades` always matches its own sibling
`endingBalance` regardless of which bundle's source day wins.

The harder question -- worked through rather than assumed -- was whether
this could violate `results-schema.ts`'s own write-time cross-checks
(`longShort.endingBalance >= endingBalance`,
`longShort.worstCase.endingBalance <= worstCase.endingBalance`) now that
the two bundles can come from _different_ source days. **It provably
cannot, and this isn't a coincidence of the fixture used to verify it --
it follows from a structural property of this optimizer's reciprocal-price
short model**: for any single source, flipping every leg of its own
best (or worst) sequence's direction (long <-> short, identical slots)
is always a _valid_ candidate for that same source's own opposite-mode
search (both use `includeShorts: true`, same candidate pool, just
opposite comparison direction) -- so a source's `longShort.best` and
`longShort.worst` are always reciprocal-bounded against each other, and
a source's plain `worst` is always reciprocal-bounded against its own
`longShort.best`. Chaining those two facts across the long-only winner
and the long+short winner (which can be two different sources) is enough
to prove both cross-checks hold unconditionally -- see `mergeDayVariants`'s
own doc comment in `pipeline.ts` for the full chain, and
`pipeline.test.ts`'s "picks the long-only bundle and the long+short
bundle independently..." test for a concrete fixture (hand-verified
against the real optimizer, not just asserted) where the two
granularities disagree on which is long-only-best vs. long-short-best.

**One accepted, documented (not fixed) limitation**: `barIntervalMinutes`
is a single scalar per day, so on the rare date where the two bundles'
winners come from different granularities, it reflects only the
long-only bundle's source -- there's no way to represent two
granularities in one scalar field without a schema change. Same
"documented tradeoff" posture as this file's own "neither override is
held to the same alerting standard" precedent.

### Per-range/per-day optimizer-overflow containment

**The bug**: a short's reciprocal-price payoff (`P[open]/P[close]`) is
unbounded above as the covering price approaches zero (see
`packages/core/CLAUDE.md`'s "Short-selling mode" section), so a real
ticker's price collapsing toward near-zero at some point within a
range's window can overflow `endingBalance` past `Number.MAX_VALUE` and
trip `optimizeAllVariants`' own finite-endingBalance guard
(`OptimizerInputError`). Before this fix, that throw propagated
synchronously out of `buildWindowResults`'/`buildIntradayResults`'
plain `.map()`/loop calls, invoked before the write loop's own
`Promise.allSettled` -- aborting the _entire_ run (every window range,
every intraday day, for every range) instead of just the one affected
range or day.

**The fix**: `buildWindowResults` now wraps each range's own compute
step in try/catch, and `packages/core`'s `optimizeIntradayDays` now
wraps each _day's_ own compute step in try/catch (see its own
`OptimizeIntradayResult` doc comment) -- a failure is logged
(`console.error`) and that range/day is excluded from the successful
output, matching this system's "write whatever succeeded" philosophy
rather than aborting everything. The failure is not silently swallowed,
though: `buildWindowResults`/`buildIntradayResults` both return a
`{results, failures}` shape (mirroring `fetchUniverseHistory`'s own
`{history, skipped, abortError}` precedent for "per-item failure
shouldn't abort the batch, but must still be reported"), and
`runPipeline` folds `failures` into the _same_ aggregated "at least one
path or write failed" throw that issue #47's write-time validation
failures already use -- a range/day that couldn't be computed at all is
genuinely missing this run (or, on a later run, silently stuck stale),
exactly the failure mode this system's must-fail-the-run alerting exists
to catch, unlike a granularity override's non-fatal failure.

**One deliberate asymmetry**: an _override_ granularity's own per-day
failures (e.g. the 5-minute fetch's optimizer overflowing for one day)
are logged but NOT folded into the fatal `failures` list -- unlike the
_base_ 60-minute pass's failures, which always are. This mirrors the
existing override-fetch-failure posture exactly:
`mergeDaysByGranularity` already falls back to the base 60-minute day
for any date an override doesn't cover, so an override-only day failure
degrades gracefully to that range's pre-override behavior for that one
day, not a loss of previously-working data. See `pipeline.test.ts`'s
"per-range/per-day compute-failure containment" describe block for
fixtures covering both the window-path and intraday-base-path cases
(each uses a same-ticker pair with one price at `Number.MIN_VALUE` to
trigger a real overflow, not a mocked throw).

## Write-time result self-validation (issue #47)

Immediately before each range's `putObject` call, `runPipeline` now
calls `validatePrecomputedResult` (`packages/core/src/results-schema.ts`
-- see `packages/core/CLAUDE.md` for what it checks) on that result, so
a malformed result (e.g. a future refactor bug producing a `NaN`
`endingBalance`) throws and fails the Lambda invocation loudly instead
of shipping silently to S3. This is this system's only alerting
mechanism (see the top of this file) -- a thrown error here plugs into
existing behavior with no new plumbing needed.

- **The `results.map(...)` callback around the write loop must stay
  `async`, not a bare arrow returning `store.putObject(...)` directly --
  a real, easy-to-get-wrong subtlety, not a style choice.** `.map()`
  invokes its callback _synchronously_ for every element before
  `Promise.allSettled` ever starts awaiting; if `validatePrecomputedResult`
  threw synchronously inside a _non_-`async` callback, that throw would
  propagate straight out of `.map()` itself and abort the whole loop
  before later elements' `putObject` calls ever got a chance to start --
  silently breaking the "write whatever succeeded, then still throw if
  either path failed" guarantee (see "Two independent paths" below) for
  every range after the first invalid one in iteration order, not just
  the invalid one. Making the callback `async` fixes this: a synchronous
  throw inside an `async` function body is caught by the function's own
  machinery and turned into that one element's rejected promise instead
  of a synchronous exception out of `.map()`, so every other element's
  `async` callback still runs (and its `putObject` still starts)
  independently. If this callback is ever refactored back to a bare
  arrow function around `store.putObject(...)`, re-add `async` (or
  otherwise ensure the validation call can't throw synchronously out of
  `.map()`).
- **The write loop uses `Promise.allSettled`, not `Promise.all` -- an
  early version of this used `Promise.all`, and that was a real, subtle
  bug caught in code review, not a style preference.** `validatePrecomputedResult`
  is synchronous and effectively instantaneous; a sibling range's
  `store.putObject(...)` call is real network I/O (a real S3 `PUT` in
  production) taking real time. With `Promise.all`, one range's
  validation failure rejects almost immediately -- well before other
  ranges' in-flight `putObject` calls have finished -- and `Promise.all`
  settles (rejected) as soon as **any** input promise rejects; it does
  not wait for the others. That rejection propagates out of `runPipeline`
  to the Lambda handler, and AWS can freeze/recycle the execution
  environment as soon as the handler's returned promise settles --
  potentially cutting off other, valid ranges' still-in-flight S3 writes
  before they land. That directly undermines the "write whatever
  succeeded, then still throw if something failed" guarantee this
  section (and this file's tests) claims to preserve -- the earlier
  "the other, still-valid writes aren't prevented from completing in
  the background" claim this bullet used to make was true only in a
  same-process, no-real-I/O sense, not once a real Lambda freeze after
  invocation is in the picture. **The existing in-memory test store
  can't catch this on its own** -- it has no I/O delay, so every write
  resolves before a rejection ever has a chance to race it; the fix
  (`src/pipeline.write-validation.test.ts`) added a configurable
  per-key write delay to the test store specifically so a slower,
  valid write can be shown to still land even though a sibling range's
  validation rejects first. Fixed by switching to `Promise.allSettled`:
  every write is given the chance to finish, succeed or fail, before
  `runPipeline` decides anything. A related finding from the same
  review: plain `Promise.all` (or a naive "throw on the first rejected
  settlement" loop) only ever surfaces the **first** validation/write
  failure even when multiple ranges are independently broken in the
  same run -- `runPipeline` now collects every `rejected` outcome and
  folds all of them, one line per failed range, into the same
  aggregated error the "at least one path failed" check below already
  builds (see "Two independent paths" below), rather than throwing a
  second, separate error for write-time problems.
- Covered by `src/pipeline.write-validation.test.ts`, a small file kept
  deliberately separate from the main `pipeline.test.ts` -- it needs to
  `vi.mock("@hadiknowntrades/core", ...)` to force `validatePrecomputedResult`
  to fail for one or more specific ranges while leaving the real
  implementation in place for every other range (via `importOriginal`),
  and `vi.mock` applies module-wide to every test in whatever file calls
  it; doing this in `pipeline.test.ts` would have broken every other
  test there that expects real validation to pass. Uses `vi.hoisted()`
  to hold the "which ranges should fail" set the mock factory reads --
  needed because `vi.mock`'s factory (like the mock call itself) is
  hoisted above normal top-level `const` declarations, so a plain outer
  variable read by the factory would hit the temporal dead zone. One
  test forces two ranges to fail simultaneously and asserts the thrown
  error names both, while every other, still-valid (and deliberately
  slow-to-write) range still lands in the store.
  `results-schema.test.ts` (`packages/core`) already covers
  `validatePrecomputedResult`'s own pass/fail logic directly; this file
  only checks the pipeline's _wiring_ to it.

## Granularity overrides: 3M's 5-minute and 1M's 1-minute bars (issues #30, #29)

A **granularity override** upgrades one range's days to a finer bar
granularity than the base 60-minute fetch, on a best-effort basis --
issue #30 added the first one (5-minute bars, upgrading 3M's most
recent days), issue #29 added the second (1-minute bars, upgrading 1M).
Both are driven by one generic mechanism in `pipeline.ts`, not two
parallel implementations:

- **`buildGranularityOverrideSpecs(options, asOf)` builds the single
  list every other piece of this mechanism iterates over** -- one
  `GranularityOverrideSpec` per override (`range`, `label`,
  `barIntervalMinutes`, its own retention-bounded `from`, and the
  underlying `fetchBars` function). `runPipeline` fetches every spec's
  history via one inner `Promise.all` (still fully concurrent with the
  window/intraday fetches and with each other, just gathered as an
  array instead of separate named bindings); `buildIntradayResults`
  loops over the resulting `{ spec, outcome }` pairs to solve
  (`optimizeIntradayDays` with that spec's `barIntervalMinutes`) and
  merge (`mergeDaysByGranularity` against the base 60-minute days) each
  one, building the `granularityOverrides: Map<PresetRange,
GranularityOverride>` lookup that `buildIntradayResults`'s final
  per-range loop reads from (`range === "3M"` and `range === "1M"` never
  appear as branches anywhere in this file); and the final "at least one
  path failed" error message loops over the same pairs to append one
  status line per override, purely for operational visibility.
  **Adding a third override means adding one entry to the list
  `buildGranularityOverrideSpecs` returns (plus one new `fetch*Bars`
  field on `RunPipelineOptions`, wired up in `src/run.ts`) -- nothing
  else in this file changes.**
- **This wasn't true when 1M's override first landed, and that gap was
  itself a real, code-review-caught bug, not just a style nit.** #30's
  own code comment on `GranularityOverride` promised "adding another
  range's override means adding one map entry, not a third bespoke
  branch" -- but the actual duplication ran deeper than that one map:
  issue #29's first draft added 1M's override by hand-duplicating a
  `fiveMinute*`/`oneMinute*` field pair through
  `BuildIntradayResultsOptions`, a second copy-pasted
  optimize-then-merge block, a second `Promise.all` entry, and a second
  error-message status line -- 7 separate spots touched by hand for one
  new override, not the "one map entry" the promise described. Fixed by
  generalizing to the `buildGranularityOverrideSpecs`/loop design above
  before merging -- the bar going forward is that a _third_ override
  should be a small, localized change, not another multi-spot edit.
- **The merge is NOT "the finer granularity always wins wherever it
  exists"** -- an earlier version of #30 did exactly that, and it was a
  real correctness bug caught in code review: the two granularities can
  see different ticker universes for the same day (e.g. a ticker's
  finer-granularity fetch failed for just that day while its 60-minute
  fetch succeeded), so the finer day can legitimately have _worse_
  coverage -- and therefore a worse achievable outcome -- than the
  60-minute day for that exact date. Blindly preferring the finer
  granularity regardless would silently make that range's reported
  result strictly worse than what 60-minute-only data would have shown
  for that day, which cuts against this whole app's "best possible
  outcome" premise, not just a granularity choice. Fixed:
  `mergeDaysByGranularity` keeps whichever day's `endingBalance` is
  actually higher when both granularities cover a date (both were
  solved with the same `startingCapital`, so ending balance is directly
  comparable); for a date only one granularity covers, that one wins by
  default -- there's nothing to compare. **Issue #13 code review follow-up:
  this comparison only ever looked at the long-only `endingBalance`, never
  at the parallel `longShort` field -- see "mergeDaysByGranularity and
  long+short (issue #13 code review follow-up)" below for the real bug
  this was and the fix.**
- **Each override's `dataAsOf` folds in that override's own fetch
  freshness, not just the 60-minute fetch's** -- another real bug caught
  in #30's code review: since an override range's merged days can
  include one sourced only from the override fetch, using only the
  60-minute fetch's `dataAsOf` could understate how fresh that range's
  own data actually is, contradicting that field's own documented
  meaning ("the actual last trading date found in the fetched data" --
  see the top of this file). Fixed via `maxDateString(dataAsOf,
override?.extraDataAsOf ?? null)`; a range with no override (1Y) has its
  `dataAsOf` untouched.
- **Neither override is held to the window/intraday split's "must still
  fail the run" standard** (see the section above): an override's abort
  or empty-data outcome does not get added to the `if
(windowFetch.failureReason || intradayFetch.failureReason)` throw
  condition in `runPipeline` -- each override's status is only reported
  in that error's message for visibility, alongside the two required
  paths' statuses. The reasoning is qualitatively different from why
  window/intraday _are_ held to that standard: their failure means a
  whole range silently serves frozen/stale JSON forever, which is
  exactly what that alerting exists to catch. An override's failure
  instead means its range's affected days silently fall back to
  already-shipped, fully-correct (just coarser) 60-minute bars --
  functionally identical to that range's pre-override behavior, not a
  loss of previously-working data. Revisit this distinction if
  finer-granularity data for either range ever becomes something the
  product actually depends on, rather than a bonus precision upgrade
  layered on top of an already-complete 60-minute result.
- `IntradayDayResult.barIntervalMinutes` (60, 5, or 1) is stamped onto
  every day, for every range -- makes which granularity produced a given
  day's numbers visible in the JSON output itself rather than only
  inferable from the day's date relative to "now," per #30's own
  call-out that this isn't obvious otherwise. Not worth a
  `RESULTS_SCHEMA_VERSION` bump: it's a purely additive field on the
  already-versioned `IntradayDayResult` shape, and nothing in `apps/web`
  reads it yet (see that constant's own "bump when a reader needs to
  know" criterion).
- An override range's `skippedTickers` merges in tickers skipped by that
  override's own fetch (a range with no override doesn't see them) -- a
  ticker that fails only the override fetch but succeeds the 60-minute
  one can still be absent from a given day it would otherwise have won
  on, since a day's winning granularity is picked wholesale (see the
  merge-correctness bullet above), not spliced per-ticker within a day.
  Same reasoning for that range's `universeSize`, which unions tickers
  across both the 60-minute and override histories rather than reading
  only one.
- Full design writeup for the granularity-agnostic mechanism above lives
  in `packages/core/CLAUDE.md`'s "Mixed-granularity 1M/3M assembly"
  section -- read that first before re-deriving any of this from
  scratch.

### Per-override specifics

The two overrides share every mechanism above but differ in their own
retention wall, lookback window, and fetch shape:

- **3M / 5-minute (issue #30)**: scoped to `FIVE_MINUTE_LOOKBACK_DAYS`
  (59) days back from `asOf` -- Yahoo's real retention for `interval=5m`
  is a hard 60-day wall (verified live: 59 days back succeeds, 60 fails
  with a 422 that surfaces as `UnexpectedResponseError`, _not_
  `TickerNotFoundError` -- see `packages/core/CLAUDE.md`'s "5-minute
  intraday bars" section for why that distinction matters
  operationally). `fetchFiveMinuteBars` is a single request per ticker,
  no chunking. 3M's own window (up to ~92 days) so comfortably exceeds
  this 59-day lookback that "does the override's own window fully cover
  the range's window" never came up as sharply during #30 as it did for
  1M below.
- **1M / 1-minute (issue #29)**: scoped to `ONE_MINUTE_LOOKBACK_DAYS`
  (29) days back from `asOf`, via the same `daysBeforeUtc` helper --
  deliberately **not** `presetRangeStartDate("1M", asOf)`: that can land
  up to 31 calendar days back (one day past `interval=1m`'s retention
  wall whenever `asOf` falls after a 31-day-long source month), a real
  bug this issue's plan review caught before any code was written. See
  `packages/core/CLAUDE.md`'s "1-minute intraday bars" section for the
  live-verified 30-day wall this constant is derived from.
  `fetchIntraday1mBars` **chunks each ticker's request internally**
  (Yahoo caps a single `interval=1m` request at 8 days), unlike
  `fetchFiveMinuteBars`'s single-request shape -- entirely opaque to
  `runPipeline`, which still just sees one promise per ticker either
  way, the same "generic over the fetch function" design #28
  established. This override reuses the same `fetchConcurrency` as
  every other path rather than a separate, lower knob (an earlier draft
  of this issue's plan assumed one would be needed):
  `fetchIntraday1mBars` issues its internal chunks **sequentially**, not
  concurrently, so peak simultaneous connections per worker stays at
  exactly 1 regardless of how many chunks a given ticker's fetch needs
  -- concurrency still bounds peak simultaneous _tickers_ in flight the
  same way it does for every other path, just with each ticker taking
  longer wall-clock time for this one override specifically. And unlike
  3M's relationship to its 5-minute fetch, **1M's own window can
  genuinely outreach the 1-minute fetch's own lookback**: 1M's
  ~29-31-day window and the 1-minute fetch's ~29-day lookback are close
  enough that the oldest day or two of a 31-day month legitimately has
  no 1-minute data at all. This isn't a bug -- `mergeDaysByGranularity`
  already handles "a date only the 60-minute array covers" by falling
  back to it, the exact same mechanism 3M's older-than-59-day days
  already rely on, it just triggers more routinely for 1M than it does
  for 3M. See `packages/core/CLAUDE.md`'s "Mixed-granularity 1M/3M
  assembly" section for the full reasoning.

## Buy-and-hold (SPY) comparison stat (issue #12)

`pipeline.ts`'s `fetchBenchmarkHistory`/`computeBenchmark` add a whole-
window SPY buy-and-hold figure to **every** `PrecomputedResult` (all 5
ranges, both models), via a fourth, non-fatal concurrent fetch alongside
the window/intraday/override paths. Much simpler than a granularity
override: exactly one ticker (`SPY`, hardcoded per the issue's own scope
-- no user-chosen ticker), so it skips `fetchUniverseHistory`'s worker-
pool-plus-abort-classification machinery entirely (a flat try/catch is
equally correct for `n=1`), and its failure never fails the run (same
non-fatal posture as a granularity override) -- `benchmark: null` on
every range this run if SPY's fetch fails outright.

- **`RESULTS_SCHEMA_VERSION` bumped 3 -> 4** (a fresh bump on top of
  issue #31's own 2 -> 3, not instead of it -- #31 and #12 were planned
  in parallel against the same constant/`PrecomputedResultBase`, and #31
  merged first). See `packages/core/CLAUDE.md`'s own note on
  `BenchmarkResult`/`validateBenchmark`.
- **Shown on all 5 ranges, not just the window model's 5Y/MAX** -- a
  human-confirmed product decision. It's a single well-defined
  whole-window figure (SPY's own start price to end price over the
  range) regardless of which trading model a given range uses, unlike
  e.g. the OG card (issue #33), which deliberately scopes itself to
  `"window"` only for a genuinely different reason (no single top-level
  `endingBalance` to headline for the intraday-daily model).
- **`truncated` is deliberately NOT `start.date > rangeStartString`**
  (an earlier draft of this issue's plan did exactly that, and an
  independent plan review only caught half the problem -- the MAX-range
  inversion, see below). The actual bug: a range's nominal
  `rangeStartString` (`presetRangeStartDate`) is a plain calendar date
  with no guarantee of being a real trading day -- **live-checked**
  (not assumed) that it lands on a weekend for **~28% of days**, across
  a 2-year sample, for _every_ bounded range (1M/3M/1Y/5Y). Comparing
  `start.date` (the nearest real trading day actually used) directly
  against that nominal boundary would flag `truncated: true` on a large
  fraction of days for every bounded range, not just MAX -- exactly the
  false-positive flicker the field's own semantics ("history doesn't
  reach back that far") don't intend, and would defeat the whole
  point of a flag meant to be a rare, MAX-specific caveat. Fixed:
  `truncated` compares `rangeStartString` against SPY's _overall_
  earliest fetched date (across the whole `closes` array, not just the
  in-window slice) -- that only exceeds the nominal boundary when SPY's
  data genuinely doesn't reach back that far _at all_, regardless of
  which specific day inside the window happened to have the first
  trading-day bar. Regression-tested in `pipeline.test.ts` with a
  fixture asOf whose 5Y boundary is a real Saturday (2019-06-15, from
  the file's own `ASOF` constant).
- **The MAX-range inversion bug** (`presetRangeStartDate("MAX", asOf)`
  returns `null`, which made an earlier expression short-circuit to
  `truncated: false` unconditionally for MAX -- the one range this
  field exists for) is fixed by `truncated: rangeStartString === null
|| earliestOverall > rangeStartString`: `rangeStartString === null`
  makes MAX unconditionally `truncated: true`, correct since SPY's
  finite history (real inception 1993-01-29, confirmed live) is always
  a truncation relative to an unbounded window.
- **Live-verified** (both facts, not assumed): a real
  `fetchDailyCloses("SPY", ...)` call confirms SPY's first real bar is
  `1993-01-29` and the returned array is date-ascending in practice
  (`computeBenchmark` still does an explicit min/max scan rather than
  trusting `inWindow[0]`/`.at(-1)`, same defensive posture as
  `findMaxDate` above -- this hasn't been shown to be _necessary_, just
  cheap insurance, per `fetchDailyCloses`'s own undocumented-ordering
  note in `packages/core/CLAUDE.md`). A real small-universe pipeline run
  (`AAPL`+`MSFT`) produced a valid, schema-passing `benchmark` for every
  one of the 5 written ranges, with MAX correctly `truncated: true` at
  `startDate: "1993-01-29"` and every bounded range `truncated: false`.
