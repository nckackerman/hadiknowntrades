# apps/pipeline — working notes

Nightly precompute job: fetch (via `packages/core`'s Yahoo client) ->
optimize (via `packages/core`'s optimizer) -> write results to S3, for
all 6 preset ranges. Read this before re-investigating something below —
if a fact here turns out to be stale, fix the fact here too, not just the
code.

- Fetches each ticker's **full** history once (from 1970, effectively
  "everything Yahoo has"), then slices that one fetch into the 6 preset
  windows locally — not 6x separate network fetches per ticker.
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

## Two independent paths since issue #28: window (5Y/MAX) vs. intraday (1W/1M/3M/1Y)

`runPipeline` fetches and computes two paths concurrently, sharing the
same generalized `fetchUniverseHistory` worker pool (now generic over
bar type, not daily-close-specific):

- **Window path (5Y/MAX)**: unchanged from before #28 -- one daily-close
  fetch from `earliestDate`, sliced per range, run through
  `optimizeTrades`. Writes a `WindowResult`.
- **Intraday path (1W/1M/3M/1Y)**: one 60-minute-bar fetch from the 1Y
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
  1W/1M/3M/1Y (or vice versa) if the other fetch is fine.
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
  per range (1W/1M/3M/1Y) afterward -- not re-run separately for each
  range. An earlier version did re-run it per range, which was a real,
  needless cost caught in code review: a given trading day's own result
  never depends on which range window it falls inside (range-slicing
  only ever drops whole out-of-range days, never bars within an
  in-range one), so re-solving the same day's DP up to 4 times (1W/1M/3M/1Y
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

### mergeDayVariants' assertion: real crash risk found (second review

### round), but the underlying proof turned out to be fixable, not wrong

A later review round found the paragraph above's proof had a real flaw,
with a concrete counterexample (`X.worstCase=50`, `Y.longShort.best=200`,
`Y.worstCase=65`, `Y.longShort.worst=60` -- every value individually
valid per each source's own _checked_ invariants, yet `60 > 50` trips the
"impossible by construction" throw) -- and, independently and more
urgently, that the throw itself had **no try/catch anywhere between
`mergeDayVariants` and `buildIntradayResults`**, unlike every other risky
computation this PR added (the per-range/per-day overflow containment
below already wraps its own risky calls). If this assertion ever fired on
real data, it would crash the _entire_ `runPipeline` invocation --
discarding every other already-computed window/custom-anchor/intraday
result too, not just the one affected day. Both findings were addressed,
but they resolved differently, and it's worth being precise about which
is which:

- **The crash risk was real and is fixed**: `mergeDayVariants` no longer
  throws. A violation now falls back to the long-only winner's own day
  wholesale for _both_ bundles (trivially safe -- a single day from one
  `optimizeAllVariants` call always satisfies both cross-checks
  internally, by construction) and reports it through
  `mergeDaysByGranularity`'s own return value, which `buildIntradayResults`
  folds into its `failures` -- fatal, reaching `computeFailures` and this
  system's only alerting mechanism, exactly like an override solve
  failure (see the section below) -- rather than a bare throw. Contained,
  but not silent: the same "contained but not silent" principle the
  overflow-containment fix below already established, now applied here
  too.
- **The counterexample itself does NOT reflect data the real optimizer
  can produce -- re-derived and empirically confirmed, not just
  re-asserted.** The counterexample's own numbers silently violate a
  _deeper_ structural invariant of the reciprocal-price short model that
  isn't explicitly checked anywhere in code but _is_ mathematically
  guaranteed for any real `optimizeAllVariants` output: for a single
  source's own longShort search, flipping every leg of its best sequence
  (long <-> short, same slots) is always a valid candidate for that same
  source's own _worst_ search (both use `includeShorts: true`), so
  `longShort.worst * longShort.best <= startingCapital^2` always holds.
  The counterexample's `Y.longShort.worst=60` and `Y.longShort.best=200`
  give a product of 12,000 -- way past `startingCapital^2 = 400` at this
  app's real `$20` starting capital -- so those two numbers together
  could never come out of a real optimizer call in the first place, only
  out of hand-picked test values that individually pass the _shallower_
  checked invariant (`longShort.worst <= worst`) while silently breaking
  this unchecked deeper one.
- **The original proof's stated _conclusion_ for this exact inequality
  was correct; its stated _derivation_ had a real, independent algebra
  error, since fixed.** The original text said "flipping `Y`'s own
  longShort-_worst_ sequence is a valid candidate for `Y`'s own
  longShort-_best_ search, giving `Y.longShort.worst <=
startingCapital^2 / Y.longShort.best`" -- but flipping a sequence into
  a _max_ search only ever yields a _lower_ bound on that search's
  result (a max can't be beaten by one specific candidate), so that
  pairing actually derives `Y.longShort.worst >= startingCapital^2 /
Y.longShort.best` -- the opposite direction from both the text's own
  stated conclusion and from what the overall proof needs. The fix pairs
  each flip with the search it actually bounds: flipping `X`'s long-only
  _worst_ sequence into `X`'s own longShort-_best_ search (a max search)
  gives a lower bound, `X.worst >= startingCapital^2 / X.longShort.best`;
  flipping `Y`'s longShort-_best_ sequence into `Y`'s own longShort-
  _worst_ search (a min search) gives an upper bound,
  `Y.longShort.worst <= startingCapital^2 / Y.longShort.best`. Chaining
  those two facts with `Y.longShort.best > X.longShort.best` (true
  whenever `Y` wins the longShort slot) proves
  `Y.longShort.worst <= X.worst` unconditionally -- see `mergeDayVariants`'s
  own doc comment in `pipeline.ts` for the full corrected chain.
- **Verified two ways, not just re-derived on paper**: (1) the corrected
  hand proof above, and (2) a throwaway 20,000-trial randomized
  brute-force check directly against the real `optimizeAllVariants`
  (varied ticker counts, trade counts 1-3, and price ranges down to
  `0.0001` specifically to stress the reciprocal-price short's near-zero
  overflow regime) -- **0 violations**, with 2,087 of those trials
  genuinely exercising the `X !== Y` disagreeing-winners case (one source
  wins long-only, the other wins longShort) the proof depends on, not
  just the trivial `X === Y` same-source case. Script deleted before
  commit, same technique this file's other "live-verified, no S3 write"
  entries use.
- **Net effect**: the containment fix (no more bare throw) is real,
  necessary, and applies regardless of whether the proof is fixable --
  "provably safe" is still worth containing rather than trusted blindly
  at runtime, especially given this exact proof was already wrong once
  (its derivation, not its conclusion). But the fallback path itself is
  expected to be **dead code on every real run**, the same
  "defense-in-depth for something that shouldn't be reachable" posture as
  `results-schema.ts`'s own write-time cross-checks. `pipeline.merge-
fallback.test.ts` exercises it anyway, via a mocked `optimizeIntradayDays`
  injecting the same style of counterexample values directly (the only
  way to reach this path at all, since real optimizer output can't) --
  confirming the fallback produces a valid, safe result and the run still
  fails loudly via `computeFailures`, instead of trusting the containment
  logic never gets exercised by any test.

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
to catch. See `pipeline.test.ts`'s "per-range/per-day compute-failure
containment" describe block for fixtures covering both the window-path
and intraday-base-path cases (each uses a same-ticker pair with one
price at `Number.MIN_VALUE` to trigger a real overflow, not a mocked
throw).

**A third code-review round found the original "one deliberate
asymmetry" here (an _override_ granularity's per-day solve failures were
logged but NOT folded into the fatal `failures` list, unlike the _base_
60-minute pass's) was itself a real, if narrower, instance of the same
bug class -- "contained but not silent" had quietly slipped into
"contained, and therefore silent."** The original reasoning leaned on an
analogy to override _fetch_ failures (a per-ticker data-availability
gap): since `mergeDaysByGranularity` already falls back to the base
60-minute day for any date an override doesn't cover, an override-only
day failure was treated as "gracefully degrading," the same as a fetch
failure. **That analogy doesn't actually hold once you separate two
different questions -- "does this range's stored _output_ degrade
gracefully" (yes, for both fetch and solve failures, via the same merge
fallback) from "does this failure deserve this system's only alerting
mechanism" (no for a fetch failure, yes for a solve failure).** A fetch
failure means the finer-grained data was never available -- there is
nothing to alert on, the range's data is exactly as correct as its
pre-override self. A solve failure means the data _was_ fetched
successfully and something broke while `optimizeIntradayDays` computed
over it -- e.g. the documented short-payoff overflow, but just as
plausibly a genuinely new defect this codebase hasn't seen yet. Silently
downgrading the latter to "non-fatal, logged only via console.error
buried in CloudWatch" because its _symptom_ happens to be paperable-over
is exactly what this system's "no custom retry/alerting" design (see the
top of this file) exists to prevent -- see the guarantee's own framing
elsewhere in this file: "nothing beyond a console.warn buried in
CloudWatch to notice." **Fixed**: `buildIntradayResults` now folds
_every_ override's own `skippedDays` (prefixed `"<label> override
(<range>): "` for context) into its `failures` return value alongside
the base pass's, so a solve failure on either pass reaches
`computeFailures` and fails the run the same way -- while the per-day
try/catch inside `optimizeIntradayDays` still _contains_ it (that
override's other days, and every other range/path, still compute and
write normally). Containment and fatality are independent axes, not the
same lever: this fix keeps the former (one bad day still can't crash the
whole run before other results get a chance to write) while restoring
the latter for a case where it genuinely belongs. The override
_fetch_-failure posture (`GranularityOverrideInput.outcome.failureReason`,
surfaced only via `overrideStatusLines` for visibility) is unchanged and
correctly still non-fatal -- that distinction was never the bug; only
the solve-failure side had been folded into the same non-fatal bucket by
mistake. See `pipeline.override-solve-failure.test.ts` for a regression
test (kept in its own file, like `pipeline.write-validation.test.ts`,
since it needs to mock `optimizeIntradayDays` for just the override
call) using a genuinely _non-overflow_ forced failure specifically to
prove the fix isn't narrowed to the overflow case -- and
`intraday-optimizer.test.ts`'s own "reports a genuinely different
(non-overflow) exception the same way" test, which locks in that
`optimizeIntradayDays`'s own `catch` block was never actually the bug
(it already unconditionally folded every exception into `skippedDays`
regardless of type) -- the gap was entirely in how `buildIntradayResults`
consumed an override call's returned `skippedDays`, one level up.

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
  `writeJobs` concatenates `presetWriteJobs` (6 preset ranges) and
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
  `mapWithConcurrency` (this file) and `fetchUniverseHistory` both build
  on one shared `runWorkerPool(itemCount, concurrency, perItem)` helper
  (this file) -- **not two independent copies of the "N workers pulling
  the next index off a shared cursor" loop that merely look alike, which
  is what an earlier fix round actually produced despite claiming to
  "mirror" the shape (a real, code-review-caught gap, second round --
  asking for one function to "mirror" another's shape is not the same
  instruction as asking it to reuse that shape, and got interpreted as
  the weaker one).** `runWorkerPool` doesn't know about tickers, S3, or
  abort classification at all -- it just calls `perItem(index)` per
  claimed index and stops dispatching new work once some call returns
  `true`. `fetchUniverseHistory` uses that `true` return for its
  BlockedError/UnexpectedResponseError abort signal;
  `mapWithConcurrency` never returns `true` (every job always gets a
  chance to run) and instead uses `runWorkerPool` purely for the
  concurrency cap, turning each outcome into a `PromiseSettledResult<R>`
  itself. The two callers still return genuinely different shapes
  (`{ history, skipped, abortError }` vs. `PromiseSettledResult<R>[]`,
  in original item order) since their semantics differ (abort-on-
  systemic-failure vs. "run every job to completion regardless") -- only
  the worker-pool mechanics underneath are now actually shared, not just
  described as such. `writeConcurrency` defaults to the same value as
  `fetchConcurrency` but is its own `RunPipelineOptions` field --
  deliberately not reusing `fetchConcurrency` directly, since Yahoo's
  own request-volume tolerance and S3's are independent concerns that
  could reasonably need different caps later even though they happen to
  agree today.
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

## Granularity overrides: 3M's 5-minute and 1M's (and, since issue #60, 1W's) 1-minute bars (issues #30, #29, #60)

A **granularity override** upgrades one or more ranges' days to a finer
bar granularity than the base 60-minute fetch, on a best-effort basis --
issue #30 added the first one (5-minute bars, upgrading 3M's most
recent days), issue #29 added the second (1-minute bars, upgrading 1M).
Both are driven by one generic mechanism in `pipeline.ts`, not two
parallel implementations:

- **`buildGranularityOverrideSpecs(options, asOf)` builds the single
  list every other piece of this mechanism iterates over** -- one
  `GranularityOverrideSpec` per override (`ranges`, `label`,
  `barIntervalMinutes`, its own retention-bounded `from`, and the
  underlying `fetchBars` function). **`ranges` is a `readonly
PresetRange[]`, not a single `PresetRange`** (generalized for issue #60,
  see its own bullet below) -- every range in the list shares that one
  spec's fetch/solve/merge output verbatim, not one output per range.
  `runPipeline` fetches every spec's history via one inner `Promise.all`
  (still fully concurrent with the window/intraday fetches and with each
  other, just gathered as an array instead of separate named bindings);
  `buildIntradayResults` loops over the resulting `{ spec, outcome }`
  pairs to solve (`optimizeIntradayDays` with that spec's
  `barIntervalMinutes`) and merge (`mergeDaysByGranularity` against the
  base 60-minute days) each one **once**, then registers that one
  already-computed `GranularityOverride` object under every range in
  `spec.ranges` in the `granularityOverrides: Map<PresetRange,
GranularityOverride>` lookup that `buildIntradayResults`'s final
  per-range loop reads from (`range === "3M"`/`range === "1M"`/
  `range === "1W"` never appear as branches anywhere in this file); and
  the final "at least one path failed" error message loops over the same
  pairs to append one status line per override (`spec.ranges.join("/")`
  in the label, e.g. "1-minute path (1M/1W only, non-fatal): ok."),
  purely for operational visibility.
  **Adding a third genuinely new granularity means adding one entry to
  the list `buildGranularityOverrideSpecs` returns (plus one new
  `fetch*Bars` field on `RunPipelineOptions`, wired up in `src/run.ts`)
  -- nothing else in this file changes. Adding a range that reuses an
  _existing_ override's already-fetched data (as 1W does for 1M's
  1-minute fetch) means appending that range to an existing spec's
  `ranges` array instead -- no new spec, no new fetch function.**
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
- **An override's own _fetch_ failure (abort or empty-data outcome) is
  NOT held to the window/intraday split's "must still fail the run"
  standard** (see the section above): it does not get added to the `if
(windowFetch.failureReason || intradayFetch.failureReason)` throw
  condition in `runPipeline` -- each override's fetch status is only
  reported in that error's message for visibility, alongside the two
  required paths' statuses. **This is deliberately narrower than it used
  to read**: an earlier version of this bullet said "neither override is
  held to that standard" at all, covering an override's own _solve_
  failures too (`optimizeIntradayDays` throwing while solving data the
  override's fetch _did_ return) -- a third code-review round on issue
  #13's PR found that was itself a real gap, not a deliberate design
  choice that happened to also cover solve failures: see "Per-range/
  per-day optimizer-overflow containment" (under "Code review follow-up:
  issue #13 short-selling PR") above for the full reasoning and the fix
  (override solve failures now DO fold into `computeFailures` and fail
  the run, exactly like a base-pass solve failure). The reasoning below
  is about fetch failures specifically. The reasoning is qualitatively
  different from why
  window/intraday _are_ held to that standard: their failure means a
  whole range silently serves frozen/stale JSON forever, which is
  exactly what that alerting exists to catch. An override's _fetch_
  failure instead means its range's affected days silently fall back to
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

### 1W reuses 1M's 1-minute override wholesale (issue #60)

1W (the 6th preset range, past 7 days -- see
`docs/plans/issue-60-plan.md`) needs **no new fetch, no new
`GranularityOverrideSpec`, and no new solve/merge pass**: its own
7-day window sits comfortably inside the 1-minute override's ~29-day
lookback (`ONE_MINUTE_LOOKBACK_DAYS`), so `buildGranularityOverrideSpecs`
just lists `ranges: ["1M", "1W"]` on that one existing spec instead of
`range: "1M"`. `buildIntradayResults`' override loop still runs that
spec's `optimizeIntradayDays`/`mergeDaysByGranularity` pass **exactly
once**, then registers the identical resulting `GranularityOverride`
object under both `"1M"` and `"1W"` in the `granularityOverrides` map --
the final per-range slicing loop needed zero changes, since it already
does a generic `granularityOverrides.get(range)` per range and now just
finds a real entry for `"1W"` the same way it always has for `"1M"`.

- **Why this is safe, not just convenient**: `mergeDaysByGranularity`'s
  `mergedDays` array spans the _full_ base 60-minute fetch's range (see
  "Mixed-granularity 1M/3M assembly" in `packages/core/CLAUDE.md` for
  why -- every day is sourced from `primaryDays` first, then overlaid by
  the override wherever it reaches), not truncated to the override's own
  ~29-day lookback. 1W's own per-range date filter narrows that already-
  full shared array down to its own 7-day window, and every day in that
  window is guaranteed to already be present -- sourced from the base
  60-minute pass at minimum, upgraded to 1-minute wherever the override's
  lookback reaches, which fully covers 1W's 7-day window in every case
  (7 < 29). The same reasoning covers `extraHistories`/`extraSkipped`/
  `extraDataAsOf`: they're the _same_ 1-minute fetch outcome's data,
  and every consumer (`universeSize`, `skippedTickers`, `dataAsOf`)
  already scopes itself to each range's own `startDateString`/
  `endDateString` window when reading them.
