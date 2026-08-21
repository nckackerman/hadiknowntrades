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
