# Plan: issue #75 -- day-precision calendar picker for the custom start date

Status: plan only, per the issue's own delegation note -- no implementation
in this worktree. The one thing this plan _does_ do that a pure design
doc wouldn't is run the real, load-bearing benchmark the issue's own
acceptance criteria requires before any data-model/S3-key decision can be
finalized (section 2) -- everything else here is design informed by that
result.

## 0. One-paragraph summary

This issue supersedes issue #11's month-granularity custom-range anchors
end to end: the 252 `YYYY-MM` anchors become real `YYYY-MM-DD`
trading-day anchors, sourced from the actual fetched daily-close history
(not a synthetic calendar/holiday model), a day-granularity picker
replaces the 252-option `<select>`, and the S3 key scheme migrates from
`results/custom/{YYYY-MM}.json` to `results/custom/{YYYY-MM-DD}.json`. A
naive extension of the _existing_ 21-year lookback to day granularity
would produce ~5,282 anchors (measured, section 2.2) -- but as this
section explains, that naive extension doesn't ship as-is; the
recommended lookback (7-8 years, section 2.5) produces roughly
1,761-2,012 anchors instead. **The real live benchmark (section 2)
shows the naive 21-year/~5,282-anchor extension does NOT fit the pipeline
Lambda's real 15-minute timeout, by a wide margin** -- real measured
compute time alone (67.2 minutes) is already ~4.5x the entire 900s
budget, well before fetch (11.2s, negligible) or S3-write time (never
directly measured, but reasoned about below) are even added in. Of the
issue's own three listed fallbacks -- (a) raise write concurrency, (b)
shrink the lookback window, (c) split the pipeline into two invocations
-- the benchmark's numbers point cleanly at **(b) alone**: this is a
compute-bound problem (a) can't touch, and the real numbers show (b) by
itself already buys back enough headroom that (c)'s real operational
complexity (multi-invocation orchestration, redundant re-fetching) isn't
needed on top of it. (An earlier draft of this section mischaracterized
the recommendation as outside the issue's own three options -- it isn't;
shrinking the lookback window _is_ fallback (b), corrected here against
the real numbers rather than left as drafted.) See section 2.4 for the
exact numbers and section 2.5 for the full reasoning on why (a) and (c)
are worse fits for what actually bottlenecked this. Everything past
section 2 (schema, S3 keys, pipeline, web plumbing, calendar UI) is
written against that recommendation. One genuine, unresolved product
question -- the exact lookback depth to ship -- is flagged for the
manager at the end rather than picked unilaterally, since it's a
user-visible product tradeoff, not a pure engineering one.

## 1. Current architecture recap (issue #11's design, what this issue replaces)

Read in full before this plan: `packages/core/src/custom-range-anchors.ts`,
`packages/core/src/results-schema.ts`, `apps/pipeline/src/pipeline.ts`
(`computeWindowOptimization`, `buildCustomWindowResults`,
`DEFAULT_WRITE_CONCURRENCY`), `apps/web/src/components/CustomRangeSelector.tsx`,
`apps/web/src/lib/use-custom-results.ts`, `apps/web/src/app/api/results/route.ts`,
`apps/web/src/lib/results-api.ts`, and `docs/plans/issue-11-plan.md`
(sections 1 and 2 -- the coarsened design actually shipped, and the
deferred fully-free-date-pair research it was chosen over). The design
notes below are the load-bearing facts this plan builds on, not a full
re-explanation -- see those files' own doc comments and
`packages/core/CLAUDE.md`/`apps/pipeline/CLAUDE.md`/`apps/web/CLAUDE.md`'s
"Custom date-range anchors" sections for the full history.

- **`customRangeAnchors(asOf): AnchorMonth[]`** is a pure function of
  calendar time alone -- no real market data needed, because a calendar
  month's "1st" always exists. It returns the 1st of every month for
  `CUSTOM_RANGE_ANCHOR_YEARS_BACK` (21) years back, newest first: 252
  strings. **This is the one property that breaks for day-granularity**
  -- see section 3.
- **No missing/holiday-date snapping was needed** in the month scheme:
  each anchor's start is a calendar-month boundary, and the ordinary
  `p.date >= startDateString` window-slicing filter every preset range's
  `startDate` already goes through forward-snaps to the nearest real
  trading day for free. Day-granularity anchors don't get this for free
  in the same way -- see section 3 for why forward-snapping a
  non-trading-day anchor is actively wrong at day granularity, unlike at
  month granularity.
- **`CustomWindowResult`** (`results-schema.ts`) is a sibling type to
  `PrecomputedResult`, keyed by `anchorMonth: AnchorMonth` instead of
  `range: PresetRange`, structurally identical otherwise (same
  `optimizeAllVariants`-backed long-only/long+short, best/worst-case
  shape as `WindowResult`). Still gated by the same global
  `RESULTS_SCHEMA_VERSION` as every `PrecomputedResult`.
- **`customResultKey(anchorMonth) -> results/custom/{anchorMonth}.json`**,
  namespaced under its own S3 prefix.
- **`apps/pipeline`'s `buildCustomWindowResults`** computes one
  `CustomWindowResult` per anchor by reusing the window path's
  already-fetched `windowFetch.history` (the same full daily-close
  history 5Y/MAX use) -- zero extra Yahoo calls, the single biggest
  reason the month scheme is cheap. Each anchor's compute is
  `computeWindowOptimization(history, startDateString, endDateString,
startingCapital, maxTrades)`: a windowed slice (binary search via
  `lowerBoundByDate`/`upperBoundByDate` against a once-per-run
  `WeakMap`-cached sort of `history`, see `sortedHistory`) followed by one
  `optimizeAllVariants` call.
