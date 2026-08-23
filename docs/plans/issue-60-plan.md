# Plan: issue #60 — 1-week (1W) preset range

Status: planning only — every code change described below was actually
made in this repo's working tree, verified against the real TypeScript
compiler and the real test suite (real failures read, not guessed at),
then **reverted** before this plan was written. Every claim in this
document about "what breaks" or "what typechecks clean" is empirical,
not inferred from reading the issue body or grepping — see each
section's own "verified" note. `git status` is clean as of this plan.

## 0. One-paragraph summary

1W is additive in every sense that matters: no new `PresetRange` union
member's _plumbing_ is genuinely hard, no new Yahoo fetch, no new
pipeline compute, no `RESULTS_SCHEMA_VERSION` bump. The one real design
decision is section 2 below (how the granularity-override lookup
resolves 1W to 1M's already-fetched 1-minute data) — everything else is
"add the union member, fix what the compiler flags, add a slice in the
pipeline's final per-range loop, add copy." The issue body's own file
list for "every touchpoint TypeScript can find" turned out to be both
too broad (several listed files need zero change) and incomplete (it
misses a real one) — see section 3.

## 1. `packages/core`: `PRESET_RANGES` and `presetRangeStartDate("1W", ...)`

**Verified**: adding `"1W"` to the `PRESET_RANGES` tuple and running
`pnpm --filter core typecheck` produces exactly one compiler error:

```
src/preset-ranges.ts(41,71): error TS2366: Function lacks ending return
statement and return type does not include 'undefined'.
```

— `presetRangeStartDate`'s switch, confirming the issue's own claim that
this needs a `"1W"` case.

- Add `"1W"` as the **first** element of `PRESET_RANGES`
  (`["1W", "1M", "3M", "1Y", "5Y", "MAX"]`), not appended at the end.
  `RangeSelector.tsx` renders pills by `PRESET_RANGES.map(...)` with no
  separate ordering logic (confirmed by reading the file), so this
  placement alone satisfies the acceptance criterion "positioned before
  1M" with zero change to `RangeSelector.tsx` beyond its own required
  label-map entry (section 3).
- `presetRangeStartDate("1W", asOf)` needs **day-count** arithmetic (7
  days back), not `subtractCalendar`'s month/year semantics — confirmed
  correct per the issue's own claim.
- **On the issue's claimed "day-count pattern... around `pipeline.ts:398`"**:
  confirmed exact. `apps/pipeline/src/pipeline.ts:398-403`:

  ```ts
  /** `date` minus a plain number of calendar days, in UTC (issue #30) -- used for every granularity override's lookback window; presetRangeStartDate's month/year subtraction doesn't cover a plain days-back offset. */
  function daysBeforeUtc(date: Date, days: number): Date {
    const result = new Date(date);
    result.setUTCDate(result.getUTCDate() - days);
    return result;
  }
  ```

  This is module-private to `pipeline.ts` and apps/pipeline cannot be
  imported from `packages/core` (wrong dependency direction — core has
  no dependency on apps/pipeline), so `preset-ranges.ts` cannot reuse
  this exact function. **Recommendation**: promote an equivalent helper
  into `packages/core/src/date-utils.ts` (which currently only has
  `toDateString`), export it from `index.ts` alongside `toDateString`,
  and have `presetRangeStartDate`'s new `"1W"` case call it:

  ```ts
  // date-utils.ts
  /** `date` minus a plain number of calendar days, in UTC. */
  export function daysBeforeUtc(date: Date, days: number): Date {
    const result = new Date(date);
    result.setUTCDate(result.getUTCDate() - days);
    return result;
  }
  ```

  ```ts
  // preset-ranges.ts
  case "1W":
    return daysBeforeUtc(asOf, 7);
  ```

  **Optional, low-priority follow-on** (not required for this issue to
  ship correctly): once this shared helper exists in `packages/core`,
  `pipeline.ts`'s own private `daysBeforeUtc` (used for
  `FIVE_MINUTE_LOOKBACK_DAYS`/`ONE_MINUTE_LOOKBACK_DAYS`) becomes a
  byte-for-byte duplicate. Importing the shared one and deleting the
  local copy is a genuine, free-standing cleanup matching this repo's
  demonstrated "one source of truth, no near-duplicate helper" pattern
  (see e.g. `capHistoryToEndDate`, `toAnchorMonth` in
  `packages/core/CLAUDE.md`) — recommended, but flagged as optional
  since it's not load-bearing for 1W itself and touches a file this
  issue doesn't otherwise need to touch for compilation.

