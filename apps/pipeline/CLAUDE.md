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

- **Window path (5Y/MAX)**: unchanged from before #28 — one daily-close
  fetch from `earliestDate`, sliced per range, run through
  `optimizeTrades`. Writes a `WindowResult`.
- **Intraday path (1M/3M/1Y)**: one 60-minute-bar fetch from the 1Y
  start date (`presetRangeStartDate("1Y", asOf)` — reused rather than a
  second hand-maintained lookback constant; comfortably inside Yahoo's
  730-day retention), sliced per range, run through `optimizeIntradayDays`.
  Writes an `IntradayResult` (one entry per trading day found, see
  `packages/core/CLAUDE.md`).
- **The two paths fail independently**, not as a single all-or-nothing
  unit: a systemic abort (`BlockedError`/`UnexpectedResponseError`) or
  zero usable data on _one_ path refuses to write only _that path's_
  range keys — the other path's ranges still write normally if its own
  fetch succeeded. Only if _both_ paths end up with nothing does
  `runPipeline` throw and write nothing at all, generalizing the
  original single-path "refuse to overwrite good results with an empty
  run" guarantee. This was a deliberate design choice (see
  `docs/plans/issue-28-plan.md`), not an accident of the refactor — the
  two paths hit the same Yahoo endpoint but are otherwise unrelated, and
  there's no reason a daily-close-specific failure should also block
  1M/3M/1Y (or vice versa) if the other fetch is fine.
- `n` for the intraday path is `DEFAULT_MAX_TRADES_PER_DAY` in
  `pipeline.ts`, next to (but deliberately distinct from) the existing
  `DEFAULT_MAX_TRADES` — both currently 3, but "trades across the whole
  window" and "trades within one day" are different knobs that could
  reasonably diverge later.
- **Doubled Yahoo request volume risk (flagged during planning, not yet
  hit in practice)**: this issue doubles per-run request volume — the
  window and intraday fetches each hit the full ~503-ticker universe,
  running concurrently. `packages/core/CLAUDE.md` already documents this
  endpoint as unofficial and liable to start blocking without notice;
  no throttling/rate-limiting was added to mitigate this, just flagged
  as something to watch if blocking behavior is ever observed in a real
  run (see "Current deployment state" in `infra/CLAUDE.md` for how a
  real run's memory/timing has been tracked before — the same kind of
  real-run observation is worth doing here once this is deployed).
- `RESULTS_SCHEMA_VERSION` bumped to 2 for this issue (see
  `packages/core/src/results-schema.ts`) — a global version number
  across a discriminated union (`WindowResult` | `IntradayResult`), not
  a per-range version. Concretely: 5Y/MAX are behaviorally unchanged by
  #28, but their _stored JSON_ still changes shape (gains `model:
"window"` and `maxTrades`) purely because the version number is
  shared. This means a pipeline run that writes the new schema must
  happen (rewriting _all 5_ range keys) before or atomically with
  deploying the schema-2-only `apps/web` — otherwise every range,
  including the two untouched ones, 502s with `schema_mismatch` until
  the next nightly run. Real-AWS action, needs the user's go-ahead per
  this repo's standing working agreement — not yet performed as of this
  issue's implementation; see the PR for issue #28.
