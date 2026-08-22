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

## Write-time result self-validation (issue #47)

Immediately before each range's `putObject` call, `runPipeline` now
calls `validatePrecomputedResult` (`packages/core/src/results-schema.ts`
-- see `packages/core/CLAUDE.md` for what it checks) on that result, so
a malformed result (e.g. a future refactor bug producing a `NaN`
`endingBalance`) throws and fails the Lambda invocation loudly instead
of shipping silently to S3. This is this system's only alerting
mechanism (see the top of this file) -- a thrown error here plugs into
existing behavior with no new plumbing needed.

- **The write loop's per-job callback must stay `async`, not a bare
  arrow returning `store.putObject(...)` directly -- a real,
  easy-to-get-wrong subtlety, not a style choice.** As of issue #11
  (custom-range anchors), the write loop is `mapWithConcurrency(writeJobs,
writeConcurrency, async (job) => { job.validate(); await
options.store.putObject(job.key, job.body); return job.label; })` --
  `writeJobs` concatenates `presetWriteJobs` (5 preset ranges) and
  `customWriteJobs` (up to 252 custom anchors, issue #11), and
  `mapWithConcurrency` is a bounded-concurrency worker pool (see below)
  that `await`s this callback per job inside a `try`/`catch`, not a bare
  `.map()` anymore (an earlier version of this section described a
  `results.map(...)`/`Promise.allSettled` shape that issue #11's
  concurrency-cap fix replaced -- see the next bullet). The `async`
  requirement itself is unchanged from before that refactor: if
  `job.validate()` (which calls `validatePrecomputedResult` or
  `validateCustomWindowResult`, `packages/core/src/results-schema.ts`)
  threw synchronously inside a _non_-`async` callback, that throw would
  propagate straight out of `mapWithConcurrency`'s own `worker(...)` call
  -- outside its `try`/`catch` -- and abort that whole worker's loop
  instead of becoming just this one job's own recorded rejection, risking
  the same "later jobs never get a chance to write" failure mode the
  original `.map()`-era bug had. Making the callback `async` turns a
  synchronous throw into an ordinary rejected promise the `try`/`catch`
  already handles, so every other job's write still gets a chance to
  start independently. If this callback is ever refactored again, keep
  it `async` (or otherwise ensure `job.validate()` can't throw
  synchronously out of the worker loop).
- **The write loop is bounded by `writeConcurrency`
  (`DEFAULT_WRITE_CONCURRENCY = 10`), via `mapWithConcurrency`, not an
  unbounded `Promise.allSettled(writeJobs.map(...))` (issue #11 code
  review finding, fixed).** Before this, every `WriteJob`'s `putObject`
  fired at once with no cap -- unlike every fetch pool in this file
  (`fetchConcurrency`, default 10), which was never tested against real
  S3 write volume at the custom-anchor feature's own scale (up to 257
  write jobs: 5 preset + up to 252 custom anchors -- this feature's own
  live verification explicitly excluded S3 writes, see
  `packages/core/CLAUDE.md`'s "Custom date-range anchors" section).
  `mapWithConcurrency` (this file) mirrors `fetchUniverseHistory`'s own
  "N workers pulling the next index off a shared cursor" bounded-pool
  shape rather than inventing a second, differently-structured
  concurrency mechanism, but returns a `PromiseSettledResult<R>[]`
  (fulfilled/rejected per item, in original item order) instead of
  `fetchUniverseHistory`'s own `{ history, skipped, abortError }` shape
  -- the two loops have genuinely different semantics (abort-on-systemic-
  failure vs. "run every job to completion regardless"), so
  `mapWithConcurrency` is a separate, more generic function, not a call
  into `fetchUniverseHistory` itself. `writeConcurrency` defaults to the
  same value as `fetchConcurrency` but is its own `RunPipelineOptions`
  field -- deliberately not reusing `fetchConcurrency` directly, since
  Yahoo's own request-volume tolerance and S3's are independent
  concerns that could reasonably need different caps later even though
  they happen to agree today.
- **The write loop uses `Promise.allSettled`-equivalent semantics (every
  job settles, success or failure, before the loop decides anything),
  not `Promise.all` -- an early version of this used `Promise.all`, and
  that was a real, subtle bug caught in code review, not a style
  preference.** `job.validate()` is synchronous and effectively
  instantaneous; a sibling job's `store.putObject(...)` call is real
  network I/O (a real S3 `PUT` in production) taking real time. With
  `Promise.all`, one job's validation failure rejects almost immediately
  -- well before other jobs' in-flight `putObject` calls have finished --
  and `Promise.all` settles (rejected) as soon as **any** input promise
  rejects; it does not wait for the others. That rejection propagates
  out of `runPipeline` to the Lambda handler, and AWS can freeze/recycle
  the execution environment as soon as the handler's returned promise
  settles -- potentially cutting off other, valid jobs' still-in-flight
  S3 writes before they land. That directly undermines the "write
  whatever succeeded, then still throw if something failed" guarantee
  this section (and this file's tests) claims to preserve -- the earlier
  "the other, still-valid writes aren't prevented from completing in
  the background" claim this bullet used to make was true only in a
  same-process, no-real-I/O sense, not once a real Lambda freeze after
  invocation is in the picture. **The existing in-memory test store
  can't catch this on its own** -- it has no I/O delay, so every write
  resolves before a rejection ever has a chance to race it; the fix
  (`src/pipeline.write-validation.test.ts`) added a configurable
  per-key write delay to the test store specifically so a slower,
  valid write can be shown to still land even though a sibling job's
  validation rejects first. `mapWithConcurrency` preserves this property
  under a bounded worker pool: every job is given the chance to finish,
  succeed or fail, before `runPipeline` decides anything -- it never
  short-circuits the way `Promise.all` does. A related finding from the
  same review: plain `Promise.all` (or a naive "throw on the first
  rejected settlement" loop) only ever surfaces the **first**
  validation/write failure even when multiple jobs are independently
  broken in the same run -- `runPipeline` now collects every `rejected`
  outcome and folds all of them, one line per failed job, into the same
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
  default -- there's nothing to compare.
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
- **`computeBenchmark` was generalized (issue #11) to take
  `rangeStartString: string | null` directly instead of a
  `range: PresetRange` + `asOf` pair it derived one from internally** --
  every existing call site (the `benchmarksByRange` construction loop)
  now computes its own `rangeStartString` via `presetRangeStartDate`
  first, the same computation that used to live inside `computeBenchmark`
  itself. This is what lets the exact same function also serve
  `buildCustomWindowResults`'s per-anchor benchmark (see below) with no
  PresetRange-specific branching anywhere in the function.

## Custom date-range anchors (issue #11)

`buildCustomWindowResults` computes one `CustomWindowResult` per
requested anchor (`packages/core`'s `AnchorMonth`, see that package's own
CLAUDE.md for the full anchor-scheme design), reusing a new
`computeWindowOptimization` helper factored out of `buildWindowResults`
specifically so the 5Y/MAX preset path and the custom-anchor path share
one windowed-slice-plus-`optimizeBothDirections` implementation instead
of two that could drift. See `docs/plans/issue-11-plan.md`'s section 1
for the full design writeup.

- **Reuses the window path's own already-fetched `windowFetch.history`
  -- zero new Yahoo requests, zero new fetch pool.** `buildCustomWindowResults`
  is gated behind `windowFetch.failureReason` the exact same way
  `windowResults` itself is: if the window path has no usable history,
  there's nothing to slice for any anchor either.
- **`computeWindowOptimization` binary-searches each ticker's window
  boundaries instead of a linear `Array.prototype.filter` scan (code
  review finding, fixed)** -- `buildCustomWindowResults` calls it once
  per anchor (up to 252x per run), and a full O(days) re-scan of each
  ticker's entire multi-decade history on every single call was real,
  needless cost at that scale. Fixed via `lowerBoundByDate`/
  `upperBoundByDate` (`pipeline.ts`), which need a genuinely
  date-ascending-sorted array to be correct -- rather than trust
  `fetchDailyCloses`'s return order (documented elsewhere as "ascending
  in practice," not a guaranteed contract -- see
  `packages/core/CLAUDE.md`), `sortedHistory` explicitly sorts each
  ticker's series once and caches the result in a `WeakMap` keyed by the
  `history` Map's own object identity, so the O(tickers x days log days)
  sort cost is paid at most once per pipeline run regardless of how many
  times `computeWindowOptimization` is called against the same
  `windowFetch.history` reference. If a future caller ever passes a
  _fresh_ history Map per call (rather than the one shared reference
  `runPipeline` builds today), this cache buys nothing -- worth revisiting
  if that assumption ever changes.
- **`buildCustomWindowResults` de-dups its `anchors` input by
  `anchorMonth` before building any result (code review finding, fixed)**
  -- `customResultKey` is a pure function of `anchorMonth` alone, so two
  anchors sharing the same month would otherwise silently collide on the
  same S3 key with no error surfaced. Not reachable via the one real
  caller (`customRangeAnchors`, `packages/core`, which is tested to never
  produce a duplicate), but a caller-supplied `anchors` list (a test, or
  a future second caller) could in principle include one -- a repeat is
  now skipped with a `console.warn`, not silently computed-and-overwritten.
- **`RunPipelineOptions.customRangeAnchors` defaults to empty (`[]`), not
  `customRangeAnchors(asOf)` computed internally** -- deliberately unlike
  every other option this file defaults itself. `src/run.ts` (the real
  nightly entry point) is the one place that explicitly passes
  `customRangeAnchors(asOf)` (`packages/core`) to turn this on for the
  real deployed pipeline. This was a pragmatic call, not an oversight: it
  keeps every pre-existing test in `pipeline.test.ts` (which never passes
  this option) completely unaffected by this feature's introduction --
  retrofitting ~250 extra anchor-result assertions into every unrelated
  existing test would have been pure test-maintenance churn with zero
  correctness value. `pipeline.custom-range.test.ts` is a small, dedicated
  file (mirroring `pipeline.write-validation.test.ts`'s own precedent for
  a focused fixture set) covering the feature itself.
- **A custom-anchor write failure is held to the exact same "must fail
  the run" standard a preset range's write failure already gets, not the
  looser best-effort standard a granularity override's failure gets.**
  Both preset and custom-anchor results now flow through one combined
  `WriteJob` list / one bounded-concurrency write loop (`mapWithConcurrency`,
  see the "Write-time result self-validation" section above -- previously
  just `results.map(...)` over a single `Promise.allSettled`, before this
  same issue's own code review added the concurrency cap) -- a failure in
  either family aggregates into the same thrown error, this pipeline's
  only alerting mechanism. Reasoning:
  unlike a granularity override (a genuinely different, independently-
  fetched data source that gracefully degrades to already-correct
  60-minute bars on failure), a custom anchor is derived from the _same_
  already-required-to-succeed window-path history, so there's no lesser
  standard that makes sense for it. The final aggregated error message's
  denominator (`wrote N of M expected result(s)`) is the _ideal_ total
  for a fully-healthy run (`PRESET_RANGES.length` + every requested
  anchor), not just how many results were actually built and attempted --
  a real, deliberate choice (found while updating this file's own
  pre-existing tests that asserted on the old message text): using the
  smaller "actually attempted" denominator would understate the gap
  whenever a whole path failed before any of its results were even built
  (e.g. "wrote 2 of 2" reads as a clean 100%, hiding that a failed path
  meant only 2 were ever attempted out of an expected 5).
- **This is the answer to the cache/invalidation-gap an independent
  reviewer flagged on the original plan**: there is no separate
  "permanent cache" for custom-anchor results, and therefore no separate
  invalidation logic anywhere. Every one of the 252 anchors is recomputed
  from scratch every nightly run, exactly like the 5 preset ranges
  already are -- a bug fix or schema change to the optimizer fixes every
  stored anchor automatically on the next nightly run.
- **Live-verified, real numbers, no S3 write** (full 503-ticker universe,
  real Yahoo network calls, all 252 real anchors via a throwaway Vitest
  file, deleted before commit): full run (every fetch pool + solving all
  5 preset ranges + all 252 custom anchors) completed in **154.0s (~2.6
  minutes)**, 0 of 503 tickers skipped, 257 total result objects (5
  preset + 252 custom-anchor), **431.5KB** total across all 252
  custom-anchor result objects' serialized JSON -- comfortably inside the
  15-minute Lambda timeout (over 12 minutes of headroom) and negligible
  new S3 storage. See `docs/plans/issue-11-plan.md` section 1.6 for the
  full writeup; this run's total includes real network fetch time (not
  isolated from pure compute), so it's an upper bound on the
  custom-anchor compute addition specifically, not a clean marginal
  delta.