- **Verified**: with this case added, `pnpm --filter core typecheck`
  passes clean, and the existing `preset-ranges.test.ts` suite (which
  has its own per-range `describe`/`it` blocks, see below) is unaffected
  by the addition — no existing test in that file iterates
  `PRESET_RANGES` generically, so nothing there needs updating, only a
  new test needs adding (section 5).
- Sanity-checked the arithmetic by hand against the file's own fixture
  convention: `presetRangeStartDate("1W", new Date("2024-06-15T00:00:00Z"))`
  → `2024-06-08`.

## 2. `apps/pipeline`: `INTRADAY_RANGES` and the granularity-override resolution (the one real design decision)

### 2.1 `INTRADAY_RANGES`

Add `"1W"` to `INTRADAY_RANGES` (`["1W", "1M", "3M", "1Y"]`, matching
`PRESET_RANGES`'s own new ordering). **Verified**: `WINDOW_RANGES`/
`INTRADAY_RANGES` are plain `readonly PresetRange[]` values, not
compiler-checked against `PRESET_RANGES` — adding `"1W"` to
`PRESET_RANGES` alone produces **zero** TypeScript errors in
`pipeline.ts`. The only thing that catches a range left out of both
groups is the runtime test `pipeline.test.ts`'s "writes results for
every range whose path has usable data..." test, which asserts
`writtenRanges` (from `store.objects.keys()`) equals
`[...PRESET_RANGES].sort()` — **verified this test fails exactly as
designed** when `"1W"` is added to `PRESET_RANGES` but left out of
`INTRADAY_RANGES`/`WINDOW_RANGES`:

```
AssertionError: expected [ '1M', '1Y', '3M', '5Y', 'MAX' ] to deeply equal [ '1M', '1W', '1Y', '3M', '5Y', 'MAX' ]
```

This is the repo's own designed-in safety net for exactly this mistake
working correctly; no change needed to that test itself, just don't
forget the `INTRADAY_RANGES` addition it's guarding.

### 2.2 The granularity-override resolution — verified design, with a real recommendation

**This is the one genuinely non-mechanical decision in this issue.**
The issue body frames it as "the lookup... needs to resolve 1W to 1M's
entry (e.g. an explicit small mapping or override-source indirection)".
Both were considered; **recommendation: generalize
`GranularityOverrideSpec` to cover multiple consuming ranges, not a
narrow 1W-specific side-mapping.**

**Why not the narrow special case** (a small
`Partial<Record<PresetRange, PresetRange>>` alias map consulted only at
the final per-range lookup site, e.g. `granularityOverrides.get(ALIAS[range] ?? range)`):
it would work, but this repo has a direct, on-point precedent for why
that's the wrong level to solve this at. `packages/core/CLAUDE.md`'s own
"Granularity overrides" section documents that issue #29's _first draft_
added 1M's override by hand-duplicating fields through
`BuildIntradayResultsOptions` instead of generalizing
`GranularityOverrideSpec`'s own list — caught in code review as "a real
violation of the exact promise this mechanism's own #30 code comment
made" and fixed before merging. A range-alias map bolted onto the
_lookup_ site (rather than the _spec_ itself) is a smaller version of
the same mistake: it works for exactly one case (1W→1M) and any future
range wanting to piggyback on a different override (e.g. a hypothetical
future "3D" riding 3M's 5-minute data) would need its own alias entry
plus its own understanding of the lookup-time indirection, rather than
just appending to the one list `buildGranularityOverrideSpecs` already
returns — the same "should be one array entry, not another hand-touched
spot" bar this file's own doc comments hold every future override to.

**Recommended design**: `GranularityOverrideSpec.range: PresetRange`
becomes `GranularityOverrideSpec.ranges: readonly PresetRange[]` — the
set of preset ranges this one fetch's override data serves. The merge
(`optimizeIntradayDays` + `mergeDaysByGranularity`) still runs **once**
per spec, not once per consuming range; the resulting `GranularityOverride`
object is registered in the `granularityOverrides` map under **every**
range in `spec.ranges`, sharing the identical already-computed object:

```ts
// buildGranularityOverrideSpecs:
{
  ranges: ["1M", "1W"],
  label: "1-minute",
  barIntervalMinutes: 1,
  from: daysBeforeUtc(asOf, ONE_MINUTE_LOOKBACK_DAYS),
  fetchBars: options.fetchIntraday1mBars,
},

// buildIntradayResults' override loop, after the existing merge:
const override: GranularityOverride = {
  days: mergedDays,
  extraHistories: [cappedOverrideHistory],
  extraSkipped: outcome.skipped,
  extraDataAsOf: outcome.dataAsOf,
};
for (const range of spec.ranges) {
  granularityOverrides.set(range, override);
}
```

The **final per-range slicing loop itself needs zero special-casing for
1W** — it already does `granularityOverrides.get(range)` per range, and
now finds a real entry for `"1W"` the same way it finds one for `"1M"`,
because the population step (not the lookup step) is what changed. The
existing per-range date-window filter
(`sourceDays.filter(day => day.date >= startDateString && day.date <= endDateString)`)
already narrows the shared `days` array down to 1W's own 7-day window
correctly — no additional slicing logic needed there either, since that
filter is already keyed off each range's own `presetRangeStartDate`
output, not off which override entry it came from.

Three other `spec.range` (singular) usages need updating to
`spec.ranges.join("/")` for their log/status-message strings (the two
`overrideSolveFailures.push` sites and the final `overrideStatusLines`
message) — mechanical, cosmetic-only changes; the actual computed data
is unaffected.

**Why this is provably correct, not just "seems to work"**: `mergeDaysByGranularity`
merges `primaryDays` (the _full_ base 60-minute fetch, from
`presetRangeStartDate("1Y", asOf)` — i.e. covering up to a year back)
with `overrideDays` — every day is set from `primaryDays` first, then
overlaid by `overrideDays` for any date it also covers (`pipeline.ts:493-514`).
So a spec's resulting `mergedDays` array is **not** truncated to that
spec's own lookback window (~29 days for the 1-minute override) — it
spans the full base fetch's range, with only the days inside the
override's own lookback upgraded to finer granularity. This is exactly
why reusing the _same_ `GranularityOverride.days` array for both "1M"
and "1W" is safe: 1W's own final per-range filter narrows that already-full
array down to its own 7-day window, and every day in that 7-day window
is guaranteed to already be present (sourced from `primaryDays` at
minimum, upgraded to 1-minute wherever the override's ~29-day lookback
reaches — which fully covers 1W's 7-day window in every case, since 7 <
29). The same reasoning applies to `extraHistories`/`extraSkipped`/
`extraDataAsOf`: they're `override.extraHistories`/`extraSkipped`/
`extraDataAsOf` from the _same_ 1-minute fetch outcome, and the
`universeSize`/`skippedTickers`/`dataAsOf` computations already scope
themselves to each range's own `startDateString`/`endDateString` window
when consuming them (see `pipeline.ts`'s per-range loop, `tickersInRange`
computed via `hasBarInRange` checked against that range's own bounds) —
so no separate narrowing is needed for those either.

**Empirically verified end-to-end** (implemented this exact design in
the working tree, wrote a throwaway Vitest file, ran it, then reverted
both — no S3 write, no real network I/O, synthetic fixture only):

- A 1-minute fetch mock was called **exactly once** for the whole
  `runPipeline` invocation (`oneMinuteFetchCallCount === 1`) — confirms
  1W triggers **no second fetch call**, matching the issue's own "1W's
  data is close to free" claim and the "no new fetch call" acceptance
  criterion.
- `results/1W.json` was written, with exactly one day in its `days`
  array (the fixture had bars 3 days back — inside 1W's 7-day window —
  and 20 days back — inside 1M's window but outside 1W's), confirming
  the per-range date filter correctly narrows the shared override data
  down to 1W's own window and doesn't leak 1M's older days into it.
- That one day's `barIntervalMinutes` was `1` and its trade used the
  1-minute fixture's price (`closePrice: 50`), not the coarser 60-minute
  fixture's price (`20`) — confirms 1W actually gets the upgraded
  granularity, not silently falling back to 60-minute bars.
- The aggregated status message correctly read `1-minute path (1M/1W
only, non-fatal): ok.` — confirms the `spec.ranges.join("/")` status-line
  change reads sensibly.

### 2.3 What does _not_ need to change in `apps/pipeline`

- `run.ts`: **no change**. No new `fetch*Bars` field is added to
  `RunPipelineOptions` (1W reuses `fetchIntraday1mBars`, already wired),
  so `run.ts`'s own call to `runPipeline(...)` needs nothing new.
- `fetchUniverseHistory`/`fetchPathHistory`/`mapWithConcurrency`: no
  change — these are all already generic over range/fetch-function, and
  this issue adds no new fetch pool at all.
- The window path (`WINDOW_RANGES`, `buildWindowResults`,
  `computeWindowOptimization`): untouched, confirming the issue's own
  "1W is a preset range only, no change to the whole-window model"
  out-of-scope note.

## 3. `apps/web`: the real, compiler-verified touchpoint list — and where the issue's own list is wrong

**Method**: added `"1W"` to `PRESET_RANGES` in the working tree and ran
`pnpm --filter web typecheck` (which runs `next typegen && tsc --noEmit`),
then `pnpm -r typecheck` across the whole monorepo to confirm nothing
else was missed. Fixed each reported error with a minimal `"1W"` case,
re-ran until clean. This is the complete, real list — not the issue
body's own claimed list, which turned out to be inaccurate in both
directions.

### 3.1 Files that genuinely need a `"1W"` case (compiler-verified)

1. **`packages/core/src/preset-ranges.ts`** — `presetRangeStartDate`'s
   switch (section 1).
2. **`apps/web/src/components/RangeSelector.tsx`** — `RANGE_LABELS: Record<PresetRange, string>`.
   Add `"1W": "1W"` (matching the existing bare-range-name convention
   for every entry except `MAX`/`"Max"`).
3. **`apps/web/src/components/ResultsPanel.tsx`** — `RANGE_COPY: Record<PresetRange, string>`.
   Add `"1W": "the past week"` (matching the issue's own suggested copy
   and the existing "the past N..." convention).
4. **`apps/web/src/lib/og-card.ts`** — `rangeLabel`'s switch. **This file
   is not in the issue body's own file list at all** — a real gap in the
   issue's own grep pass, found only by running the real compiler.
   `rangeLabel(range: PrecomputedResult["range"])` is typed over the
   full `PresetRange` union (it takes `content.range`, an
   `OgCardContent.range`), even though in practice `OgCard.tsx` only
   ever calls it with a `"window"`-model result's range (`buildOgCardContent`
   returns `null` for every non-`"window"` result, and 1W is always
   `"intraday-daily"` — see section 3.2). TypeScript's exhaustiveness
   check doesn't know that at the type level, so it still requires a
   case. Add `case "1W": return "1 week";` — dead code on every real
   run (1W never reaches an OG card, per the issue's own explicit
   out-of-scope note), but required for compilation.

With exactly these four cases added, `pnpm -r typecheck` (all 5
workspace projects: `packages/core`, `apps/pipeline`, `apps/web`,
`infra/cdk`) passes clean. No other file in the repo needs a
compiler-forced `"1W"` case.

### 3.2 Files the issue body lists that need **zero** code change (verified, not assumed)

The issue's own Background section claims "every touchpoint TypeScript
can find via this union needs a '1W' case" and lists eight files besides
`preset-ranges.ts`/`results-schema.ts`. Of those eight, **only two**
(`RangeSelector.tsx`, `ResultsPanel.tsx`) actually needed a change per
the real compiler. The rest are genuinely generic over `PresetRange`
already, confirmed by reading each one and by the clean `pnpm -r typecheck`
above:

- **`apps/pipeline/src/pipeline.ts`**: needs `INTRADAY_RANGES`/the
  override generalization (section 2) — real, required changes, but
  **not** compiler-forced the way the issue's framing implies; they're
  required by the runtime "covers every PresetRange" test and by the
  feature's own correctness, not by `tsc`.
- **`apps/web/src/app/api/og/[range]/route.tsx`**: zero change needed.
  `isCanonicalRange` is a generic `(PRESET_RANGES as readonly string[]).includes(...)`
  membership check, and `buildOgCardContent` branches on `result.model`,
  never on `range` directly — this route will simply 404 for `1W` the
  same way it already does for `1M`/`3M`/`1Y` today (all `"intraday-daily"`,
  no card), with no code path change at all.
- **`apps/web/src/lib/results-api.ts`**: zero change needed.
  `parseRange`/`isCanonicalRange` are both generic membership checks
  against `PRESET_RANGES`, not switches.
- **`apps/web/src/lib/use-results.ts`**: zero change needed. `useResults`
  builds a URL via a template literal (`` `/api/results?range=${range}` ``),
  no switch/map.
- **`apps/web/src/lib/use-daily-guess.ts`** and
  **`apps/web/src/lib/daily-guess-storage.ts`**: zero change needed —
  see section 4, this is the specific claim the task asked to verify
  rather than assume.
- **`apps/web/src/components/ResultsPage.tsx`**: zero change needed.
  Its only `PresetRange`-typed value is `DEFAULT_RANGE: PresetRange = "1Y"`,
  a constant unaffected by the union growing a new member; every other
  `PresetRange` usage here is a plain type annotation on state, not a
  switch/map.
- **`packages/core/src/results-schema.ts`**: zero change needed, but
  worth being precise about _why_, since this one is more subtle than
  "no switch exists." `validateBase`'s own range check
  (`(PRESET_RANGES as readonly string[]).includes(result.range as string)`)
  is already a generic membership check against the live `PRESET_RANGES`
  export, not a hardcoded list — it accepts `"1W"` automatically the
  moment the tuple grows. No `WindowResult`/`IntradayResult`/`CustomWindowResult`
  field is range-specific in shape. Confirmed no compiler error here
  either.

### 3.3 New test needed: pill ordering

`RangeSelector.test.tsx`'s existing tests all iterate `PRESET_RANGES`
generically (`for (const range of PRESET_RANGES) ...`) and pass
unmodified once `"1W"` exists — verified: the full `apps/web` suite (361
tests, 37 files) passed with **zero** test-file changes, only the two
`Record` fixes in section 3.1. But no existing test asserts pill
_order_, which the acceptance criteria explicitly calls out ("positioned
before 1M"). Add one new test asserting the rendered button order
matches `PRESET_RANGES`'s own order (or more narrowly, that "1W"'s
button precedes "1M"'s in the DOM) — this is a real, currently-untested
requirement, not just documentation.

## 4. `daily-guess-storage.ts` / `use-daily-guess.ts`: confirmed genuinely generic, zero-touch

The issue's own Background text hedges on this ("This also means 1W
gets the existing daily guessing-game gate... for free"), and the task
specifically asked to confirm this isn't an assumption, since guesses
are keyed by `(range, date, mode)`. Verified by reading both files in
full:

- `daily-guess-storage.ts`'s `keyFor`/`legacyKeyFor` both take
  `range: PresetRange` and interpolate it into a template-literal
  storage key (`` `${KEY_PREFIX}${range}:${date}:${mode}` ``) — no
  switch, no `Record<PresetRange, ...>`, no enumeration of range values
  anywhere in the file. A guess made under `range: "1W"` gets its own
  distinct key (`hikt:daily-guess:1W:{date}:{mode}`) automatically,
  correctly distinct from `"1M"`'s keys for the same calendar date — the
  exact keying property the file's own header comment says this
  mechanism exists to guarantee, extended to a new range for free.
- `use-daily-guess.ts`'s `useDailyGuess(range: PresetRange | null, date, mode)`
  only ever passes `range` through to `getDailyGuess`/`saveDailyGuess`
  (both generic per above) or checks `range === null` (the custom-anchor
  case, unrelated to 1W) — no range-specific branching.
- **Confirmed via the full `apps/web` test suite passing unmodified**
  (section 3.3) that this isn't a false-negative from reading the code
  in isolation — nothing in the daily-guess machinery broke or needed a
  fixture change when `"1W"` was added to the live `PRESET_RANGES` used
  throughout the test suite.

**Conclusion: genuinely zero-touch, not an assumption.** This is one of
the few places the issue body's own "for free" framing is fully correct
as stated.

## 5. Test plan — the real, compiler/test-verified list

**Method**: this section's file/line list comes from actually running
`pnpm --filter core test`, `pnpm --filter pipeline test`, and
`pnpm --filter web test` with `"1W"` wired all the way through
(`PRESET_RANGES`, `presetRangeStartDate`, `INTRADAY_RANGES`, and the
`GranularityOverrideSpec.ranges` generalization from section 2) and
reading the real failures — not guessed at from grepping for the number 5.

### 5.1 New tests

- **`packages/core/src/preset-ranges.test.ts`**: a new
  `it("subtracts 7 days for 1W", ...)` alongside the existing per-range
  tests, asserting `presetRangeStartDate("1W", asOf)` → `"2024-06-08"`
  for the file's existing `asOf = 2024-06-15` fixture. Also worth a
  month-boundary-crossing case (e.g. `asOf` early in a month, so the
  7-day-back date falls in the _previous_ month) exercising plain
  day-count arithmetic near a month boundary — the existing
  month-end-clamping `describe` block doesn't cover this since it's
  about `subtractCalendar`'s clamping, not `daysBeforeUtc`'s much
  simpler arithmetic, but a quick sanity check costs little.
- **`apps/pipeline/src/pipeline.test.ts`**: a new "1-week path (1W,
  issue #60)" `describe` block (structurally mirroring the existing
  "5-minute path"/"1-minute path" blocks) asserting: 1W's days are
  sourced from the shared 1-minute override (a day inside 1W's 7-day
  window shows `barIntervalMinutes: 1` and the 1-minute fixture's
  price, not the 60-minute fixture's), and — the acceptance criterion's
  own explicit ask — that `fetchIntraday1mBars` is called **exactly
  once** per ticker for the whole run (a call-counting mock, exactly
  the technique used in this plan's own section-2.2 verification),
  confirming 1W introduces no second fetch.
- **`apps/web/src/components/RangeSelector.test.tsx`**: the pill-ordering
  test from section 3.3.

### 5.2 Existing tests with hardcoded assumptions that need updating

**`apps/pipeline/src/pipeline.test.ts`** (verified via a real
failing-test run with 1W fully wired — 8 of 56 tests in this file failed
before any fix):

| Line | Current                                            | Needs to become                                                                     |
| ---- | -------------------------------------------------- | ----------------------------------------------------------------------------------- |
| 91   | `expect(store.objects.size).toBe(5)`               | `6`                                                                                 |
| 92   | `expect(summary.results).toHaveLength(5)`          | `6`                                                                                 |
| 277  | `.rejects.toThrow(/wrote 3 of 5 expected result/)` | `/wrote 4 of 6 expected result/` (verified exact count via the real thrown message) |
| 419  | `.rejects.toThrow(/wrote 2 of 5 expected result/)` | `/wrote 2 of 6 expected result/`                                                    |
| 597  | `expect(summary.results).toHaveLength(5)`          | `6`                                                                                 |
| 925  | `expect(summary.results).toHaveLength(5)`          | `6`                                                                                 |
| 1182 | `expect(summary.results).toHaveLength(5)`          | `6`                                                                                 |
| 1288 | `.rejects.toThrow(/wrote 3 of 5 expected result/)` | `/wrote 4 of 6 expected result/`                                                    |
| 1310 | `.rejects.toThrow(/wrote 2 of 5 expected result/)` | `/wrote 2 of 6 expected result/`                                                    |

Line 157 (`expect(writtenRanges).toEqual([...PRESET_RANGES].sort())`)
needs **no change** — it's already generic, this is the test that
_catches_ the "forgot to wire up 1W" mistake (section 2.1), not one
that needs updating for it.

**`apps/pipeline/src/pipeline.custom-range.test.ts`** (3 of its own
tests failed in the same verification run):

| Line | Current                                   | Needs to become                            |
| ---- | ----------------------------------------- | ------------------------------------------ |
| 116  | `expect(summary.results).toHaveLength(5)` | `6`                                        |
| 117  | `expect(store.objects.size).toBe(7)`      | `8` (6 preset + 2 custom anchors, was 5+2) |
| 189  | `expect(store.objects.size).toBe(5)`      | `6`                                        |
| 346  | `expect(objects.size).toBe(5)`            | `6`                                        |

**`apps/pipeline/src/pipeline.write-validation.test.ts`** (2 tests
failed):

| Line | Current                              | Needs to become |
| ---- | ------------------------------------ | --------------- |
| 140  | `expect(store.objects.size).toBe(4)` | `5`             |
| 198  | `expect(store.objects.size).toBe(3)` | `4`             |

**`apps/web`**: **verified zero test changes needed** beyond the two
`Record` fixes already covered in section 3.1/3.3 — the full 361-test,
37-file suite passed unmodified once those two fixes were in place
(before even adding the pill-ordering test from section 3.3, which is
new coverage, not a fix to something broken).

**`packages/core`**: **verified zero existing test changes needed** —
the full 1141-test suite passed unmodified with `"1W"` added to
`PRESET_RANGES` and the new switch case in place; only a new test needs
adding (section 5.1).

### 5.3 What this list does _not_ cover

The counting-literal updates in 5.2 are almost certainly not exhaustive
for every conceivable future fixture combination in `pipeline.test.ts`
(a 583+-line file with many independent test blocks) — this plan's list
is what a real, full test run against the fully-wired feature actually
flagged, which is a much stronger basis than grepping for "5", but a
final implementation pass should still run the full suite once more
after making these changes and fix anything this pass didn't happen to
exercise (e.g. a test whose fixture bars happen to fall outside 1W's own
7-day window would silently produce a `days: []` for 1W rather than a
count mismatch, and wouldn't show up as a failure in this pass unless
it also asserts on `1W`'s specific day contents).

## 6. Rollout / schema-version check

**Verified, matches the issue's own claim exactly**: this is additive to
`PRESET_RANGES` (a new value in an already-generic union) with **no**
shape change to `IntradayResult`, `WindowResult`, or any nested type.
`validateBase`'s range check (section 3.2) and every field-level
validator in `results-schema.ts` are unaffected. **No
`RESULTS_SCHEMA_VERSION` bump is needed** — confirmed by reading
`results-schema.ts` end to end, not just trusting the issue's own
precedent citation (`barIntervalMinutes` landing additively at schema
version 5 without a bump, per `packages/core/CLAUDE.md`'s "Mixed-granularity
1M/3M assembly" section, is the same class of change: a genuinely new
_value_ the schema already generically accommodates, not a new _field_
either, which is an even smaller change than that precedent).

This means 1W's code can land and merge without the "pipeline must write
the new schema atomically with the web deploy" hazard every prior
schema-version bump in this repo has needed (see
`apps/pipeline/CLAUDE.md`'s bump history) — the existing deployed S3
data (schema v1, already stale per `infra/CLAUDE.md`) is orthogonal to
this issue and stays exactly as stale/fresh as it already is until the
user separately approves a real pipeline run. This plan introduces
**no** real S3 write and **no** schema-version change, matching the
issue's own explicit out-of-scope note.

## 7. Live verification plan (not performed as part of this planning task)

Per this repo's standing working agreement (verify live at least once
per feature) and the issue's own acceptance criterion ("Local pipeline
run (no S3 write) confirms 1W's per-day results are populated with
1-minute-granularity data reused from 1M's fetch"):

- A real local pipeline run (real Yahoo network calls, real S&P 500
  universe or a small subset, `store` swapped for an in-memory/throwaway
  one — no real `putObject` call, same technique this repo's other
  "live-verified, no S3 write" notes use throughout both `CLAUDE.md`
  files) confirming: `results/1W.json`'s `days` array is non-empty and
  every day in it has `barIntervalMinutes: 1` (or falls back to `60` for
  the rare day the 1-minute fetch didn't reach, exactly like 1M's own
  existing behavior) with no `fetchIntraday1mBars` call count higher
  than what 1M alone already causes.
- Confirm `generatedAt`/`dataAsOf` for `results/1W.json` are sane
  relative to the other ranges' — nothing about this feature should
  change how those are derived (section 2.2's `dataAsOf` reasoning
  already covers why the shared-override `extraDataAsOf` value is
  correct to reuse as-is for 1W), but worth eyeballing on real data once.
- A screenshot of the running app (this repo's `run`/screenshot
  conventions, `apps/web/CLAUDE.md`'s "Screenshotting a component
  locally" section, since there's no local `RESULTS_BUCKET`) with a
  throwaway fixture confirming the "1W" pill renders before "1M", the
  intraday-daily view (day selector, per-day guess form, worst-case
  stat, benchmark stat) renders correctly scoped to a 7-day window, and
  the copy reads sensibly ("the past week").

## 8. Deviations from the issue as filed — summary

Restating explicitly, since the task calls out that contradicting the
issue body is a first-class output here, not something to silently work
around:

1. **The issue's own "every touchpoint" file list is inaccurate in both
   directions** (section 3): `apps/pipeline/src/pipeline.ts`,
   `apps/web/src/app/api/og/[range]/route.tsx`,
   `apps/web/src/lib/daily-guess-storage.ts`,
   `apps/web/src/lib/results-api.ts`, `apps/web/src/lib/use-daily-guess.ts`,
   `apps/web/src/lib/use-results.ts`, and
   `apps/web/src/components/ResultsPage.tsx` do **not** need a
   compiler-forced `"1W"` case (some need functional changes for other
   reasons — `pipeline.ts` does, per section 2 — but not because
   TypeScript flags them). Meanwhile **`apps/web/src/lib/og-card.ts`**,
   not mentioned anywhere in the issue body, **does** need one
   (`rangeLabel`'s switch, section 3.1).
2. **The `pipeline.ts:398` line citation is correct** — the issue's one
   specific, checkable citation held up exactly as claimed.
3. **The `daily-guess-storage.ts`/`use-daily-guess.ts` "for free" claim
   is correct**, confirmed rather than assumed (section 4).
4. **The schema-version claim is correct** — no bump needed (section 6).
5. **The granularity-override resolution recommendation goes further
   than the issue's own "small mapping" suggestion**: a generalized
   `GranularityOverrideSpec.ranges: readonly PresetRange[]` field
   (section 2.2), not a side-table alias consulted only at the lookup
   site — this is a stronger, more reusable design than either option
   the issue's own Background text raised as an example, chosen and
   empirically verified during this planning pass rather than left as
   an open implementation-time judgment call.
