# Plan: issue #11 - arbitrary date-range picker

Status: **implemented** (this branch, `feat/11-arbitrary-date-range`).
Originally written as a plan-only document against `main` at `2d2e48f`
(post-#57, buy-and-hold benchmark) recommending live compute + a
permanent result cache (section 7.1's "Option A"). **The human user
instead chose the plan's own cheaper alternative, Option B: a coarsened
precompute matrix** -- month-granularity start date, end pinned to
"today," served from an expanded but bounded set of nightly-precomputed
anchor results, no new infrastructure, no dependency on the still-
placeholder web Lambda. Section 1 below is the primary, as-implemented
design for that choice, worked out to the same level of rigor the
original live-compute recommendation got. The original live-compute
research (under "## 2. Deferred..." below, at its own original internal
section numbers `## 0.` through `## 9.`, deliberately not renumbered --
see that section's own intro note for why) is kept in full as
documented-but-deferred research for a future round, not deleted, along
with one correction to its own numbers found during independent review.

## 1. Implemented design: coarsened precompute (Option B)

### 1.1 Anchor scheme

**Month-anchored start, end pinned to `asOf` ("today"), going back
`CUSTOM_RANGE_ANCHOR_YEARS_BACK` = 21 years** -- the same Scheme A the
original plan's section 3.2 worked out the real numbers for, adopted
here as the actual implementation rather than left as one of three
sketched options. Concretely (`packages/core/src/custom-range-
anchors.ts`):

- `customRangeAnchors(asOf)` returns 21 x 12 = **252 anchor points**, the
  1st of every calendar month from the current (possibly partial) month
  back 21 years, newest first -- a plain `YYYY-MM` string (`AnchorMonth`)
  identifies each one, e.g. `"2019-03"`.
- **21 years chosen to match the depth already used to benchmark the
  optimizer's own "Max" range** (`packages/core/CLAUDE.md`'s "Optimizer
  algorithm" section, ~330ms for a 21-year window) -- not MAX's own true,
  unbounded, ticker-inception-dependent reach (some individual S&P 500
  constituents' real Yahoo history goes back further than 21 years), just
  a concretely cost-modeled depth this feature's nightly compute/storage
  budget is sized against. Bumping this constant later is a one-line
  change -- every consumer (pipeline, API, UI picker) derives its own
  bounds from it, nothing hardcodes 252 or 21 a second time.
- **No missing/holiday-date snapping logic was needed**, unlike the
  live-compute design's section 2 (below) spent real design effort
  working out: each anchor's start is always a _calendar_ month
  boundary, and the exact same slicing filter every preset range's own
  `startDate` already goes through (`p.date >= startDateString`,
  `apps/pipeline/src/pipeline.ts`'s `computeWindowOptimization`) already
  forward-snaps to the nearest real trading day on or after it -- with no
  new code. The end date is always "today," handled identically to how
  every preset range already handles it (`dataAsOf` vs. `endDate`).
  `CustomWindowResult.startDate` stores the anchor's own literal calendar
  boundary (e.g. `"2019-03-01"`), not the snapped date -- the exact same
  convention `WindowResult.startDate` already follows for presets; the
  snap is only ever visible in the resulting `trades`/`benchmark` data,
  never a separate field. Live-verified end to end, not just reasoned
  about -- see section 1.6.

### 1.2 Nightly cost: real numbers, not re-estimated

Real, live-measured numbers from this implementation (not re-derived
from the original plan's synthetic benchmarks) -- see section 1.6 for
methodology:

- **A full real run** (full 503-ticker universe, real Yahoo network
  calls, all 4 concurrent fetch pools -- window/intraday/5-minute/
  1-minute -- plus the SPY benchmark fetch, plus solving all 5 preset
  ranges and all 252 custom anchors) **completed in 154.0s (~2.6
  minutes)** -- see section 1.6 for the exact run. Comfortably inside the
  pipeline Lambda's 15-minute timeout and current 2048MB memory
  allocation (`infra/CLAUDE.md`'s "Current deployment state") -- no infra
  change needed for this feature. This figure includes real network fetch
  time (which dominates and isn't isolated from pure compute time in this
  measurement), so it's an upper bound on the custom-anchor compute
  addition specifically, not a clean marginal delta -- but it's the
  number that actually matters for "does this fit in the Lambda timeout,"
  which it does with over 12 minutes of headroom to spare.
- **New S3 storage: 431.5KB total across all 252 custom-anchor result
  objects** -- even smaller than the original plan's own ~750KB-1MB
  estimate (section 3.2 below), a rounding error against the $20/month
  budget.
- **Zero new Yahoo requests**: every custom-anchor result is computed
  from the window path's own already-fetched `windowFetch.history`
  (`apps/pipeline/src/pipeline.ts`'s `buildCustomWindowResults`), the
  same daily-close history the 5Y/MAX ranges already require. This is
  the single biggest reason this feature is cheap: it's pure additional
  compute over data already resident in memory, not a new I/O path.

### 1.3 Schema: `CustomWindowResult`, a sibling of `PrecomputedResult`

`packages/core/src/results-schema.ts` adds `CustomWindowResult` --
structurally the same whole-window model as `WindowResult` (same
optimizer, same `startingCapital`/`endingBalance`/`trades`/`worstCase`/
`benchmark` shape), keyed by `anchorMonth: AnchorMonth` instead of
`range: PresetRange`.

- **Deliberately a type separate from `PrecomputedResult`, not a third
  union member** -- `PresetRange` is a closed, exhaustively-iterated
  5-member union throughout this codebase (`PRESET_RANGES` itself,
  `WINDOW_RANGES`/`INTRADAY_RANGES`, `isCanonicalRange`/`parseRange`).
  Folding a 252-member anchor set into that same `range` field would mean
  loosening `PresetRange` everywhere it appears, not just here.
- **Still gated by the same `RESULTS_SCHEMA_VERSION`** as every
  `PrecomputedResult` -- a deliberate difference from the deferred
  live-compute design's own judgment call (section 5.3 below), whose
  reasoning ("no separate writer to drift from the reader") doesn't apply
  here: a `CustomWindowResult` _is_ written by a separate process
  (`apps/pipeline`, nightly) from the one that reads it (`apps/web`'s API
  route) -- the exact writer/reader-drift risk `RESULTS_SCHEMA_VERSION`
  exists to catch for every other result, so it reuses that same
  protection rather than inventing a parallel one.
- `customResultKey(anchorMonth)` -> `results/custom/{anchorMonth}.json`,
  namespaced under its own prefix (not flat alongside the 5 preset keys)
  so the two families are trivially distinguishable by key prefix alone.
- `validateCustomWindowResult` mirrors `validatePrecomputedResult`'s own
  write-time self-validation (issue #47) -- same hand-rolled, "check
  every field, report every problem" discipline, reusing every one of
  the same private field-level validators (`isPositiveFiniteNumber`,
  `validateTrade`, `validateWorstCaseResultWith`, `validateBenchmark`)
  so the two validators can't drift on what counts as e.g. a valid
  `Trade`.

### 1.4 Pipeline: every anchor recomputed fresh, every nightly run

`apps/pipeline/src/pipeline.ts`'s `buildCustomWindowResults` computes one
`CustomWindowResult` per requested anchor, reusing
`computeWindowOptimization` -- a helper factored out of the pre-existing
`buildWindowResults` specifically so the 5Y/MAX preset path and the
custom-anchor path share one windowed-slice-plus-`optimizeBothDirections`
implementation, not two copies that could drift.

- **This is the answer to the cache/invalidation-gap finding an
  independent reviewer raised on the original plan**: there is no
  separate "permanent cache" for custom-anchor results at all, and
  therefore no separate invalidation logic to build or forget. Every one
  of the 252 anchors is recomputed from scratch on every nightly run,
  exactly like the 5 preset ranges already are -- a bug fix or schema
  change to the optimizer fixes every stored anchor automatically on the
  next nightly run, with zero bespoke cache-busting code anywhere. This
  was only viable _because_ the coarsened design's anchors are cheap,
  bounded, pipeline-computed values (section 1.2) -- the exact opposite
  of the live-compute design's arbitrary-any-date cache (section 8
  below), whose permanent-cache complexity was specific to that
  approach and doesn't apply here.
- **Defaults to zero custom anchors unless the caller opts in**
  (`RunPipelineOptions.customRangeAnchors`, default `[]`) -- deliberately
  _not_ wired to always run inside `runPipeline` itself, unlike every
  other option this file defaults internally. `src/run.ts` (the real
  nightly entry point) is the one place that explicitly passes
  `customRangeAnchors(asOf)` to turn this on for the real deployed
  pipeline. This was a pragmatic call to avoid retrofitting ~250 extra
  anchor-result assertions into every pre-existing preset-range test in
  `pipeline.test.ts` that has nothing to do with this feature -- a
  dedicated `pipeline.custom-range.test.ts` covers the feature itself
  with a small, focused fixture set instead.
- **A custom-anchor write failure is held to the same "must fail the
  run" standard as a preset range's**, not the looser best-effort
  standard a granularity override's failure gets -- both preset and
  custom-anchor results are validated and written through one combined
  `Promise.allSettled` write loop, and a failure in either family
  aggregates into the same thrown error (this pipeline's only alerting
  mechanism). Reasoning: unlike a granularity override (a genuinely
  different, independently-fetched data source that gracefully degrades
  to already-correct 60-minute bars on failure), a custom anchor is
  derived from the _same_ already-required-to-succeed window-path
  history -- there's no lesser standard that makes sense for it.

### 1.5 Web: API route and UI picker

- **`GET /api/results?anchor=YYYY-MM`** is the same route as
  `GET /api/results?range=...`, branching on which query param is
  present (`apps/web/src/app/api/results/route.ts`) -- not a second route
  file. This differs from the deferred live-compute design's own section
  5.2, which recommended a genuinely separate route because live compute
  and a precomputed S3 read have different backing logic, cache
  semantics, and error vocabularies. None of that applies once the
  custom-anchor path is _also_ just a precomputed S3 read: same
  `getResultsResponse`-style logic (`getCustomResultsResponse`, a sibling
  function reusing the exact same error-response shape and
  `Cache-Control` header), same reader, same route.
- **Anchor validation is shape-only, not bounds-checked against a
  live-computed "currently valid" list** -- `parseAnchorMonth` rejects a
  malformed string (400 `invalid_anchor`) but does not separately check
  whether the anchor falls inside `customRangeAnchors(asOf)`'s current
  252-month window. A syntactically well-formed but never-computed anchor
  (out of range, or simply not published yet) falls through to the
  ordinary `not_found` 404 instead, exactly like any preset range not yet
  computed on a first-ever pipeline run. This sidesteps a real clock-skew
  edge case: the web server's own "now" and the pipeline's last-run "now"
  can disagree by up to one anchor right around a month boundary, and
  re-validating against a live-computed bound here would risk rejecting a
  genuinely still-published anchor.
- **`CustomRangeSelector.tsx`** is a plain `<select>` next to
  `RangeSelector` -- same reasoning `DaySelector` already established
  (`apps/web/CLAUDE.md`'s "Two result models" section): up to 252 options
  is far too many for a row of pill buttons. A disabled placeholder
  option ("Choose a start month...") makes "you can only pick from this
  fixed list, not any date" discoverable by opening the dropdown, rather
  than a silent limitation a user would otherwise only discover after
  picking something that 404s -- directly satisfying this task's own
  instruction that the constraint be discoverable, not silent. A native
  `<input type="date">` was deliberately not used for exactly this
  reason: it would invite picking a day the pipeline never actually
  computed a result for.
- **Range mode and custom-anchor mode are mutually exclusive URL state**
  (`?range=` xor `?anchor=`, `ResultsPage.tsx`) -- selecting one clears
  the other, mirroring how `?day=` is already cleared on a range switch.
  `useResults(range)` and the new `useCustomResults(anchor)` both accept
  `null` and idle without fetching when their own mode isn't active, so
  exactly one network request is in flight at a time, never both.
- **`ResultsPanel.tsx` gained a third render branch** (`"custom-window"`,
  alongside the existing `"window"`/`"intraday-daily"`), sharing a new
  extracted `WindowResultBody` component with the `"window"` branch --
  the two models are the identical underlying computation (just keyed
  differently), so the JSX renders through one shared component rather
  than two copies that could drift on wording/layout over time.

### 1.6 Live verification (real Yahoo data, no S3 write)

A real pipeline run against the full 503-ticker S&P 500 universe, real
Yahoo network calls, `customRangeAnchors(new Date())` (252 real anchors),
an in-memory store (no real S3 write) -- same "verify live at least once
per feature" standard every prior plan in this repo has followed, and the
same no-S3-write technique issue #31's own live verification used
(`packages/core/CLAUDE.md`'s "Worst-case search" section). Run via a
throwaway Vitest file (`apps/pipeline/src/live-verify-custom-range.temp.test.ts`,
deleted before this PR's final commit -- same convention this plan's own
section 4 documents).

Real results:

- **Total elapsed: 153,986ms (154.0s / ~2.6 minutes)** for the entire
  run -- every fetch pool (window, intraday, 5-minute, 1-minute, SPY
  benchmark) plus solving all 5 preset ranges and all 252 custom anchors.
- **0 of 503 tickers skipped.**
- **5 preset results + 252 custom-anchor results = 257 total result
  objects** that would have been written to S3.
- **431.5KB total** across all 252 custom-anchor result objects'
  serialized JSON.

Confirms section 1.2's cost estimate was, if anything, conservative --
comfortably inside the 15-minute Lambda timeout with substantial margin,
and S3 storage growth is negligible.

## 2. Deferred: original live-compute research (not implemented)

Everything below this point is the **original plan-only research**
written before the human's Option B decision above -- kept in full as
documented-but-deferred research for a future round (e.g. if this
feature's scope ever needs to grow past month-granularity/end-pinned-to-
today), not deleted. **Deliberately left at its own original internal
section numbers (`## 0.` through `## 9.`), not renumbered to nest under
this document's new top-level "## 1."/"## 2." sections above** -- every
cross-reference inside this original research (e.g. "see section 3.2")
refers to that original numbering, and renumbering ~600 lines of
cross-references to shift by +2 would risk introducing a real error for
a purely cosmetic fix. Read "## 0." below as "this plan's own section 0,"
not "the third H2 heading in the file."

**One correction, made during independent review of this plan before
implementation began**: section 0 (`## 0. Numbers actually measured for
this plan, and how`, immediately below)'s raw price-history size
benchmark (58.6MB) was run against an inconsistent/lower-density dataset
than claimed -- a reviewer's own re-run found the real figure is closer
to **~97-100MB** at realistic trading-day density. This doesn't change
any conclusion in section 1 above (the coarsened path needs no raw
price-history store at all), and the original 58.6MB-based numbers below
are left as-is (not silently edited) since they're a historical record of
what was actually measured in that session -- treat every "58.6MB" figure
below as superseded by ~97-100MB if this research is ever revived.

## 0. Numbers actually measured for this plan, and how

All of the following were run live in this session against this repo's
real `packages/core/src/optimizer.ts` and `yahoo-client.ts` types (not
estimated, not copied from `packages/core/CLAUDE.md` without
re-checking) via two throwaway Vitest files
(`optimizer.bench.temp.test.ts`, `raw-store-size.bench.temp.test.ts`),
written under `packages/core/src/`, run with `pnpm vitest run
--reporter=verbose`, then deleted before this plan was committed --
same throwaway-verification pattern this codebase already uses
elsewhere (see `apps/web/CLAUDE.md`'s "Screenshotting a component
locally" section for the analogous convention). `git status`/`git diff`
show none of this in the committed tree.

- **Optimizer re-verification** (503 synthetic tickers, `maxTrades: 3`,
  `startingCapital: 20`, 5 timed runs after a warm-up run):
  - ~3174 unique synthetic trading days (a lower-density approximation
    of a real 21-year calendar -- see caveat below): `optimizeTrades`
    (single direction) **min 211.8ms, avg 243.3ms**;
    `optimizeBothDirections` (best+worst, issue #31's shared-state path)
    **min 361.0ms, avg 373.3ms**.
  - ~252 days (~1Y-scale window): `optimizeTrades` **min 8.6ms, avg
    10.2ms**.
  - This confirms the same order of magnitude as `packages/core/CLAUDE.md`'s
    documented ~330ms/~575ms figures, and confirms near-linear scaling
    in day-count `T` (consistent with the DP's own documented
    `O(days * tickers * maxTrades)` bound): per-day cost from the
    long-window run is ~0.0767ms/day; extrapolating that rate to a real
    ~5292-trading-day 21-year window gives **~406ms**, close to (a bit
    above) the documented ~330ms -- plausible given my synthetic
    calendar has ~40% fewer unique days than a real 21-year calendar
    would, so this run's absolute numbers run a bit fast, not a bit
    slow. **This plan uses ~0.08ms/trading-day (single direction) and
    ~1.5x that (~0.12ms/trading-day) for `optimizeBothDirections`** as
    the working per-day-count cost model for every estimate below.
- **Raw full-universe daily-close history size** (503 tickers x 5292
  real-density trading days, JSON-serialized): **58.6MB**, `JSON.stringify`
  took 186ms, `JSON.parse` of the full blob took **249ms / 325ms / 251ms**
  across 3 runs (~38.5 bytes/record average). This is the number that
  matters for "how expensive is a durable raw-price-history store" --
  section 3.3 below.

**Caveat, explicit**: both benchmarks ran on this session's local
sandbox machine (`node v24.19.0` via the repo's `mise` shim), not on a
real Lambda -- absolute numbers on Lambda's actual CPU allocation (which
scales with configured memory) will differ, and S3 GET transfer time for
the 58.6MB blob is _not_ measured at all here (this sandbox has no AWS
credentials -- see `infra/CLAUDE.md`). Section 9's live-verification plan
calls out a real Lambda-based re-measurement as a required follow-up
before shipping, the same way issue #31's plan flagged its own
un-measured intraday-doubling risk for later confirmation.

## 1. Current architecture recap (files read for this plan)

- `packages/core/src/preset-ranges.ts`: `presetRangeStartDate(range,
asOf)` -- the 5 fixed ranges' start-date math, returns `null` for MAX
  (unbounded).
- `packages/core/src/optimizer.ts`: the DP (`optimizeTrades`/
  `optimizeWorstTrades`/`optimizeBothDirections`) -- takes an in-memory
  `Map<string, DailyClose[]>` and `{startingCapital, maxTrades}`, no
  date-range concept of its own at all; a caller already slices the
  window before calling it. **This means an arbitrary-date-range
  feature needs zero optimizer changes** -- same "no packages/core
  change needed" shape as issue #15 (configurable starting capital).
- `apps/pipeline/src/pipeline.ts`: fetches the full ~503-ticker daily-close
  history from 1970 once (`DEFAULT_EARLIEST_DATE`), slices it per preset
  range locally, discards the raw fetched data after building each
  range's `WindowResult`/`IntradayResult` -- **no raw price history is
  persisted anywhere today**, only the optimized outputs.
- `apps/web/src/lib/results-api.ts`: `getResultsResponse(rawRange,
reader)` -- a thin S3 read + schema/model validation, zero compute
  capability. `parseRange`/`isCanonicalRange` only ever validate against
  the 5-member `PRESET_RANGES` union.
- `apps/web/src/app/api/results/route.ts`: `force-dynamic`, reads via
  `S3ResultReader` (`GetObjectCommand`), `RESULTS_BUCKET` env var.
- `infra/cdk/lib/hadiknowntrades-stack.ts`: pipeline Lambda is a real
  `NodejsFunction` (2048MB, 15min timeout, `results/*` PutObject grant
  only). **The web Lambda is still the placeholder** (`web-placeholder/`,
  256MB/10s, no S3 grants at all) -- `infra/CLAUDE.md` calls this "the
  main gap" as of 2026-08-21; apps/web itself is real, but nothing
  compute-capable is actually deployed behind it yet. This is a hard
  prerequisite fact for section 3/4 below, not a minor detail.
- `apps/web/src/components/ResultsPage.tsx`: owns `?range=`/`?day=` as
  URL state via `useSearchParams`/`router.replace`, the pattern any new
  `?start=&end=` state should follow.

## 2. Missing/holiday date handling: designed explicitly (per the issue's own ask)

This app already has a _hidden_ version of this problem: every existing
preset's `startDateString` is a plain calendar boundary with no
guarantee of landing on a real trading day, and `buildWindowResults`'s
slice filter (`p.date >= startDateString && p.date <= endDateString`)
silently uses whichever real trading day is nearest-at-or-after/nearest-
at-or-before -- issue #12's own pipeline work **measured this live**
at **~28% of days, across a 2-year sample, for every bounded preset
range** (`apps/pipeline/CLAUDE.md`'s "Buy-and-hold" section). A
user-picking-any-date feature hits this on nearly a third of picks, not
as a rare edge case -- exactly why the issue calls this out as needing
"real, tested UI/API handling," and why the design below is explicit
where the preset code got away with silence.

**Snapping policy, explicit and directional**:

- **A chosen start date snaps forward** to the nearest real trading day
  on or after it (`date >= requestedStart`) -- mirrors the existing
  preset slice-filter semantics exactly, and never shows the user a
  trade before the date they actually asked to start from.
- **A chosen end date snaps backward** to the nearest real trading day
  on or before it (`date <= requestedEnd`), capped at `dataAsOf` (the
  most recent trading day the raw store actually has) if the user picks
  a future date or "today" before that day's data has landed -- same
  clamp-to-what's-actually-available behavior every existing range
  already has via `endDate: toDateString(asOf)`.
- **Both snaps are surfaced to the caller, not silent**: the response
  carries `requestedStartDate`/`requestedEndDate` (what the user picked)
  alongside `startDate`/`endDate` (what was actually used), plus
  `snappedStart`/`snappedEnd` booleans, so the UI can render "You picked
  Sat, Mar 15 -- showing results from Mon, Mar 17, the next trading day."
  This reuses the exact precedent `BenchmarkResult.truncated` already
  established in this codebase (issue #12) for "the data doesn't reach
  back exactly where you asked" -- a visible, honest field on the
  response, not a UI-side inference.
- **Zero-trading-days case, a real rejection, not a silent empty
  result**: if forward-snapping the start and backward-snapping the end
  cross (e.g. a start/end pair that both land inside the same
  weekend/holiday gap with nothing in between), or `snappedStart >
snappedEnd` after clamping, the API returns a new `no_trading_days`
  error (400) with a clear message -- mirrors this codebase's existing
  "refuse to produce a silently-empty/misleading result" philosophy
  (`apps/pipeline`'s "refuse to overwrite good results with an empty
  run" guarantee, applied here at the request layer instead of the
  write layer).
- **An out-of-history start** (e.g. 1900) needs no special case: forward-
  snapping naturally lands on the raw store's own earliest date, the
  same "MAX means unbounded, use whatever's earliest" behavior
  `presetRangeStartDate("MAX", ...)` already has.
- **Judgment call, flagged**: whether `snappedStart`/`snappedEnd` should
  also be sanity-bounded (e.g. reject a start more than N years before
  any ticker's real listing, rather than silently snapping to "whatever
  the earliest is") is left to the reviewer -- the MAX-range precedent
  argues for "just use what's there, no error," but a user-facing
  date-picker inviting arbitrary input is a different trust boundary
  than an internal preset constant. Not resolved here.

## 3. The architecture fork, with real numbers

### 3.1 What "arbitrary" the issue actually asks for

The issue's Scope says "pick any start/end date" -- **both** endpoints,
not just a start date anchored to "today" the way every existing preset
already works. This distinction matters enormously for what a bounded
precompute matrix can realistically cover (3.2) vs. what live compute
naturally handles (3.3) -- it's the crux of this plan's analysis, so
it's called out before any numbers.

### 3.2 Precompute-matrix option, with real numbers

**Scheme A -- month-anchored start, end pinned to `asOf` (today)**, the
natural generalization of the existing 5 presets (which already all end
at "today"):

- 21 years back x 12 anchors/year = **252 anchor points**.
- Cost model (section 0): average anchor spans roughly half the max
  window (anchors are evenly spread across calendar time, so average
  day-count ~= 5292/2 = 2646 days) -> ~2646 x 0.12ms/day (both
  directions, matching the existing worst-case-stat precedent) ~= **317ms
  per anchor** -> 252 x 317ms ~= **~80 seconds of added nightly compute**.
  Reuses the window path's _already-fetched, already-in-memory_
  `windowFetch.history` -- zero new Yahoo requests, zero new fetch-pool
  code, no new peak memory (each anchor's DP working set is a handful of
  small arrays, GC'd between iterations; the big in-memory cost is the
  raw history itself, which is already resident today).
- Existing full pipeline run is measured at **~37s**
  (`apps/pipeline/CLAUDE.md`) for everything it currently does (4
  concurrent fetch pools + optimize x5 ranges). Adding ~80s of pure
  compute (no new fetch) brings a rough new total to **~2 minutes** --
  trivially inside the 15-minute Lambda timeout, no memory-pressure
  change.
- S3 storage growth: 252 new result objects, each roughly the size of an
  existing `WindowResult` (a few KB, dominated by fixed fields, not
  window length) -> **~750KB-1MB total new storage**, and a proportional
  handful of extra monthly PUT requests -- both **negligible** against
  the $20/month budget (S3 Standard is ~$0.023/GB-month; this is a
  rounding error).
- **What this scheme cannot do**: it only lets a user pick a
  _month-granularity_ start, and the end date is always "today" -- not a
  real answer to "pick any start/end date."

**Scheme B -- day-granularity start, end still pinned to `asOf`**:

- ~5292 anchor points (one per real trading day over 21 years) instead
  of 252. Same per-anchor cost model, same "reuses already-fetched
  history" property, but now **~5292 x 317ms ~= ~28 minutes of added
  nightly compute** -- on its own, past the pipeline Lambda's 15-minute
  timeout ceiling, before even adding the existing ~37s of fetch/compute
  it already does. **Not viable as a nightly-recompute-everything
  scheme.**

**Scheme C -- day-granularity, both start and end arbitrary (the
issue's literal ask)**: a full (start, end) grid over ~5292 possible
trading days is combinatorially ~5292^2/2 (start < end) ~= **~14 million
pairs** -- not "a much larger precompute matrix," a different order of
problem entirely, and obviously not nightly-recomputable in any bounded
Lambda invocation. **The issue's own Background text already
anticipated this ("even just anchoring every possible start day to
'today'... is thousands of combinations") -- this plan's numbers confirm
it's worse than that once the end date is genuinely free too, not just
"thousands," millions.**

**The real insight that breaks the binary framing**: this app only ever
deals in _closed, historical_ EOD data. Once `end < asOf`'s `dataAsOf`,
a computed `(start, end)` result is **immutable forever** -- unlike every
existing preset (whose `end` is always "today" and therefore
legitimately needs nightly recomputation), a specific historical window
never needs to be recomputed once it's been computed once. That means
Scheme C's "14 million pairs" number is a wildly pessimistic _nightly_
figure but not a realistic _ever-computed_ figure -- almost none of
those 14 million pairs will ever actually be requested by a real user.
This is exactly what section 4's recommended design exploits.

### 3.3 Live-compute option, with real numbers

What live compute actually needs, concretely:

1. **A durable raw-price-history store** (doesn't exist today -- see
   section 1). Measured size (section 0): **58.6MB** for the full
   503-ticker, 21-year universe as one JSON blob; growth going forward
   is ~503 new (ticker, date) records/trading-day x ~38.5 bytes/record
   ~= **~19KB/trading day ~= ~7MB/year** -- the base size dominates, not
   ongoing growth, for at least the next decade.
2. **A compute-capable read path.** Loading + parsing that 58.6MB blob
   measured at **249-325ms** (`JSON.parse`, this session's real
   measurement) on a local sandbox machine. S3 GET transfer time for a
   58.6MB same-region object is _not measured here_ (no AWS
   credentials in this sandbox) -- estimated at roughly 200-800ms for a
   single-stream same-region GET based on typical S3 throughput, **an
   assumption, not a measurement, flagged for real verification in
   section 9**. Combined cold estimate: **~0.5-1.1s** to have the raw
   store loaded and parsed, plus the optimizer's own **~10-410ms**
   (section 0, depending on the actual chosen window's day-count) ->
   **roughly 0.6-1.5s for a cold request**. A **warm** Lambda that keeps
   the parsed store in module-level memory across invocations (the
   normal Lambda execution-environment reuse behavior) pays only the
   optimizer's own cost on every subsequent request while warm --
   **sub-second, often well under 100ms** for a short window.
3. **Lambda sizing**: 58.6MB of raw JSON plus its parsed in-memory JS
   object overhead (commonly 2-4x raw JSON size for an object graph this
   shape in V8) suggests **~150-250MB** resident for the raw store alone
   -- comfortably fits well inside **1024MB**, a fraction of the
   pipeline Lambda's 2048MB (which holds _four_ concurrent multi-year
   fetch pools simultaneously, a fundamentally bigger footprint than
   holding one already-fetched blob). Timeout: recommend 30-60s as a
   safety margin over the ~1.5s expected cold path, not because that
   duration is expected routinely.
4. **Dollar cost at this project's realistic traffic**: Lambda pricing is
   ~$0.0000166667/GB-second + $0.20/1M requests (AWS's published rate,
   not verified against a real invoice in this sandbox). At 1GB memory,
   a cold request (~1.5 GB-seconds) costs **~$0.000025**; a warm request
   (~0.3 GB-seconds) costs **~$0.000005**. Even at a generous 10,000
   requests/month, compute cost is **~$0.05-$0.25/month** -- nowhere
   close to threatening the $20/month budget alert on its own. **Dollar
   cost is not the deciding factor between the two options** -- see
   section 8 for what actually is.

### 3.4 Live compute's real, non-optional prerequisite

`infra/CLAUDE.md` is explicit: **the web Lambda is still the
placeholder** -- no real OpenNext build, no S3 grants, 256MB/10s sized
for essentially nothing. Any live-compute API route runs inside that
same Lambda once it's real (Next.js API routes and pages share one
Lambda under OpenNext). **This means issue #11's live-compute path
cannot ship in isolation** -- it depends on the OpenNext-build-out work
`infra/CLAUDE.md` already flags as "the main gap," which has no tracked
issue number as of this plan (checked `gh issue list`, nothing open
matches). This is a real sequencing fact for whoever picks this issue
up, not a footnote -- flagged again in section 7.

## 4. Recommendation

**Live compute, with a permanent write-through result cache keyed by
`(start, end)`, not a bigger precompute matrix** -- for the _literal_
reading of the issue's "pick any start/end date." Reasoning, weighing
sections 3.2/3.3 against each other explicitly:

- A bounded precompute matrix can only satisfy a _coarsened_ version of
  "arbitrary" (Scheme A: month-granularity start, end always "today")
  without blowing the nightly Lambda timeout (Scheme B) or becoming a
  different-order problem entirely (Scheme C, ~14M pairs). Any precompute
  scheme that actually matches the issue's literal Scope text isn't
  "bounded" in any nightly-safe sense.
- Live compute's real numbers (freshly measured, section 3.3) are much
  more favorable than the issue's own Background text worried about:
  the "durable raw-price-history store" is a modest 58.6MB, not an
  unboundedly growing problem, and cold-path latency is plausibly
  ~0.6-1.5s -- a reasonable UX for an explicit "explore a custom range"
  action, distinct from the always-instant preset tabs.
- **The write-through cache is what makes this recommendation coherent,
  not a bolt-on**: because a historical `(start, end < today)` result
  never changes once computed (section 3.2's "real insight"), caching
  every computed result permanently in S3 converges live-compute's
  steady-state cost toward the precompute matrix's own profile for any
  range that gets asked for more than once, while still covering the
  full space Scheme C's matrix cannot realistically precompute. This is
  genuinely a hybrid of "live compute" and "precompute," not a pure
  pick of one side of the issue's own framing -- worth naming
  explicitly rather than presenting as if it were 100% "live compute."

**This is a real, non-trivial recommendation with a real prerequisite
gap (section 3.4) and a real new cost-abuse risk (section 8) -- see
section 7.1 for why the _scope_ question underneath this recommendation
is still an open call for the human, not something this plan resolves
by itself.**

## 5. Design: integrating the recommendation

### 5.1 New pipeline step (`apps/pipeline/src/pipeline.ts`, `src/run.ts`)

After the window path's daily-close fetch succeeds
(`windowFetch.history`, already the full from-1970 dataset, already
resident in memory for `buildWindowResults`), add one more
`store.putObject` call writing it to a new key, e.g.
`raw/daily-closes.json`:

```json
{ "schemaVersion": 1, "generatedAt": "...", "dataAsOf": "...", "closesByTicker": { "AAPL": [...], ... } }
```

- Reuses the existing `ResultStore`/`S3ResultStore` interface as-is --
  no new store abstraction needed, just one more key.
- Gated behind `windowFetch.failureReason` the same way `results/{5Y,MAX}.json`
  already are: a failed/aborted window fetch skips this write too,
  same "don't overwrite good data with a bad run" principle.
- Own `schemaVersion` (independent of `RESULTS_SCHEMA_VERSION`, which is
  specific to `PrecomputedResult`) so the reader can reject an
  incompatible shape the same defensive way `results-api.ts` already
  checks `RESULTS_SCHEMA_VERSION` -- this is a different object with a
  different contract, not a `PrecomputedResult`.
- One JSON blob, not per-ticker objects: at 58.6MB total, a single GET
  is simpler and (per section 3.3) fast enough; per-ticker files would
  mean ~503 separate S3 GETs per cold load, worse for both latency and
  S3 request-count cost. Revisit only if the universe or history depth
  grows enough to make 58.6MB impractical -- not close to that today.

### 5.2 New API route: `GET /api/results/custom?start=YYYY-MM-DD&end=YYYY-MM-DD`

Deliberately a **separate route** from `/api/results?range=...`, not an
overload of it -- the two have genuinely different backing logic
(S3-read-only vs. compute), different cache semantics (5-minute
`max-age` for nightly-refreshed presets vs. effectively-immutable
long-lived caching for a historical custom pair, once computed), and
different error vocabularies. `/api/results` itself is untouched.

Handler flow:

1. Parse/validate `start`/`end` (parseable ISO dates, `start <= end`,
   neither past `asOf`) -- reject malformed input with a new
   `invalid_date_range` error code (400), extending the existing
   `ApiErrorCode` union in `results-api.ts`.
2. Load the raw store: a module-scope loader function that fetches +
   parses `raw/daily-closes.json` once per cold Lambda start and caches
   the parsed result in module state for reuse across warm invocations
   of the same execution environment -- the mechanism that makes the
   "sub-second warm, ~1.5s cold" number in section 3.3 real rather than
   paid on every request.
3. Snap `start` forward / `end` backward per section 2's policy against
   the loaded calendar; `no_trading_days` (400) if nothing survives.
4. Cache check: `custom-results/{snappedStart}_{snappedEnd}.json`. If
   present, serve directly with `Cache-Control: public,
max-age=31536000, immutable` (this pair's data can never change once
   `end < dataAsOf`).
5. Cache miss: slice the loaded raw history to `[snappedStart,
snappedEnd]`, call `optimizeBothDirections` (existing `packages/core`
   function, **zero changes needed** -- same "no optimizer change"
   shape as issue #15), build a result object (section 5.3), and
   `store.putObject` it to the cache key before returning -- write-
   through, not write-behind, so a concurrent duplicate request during
   the same miss might recompute once redundantly (acceptable; not
   worth a distributed lock for this traffic scale) but never returns
   stale/partial data.
6. If `end === asOf`'s `dataAsOf` (the pair reaches all the way to
   "today"), **do not cache** -- tomorrow's data would make today's
   cached answer stale, same reasoning every preset's own nightly
   refresh already encodes. Only genuinely historical (`end <
dataAsOf`) pairs are permanently cacheable.

### 5.3 Schema (`packages/core/src/results-schema.ts`)

**Judgment call, flagged**: a new `CustomWindowResult` type, structurally
similar to `WindowResult` (same `trades`/`worstCase`/`benchmark`/
`endingBalance` shape) plus `requestedStartDate`/`requestedEndDate`/
`snappedStart`/`snappedEnd` (section 2), but with `range: "CUSTOM"` as a
sentinel rather than a `PresetRange`. Proposed as a type **separate
from** the `PrecomputedResult` union (not a third member alongside
`WindowResult`/`IntradayResult`), and **not gated by
`RESULTS_SCHEMA_VERSION`** -- that constant's whole "read-time exact
equality" contract (`apps/web/CLAUDE.md`/`packages/core/CLAUDE.md`)
exists specifically to catch a version skew between the nightly
pipeline (writer) and the results API (reader) as two independently
deployable things; a custom result is produced by the read path itself,
on demand, so there's no separate writer to drift from it. Forcing it
through that same gate would add friction with no matching safety
benefit. **A reviewer could reasonably disagree and prefer folding it
into the existing union for consistency -- not resolved here.**

### 5.4 Infra (`infra/cdk/lib/hadiknowntrades-stack.ts`)

- `resultsBucket.grantPut(pipelineFn, "raw/*")` alongside the existing
  `results/*` grant (section 5.1's write).
- Once the placeholder web Lambda is replaced with a real OpenNext build
  (section 3.4's prerequisite): `resultsBucket.grantRead(webFn, "raw/*")`
  and `resultsBucket.grantReadWrite(webFn, "custom-results/*")`. Reusing
  the existing `resultsBucket` (not a new bucket) is simplest -- same
  `DESTROY`/`autoDeleteObjects` lifecycle already fits "regenerated
  data, sandbox project."
- `webFn`'s `memorySize`/`timeout` need to grow well past the
  placeholder's 256MB/10s -- section 3.3 suggests **1024MB / 30-60s** as
  a reasonable starting point, mirroring how the pipeline Lambda's own
  2048MB was set proactively from an estimate and flagged for
  confirmation against a real measured run (same pattern to follow
  here, not a new one).

### 5.5 UI (`apps/web/src/components`)

- A new "Custom" option alongside the existing 5 pills in
  `RangeSelector.tsx` (or a distinct control next to it) revealing two
  native `<input type="date">` fields -- native-first, no date-picker
  library, consistent with this codebase's established pattern of
  reaching for a browser primitive before a library (the hand-rolled SVG
  chart, the plain `<select>`-based `DaySelector`).
- `ResultsPage.tsx` grows `?start=&end=` URL state alongside the
  existing `?range=`/`?day=`, following the exact same
  `useSearchParams`/`router.replace` shape already established there.
  Selecting a custom range clears `?range=`/`?day=` (and vice versa) --
  the two are mutually exclusive view modes, not composable.
- A small, dismissible note rendered when `snappedStart`/`snappedEnd` is
  true (section 2's messaging requirement) -- reuses the existing
  `--text-muted`/small-caption visual language already used for
  `dataAsOf`/benchmark captions, no new visual pattern needed.
- `useResults`-equivalent hook for the custom path: a new
  `use-custom-results.ts` (mirrors `use-results.ts`'s fetch state
  machine) rather than overloading `useResults` itself, since the two
  hit different routes with different param shapes.

## 6. Missing/holiday date handling: test coverage this needs

- Start date on a weekend/holiday -> snaps forward, `snappedStart: true`.
- End date on a weekend/holiday -> snaps backward, `snappedEnd: true`.
- Both dates land inside the same gap with nothing between -> `no_trading_days`.
- Start after end (raw input, before snapping) -> `invalid_date_range`.
- Start before any real data (e.g. 1900) -> snaps to the raw store's
  earliest date, no error (mirrors MAX's `null`-start "unbounded"
  behavior).
- End beyond `dataAsOf` (future date, or "today" before the pipeline has
  run) -> silently clamped to `dataAsOf`, no error and (per the
  judgment call in section 2) no `snappedEnd` message either, mirroring
  every existing preset's silent `dataAsOf`-lag behavior -- **a
  reviewer could reasonably want this surfaced instead; flagged as a
  judgment call, not resolved.**
- Cache-hit vs. cache-miss paths both return byte-identical
  `trades`/`endingBalance` for the same `(start, end)` pair.
- A pair reaching `end === dataAsOf` is never written to the permanent
  cache (section 5.2 step 6).

## 7. Open questions / judgment calls this plan made without a resolving answer

### 7.1 THE central open question: how literally should "arbitrary" be taken? (flagged for the human, not resolved here)

Section 3 shows the issue's literal Scope text ("pick any start/end
date") only cleanly maps to live compute + cache; a bounded, nightly-safe
precompute matrix can only offer a materially coarser feature (month-
granularity start, end pinned to today). **This is a genuine, close
product/infra-spend decision, not a technical question this plan should
resolve unilaterally** -- per this task's own instruction to flag exactly
this kind of call:

- **Option A (this plan's recommendation, section 4)**: build live
  compute + permanent cache, literal arbitrary start/end at day
  granularity. Real benefits (full feature, decent latency per section
  3.3) and real costs (blocked on the OpenNext prerequisite, section
  3.4; new cost-abuse attack surface, section 8; the most implementation
  work of any option here).
- **Option B (Scheme A from section 3.2)**: ship a _coarser_ feature --
  month-granularity start only, end always "today" -- entirely within
  the existing pipeline/S3-read architecture, **zero new infra, no
  OpenNext prerequisite, no new attack surface**. This is materially
  cheaper and faster to ship, at the cost of "arbitrary" meaning
  something narrower than the issue's own words suggest.
- **A middle option** not designed in depth here: day-granularity start
  _only_ (Scheme B, section 3.2) via the existing precompute
  architecture, accepting the ~28-minute nightly compute addition by
  splitting it across multiple pipeline invocations or a separate
  schedule -- not fully worked out, flagged as a possibility rather than
  a recommendation, since it still doesn't give a free end date and adds
  its own new complexity (multi-invocation coordination) this plan
  hasn't scoped.

**This plan does not pick between these for the human** -- it recommends
Option A as the technically-correct answer to the issue _as literally
written_, but Option B is a legitimate, much cheaper "good enough"
answer if the product goal is "let users explore roughly-custom
timeframes" rather than "support every possible calendar date." Whoever
picks this issue up next should get an explicit answer to this question
before starting implementation, not infer one.

### 7.2 Other open questions/assumptions

- **S3 GET transfer time for the 58.6MB raw blob is estimated
  (200-800ms), not measured** (section 3.3, point 2) -- this sandbox has
  no AWS credentials. A real Lambda-based measurement is required before
  trusting the "~0.6-1.5s cold path" number for real UX decisions; see
  section 9.
- **Rate limiting / abuse mitigation for the live-compute route is not
  designed here** -- flagged as a real risk in section 8, deliberately
  left unresolved pending the section 7.1 scope decision (Option B has
  no such risk at all, which is itself an argument in Option B's favor
  independent of the "how literal is arbitrary" question).
- **Per-ticker vs. single-blob raw store** (section 5.1): recommended
  single blob given the measured 58.6MB size; revisit if universe size
  or history depth grows enough to change that calculus. Not expected
  to be an issue for years at current growth (~7MB/year, section 3.3).
- **`CustomWindowResult` outside the versioned `PrecomputedResult`
  union** (section 5.3): a real design judgment call a reviewer could
  reasonably overturn.
- **Silent vs. messaged end-date clamping** (section 2, section 6): left
  as "silent, mirrors existing preset behavior" by default, flagged as
  reasonably arguable the other way.
- **Whether `startingCapital`/`maxTrades` should also be part of the
  custom-cache key**: today both are fixed constants pipeline-wide
  (`DEFAULT_STARTING_CAPITAL = 20`, `DEFAULT_MAX_TRADES = 3`), and issue
  #15's configurable-starting-capital feature is purely a _display-time_
  rescale (`packages/core`'s optimizer output is capital-invariant in
  shape, only the displayed dollar amounts scale) -- so this plan
  assumes the custom route's cached result, like every existing preset's
  result, is computed once at the fixed default capital and rescaled
  client-side the same way `HeroStat`'s `displayStartingCapital` already
  does. **Not re-verified against `use-starting-capital.ts` in depth for
  this plan** -- worth a quick confirmation pass before implementation,
  not expected to change the recommendation.

## 8. Risks

- **New attack surface: AWS cost that scales with adversarial user
  input, a first for this codebase.** Every existing feature's AWS cost
  is either flat (nightly pipeline compute) or fully cache-absorbed
  (CloudFront/Next caching the 5 preset ranges' static-ish responses).
  A live-compute custom-range route has no such natural ceiling on
  _first-time_ requests for a given `(start, end)` pair -- a scripted
  client cycling through thousands of distinct pairs forces a fresh
  optimizer run (plus, worse, a fresh raw-store cold-load if it also
  exhausts warm Lambda capacity) on each one. The write-through cache
  (section 5.2) blunts _repeat_ costs but does nothing for a first pass
  across many distinct pairs. `infra/CLAUDE.md` is explicit that this
  sandbox's $20/month budget currently has **only an email alert, no
  automatic lockdown** -- a deliberate, informed choice the user made
  before this feature existed. **This plan does not silently accept that
  choice still being fine now that a cost-scales-with-input surface
  exists** -- worth explicitly re-raising with the user before this
  ships, not just noting here.
- **Blast radius / prerequisite gap**: this recommendation is blocked on
  work (a real OpenNext build replacing `web-placeholder/`) that isn't
  this issue's own scope and has no tracked issue number today (section
  3.4) -- a real sequencing risk for whoever picks this up, not a detail.
- **Perf assumption not yet verified live**: the ~0.6-1.5s cold-path
  latency estimate rests on an _unmeasured_ S3 transfer-time assumption
  (section 7.2) -- if real S3 GET latency for a 58.6MB object in
  us-west-2 turns out meaningfully worse than assumed, the UX case for
  live compute over Option B (section 7.1) weakens; this needs
  confirming before the recommendation should be treated as settled.
- **Correctness**: the DP itself needs zero changes (section 1), so the
  main correctness risk is entirely in the new code -- the snap-forward/
  snap-backward date logic (section 2) and the cache key/invalidation
  logic (section 5.2's "never cache an `end === dataAsOf` pair" rule).
  Both are new, not reused from elsewhere, and need dedicated tests
  (section 6) rather than inheriting confidence from the well-tested
  optimizer.
- **Judgment calls a reviewer should explicitly sign off on** (collected
  from throughout this document): section 2's "silent end-date clamp"
  and "no sanity bound on how far back a start date can snap"; section
  5.3's "`CustomWindowResult` outside `PrecomputedResult`'s
  versioning"; and, above all, **section 7.1's scope question**, which
  is the one item on this list that's a product decision for the human,
  not an implementation detail for a reviewer.

## 9. Live verification plan (not performed in this planning phase)

Whichever option section 7.1 resolves to, before merging real
implementation:

- **If live compute (Option A)**: a real Lambda-based measurement of (a)
  S3 GET latency for the actual ~58.6MB (or larger, by then) raw blob in
  us-west-2, (b) cold vs. warm end-to-end request latency for a real
  custom `(start, end)` pair against real deployed infra, and (c) actual
  Lambda memory usage (same "measure it for real, don't just trust the
  estimate" discipline `apps/pipeline/CLAUDE.md`'s 903MB/2048MB history
  already establishes for this codebase). Needs the OpenNext prerequisite
  (section 3.4) resolved first.
- **If the coarser option (Option B)**: a real pipeline run confirming
  the measured ~80s-per-252-anchors addition (section 3.2) against real
  S&P 500 data rather than this plan's synthetic-data extrapolation,
  the same "verify live at least once per feature" standard every prior
  plan in this repo has followed.
- Either way: a real end-to-end check of the missing/holiday-date
  snapping behavior (section 2) against real calendar data, not just
  unit tests against synthetic gaps -- confirm the ~28% weekend/holiday
  rate issue #12 measured for preset boundaries holds up similarly for
  arbitrary user-chosen dates, and that the UI's snap-notice renders
  correctly for a real snapped pair.