- **`apps/web`'s `CustomRangeSelector.tsx`** calls
  `customRangeAnchors(new Date())` **directly, client-side**, to populate
  a plain `<select>` -- this only works because the month scheme needs no
  real data. Its own doc comment's explicit argument against
  `<input type="date">` ("it would invite exactly that failure mode: a
  day the pipeline never actually computed a result for") is the
  design principle this issue's calendar UI must carry forward -- see
  section 6.
- **Live-measured cost of the current 252-anchor system** (`docs/plans/issue-11-plan.md`
  section 1.6, `packages/core/CLAUDE.md`'s "Custom date-range anchors"
  section): a full pipeline run (every fetch pool + solving all 5 preset
  ranges + all 252 custom anchors, no S3 write) took **154.0s total**,
  **431.5KB** total JSON across all 252 custom-anchor result objects.
- **The pipeline Lambda's real timeout is 900s (15 minutes)** -- confirmed
  directly from `infra/cdk/lib/hadiknowntrades-stack.ts:190`
  (`timeout: Duration.minutes(15)`), not assumed from the issue's own
  citation. Memory is `2048MB` (bumped for issue #29, not yet deployed --
  `infra/CLAUDE.md`'s "Current deployment state").

## 2. The live benchmark (load-bearing)

### 2.1 Methodology

Per the issue's own delegation note and this repo's "verify live at least
once per feature" convention, this benchmark used **real Yahoo network
calls against the full 503-ticker S&P 500 universe, no mocks**, and
called the pipeline's own real production functions directly rather than
reimplementing fetch/slice/DP logic a second time (which would measure an
approximation, not the real code path):

- `fetchUniverseHistory` and `computeWindowOptimization`
  (`apps/pipeline/src/pipeline.ts`) were **temporarily exported** (adding
  the `export` keyword to each, two one-line diffs) so a throwaway script
  could call them directly. **Reverted before this worktree is done** --
  `git diff apps/pipeline/src/pipeline.ts` is clean.
- A throwaway Vitest file,
  `apps/pipeline/src/live-verify-day-anchor-benchmark.temp.test.ts`
  (30-minute test timeout, since this is a real long-running live
  benchmark, not a unit test) -- **deleted before this worktree is done**,
  same technique issue #11/#13/#31's own live verifications used
  (`packages/core/CLAUDE.md`'s "Custom date-range anchors" /
  "Short-selling mode" sections).
- The script: (1) fetches full daily-close history (from 1970) for all
  503 real tickers via the real `fetchUniverseHistory`, concurrency 10
  (matching `DEFAULT_FETCH_CONCURRENCY`); (2) derives the real
  trading-day calendar via `buildCalendar(history).dates` -- the same
  union-of-every-ticker's-real-dates mechanism `optimizer.ts` already
  uses internally, reused rather than a second dedup/holiday-derivation
  implementation (see section 3 for why this specific mechanism is the
  right trading-day source); (3) filters that calendar to the last 21
  years (`CUSTOM_RANGE_ANCHOR_YEARS_BACK`), giving the real
  day-granularity anchor list; (4) calls the real
  `computeWindowOptimization` once per anchor, in a tight sequential
  loop (matching how `buildCustomWindowResults`' own `for` loop runs
  today -- no `Promise.all`, since this is synchronous CPU-bound work,
  not I/O); (5) builds a `CustomWindowResult`-shaped object per anchor
  (`benchmark: null` -- the one deliberate approximation, see its own
  note below) and sums its serialized JSON byte length; (6) logs
  progress every 500 anchors (elapsed, anchors/sec, RSS) so the run's
  rate is observable before completion, not just a final number.
- **One deliberate approximation**: each benchmark result object omits
  the real `benchmark` (SPY buy-and-hold) field (set to `null` instead of
  a second per-anchor `computeBenchmark` call) -- that field is a small,
  ~150-250-byte fixed-size object per anchor, independent of window
  length, that would have needed either a second live SPY fetch or
  duplicating `computeBenchmark`'s own private logic in the throwaway
  script for no real benchmarking value (it's not what's expensive here).
  This slightly _underestimates_ total JSON payload size (by roughly
  ~1MB across ~5,300 anchors) but has zero effect on the timing numbers,
  which are what this benchmark actually needs to answer.

### 2.2 Real numbers

Run 2026-08-23, real Yahoo network calls, full 503-ticker S&P 500
universe, no mocks, no S3 write:

- **Universe fetch: 503/503 tickers succeeded, 0 skipped, in 11.2s**
  (concurrency 10, full history from 1970).
- **Real trading-day calendar: 14,281 total dates** (union of every
  ticker's real close dates, back to 1970, via `buildCalendar`); **5,282
  fall within the 21-year lookback** (`CUSTOM_RANGE_ANCHOR_YEARS_BACK`).
  This is within 10 of the issue's own "~5,292" estimate -- the small gap
  is immaterial (exact trading-day count depends on the run's own "as of"
  date and holiday calendar for the current partial year), not a sign
  anything is wrong.
- **Compute: all 5,282 sequential `computeWindowOptimization` calls took
  4,031.5s (67.2 minutes) total.** Progress checkpoints (every 500
  anchors, processed oldest-anchor-first since `buildCalendar(...).dates`
  is ascending and this benchmark does not reverse it, matching
  `buildCustomWindowResults`' own iteration order once anchors are fed to
  it):

  | anchors done | cumulative elapsed | anchors/s (cumulative) |
  | ------------ | ------------------ | ---------------------- |
  | 500          | 753.0s             | 0.7                    |
  | 1,000        | 1,399.2s           | 0.7                    |
  | 1,500        | 1,982.7s           | 0.8                    |
  | 2,000        | 2,481.7s           | 0.8                    |
  | 2,500        | 2,909.4s           | 0.9                    |
  | 3,000        | 3,267.3s           | 0.9                    |
  | 3,500        | 3,559.2s           | 1.0                    |
  | 4,000        | 3,783.7s           | 1.1                    |
  | 4,500        | 3,937.4s           | 1.1                    |
  | 5,000        | 4,018.4s           | 1.2                    |
  | 5,282 (all)  | 4,031.5s           | 1.3                    |

  The cumulative rate understates how front-loaded this is -- see the
  _instantaneous_ per-checkpoint rate in section 2.3.

- **Total elapsed (fetch + compute, no S3 write): 4,042.7s (67.4
  minutes).**
- **Total JSON payload (custom-window results only, `benchmark` field
  omitted per this benchmark's documented approximation, see 2.1): 11,847,887
  bytes = 11,570.2KB = 11.30MB.** Avg 2,243 bytes/anchor (vs. ~1,712
  bytes/anchor for the old 252-anchor month system's 431.5KB total --
  larger because older/longer-window anchors carry longer trade
  sequences on average).
- **Peak RSS observed: 1,779MB.** Reached early (at the 500-anchor
  checkpoint, i.e. among the oldest/largest-window/most expensive
  anchors), then settled to a steady ~1.63-1.66GB for the rest of the
  run -- see 2.3 for why this pattern matters.

### 2.3 Bottleneck diagnosis: compute-bound, not I/O- or write-bound

**Fetch is not the bottleneck.** 11.2s out of 4,042.7s total is 0.28% of
the run. Even a Lambda-network-conditions fetch several times slower than
this benchmark's (fast, local-to-benchmark-machine) network would still
be a rounding error against the real number below.

**Write time was not directly measured** (this benchmark, like every
prior "no S3 write" live-verification in this codebase, deliberately
excludes it -- see 2.1), but it can be bounded by reasoning, not just
assumed away: at `DEFAULT_WRITE_CONCURRENCY = 10`
(`apps/pipeline/src/pipeline.ts`), writing all 5,282 custom-anchor
objects plus 5 preset-range objects plus the new manifest (5,288 jobs) is
~529 sequential rounds of 10 concurrent `putObject` calls. Even a
pessimistic 200-300ms/round same-region S3 PUT estimate puts total write
time at roughly 106-159s -- two orders of magnitude below the 4,031.5s
compute cost. **Write time cannot plausibly be the bottleneck at this
scale**, and raising write concurrency (issue fallback (a)) has no
meaningful lever to pull against a gap this size.

**Compute time is drastically front-loaded by window length**, which is
the real story. Converting the cumulative checkpoints in 2.2 to
_instantaneous_ per-checkpoint rates:

| anchor range         | elapsed for this batch | instantaneous rate | s/anchor |
| -------------------- | ---------------------- | ------------------ | -------- |
| 1-500 (oldest)       | 753.0s                 | 0.66/s             | 1.506s   |
| 500-1,000            | 646.2s                 | 0.77/s             | 1.292s   |
| 1,000-1,500          | 583.5s                 | 0.86/s             | 1.167s   |
| 1,500-2,000          | 499.0s                 | 1.00/s             | 0.998s   |
| 2,000-2,500          | 427.7s                 | 1.17/s             | 0.855s   |
| 2,500-3,000          | 357.9s                 | 1.40/s             | 0.716s   |
| 3,000-3,500          | 291.9s                 | 1.71/s             | 0.584s   |
| 3,500-4,000          | 224.5s                 | 2.23/s             | 0.449s   |
| 4,000-4,500          | 153.7s                 | 3.25/s             | 0.307s   |
| 4,500-5,000          | 81.0s                  | 6.17/s             | 0.162s   |
| 5,000-5,282 (newest) | 13.1s                  | 21.5/s             | 0.046s   |

That's a **>30x per-anchor cost spread** across a single run, monotonic
with anchor age. This is exactly what `optimizer.ts`'s own documented
complexity predicts (`packages/core/CLAUDE.md`'s "Optimizer algorithm"
section: O(days x tickers x maxTrades)) -- each anchor's window runs from
that anchor's date to "today," so the oldest anchors carry close to the
full ~21-year window and the newest carry almost none. This benchmark's
own most-expensive anchor (the oldest, ~full-21-year window) is, by
construction, almost exactly the same call as the separately-measured
MAX-range `optimizeAllVariants` benchmark already in this codebase
(`packages/core/CLAUDE.md`'s "Short-selling mode" section: ~3.36s for one
full-503-ticker/21-year `optimizeAllVariants` call) -- these two
independently-measured numbers are consistent with each other, not in
tension.

**Peak RSS is a secondary, confirming signal pointing the same
direction.** The 1,779MB peak was reached at the very first checkpoint
(the 500 most expensive, largest-window anchors) and then _fell_ to a
steady ~1.63-1.66GB for the remaining, progressively cheaper 4,782
anchors -- consistent with the single largest in-flight computations
(not the total count of anchors processed) driving the memory peak, the
same pattern the fetch+5-preset-range-only baseline already established
(`packages/core/CLAUDE.md`'s "Short-selling mode" section: ~1.28GB
"driven primarily by holding the full fetched...history in memory, not
by the optimizer's own...state"). Note this is measured against the
pipeline Lambda's **2048MB `memorySize` -- itself bumped from 1024MB in
code for issue #29 but _not yet deployed_ to the real Lambda**
(`infra/CLAUDE.md`'s "Current deployment state"); 1,779MB against a
2048MB ceiling is only ~13% headroom, and against the _currently live_
1024MB it would not fit at all. This plan doesn't relitigate the
already-decided 2048MB bump (that's issue #29's call, already made) but
flags it as a real precondition this feature also depends on, and as one
more reason (alongside compute time) the full 21-year/5,282-anchor scheme
specifically -- not day-granularity anchors in general -- is the wrong
target to ship.

### 2.4 Does it fit the real 900s Lambda timeout?

**No, not remotely.** Total measured elapsed (fetch + compute, no S3
write) was 4,042.7s (67.4 minutes) -- **about 4.5x the entire 900s (15
minute) budget from compute time alone**, before a single byte reaches
S3. This is not a marginal miss a small tuning change would close; it's
an order-of-magnitude gap. For scale: even splitting the naive full
21-year/5,282-anchor scheme across 5 parallel invocations (fallback (c))
would leave each at ~806s of compute alone (4,031.5s / 5), still without
real margin once fetch/write/orchestration overhead is added back in --
confirming this isn't a problem fallback (c) can solve on its own at any
practical split factor, let alone fallback (a) (see 2.3).

### 2.5 Fallback recommendation

Given the diagnosis in 2.3 (compute-bound, cost concentrated in the
oldest/largest-window anchors, not I/O- or write-bound), the issue's
three listed fallbacks resolve cleanly:

- **(a) Raise write concurrency: rejected.** Write time is estimated at
  roughly 106-159s even pessimistically (2.3) against a 4,031.5s compute
  cost -- under 4% of the gap. No write-concurrency change touches the
  actual bottleneck.
- **(c) Split into two (or more) scheduled invocations: rejected as
  unnecessary, not as unworkable.** It would help in principle (compute
  is parallelizable across independent invocations), but at real cost:
  each invocation independently re-fetching the full universe (multiplying
  real Yahoo request volume, a cost/risk this repo hasn't taken on for
  any other feature), plus genuine new orchestration complexity (a Step
  Function or equivalent multi-Lambda coordination layer, and a new "is
  tonight's run actually done yet" question for monitoring that doesn't
  exist today). Worth keeping in reserve if a future feature needs both
  full 21-year depth _and_ day granularity at once, but (b) alone already
  solves this issue's real problem without any of that complexity.
- **(b) Shrink the lookback window: recommended.** Because compute cost
  is concentrated in the oldest anchors (2.3's front-loading), cutting
  years off the lookback removes disproportionately expensive anchors,
  not just proportionally-fewer average-cost ones. Using the real
  checkpoint data in 2.2/2.3 (trading days/year ~= 5,282/21 ~= 251.5,
  interpolating the anchors an equivalent shorter lookback would _keep_ --
  the newest, cheapest suffix of the same real anchor list, not a
  separate estimate):

  | lookback (years) | anchors kept (~) | compute time (~)                          |
  | ---------------- | ---------------- | ----------------------------------------- |
  | 5                | 1,258            | 240s                                      |
  | 6                | 1,509            | 350s                                      |
  | 7                | 1,761            | 463s                                      |
  | 8                | 2,012            | 607s                                      |
  | 9                | 2,264            | 754s                                      |
  | 10               | 2,515            | 931s (already over 900s on compute alone) |

  **10 years is already too deep** -- compute alone exceeds the entire
  budget before fetch/write/preset-range overhead (a combined ~75-160s,
  generously estimated: 11.2s fetch + ~4s for the 5 preset ranges'
  `optimizeAllVariants` calls, per `packages/core/CLAUDE.md`'s own
  ~4.0s live-measured figure + up to ~159s worst-case write time) are
  even added back in. **7-8 years lands with real margin**: at 8 years,
  ~607s compute + ~75-160s overhead ~= 682-767s, leaving 133-218s
  (15-24%) of headroom under 900s; at 7 years the margin is more
  comfortable still (~463s compute, ~538-623s total, 277-362s/31-40%
  headroom). This also happens to land inside the issue's own suggested
  "5-10 years" bracket for fallback (b), at the deeper end that real
  margin allows rather than the shallowest option that merely clears the
  bar.

  **The exact figure within 7-8 years (or elsewhere in this range) is a
  genuine product-depth tradeoff, not picked here** -- see "For the
  manager." This plan's engineering recommendation is the _shape_ of the
  fix (shrink the lookback, not (a) or (c)) and the _safe range_ (7-8
  years, backed by the real numbers above), not a specific unilateral
  final number.

## 3. Anchor generation: real trading days, not naive calendar days

**The core design shift**: `customRangeAnchors` can no longer be "a pure
function of calendar time alone" the way the month scheme's version was
-- there is no calendar-math equivalent of "the 1st of the month" for
"a real NYSE/Nasdaq trading day." Two options exist for sourcing real
trading days, and this plan recommends the one the issue itself points
at:

- **Option A (recommended): derive trading days from the actual fetched
  daily-close history**, via `optimizer.ts`'s already-exported
  `buildCalendar(history).dates` -- the union of every date any ticker in
  the fetched universe actually has a close for, sorted ascending. This
  is exactly what the benchmark (section 2) used, and it's what the
  issue's own scope text points at ("reuse whatever trading-calendar
  source the existing daily-close data already establishes").
- **Option B (rejected): hand-roll a US market holiday calendar**
  (fixed holidays + Good Friday + weekend exclusion + observed-holiday
  weekday shifting). Rejected for the same reason
  `CustomRangeSelector.tsx`'s own existing doc comment gives for
  rejecting `<input type="date">`: a synthetic holiday-calendar model can
  drift from reality (an unscheduled closure -- 9/11, a hurricane, a
  national day of mourning -- or a plain implementation bug in the
  holiday-shifting rules) in a way real fetched data structurally can't.
  Option A's anchor list is _definitionally_ correct -- every date it
  produces is a date the pipeline demonstrably has real data for, because
  it's derived from that exact data, not from a separate model of it.

**Concretely, `customRangeAnchors`'s signature changes**:

```ts
// packages/core/src/custom-range-anchors.ts
export type AnchorDate = string; // YYYY-MM-DD, matches DailyClose.date / toDateString's own format

export function customRangeAnchors(
  tradingDates: readonly string[], // ascending, e.g. buildCalendar(history).dates
  asOf: Date,
): AnchorDate[] {
  const cutoff = toDateString(
    new Date(
      Date.UTC(
        asOf.getUTCFullYear() - CUSTOM_RANGE_ANCHOR_YEARS_BACK,
        asOf.getUTCMonth(),
        asOf.getUTCDate(),
      ),
    ),
  );
  const endString = toDateString(asOf);
  return tradingDates.filter((d) => d >= cutoff && d <= endString).reverse(); // newest first, matching the existing convention
}
```

This stays a pure, easily-unit-tested function (feed it a synthetic
`tradingDates` array and a fixed `asOf`, assert the filtered/reversed
output) -- it's just no longer _itself_ the thing that can compute real
trading days from nothing. That responsibility moves to its one real
caller.

- **`apps/pipeline/src/run.ts`** (the real nightly entry point) is the
  only place `customRangeAnchors` needs real data, and it already has
  it for free by the time it would call this: `runPipeline`'s own
  `windowFetch.history` (the same full daily-close history 5Y/MAX use)
  is exactly the `Map<string, DailyClose[]>` `buildCalendar` needs.
  Concretely, inside `apps/pipeline/src/pipeline.ts`'s `runPipeline`,
  right where `buildCustomWindowResults` is already called with
  `history: windowFetch.history`, the anchor list becomes
  `customRangeAnchors(buildCalendar(windowFetch.history).dates, asOf)`
  instead of accepting a pre-computed `options.customRangeAnchors` list
  from the caller. **This is a real, deliberate shift in where the
  anchor list gets computed** -- today `src/run.ts` computes it and
  passes it into `runPipeline` as a plain option; after this change, it
  has to move _inside_ `runPipeline` (or `buildCustomWindowResults`
  itself), since only `runPipeline` has `windowFetch.history` in scope
  and it's only available _after_ the fetch completes, not before the
  call the way today's `RunPipelineOptions.customRangeAnchors` value is.
  `RunPipelineOptions.customRangeAnchors` (today: a pre-computed
  `AnchorMonth[]`, defaulting to `[]`, opted into only by `src/run.ts`)
  becomes moot for the real per-anchor list; a boolean-shaped
  `computeCustomAnchors?: boolean` (default `false`) preserves the same
  "off unless a real caller opts in, so every existing pipeline.test.ts
  fixture that doesn't care about this feature is unaffected" property
  the current default already gives, without needing every test to
  fabricate a pre-computed anchor array of its own that predates having
  fetched history to derive one from.
- **Zero new Yahoo requests** -- the single biggest reason this stayed
  cheap under the month scheme stays true under the day scheme: no new
  fetch is added anywhere by this change. Every anchor is still derived
  from data the window path was already required to fetch.

### 3.1 No forward-snapping at day granularity -- this is a real, new correctness requirement

The month scheme never needed missing-date snapping logic because
`p.date >= startDateString`'s ordinary forward-snap already handled a
month-1st landing on a weekend correctly (there's exactly one canonical
"next trading day" to snap forward to, and it's obviously what the user
meant by "the start of March 2019"). **That forward-snap is actively
wrong once anchors are themselves real trading days**: if Saturday
2019-03-16 and Sunday 2019-03-17 were naively included as calendar-day
anchors (the naive ~7,650-calendar-day approach the issue explicitly
rejects), both would forward-snap to the exact same real trading day
(Monday 2019-03-18) and produce **byte-identical `CustomWindowResult`s**
under two different, both-selectable anchor identities -- wasted compute
and storage, and a genuinely confusing product surface (two different
calendar days a user can click, both showing "the same answer," with no
indication why). This is exactly why Option A (section 3, above) doesn't
merely filter calendar days down to a plausible-looking set -- **every
element of `buildCalendar(history).dates` is, by construction, a day at
least one ticker actually has a close for**, so there is no
weekend/holiday date in the anchor list to begin with, and no
snapping-collision case to design around. This is also why "~5,292
anchors, not ~7,650 raw calendar days" (the issue's own framing) isn't
just a smaller number for its own sake -- it's the difference between
"every anchor is a real, distinct trading day" and "some anchors are
duplicates in disguise."

## 4. Schema: `CustomWindowResult` field rename, `RESULTS_SCHEMA_VERSION` bump

- **`CustomWindowResult.anchorMonth: AnchorMonth` becomes
  `anchorDate: AnchorDate`** -- the field itself, not just its type, since
  "month" is no longer an accurate name for what it holds. This is a
  reader-visible shape change to a type gated by the same global
  `RESULTS_SCHEMA_VERSION` every `PrecomputedResult` already uses (see
  section 1) -- **`RESULTS_SCHEMA_VERSION` bumps 5 -> 6**, the same
  "shape change a reader needs to know about" criterion every prior bump
  in this codebase's history has used (issues #28, #31, #12, #13). This
  carries the same rollout hazard every prior bump already has: the real
  pipeline write and the `apps/web` deploy need to happen together (or
  the pipeline first), or `apps/web` 502s every custom-anchor request
  with `schema_mismatch` until the next nightly run picks up the new
  shape -- a real-AWS action needing the user's explicit go-ahead per
  this repo's standing working agreement, not performed as part of this
  plan-only issue.
- **`anchorMonthToDate` is renamed `anchorDateToDate`** (same
  parse-to-`Date`-or-null shape, same `MIN_ANCHOR_YEAR`/max-year sanity
  floor reused unchanged -- that defensive logic has nothing to do with
  month-vs-day granularity), and its regex changes from
  `^\d{4}-(0[1-9]|1[0-2])$` to a day-shaped
  `^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$`.
- **`toAnchorMonth` is deleted, not renamed.** It existed to format a
  `Date` as `YYYY-MM` -- but `AnchorDate` is already the exact same
  `YYYY-MM-DD` shape `date-utils.ts`'s `toDateString` already produces
  (the same format `DailyClose.date`/every `WindowResult.startDate`
  already uses). There's no day-granularity equivalent formatting need
  this package doesn't already have a single source of truth for --
  every call site that used to call `toAnchorMonth(date)` calls
  `toDateString(date)` instead. One fewer function to keep in sync, not
  a like-for-like rename.
- **`customResultKey(anchorMonth: AnchorMonth)` becomes
  `customResultKey(anchorDate: AnchorDate)`** -- the template body itself
  (`` `results/custom/${anchorDate}.json` ``) is unchanged; only the
  parameter's name/type and what it holds changes. See section 5 for the
  full key-migration story.
- **`validateCustomWindowResult`** updates its one anchor-specific check
  (`anchorMonthToDate` -> `anchorDateToDate`, `anchorMonth` -> `anchorDate`
  in every error message) -- every other check it runs (shared with
  `validatePrecomputedResult`'s "window" branch via
  `validateSharedResultFields`/`validateWindowLikeFields`, see
  `results-schema.ts`'s own doc comments) is untouched, since none of it
  is anchor-format-specific.
- **New: `CustomAnchorsManifest`**, a small new type for the picker's
  valid-day list (see section 6 for why this needs its own S3 object):

  ```ts
  export interface CustomAnchorsManifest {
    schemaVersion: number; // reuses RESULTS_SCHEMA_VERSION -- see below
    anchors: AnchorDate[]; // ascending (oldest first) -- NOT customRangeAnchors' own newest-first order
  }
  ```

  **Reuses `RESULTS_SCHEMA_VERSION`, the same global constant, rather
  than inventing a second parallel version number** -- the exact same
  reasoning `CustomWindowResult` itself already documents for why it
  didn't get an exemption from this check the way the deferred
  live-compute design's own judgment call would have: this manifest
  _is_ written by a separate process (the nightly pipeline) from the one
  that reads it (`apps/web`'s new manifest route, section 6), the same
  writer/reader-drift risk this constant exists to catch everywhere else.
  A small `validateCustomAnchorsManifest` (same hand-rolled, "check every
  field, report every problem" discipline as every other validator in
  this file) checks `schemaVersion` exact-equality, `anchors` is a
  non-empty array of well-formed `AnchorDate` strings (via
  `anchorDateToDate`), and is strictly ascending with no duplicates --
  called immediately before the manifest's own `putObject`, the same
  "last line of defense before this becomes what a reader trusts"
  discipline issue #47 established for every other write.

## 5. S3 key scheme migration

- **`results/custom/{YYYY-MM}.json` -> `results/custom/{YYYY-MM-DD}.json`**
  -- mechanically just `customResultKey`'s new parameter type (section
  4); the key _shape_ (`results/custom/` prefix + identifier + `.json`)
  is unchanged, only the identifier's own format grows two extra digit
  groups.
- **New key: `results/custom/index.json`** -- the anchors manifest
  (section 4/6). Chosen specifically because it can never collide with a
  real per-anchor key: `index.json` doesn't match the
  `YYYY-MM-DD.json` shape, so a plain prefix listing of `results/custom/`
  trivially distinguishes "the one manifest object" from "every
  individual anchor result" by filename shape alone, the same
  by-prefix-alone distinguishability principle issue #11's own doc
  comment already establishes for why `results/custom/` is a separate
  prefix from the 6 flat preset-range keys in the first place.
- **No IAM/infra change needed for either**: the pipeline Lambda's S3
  grant is already `resultsBucket.grantPut(pipelineFn, "results/*")` --
  a wildcard covering the whole `results/` prefix, not enumerated
  per-key -- so writing `results/custom/index.json` or any
  `results/custom/{YYYY-MM-DD}.json` key needs no policy change.
  Confirmed by reading `infra/cdk/lib/hadiknowntrades-stack.ts` directly,
  not assumed.
- **Retiring the old `results/custom/{YYYY-MM}.json` keys**: the
  acceptance criteria require either retiring them or documenting a
  reason to keep them. **Recommendation: leave them in place,
  documented, rather than run a real-AWS delete pass.** Reasoning:
  - They become **fully inert** the moment the code change ships --
    nothing in the migrated codebase ever reads a `YYYY-MM.json`-shaped
    key again (`getCustomResultsResponse`'s `buildKey` only ever
    constructs the new day-shaped key), and nothing writes to one again
    either (the old `buildCustomWindowResults`' month-anchor code path
    is deleted, not kept as a parallel writer).
  - Their storage cost is trivial and _fixed_ (252 objects, ~431.5KB
    total, per section 1's own live-measured figure) -- it does not grow
    over time the way an unbounded accumulation would, so there's no
    creeping-cost argument for cleaning them up either.
  - A real deletion pass is a genuine real-AWS action (S3
    `DeleteObjects`, needing either a new `s3:DeleteObject` IAM grant on
    the pipeline Lambda's role -- expanding its permissions for a
    one-time cleanup that has nothing to do with its ongoing job -- or a
    manual `aws s3` pass run by the user with their own credentials).
    Per this repo's own working agreement ("anything touching real
    AWS/infra needs the user's explicit go-ahead first, every time"),
    this needs to be a deliberate, separate action either way, not
    something bundled silently into this issue's code change.
  - **This recommendation is offered, not unilaterally decided** -- see
    "For the manager" at the end; if the user would rather have a clean
    bucket, the alternative is a short one-off script (not part of the
    nightly pipeline's own code or IAM surface) the user runs once with
    their own AWS credentials, listing `results/custom/` and deleting
    every key matching the old `\d{4}-\d{2}\.json` shape specifically
    (distinguishable from the new `\d{4}-\d{2}-\d{2}\.json` shape and
    from `index.json` by length/pattern alone).

## 6. Web plumbing: the anchors manifest is a new, real architectural piece

**This is the single most consequential design decision in this plan
beyond the benchmark itself, and the issue body doesn't fully spell it
out** -- worth stating plainly: under the month scheme,
`CustomRangeSelector.tsx` computes its own option list _client-side_,
for free, because `customRangeAnchors(asOf)` needed no real data (section
1). Section 3 establishes that day-granularity anchors are no longer
computable from calendar math alone -- they can only be known by
consulting the real fetched trading-day data, which only the pipeline
(server-side, nightly) ever has. **The calendar UI therefore needs a new
network fetch it never needed before**: something has to tell the
browser which ~5,300 specific days are real, precomputed, selectable
anchors, and that can only come from the server. This is precisely what
`CustomAnchorsManifest` (section 4) and its new S3 key (section 5) exist
to serve.

- **New route: `GET /api/custom-anchors`** (`apps/web/src/app/api/custom-anchors/route.ts`),
  a small, dedicated route rather than a third branch on
  `/api/results` -- unlike `?range=`/`?anchor=` (which both resolve one
  identifier to one precomputed result via the exact same
  `getPrecomputedResultResponse` skeleton, see `results-api.ts`'s own
  doc comment on why that sharing was worth doing), this route has no
  identifier to parse and returns a different shape entirely (a flat
  manifest, not a `schemaVersion`+`model`-discriminated result) --
  forcing it through the existing `ResultRouteConfig`/
  `getPrecomputedResultResponse` shape would mean stretching that
  abstraction to cover a case it wasn't designed for, not reusing it
  cleanly. A new `getCustomAnchorsResponse(reader: ResultReader | null):
Promise<Response>` in `results-api.ts` (same `ResultReader` interface,
  same `CACHE_CONTROL` constant, same `errorResponse` helper -- genuinely
  shared plumbing, just not the parameterized skeleton) backs it:
  read `results/custom/index.json` -> JSON.parse -> check
  `schemaVersion`/`Array.isArray(anchors)` -> return `{ anchors }` with
  the standard `Cache-Control` header, or the same `server_misconfigured`
  /`upstream_error`/`not_found`/`corrupt_data`/`schema_mismatch` error
  vocabulary the existing routes already use (reusing `ApiErrorCode`,
  extended with nothing new -- every one of these cases already has a
  meaning that transfers directly to "reading a manifest object instead
  of a result object").
- **New hook: `apps/web/src/lib/use-custom-anchors.ts`**, a thin
  `useFetchResultsState<CustomAnchorsManifest>("/api/custom-anchors")`
  instantiation (the shared fetch/loading/error state machine
  `useResults`/`useCustomResults` already build on) -- fetches once per
  mount (a constant URL, never re-fetched on prop change, unlike
  `useResults(range)`/`useCustomResults(anchor)` which key their fetch
  off a changing parameter). Used exclusively by `CustomRangeSelector`.
- **`use-custom-results.ts`**: `useCustomResults(anchor: AnchorDate | null)`
  -- same shape, `AnchorMonth` -> `AnchorDate` is the only change, URL
  becomes `` `/api/results?anchor=${encodeURIComponent(anchor)}` ``
  unchanged in form (the value just has two more digit groups now).
- **`results-api.ts`**: `parseAnchorMonth` renamed `parseAnchorDate`,
  delegates to core's `anchorDateToDate` instead of `anchorMonthToDate`;
  `getCustomResultsResponse`'s error copy updates from "a YYYY-MM month"
  to "a YYYY-MM-DD date."
- **`ResultsPage.tsx`**: `anchor: AnchorDate | null =
parseAnchorDate(searchParams.get("anchor"))`; `selectAnchor(next:
AnchorDate)` -- mechanically identical shape, just the type/format
  change flowing through. The mutually-exclusive `?range=` xor `?anchor=`
  URL-state design (section 1) is untouched by this issue -- out of this
  issue's scope, and nothing about day-granularity anchors changes that
  design's own reasoning.
- **`ResultsPanel.tsx`**: the one field read (`data.anchorMonth` in the
  `heroKey` template, line 718 as of this plan) becomes `data.anchorDate`
  -- a one-line change; nothing else in this file's `"custom-window"`
  branch depends on the anchor's own format.

## 7. Calendar UI: `CustomRangeSelector.tsx`, hand-rolled, no library

**Recommendation: hand-rolled remains practical here** -- this app has no
UI library dependency anywhere (every existing control, including the
252-option `<select>` this replaces, is hand-rolled Tailwind + CSS
variable classes, per the issue's own scope note), and a month-grid date
picker with a bounded, well-understood interaction surface (one month
visible at a time, prev/next navigation, a 7-column day grid, disabled
non-anchor days) is a well-trodden UI pattern many teams hand-roll
without a library. Concrete design:

- **Trigger + popover: a native `<details>`/`<summary>`**, not a
  controlled `useState` open/close -- matches this app's own established
  disclosure pattern (`ResultsPage.tsx`'s "More options", `PortfolioChart.tsx`'s
  "View chart data as a table"), gives free keyboard toggle (Enter/Space
  on the `<summary>`) and free outside-dismissal-adjacent behavior with
  zero extra state. **This is a different case from the one real
  `<details>` bug already documented in this codebase**
  (`apps/web/CLAUDE.md`'s "Mobile layout pass" section: a _closed_
  `<details>` forced visible via a CSS override doesn't paint/hit-test
  correctly in this Chromium build) -- that bug was specifically about
  overriding native closed-state behavior with CSS; this picker uses
  `<details>` the ordinary way (native `open`/`closed` toggling, no CSS
  force-open), so it isn't exposed to that failure mode. Still worth a
  real screenshot check at implementation time (see the acceptance
  criteria's own explicit ask), including the case where this
  `<details>` is _nested_ inside `ResultsPage.tsx`'s outer "More
  options" `<details>` on mobile (a different, not-previously-exercised
  combination in this codebase, even though nested native disclosure
  widgets are ordinarily well-supported).
- **Content, once opened**: a header row (`‹` prev-month / "Month YYYY" /
  `›` next-month, each a plain `<button>`, disabled at the boundary --
  can't navigate before the oldest anchor's month or after the newest's)
  above a 7-column grid (Sun-first, matching this app's existing
  `en-US`/`toLocaleDateString` convention elsewhere) of day cells for the
  currently-viewed month, with leading/trailing blank cells aligning the
  1st to its correct weekday column.
- **Selectable vs. disabled, decided by one Set membership check**: the
  manifest's `anchors` array (section 4/6), loaded once via
  `useCustomAnchors()`, becomes a `Set<AnchorDate>` (via `useMemo`) for
  O(1) per-cell lookups. A day cell in the set renders as an enabled
  `<button>` (click -> `onSelect(dateString)` + close the `<details>`);
  a day cell not in the set (a weekend, a holiday, a day outside the
  shipped lookback window -- section 2.5's recommended 7-8 years, not the
  naive 21 -- a future date, or simply a date the pipeline hasn't
  published yet) renders as a `disabled` `<button>` -- native `disabled`
  semantics mean it's automatically skipped in tab order and can't be
  activated, which both satisfies "only real anchor days are
  selectable" and needs no custom ARIA-grid/roving-tabindex machinery to
  get basic keyboard operability right (see the note on keyboard nav
  below for why this app doesn't need to go further than this).
- **Trigger label**: "Choose a start date…" when `selected` is `null`,
  else the formatted selected date (e.g. "March 15, 2019," via the same
  `toLocaleDateString("en-US", {...})` pattern the old `formatAnchorLabel`
  already used, just with `day: "numeric"` added to the options object)
  -- carries forward the same "the constraint is discoverable by opening
  the picker, not a silent limitation" principle
  `CustomRangeSelector.tsx`'s existing doc comment already establishes
  for the placeholder option, now literally showing a real calendar
  instead of implying one.
- **New failure mode this feature introduces, designed here rather than
  left open**: the old `<select>` never needed a loading/error state (a
  pure, always-synchronously-available local computation). The calendar
  now depends on a real fetch (`useCustomAnchors()`) that can be loading
  or can fail. While loading, the `<details>` trigger renders `disabled`
  with "Loading start dates…" -- not clickable into an empty/broken
  calendar. On a fetch error, render a small inline "Start-date picker
  unavailable" message in place of the trigger, no calendar at all --
  matching this app's established graceful-degradation posture (e.g. the
  OG card route's silent 404, `BenchmarkStat`'s silent `null` render)
  rather than inventing a new error-surfacing pattern for just this one
  control.
- **On keyboard navigation, matching the issue's own explicit hedge**
  ("unless you find a concrete reason that's impractical... in which
  case flag the tradeoff rather than silently deciding to add a
  dependency"): this plan's recommendation is to ship with **full
  keyboard operability via ordinary tab order** (every enabled day cell
  and every nav button is a real, individually focusable, tabbable
  `<button>`; Enter/Space activates natively; disabled cells are
  correctly skipped) but **without** hand-rolled 2D arrow-key
  roving-tabindex grid navigation (the ARIA `grid`/`gridcell` pattern a
  fully idiomatic date-picker widget would use, where arrow keys move
  focus across/up/down the day grid and wrap across month boundaries).
  This is a genuine, real scoping call, not an oversight: implementing
  _that_ correctly (focus management, month-boundary wrapping, disabled
  cells participating correctly in arrow traversal) is meaningfully more
  new interaction code than anything else this app has hand-rolled to
  date -- `PortfolioChart.tsx`'s own keyboard support (its closest
  precedent) is a single-axis point-stepping interaction, not a 2D grid
  with focus roving through a mix of enabled/disabled cells. Tab-order
  keyboard operability alone already satisfies "everything is reachable
  and operable without a mouse" (the accessibility floor this app's own
  conventions consistently hold to elsewhere, e.g. `DaySelector`'s plain
  `<select>|`), just not the richer arrow-key affordance a dedicated
  date-picker library would provide out of the box. **This is the one
  concrete point at which "hand-rolled" has a real, non-hypothetical
  cost** relative to a library -- flagged here as the tradeoff the issue
  asked to have flagged, not silently decided either way. See "For the
  manager" for the actual go/no-go on this scoping call.

## 8. Rollout sequencing

Everything in sections 4-7 needs to land in one coordinated change, not
staged with a compatibility window -- the issue's own framing
("supersedes... end-to-end... not a third option alongside it") rules
out keeping both the month and day schemes live simultaneously. Concrete
order, once implementation starts (not performed as part of this
plan-only issue):

1. Land the code change (schema rename + version bump, pipeline
   anchor-generation + manifest write, web plumbing + calendar UI) as one
   PR/branch, same as every other issue in this repo's history.
2. **Real-AWS action, needs the user's explicit go-ahead**: run the
   nightly pipeline for real (writing schema-6 custom-window results,
   the new day-shaped keys, and the new manifest) at roughly the same
   time `apps/web` is deployed with the schema-6-aware reader code --
   the same "pipeline write and web deploy need to happen together, or
   the pipeline first" hazard every prior `RESULTS_SCHEMA_VERSION` bump
   has already needed, not a new category of risk this issue introduces.
3. Old `results/custom/{YYYY-MM}.json` keys: left in place per section
   5's recommendation, unless the user requests the one-off cleanup
   script instead.

## 9. Test impact (qualitative -- no code was written for this plan-only issue)

Not run against a real compiler/test suite the way `docs/plans/issue-60-plan.md`'s
own file-list was (that plan verified an actual, if-later-reverted,
implementation; this plan doesn't implement anything, per the issue's
own plan-first instruction). Qualitatively, from reading the current test
suite's shape:

- `packages/core/src/custom-range-anchors.test.ts` needs a full rewrite
  of its fixtures (`customRangeAnchors` now takes a `tradingDates` array
  as an explicit input rather than being self-contained), but the same
  _kind_ of coverage (boundary years, leap-adjacent dates, the
  `anchorDateToDate`/`MIN_ANCHOR_YEAR` sanity-floor cases) carries over
  directly.
- `apps/pipeline/src/pipeline.custom-range.test.ts` needs more than a
  rename: today's fixtures pass a hand-picked `AnchorMonth[]` literal
  (e.g. `anchorMonth: "2019-01"`) straight into `RunPipelineOptions`,
  independent of whatever dates the fixture's own price history actually
  covers. Under the new `computeCustomAnchors: boolean` design (section
  3), the anchor list is _derived_ from the fixture's own fetched
  history via `buildCalendar`, so a fixture's price-history dates and
  its expected anchor list can no longer be specified independently --
  every existing fixture needs its expected anchors/keys re-derived from
  its own price data instead of asserted as an arbitrary parallel list.
- `apps/web/src/components/CustomRangeSelector.test.tsx` needs a full
  rewrite -- the component's entire interaction model changes from
  "select an option" to "open a popover, navigate months, click a day
  cell," plus new loading/error-state coverage that didn't exist before
  (section 7).
- New: `apps/web/src/lib/results-api.test.ts` gains coverage for
  `getCustomAnchorsResponse`'s own error paths, mirroring
  `getResultsResponse`/`getCustomResultsResponse`'s existing coverage
  shape.
- `results-schema.test.ts` gains `validateCustomAnchorsManifest`
  coverage, mirroring `validateCustomWindowResult`'s existing tests.
- Every existing test fixture across all three packages that builds a
  `CustomWindowResult` literal (or a mock schema-5 stored object) with
  an `anchorMonth` field needs the field renamed and reformatted to
  `anchorDate`/`YYYY-MM-DD` -- a mechanical, high-count but low-risk
  change (the same class of change `RESULTS_SCHEMA_VERSION`'s own bump
  history already documents recurring on every prior bump, e.g. issue
  #13's `Trade` field rename touching every fixture that builds one).

## For the manager

Three genuine judgment calls this plan couldn't resolve from the issue
body or existing conventions alone -- flagged rather than guessed at:

1. **The exact lookback-window depth to ship.** Section 2's live
   benchmark confirms the naive 21-year/5,282-anchor extension doesn't
   remotely fit (4.5x over budget on compute alone, section 2.4), and
   section 2.5 narrows the real, numbers-backed safe range to **7-8
   years** (607s compute at 8 years / 463s at 7 years, both with real
   headroom under 900s once fetch/write/preset-range overhead is added
   back in -- see 2.5's table for the full 5-10 year breakdown).
   Shrinking the lookback is an engineering lever with a direct, visible
   product consequence -- "how far back can a user pick a custom start
   date" -- not a pure backend tuning knob, so the final depth (7 years,
   8 years, or another point in the numbers-backed range) is worth the
   user's own sign-off before it's built, the same way every other real
   product tradeoff in this repo's history has gotten one (e.g. issue
   #34's starting-capital-reset-per-day design, issue #63's
   collapsed-controls scope).
2. **Old month-keyed S3 objects: leave them in place (this plan's
   recommendation, section 5) or run a real-AWS one-off cleanup pass?**
   Both are legitimate; this is a real-AWS action either way (or a
   real-AWS inaction, if "leave them" is chosen) and per this repo's own
   working agreement needs the user's explicit go-ahead regardless of
   which way it's decided, not something to default silently.
3. **The calendar picker's keyboard-navigation scope (section 7's last
   bullet)**: this plan recommends tab-order-only keyboard operability
   (no hand-rolled arrow-key grid roving) as the practical, in-scope
   choice, and identifies this as the one place "hand-rolled, no
   library" has a real, concrete cost relative to a dedicated date-picker
   dependency (richer arrow-key interaction) -- exactly the tradeoff the
   issue's own scope note asked to have surfaced rather than silently
   decided. If full arrow-key grid navigation turns out to matter more
   than this plan estimates, that's worth confirming before
   implementation, not discovering as a gap in code review.
