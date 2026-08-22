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
  "comfortably needs more than the default"); worth reconsidering the
  `memorySize` in `infra/cdk/lib/hadiknowntrades-stack.ts` before the
  universe size or per-ticker history grows, rather than assuming
  there's a lot of headroom.
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
- **Doubled Yahoo request volume risk (flagged during planning, not yet
  hit in practice)**: this issue doubles per-run request volume -- the
  window and intraday fetches each hit the full ~503-ticker universe,
  running concurrently. `packages/core/CLAUDE.md` already documents this
  endpoint as unofficial and liable to start blocking without notice;
  no throttling/rate-limiting was added to mitigate this, just flagged
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

## 5-minute path: 3M's mixed granularity (issue #30)

A third fetch, run concurrently with the window and intraday fetches
via the same `fetchPathHistory`/`fetchUniverseHistory` machinery, but
scoped only to `FIVE_MINUTE_LOOKBACK_DAYS` (59) days back from `asOf` --
Yahoo's real retention for `interval=5m` is a hard 60-day wall (verified
live: 59 days back succeeds, 60 fails with a 422 that surfaces as
`UnexpectedResponseError`, _not_ `TickerNotFoundError` -- see
`packages/core/CLAUDE.md`'s "5-minute intraday bars" section for why
that distinction matters operationally). `buildIntradayResults` runs
`optimizeIntradayDays` a _second_ time over this 5-minute history
(separately from the existing 60-minute call), then merges the two
per-day arrays for 3M specifically: the 5-minute version of a day wins
wherever it exists, every other day in 3M's window falls back to the
60-minute version. 1M and 1Y are untouched -- they only ever read the
pure 60-minute day-result array.

- **Deliberately not held to the window/intraday split's "must still
  fail the run" standard** (see the section above): a 5-minute-path
  abort or empty-data outcome does not get added to the `if
(windowFetch.failureReason || intradayFetch.failureReason)` throw
  condition in `runPipeline` -- only reported in that error's message
  for visibility, alongside the two required paths' statuses. The
  reasoning is qualitatively different from why window/intraday _are_
  held to that standard: their failure means a whole range silently
  serves frozen/stale JSON forever, which is exactly what that
  alerting exists to catch. A 5-minute-path failure instead means 3M's
  recent days silently fall back to already-shipped, fully-correct
  (just coarser) 60-minute bars -- functionally identical to 3M's
  pre-#30 behavior, not a loss of previously-working data. Revisit this
  distinction if 5-minute-granularity 3M data ever becomes something
  the product actually depends on, rather than a bonus precision
  upgrade layered on top of an already-complete 60-minute result.
- `IntradayDayResult.barIntervalMinutes` (5 or 60) is stamped onto
  every day, for every range, not just 3M -- makes which granularity
  produced a given day's numbers visible in the JSON output itself
  rather than only inferable from the day's date relative to "now,"
  per the issue's own call-out that this isn't obvious otherwise. Not
  worth a `RESULTS_SCHEMA_VERSION` bump: it's a purely additive field
  on the already-versioned `IntradayDayResult` shape, and nothing in
  `apps/web` reads it yet (see that constant's own "bump when a reader
  needs to know" criterion).
- 3M's `skippedTickers` merges in tickers skipped by the 5-minute fetch
  specifically (1M/1Y's don't) -- a ticker that fails only the 5-minute
  fetch but succeeds the 60-minute one is still absent from 3M's recent
  (5-minute-sourced) days, since the merge swaps in the 5-minute day's
  _entire_ tickers-considered set wholesale, not a per-ticker splice
  within a day. Same reasoning for 3M's `universeSize`, which unions
  tickers across both the 60-minute and 5-minute histories rather than
  reading only one.
- Full design writeup, including the live-verified 60-day retention
  boundary and the out-of-retention error-classification gap this
  surfaced in `fetchChartSeries`, lives in
  `packages/core/CLAUDE.md`'s "5-minute intraday bars" and
  "Mixed-granularity 3M assembly" sections -- read those first before
  re-deriving any of this from scratch.