- **Live-verified, no S3 write** (a throwaway Vitest fixture with bars 3
  days back -- inside 1W's window -- and 20 days back -- inside 1M's
  window but outside 1W's -- run, then deleted before commit): the
  1-minute fetch mock was called **exactly once** for the whole run
  (confirms no second fetch call for 1W), `results/1W.json` had exactly
  one day (confirms the shared override data is correctly narrowed to
  1W's own window, with no leakage of 1M's older days), and that day's
  `barIntervalMinutes` was `1` with the 1-minute fixture's price (not
  the coarser 60-minute fixture's) -- confirms 1W actually gets the
  upgraded granularity, not a silent fallback. See
  `pipeline.test.ts`'s "1-week path (1W, issue #60)" describe block for
  the equivalent permanent regression coverage.
- Three `spec.range` (singular) usages -- the two `overrideSolveFailures.push`
  call sites and the final `overrideStatusLines` message -- became
  `spec.ranges.join("/")` as a mechanical consequence of the field
  generalizing to a list; the actual computed data is unaffected. The
  two hardcoded "Intraday (1M/3M/1Y) path" status-message strings
  elsewhere in `pipeline.ts` (the "both paths empty" abort message and
  the final aggregated failure message) were updated to "Intraday
  (1W/1M/3M/1Y) path" for the same reason.

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
one windowed-slice-plus-DP implementation instead of two that could
drift. **Post-merge with issue #13 (short-selling mode)**:
`computeWindowOptimization` calls `optimizeAllVariants`, not the
long-only-only `optimizeBothDirections` this section originally described
-- see "Merged with issue #13's short-selling mode" below for the full
integration story. See `docs/plans/issue-11-plan.md`'s section 1 for the
full design writeup (predates that merge; its own `optimizeBothDirections`
references are historical, not current).

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
  - **That denominator also subtracts anchors `buildCustomWindowResults`
    itself validly skips (duplicate, malformed, or future-dated -- see
    its own loop), not just anchors lost to a whole failed path (second-
    round code review finding, fixed).** Before this, `expectedResultCount`
    used the raw `options.customRangeAnchors.length` unconditionally, so
    a caller-supplied anchor list containing e.g. a duplicate would count
    it toward the "expected" total even though `buildCustomWindowResults`
    never intended to write a result for it -- overstating the real gap
    in the "wrote N of M" ratio for any future caller whose anchor list
    isn't as clean as `customRangeAnchors`'s own (which never produces a
    duplicate/malformed/future-dated entry today, per that function's own
    tests -- so this is a no-op for the one real production caller,
    purely a correctness fix for a less-clean future or test caller).
    `buildCustomWindowResults` now returns `{ results, validlySkippedCount }`
    instead of a bare array; `runPipeline` subtracts that count from
    `expectedResultCount`. The future-dated-anchor skip branch also
    gained a `console.warn` here, matching its two sibling skip branches
    (duplicate, malformed), which both already logged -- it used to be
    the only one of the three that skipped silently.
- **This is the answer to the cache/invalidation-gap an independent
  reviewer flagged on the original plan**: there is no separate
  "permanent cache" for custom-anchor results, and therefore no separate
  invalidation logic anywhere. Every one of the 252 anchors is recomputed
  from scratch every nightly run, exactly like the 6 preset ranges
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

### Day-granularity extension (issue #75, plan-only as of 2026-08-23) does NOT fit the Lambda timeout at the naive 21-year scope

**Don't re-run this benchmark before reading `docs/plans/issue-75-plan.md`
section 2 -- it took 67 real minutes the one time it ran.** Live-verified
(real Yahoo network calls, full 503-ticker universe, all 5,282 real
trading-day anchors within the existing 21-year lookback, via a throwaway
Vitest file, deleted before commit, same technique as the 252-anchor
verification above): extending `customRangeAnchors` from month to
trading-day granularity **at the same 21-year lookback** takes **4,042.7s
(67.4 minutes)** of real fetch+compute (11.2s fetch, 4,031.5s compute,
no S3 write measured) -- **about 4.5x over** the pipeline Lambda's real
900s timeout, from compute alone. This is **compute-bound, not
I/O-/write-bound**: per-anchor compute cost is drastically front-loaded
by window length (>30x spread between the oldest anchors, each costing
~1.5s, and the newest, each costing ~0.05s) -- consistent with
`optimizer.ts`'s documented O(days x tickers x maxTrades) complexity,
since each anchor's window runs from that anchor's date to "today." Peak
RSS was 1,779MB, reached early (among the oldest/most expensive anchors)
-- against the pipeline Lambda's 2048MB `memorySize` (itself not yet
deployed, see `infra/CLAUDE.md`'s "Current deployment state") that's only
~13% headroom, a second, independent reason the full 21-year scope is the
wrong target even before the timeout is considered.

**The fix is not more write concurrency or a multi-invocation split** --
write time is estimated (not directly measured) at roughly 106-159s even
pessimistically, two orders of magnitude below the compute cost, so it
isn't the bottleneck; a split doesn't remove the compute cost, only
redistributes it, and adds real orchestration complexity. **The real
numbers point at shrinking the lookback window alone**: 7-8 years of
day-granularity anchors (not 21) keeps compute to 463-607s, comfortably
inside the 900s budget with real margin. See
`docs/plans/issue-75-plan.md` sections 2.2-2.5 for the full per-checkpoint
data this is derived from (not just the summary above) before relying on
this for a real implementation decision -- **the exact depth (7 vs. 8
years) was deliberately left as an open product question for the user's
sign-off, not decided in that plan.** As of this note, issue #75 is
plan-only -- none of this has been implemented; `customRangeAnchors`
still generates 252 month anchors over 21 years, unchanged.

### Merged with issue #13's short-selling mode

Issues #11 and #13 were developed in parallel and merged after both had
independently landed -- `buildCustomWindowResults` originally called the
long-only-only `optimizeBothDirections` (predating issue #13), and
`buildWindowResults` (on issue #13's own branch) called
`optimizeAllVariants` directly rather than through this file's shared
`computeWindowOptimization` helper (which didn't exist yet on that
branch -- issue #13 was built before issue #11's refactor landed).
Integrated at merge time:

- **`computeWindowOptimization` now calls `optimizeAllVariants`**,
  returning `{ windowed, longOnly, longShort }` instead of `{ windowed,
best, worst }` -- both `buildWindowResults` and `buildCustomWindowResults`
  updated to read the new shape and populate their own result's
  `longShort` field from it. Every whole-window result -- preset range or
  custom anchor -- now gets computed off the same one shared
  `OptimizerState` per window, all 4 direction x instrument-set
  combinations at once.
- **`buildCustomWindowResults` gained the same per-anchor try/catch
  containment `buildWindowResults` already has** (see "Code review
  follow-up: issue #13 short-selling PR" above) -- a real, new gap this
  merge surfaced: once a custom anchor's window is solved via
  `optimizeAllVariants`, it's exposed to the same short-payoff-overflow
  risk documented there, and with up to ~252 anchors per run, one
  anchor's overflow could otherwise abort every other already-computable
  anchor. `CustomWindowResultsBuild` gained a `failures: string[]` field
  (mirroring `BuildWindowResultsOutcome.failures`), folded by
  `runPipeline` into the same `computeFailures` list that already
  fails the run for a window/intraday compute failure.
- `results-schema.ts`'s `CustomWindowResult` gained the same
  `longShort: LongShortResult` sibling field `WindowResult` already had,
  and `validateCustomWindowResult` gained the same long+short
  cross-checks -- see `packages/core/CLAUDE.md`'s own "Merged with issue
  #13's short-selling mode" section for the schema/validator side of this
  integration.
- **Live-verified via a regression test, not just typechecked**:
  `pipeline.custom-range.test.ts`'s "computes a real longShort field with
  a genuine short trade for a custom anchor" test uses a two-bar,
  pure-price-decline fixture (no long trade can be profitable) to confirm
  the long-only search correctly makes zero trades while the long+short
  search finds and reports a real short trade with a materially higher
  `endingBalance` -- round-tripped through the actual written+parsed S3
  JSON, confirming `validateCustomWindowResult`'s own longShort
  cross-checks pass at write time, not just an in-memory shape.
