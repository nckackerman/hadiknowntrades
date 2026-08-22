# Plan: issue #31 - worst-case trade sequence contrast stat

Status: **plan only, not implemented**. Written against `main` at
`ee88eea` (post-#52). Per this repo's working agreement, this issue
touches the stored data shape (`RESULTS_SCHEMA_VERSION` bump,
`PrecomputedResult` schema, pipeline output) and gets a plan-first,
review-before-implementation pass, matching `docs/plans/issue-28-plan.md`
and `docs/plans/issue-29-plan.md`.

## 0. One-paragraph summary

Add a second, parallel optimizer run per range that finds the _worst_
achievable <=3-trade sequence (same DP, `min` instead of `max` at every
step), store it as a new `worstCase` field alongside the existing
optimal-case fields, bump `RESULTS_SCHEMA_VERSION` 2 -> 3, wire it through
`apps/pipeline`, and surface it in `apps/web` as a small, de-emphasized
contrast stat next to `HeroStat`. The core algorithmic change is a
`direction: "max" | "min"` parameter threaded through `computeLevel`
(`packages/core/src/optimizer.ts`), reusing every other part of the DP
unchanged. The acceptance criteria explicitly says "all 5 preset
ranges," which means this has to reach **both** result models
(`WindowResult` for 5Y/MAX, `IntradayDayResult` for 1M/3M/1Y's per-day
model) -- not just the window one the issue's own Background section
illustrates the algorithm with.

## 1. The DP in the min direction (`packages/core/src/optimizer.ts`)

Read the file's full header comment and body before touching anything --
already done for this plan; summarizing only what changes.

### 1.1 What actually needs to flip, mechanically (not a judgment call)

`computeLevel` computes `bestValue[k]` from `bestValue[k-1]` via a
suffix-max pass per ticker. Three things must invert for a suffix-_min_
pass to be correct, none of them optional:

1. **The sentinel for "no trade possible here."** `g[i] = p === null ?
NEG_INFINITY : p * prevValue[i+1]`. `NEG_INFINITY` exists so a missing
   price never wins a _max_ search. For a _min_ search, a missing price
   must never win either -- so the sentinel has to become
   `POSITIVE_INFINITY`, not stay `NEG_INFINITY` (which would trivially
   "win" every min-comparison and corrupt the whole result). This is the
   single most important correctness detail in this plan, and it's easy
   to get wrong by only skimming "replace max with min."
2. **The suffix-pass and running-best comparisons** (`suffixMaxG`'s
   `g[i] >= suffixMaxG[i+1]`, and `runningBestValue`'s
   `candidateRatio >= runningBestValue`) need to become `<=` for a
   suffix-_min_/running-_min_ search, with their own starting sentinel
   also flipped to `POSITIVE_INFINITY` (was `NEG_INFINITY`).
3. **The "does this trade replace the carry-forward baseline" check**
   (`runningBestValue > value[d]`, strict) needs to become strict `<`
   (`runningWorstValue < value[d]`) -- a trade is only taken if it's
   _strictly worse_ than not trading, mirroring the existing rule that a
   trade is only taken if it's _strictly better_ than not trading. See
   1.3 for why this needs to stay a strict inequality in both directions,
   not `<=`.

**Rejected alternative, worth recording so it isn't re-proposed**:
negating every value and reusing the max-direction code as-is (`min(a,b)
== -max(-a,-b)`). This is the standard trick for _additive_ scores, but
`computeLevel`'s `value[d]` is a _multiplicative growth ratio_, not an
additive score, and it's also the actual number that flows downstream
into `finalMultiplier`/`endingBalance` (`startingCapital *
finalMultiplier`). Negating it would produce a nonsensical negative
"multiplier" that would need un-negating before use, which is more
surface area for a sign-flip bug than just parameterizing the four
comparison sites directly. Not used.

### 1.2 Design: `direction` threaded through `computeLevel`, not a second function

The issue offers both options; this plan recommends threading a
`direction: "max" | "min"` parameter through `computeLevel` itself
(module-private, not exported -- same visibility as today), rather than a
copy-pasted `computeLevelMin`. Concretely:

```ts
type Direction = "max" | "min";

function computeLevel(
  T: number,
  sortedTickers: [string, (number | null)[]][],
  prevValue: number[],
  direction: Direction,
): Level {
  const worstSentinel = direction === "max" ? NEG_INFINITY : POSITIVE_INFINITY;
  const isBetterOrEqual =
    direction === "max" ? (a: number, b: number) => a >= b : (a: number, b: number) => a <= b;
  const isStrictlyBetter =
    direction === "max" ? (a: number, b: number) => a > b : (a: number, b: number) => a < b;
  // ... body identical in shape to today's, with NEG_INFINITY -> worstSentinel,
  // `>=` -> isBetterOrEqual(...), `>` -> isStrictlyBetter(...) at the four
  // sites in section 1.1, and runningBestValue/suffixMaxG's initial fill
  // value changed from NEG_INFINITY to worstSentinel.
}
```

This satisfies the issue's explicit "reuse the existing DP machinery;
don't duplicate it wholesale" instruction: `computeLevel`'s structure,
comments, and every loop shape stay identical; only four comparison
sites and two sentinel initializations change from hardcoded constants
to direction-derived ones.

**Top-level API: a new sibling function, not a parameter on
`optimizeTrades`.** The issue's own "Out of scope" note says "changing
the existing optimal-case computation or its display" is not wanted.
Concretely, this plan extracts the shared body of today's
`optimizeTrades` (validation, `buildCalendar`, ticker sort, the
level-building loop, `reconstructTrades`, the `endingBalance`
finite-check) into a private `runOptimizer(priceSeriesByTicker, options,
direction): OptimizationResult`, and makes:

```ts
export function optimizeTrades(priceSeriesByTicker, options): OptimizationResult {
  return runOptimizer(priceSeriesByTicker, options, "max");
}

export function optimizeWorstTrades(priceSeriesByTicker, options): OptimizationResult {
  return runOptimizer(priceSeriesByTicker, options, "min");
}
```

`optimizeTrades`'s exported signature and behavior are unchanged (zero
diff risk to any existing caller), and `optimizeWorstTrades` is new,
additive, sharing 100% of the validation/calendar/reconstruction logic.
`reconstructTrades` itself needs **no** direction-awareness -- it only
follows `choice` pointers that `computeLevel` already computed correctly
per-direction.

### 1.3 The tie-break question the issue explicitly asks about

The issue says: "double-check the deterministic tie-break rule
(alphabetically-first ticker wins on a tied ratio) still makes sense
inverted for the min direction. Don't assume it degenerates the same way
without checking." Worked through below -- there are actually **three**
separate tie-breaks in this DP, not one; the issue only names the most
visible of them.

1. **Across tickers, on a tied best ratio for the same day (`d`):** the
   existing code iterates `sortedTickers` (alphabetical) and only
   overwrites `value[d]`/`choice[d]` on strict `>`, so the
   alphabetically-_first_ ticker processed keeps its slot on a tie.
   **Recommendation: reuse verbatim, don't invert.** This rule's entire
   purpose in the max direction is determinism/reproducibility (same
   input -> same output every run), not a meaningful semantic preference
   -- a genuine float-precision tie between two different tickers'
   achieved ratio is vanishingly rare with real price data. There's no
   principled reason "the worst case" should prefer a _different_
   arbitrary tie-break identity than "the best case" does; inverting it
   (e.g. alphabetically-_last_ wins for min) would add a second rule to
   remember and document for zero behavioral benefit. Keeping the same
   `sortedTickers`/strict-`>`-to-overwrite structure for both directions
   naturally reuses this rule unchanged -- no separate code path needed.
2. **Within one ticker, on a tied ratio across different buy/sell day
   pairs:** the suffix-min/running-min passes' `<=` (mirroring the
   existing `>=`) means the _earliest_ qualifying sell day and _earliest_
   qualifying buy day win ties, in both directions. Same reasoning as
   (1): arbitrary but deterministic, no reason to reverse it, and it
   falls out "for free" from mechanically flipping `>=` to `<=` (the
   _direction_ of the operator relative to which index is examined first
   in the backward loop is what preserves "earliest wins," not something
   that needs separate design).
3. **Between "take a trade" and "carry forward" (use fewer trades), on an
   exact tie:** the existing strict `>` means ties go to "carry forward"
   in the max direction -- a trade is only used if it's _strictly_
   better than not trading. The mechanical translation (section 1.1,
   point 3) is strict `<`: a trade is only used if it's _strictly worse_
   than not trading, so ties again go to "carry forward" in the min
   direction too. **This is the one place where "keep it symmetric"
   isn't just an arbitrary-tie-break judgment call -- it falls directly
   out of the "at most N trades" semantics staying meaningful in both
   directions**: the DP should never be forced to use a trade slot that
   doesn't change the direction-relevant outcome, whether searching for
   best or worst. Using `<=` instead here would be a real behavior
   change (using a trade slot even when it's exactly as good/bad as not
   trading), not just a different tie-break identity -- not recommended.

**Conclusion the plan reaches**: none of the three tie-break rules should
be inverted. All three carry over from the max direction to the min
direction completely unchanged in _rule_, which is also why they don't
need separate code paths -- they fall out of reusing the same
`sortedTickers` order, the same relative-operator shape (`>=`/`<=`
paired with `>`/`<`), and the same strict-inequality-for-baseline-
replacement structure, just with the comparison direction itself
parameterized. This is the answer to the issue's explicit "double-check"
ask: checked, and the rule holds up unchanged under inversion because
none of the three tie-breaks was ever really "about" maximizing in the
first place -- they're all about determinism given an otherwise-tied
objective, and that reasoning is direction-agnostic.

### 1.4 A real edge case worth flagging (open question, not resolved here)

Because "carry forward" (multiplier exactly `1`, i.e. holding cash) is
always an available option and a strict inequality gates using a trade
instead, the min-direction DP will only choose a trade if a _losing_
trade (ratio `< 1`) is available in the remaining search space for that
slot; if every remaining ticker/day option in a slot only has _winning_
trades, the worst-case DP will prefer not to trade at all (multiplier
`1`, which is smaller than any ratio `> 1`). Concretely: **it is
mathematically possible, for a sufficiently short/lucky window, for the
"worst case" DP to still show a net gain (or use fewer than 3 trades)**,
if literally every ticker in the S&P 500 rose across the whole window.
This is symmetric to the existing max-direction comment ("with real
price data across many tickers it essentially always uses the full
budget") -- overwhelmingly unlikely with a 500+-ticker universe over any
real window, but not structurally impossible, and worth deciding whether
UI copy should hedge against it (e.g. not hard-coding "you'd have lost
money" framing) rather than assuming a worst-case figure is always a
loss. **Open question, flagged for the implementer/reviewer, not
resolved in this plan.**

## 2. Schema change (`packages/core/src/results-schema.ts`,

`packages/core/src/intraday-optimizer.ts`)

### 2.1 Which result model(s) need this

The issue's Background section illustrates the algorithm using
`optimizer.ts` (the window model's DP), and its "sibling
`OptimizationResult`-shaped field" phrasing most directly matches
`WindowResult`'s shape. But the **acceptance criteria explicitly says
"all 5 preset ranges"** -- which includes 1M/3M/1Y, served by
`IntradayResult`/`IntradayDayResult` (see
`packages/core/CLAUDE.md`'s "Per-day intraday optimizer" section:
`optimizeIntradayDays` is a thin per-day wrapper around `optimizeTrades`,
with no compounding across days). This plan treats both models as in
scope, per the acceptance criteria, not just the model the issue's
Background prose illustrates with.

### 2.2 `RESULTS_SCHEMA_VERSION`: 2 -> 3

Bumped per the issue's explicit instruction, and because this is exactly
the kind of change the constant's own doc comment gates on ("a shape
change a reader needs to know about") -- unlike issues #29/#30's
additive, unread `barIntervalMinutes` field, `apps/web` _will_ read
`worstCase` for its new UI, so the "not bumped" precedent those issues
set does not apply here.

### 2.3 New types

`packages/core/src/results-schema.ts`:

```ts
/**
 * The worst achievable <=maxTrades outcome over the same window (issue
 * #31) -- same shape as the sibling optimal-case fields, minus
 * startingCapital, which is identical to the already-present sibling
 * value and not worth duplicating (see section 2.4 below for why this
 * plan doesn't reuse the exported OptimizationResult type verbatim).
 */
export interface WorstCaseResult {
  endingBalance: number;
  trades: Trade[];
}
```

`WindowResult` gains: `worstCase: WorstCaseResult`.

`packages/core/src/intraday-optimizer.ts`:

```ts
/** Per-day worst-case counterpart to IntradayDayResult's own endingBalance/trades (issue #31) -- same "why not OptimizationResult verbatim" reasoning as WorstCaseResult in results-schema.ts. */
export interface IntradayWorstCaseResult {
  endingBalance: number;
  trades: IntradayTrade[];
}
```

`IntradayDayResult` gains: `worstCase: IntradayWorstCaseResult`.

### 2.4 Judgment call: not reusing `OptimizationResult` verbatim

The issue's Scope bullet says "a sibling `OptimizationResult`-shaped
field, e.g. `worstCase`." This plan deviates slightly from the literal
suggestion: `OptimizationResult` includes its own `startingCapital`,
which for a nested `worstCase` field would always be numerically
identical to the sibling top-level `startingCapital` already on
`PrecomputedResultBase` (window model) or `IntradayDayResult` (intraday
model) -- both the optimal and worst-case search start from the same
capital. Storing it twice creates a value that could theoretically drift
out of sync with nothing enforcing they match (no reader would ever
usefully see them differ), and doesn't match how this schema already
treats `WindowResult`/`IntradayDayResult` themselves, which flatten
`endingBalance`/`trades` directly rather than nesting a full
`OptimizationResult` object. `WorstCaseResult`/`IntradayWorstCaseResult`
follow that existing flattening convention -- same fields as
`OptimizationResult` minus the redundant `startingCapital`. **Flagged
explicitly as a deviation from the issue text's literal wording, for the
reviewer to confirm or override** -- reusing `OptimizationResult`
verbatim (accepting the redundant field) is a one-line change if the
reviewer prefers matching the issue's wording exactly over avoiding the
duplication.

### 2.5 `validatePrecomputedResult` (`results-schema.ts`)

- New helper `validateWorstCaseResult(value, path, problems)`, same
  shape/style as the existing `validateTrade`: checks `endingBalance` via
  `isPositiveFiniteNumber`, `trades` is an array of valid `Trade`s (reuse
  `validateTrade`).
- `validatePrecomputedResult`'s `model === "window"` branch calls
  `validateWorstCaseResult(r.worstCase, "worstCase", problems)`.
- `validateIntradayDay` (used for each `days[]` entry) gains the same
  check against `d.worstCase`, reusing `validateIntradayTrade` for its
  `trades`.
- **Recommended addition beyond what the issue asks for**: a cross-check
  that `worstCase.endingBalance <= endingBalance` (window model) /
  `worstCase.endingBalance <= endingBalance` (per intraday day) whenever
  both are valid positive-finite numbers. This is a real, always-true
  mathematical invariant (the min-search explores a subset of the same
  trade-sequence space the max-search does, so `worst <= optimal`
  always, by construction) -- exactly the class of self-consistency check
  this file already exists for (see its own header comment on "defense
  in depth"), and specifically valuable here because "worst case ends up
  higher than optimal case" is precisely the symptom a max/min inversion
  bug (e.g. an accidentally-unflipped comparison from section 1.1) would
  produce. Cheap, can never false-positive against genuinely correct
  output. Recommended, not required by the issue's literal acceptance
  criteria -- flagged so the reviewer can drop it if judged out of scope.

## 3. `apps/pipeline` wiring (`apps/pipeline/src/pipeline.ts`)

### 3.1 Window path: `buildWindowResults`

Import `optimizeWorstTrades` alongside the existing `optimizeTrades`
import. Inside the `WINDOW_RANGES.map(...)` body, after the existing
`const optimized = optimizeTrades(windowed, { startingCapital,
maxTrades });`, add:

```ts
const worst = optimizeWorstTrades(windowed, { startingCapital, maxTrades });
```

and include `worstCase: { endingBalance: worst.endingBalance, trades: worst.trades }`
in the returned object literal. `windowed` (the already-sliced
per-range price map) is reused as-is -- both searches run over
identical input data, just different DP directions.

### 3.2 Intraday path: `optimizeIntradayDays` (`packages/core`), not `pipeline.ts`

This is the one place this plan's design **isn't** as clean a mirror of
section 1.2's "leave the existing function untouched" principle, and
it's worth calling out explicitly: `IntradayDayResult` is a single
combined per-day record (`date`, `startingCapital`, `endingBalance`,
`barIntervalMinutes`, `trades`, now `worstCase`), and
`optimizeIntradayDays`'s existing `.map()` body is what constructs that
one record. Unlike `optimizeTrades`/`optimizeWorstTrades` (kept fully
separate, zero diff to the existing function), there's no way to attach
a `worstCase` field to each day's _single_ returned object without
touching `optimizeIntradayDays`'s own body. The recommended approach:
extend its per-day `.map()` callback to _also_ call
`optimizeWorstTrades(dayBars, { startingCapital, maxTrades:
maxTradesPerDay })` and fold `worstCase: { endingBalance: worst.endingBalance,
trades: worst.trades.map(toIntradayTrade) }` into the returned object,
reusing the existing `toIntradayTrade` converter for the worst-case
trades exactly as the optimal-case trades already do.

This is additive to `optimizeIntradayDays`'s implementation (new call,
new field) and does not change any of its existing optimal-case
values/behavior -- consistent with the issue's "don't change the
existing optimal-case computation" -- but it does mean this function's
body is not left byte-identical the way `optimizer.ts`'s `optimizeTrades`
is. Flagged because the issue's own Scope section only names
`optimizer.ts`/`computeLevel` explicitly and doesn't anticipate this
second call site; a reviewer should confirm this is the right place for
it (the alternative -- a wholly parallel `optimizeWorstIntradayDays`
function whose per-day output the pipeline would then have to merge back
into the primary per-day array by date -- was considered and rejected as
meaningfully more complex for no benefit, since it would require a new
date-keyed merge step that doesn't exist today, purely to reattach one
field to a record that's otherwise already assembled once per day).

**No changes needed in `pipeline.ts` for the intraday path.**
`buildIntradayResults` already treats `IntradayDayResult` as an opaque
object it passes around (`sixtyMinuteDays`, `overrideDays`,
`mergeDaysByGranularity`, the final `days` array) -- see
`intraday-optimizer.ts`'s own doc comment on why `IntradayResult.days`
reuses `IntradayDayResult[]` "as-is." Once `IntradayDayResult` itself
carries `worstCase`, every one of those call sites carries it through
automatically with zero code change.

### 3.3 A real design question this surfaces: does `mergeDaysByGranularity` still pick the right day-record?

`mergeDaysByGranularity` (`pipeline.ts`) merges a range's base 60-minute
day results with a granularity override's (5-minute for 3M, 1-minute for
1M) by keeping, for any date both cover, whichever day-record's
`endingBalance` (the _optimal_ figure) is higher -- see
`packages/core/CLAUDE.md`'s "Mixed-granularity 1M/3M assembly" section
for why this exists (the two granularities can see different ticker
universes for the same day, so "finer always wins" was a real bug fixed
before this plan was written).

Once each day-record also carries a `worstCase` sub-result, is comparing
only the _optimal_ `endingBalance` still the right selection criterion?
**Yes, and this plan recommends leaving `mergeDaysByGranularity`'s logic
completely unchanged** -- worked through explicitly since the issue
doesn't anticipate this interaction at all (it predates the
granularity-override mechanism even being relevant here):

- The function already operates on whole `IntradayDayResult` objects
  (`byDate.set(day.date, day)`), not cherry-picked fields -- so whichever
  day-record wins carries its _own_ `worstCase` along for free, with no
  code change needed to make that happen.
- The alternative -- picking the optimal-case winner from one
  granularity's day-record but the worst-case winner from the _other_
  granularity's (whichever has the lower `worstCase.endingBalance`)
  -- would produce a self-inconsistent day-record: two figures computed
  over two different ticker universes/datasets glued together, where a
  user looking at that day's `trades` list (which belongs to only one of
  the two figures) couldn't make sense of how it relates to the other
  figure. Keeping one coherent source dataset per day-record (today's
  behavior) is simpler to reason about and explain than a second,
  independent per-field merge.
- **This is a genuine judgment call, not a forced conclusion** -- flagged
  explicitly for the reviewer. The counterargument (each field should
  independently reflect "the most complete data available for that
  field") is defensible too, just meaningfully more complex to implement
  (a second date-keyed comparison pass) for a benefit (a very slightly
  more extreme worst-case figure on the rare day where the two
  granularities disagree on which is worse) that seems marginal relative
  to the complexity. Recommendation: keep `mergeDaysByGranularity`
  unchanged; revisit only if a real run shows this producing a
  meaningfully misleading worst-case figure on override-covered days.

## 4. `apps/web` wiring

### 4.1 `apps/web/src/lib/results-api.ts`: no code change expected

This route is a pure passthrough of `PrecomputedResult` JSON (read from
S3, `JSON.parse`d, schema/model-discriminant checked, `Response.json`'d
back out) -- it never touches individual result fields beyond
`schemaVersion`/`model` (see its own file, and the "Defensive guard"
note in `apps/web/CLAUDE.md` confirming this file deliberately does
**not** re-validate field-level values on read). The new `worstCase`
field flows through automatically once `packages/core`'s
`PrecomputedResult`/`RESULTS_SCHEMA_VERSION` are updated -- no edit
needed in this file itself. **Flagged because the issue's own Scope
section says "Update apps/web/src/lib/results-api.ts,"** which this plan
believes is imprecise; noting it explicitly so the implementer doesn't
invent an unnecessary change here just to match the issue text, and so
the reviewer can confirm or correct this reading.

### 4.2 New component: `apps/web/src/components/WorstCaseStat.tsx`

A small, deliberately de-emphasized sibling to `HeroStat` -- per the
acceptance criteria ("a clear contrast... not competing for attention"):

- No count-up animation (`useCountUp`) and no `CelebrationBurst` --
  those exist specifically to make the _optimal_ figure feel like a
  reveal/payoff; reusing them for the worst-case figure would work
  against "not competing for attention" and would need its own
  gain/loss-appropriate framing (a celebration burst on a loss figure
  makes no sense even in the rare edge case from section 1.4).
- Reuses `formatHeroCurrency`/`formatMultiplier`
  (`apps/web/src/lib/format-currency.ts`) as-is -- no new formatting
  logic needed.
- Visually smaller (not the `clamp(2.5rem,6vw,4rem)` hero size) and
  styled with a muted/secondary text color.
- **Open UI judgment call, not resolved by this plan**: should its
  figure's color/tone respond dynamically to gain-vs-loss (mirroring
  `HeroStat`'s multiplier badge's `--status-good`/`--status-critical`
  convention), or should it always render in a single muted tone
  regardless of value? Dynamic coloring is more consistent with how the
  rest of the app already colors gain/loss; a fixed muted tone is
  simpler and sidesteps any risk of a rare "worst case is still a gain"
  edge case (section 1.4) rendering in celebratory green. This plan
  leans toward a fixed muted tone (simpler, and the point of this stat
  is contrast/de-emphasis, not accuracy-signaling), but explicitly
  leaves the decision to the implementer/reviewer as a product-taste
  call, not a technical one.
- **Scope call**: this component renders only the `endingBalance` (and
  optionally a multiplier) as a single contrast figure -- it does **not**
  render the worst-case `trades` list. The schema stores `trades` for
  completeness and possible future use (e.g. a "see the worst-case
  sequence" expansion, mirroring `TradeList`'s prose narration from
  issue #32), but building that narration is beyond "a new stat... not
  crowding the existing hero number" from the issue's own Scope
  wording. Flagged so this isn't mistaken for an oversight.

### 4.3 `apps/web/src/components/ResultsPanel.tsx`

- Window-model branch (`data.model === "window"`): render
  `<WorstCaseStat startingCapital={data.startingCapital}
endingBalance={data.worstCase.endingBalance} />` immediately after the
  existing `<HeroStat .../>`.
- Intraday-daily branch: render the same, immediately after the existing
  `<HeroStat key={activeDay.date} .../>`, using
  `activeDay.worstCase.endingBalance` / `activeDay.startingCapital` --
  **gated behind the same `guess !== null` reveal condition** as the
  rest of that day's content (chart, trade list). This matches the
  existing guess-then-reveal philosophy from issue #34 (`ResultsPanel.tsx`'s
  `guess === null` branch shows only `DailyGuessForm`) -- showing the
  worst-case figure before the guess is submitted would be a partial
  spoiler of "the real answer" the guessing game is built around.
  **Open question, flagged for the reviewer**: is this the right call,
  or should the worst-case contrast stat be visible pre-guess since the
  guessing game (per its own framing, "what did $20 turn into") is only
  ever about the optimal figure, not the worst case? This plan
  recommends gating it (simpler, avoids any partial-spoiler risk,
  consistent single reveal moment) but doesn't treat this as
  self-evidently the only reasonable choice.

## 5. Rollout hazard (same shape as issue #28's schema-2 bump)

Per `apps/pipeline/CLAUDE.md`'s documented precedent: because
`RESULTS_SCHEMA_VERSION` is a single global version number across the
whole `PrecomputedResult` union (not per-range), a pipeline run that
writes the new schema-3 shape (all 5 range keys, including 5Y/MAX which
get a new `worstCase` field they didn't have before, and 1M/3M/1Y whose
every day gains one too) must happen **before or atomically with**
deploying a schema-3-reading `apps/web` -- `results-api.ts`'s
`schemaVersion !== RESULTS_SCHEMA_VERSION` check means every range,
including ones that "worked fine" under schema 2, will 502 with
`schema_mismatch` until the next nightly run touches all 5 keys. This is
a real-AWS action (a Lambda invocation writing to the real S3 bucket)
and needs the user's explicit go-ahead per root `CLAUDE.md`'s working
agreement, exactly like #28's still-referenced rollout playbook -- **not
performed as part of this plan-writing pass**, and not performed as part
of implementation either without that explicit go-ahead at that time.

## 6. Testing plan (not performed in this planning phase)

- **`packages/core/src/optimizer.test.ts`**:
  - New tests for `optimizeWorstTrades` on small synthetic fixtures with
    a hand-computable worst sequence (mirroring the existing
    `optimizeTrades` fixture style).
  - An explicit tie-break test for the min direction (two tickers with
    an identical worst ratio -> alphabetically-first wins), mirroring
    the existing max-direction tie-break test -- proves section 1.3's
    conclusion in code, not just in this document.
  - A property-style invariant test across several fixtures: for any
    given input, `optimizeWorstTrades(...).endingBalance <=
optimizeTrades(...).endingBalance` -- this is always true by
    construction (see section 2.5's cross-check) and is a strong,
    cheap regression guard against a comparator-flip mistake in section
    1.1.
  - **Regression requirement**: the full existing `optimizer.test.ts`
    suite (today's max-direction behavior) must keep passing byte-for-
    byte unchanged after `computeLevel`'s refactor to take a `direction`
    parameter -- this is the proof that threading `direction` through
    didn't alter `optimizeTrades`'s existing behavior at all.
- **`packages/core/src/intraday-optimizer.test.ts`**: extend to assert
  `IntradayDayResult.worstCase` is present per day and
  `worstCase.endingBalance <= endingBalance`.
- **`packages/core/src/results-schema.test.ts`**: extend
  `validatePrecomputedResult` tests for the new field on both
  `WindowResult` and `IntradayDayResult` paths (missing `worstCase`
  fails; a malformed nested trade fails; the recommended
  worst-exceeds-optimal cross-check fails); update every hardcoded
  `schemaVersion: 2` fixture to `3`.
- **`apps/pipeline/src/pipeline.test.ts`**: extend the existing
  window/intraday result-building tests to assert `worstCase` populates
  correctly per range/day; no new split-path/failure-mode tests are
  needed since this doesn't add a new fetch path (worst-case reuses the
  exact same fetched history as the optimal case, just a second DP pass
  over it).
- **`apps/web`**: a new `WorstCaseStat.test.tsx`; extend
  `ResultsPanel.test.tsx` to assert it renders with correct values in
  both models, and (per section 4.3) is correctly gated behind the guess
  reveal in the intraday-daily model.

## 7. Live verification plan (not performed in this planning phase)

Per this repo's working agreement ("verify live... at least once per
feature") and the issue's own acceptance criterion:

1. A real pipeline run (local invocation against real Yahoo data is
   sufficient for this; a real Lambda invoke needs the user's go-ahead
   per section 5) confirming worst-case figures are sane for all 5
   ranges -- meaningfully lower than the optimal figure, not NaN/
   negative/zero, and checking section 1.4's edge case doesn't
   spuriously trigger on real data (i.e. confirm the worst case for a
   realistic window is, as expected, a real loss for the current S&P
   500 universe, not a false "still a gain" reading from a bug).
2. A rough wall-clock timing check that the "roughly doubles nightly
   optimizer wall-clock, still cheap" claim in the issue's Scope section
   holds for **both** paths, not just the window path the issue's own
   ~330ms/range benchmark (`packages/core/CLAUDE.md`) was measured on --
   that benchmark is for a single whole-window `optimizeTrades` call,
   not the per-day intraday path's ~252 separate small `optimizeTrades`
   calls (1Y window) that section 3.2 doubles too. **Explicit
   assumption, not yet verified**: each day's DP operates on a tiny `T`
   (one day's bar count, not a multi-year date range), so doubling the
   number of calls should stay cheap in absolute terms the same way the
   window path's doubling does -- but no existing benchmark number
   covers the intraday path specifically, so this should be measured,
   not assumed, during implementation.
3. A screenshot verification (via the established throwaway-debug-route
   technique documented in `apps/web/CLAUDE.md`, since this sandbox has
   no local `RESULTS_BUCKET`) of `WorstCaseStat`'s placement/visual
   weight relative to `HeroStat`, in both light and dark themes, for
   both the window model and the intraday-daily model's gated reveal
   flow -- confirming it reads as "a clear contrast... not competing for
   attention" per the acceptance criteria, which is a visual judgment
   this plan can't settle from code alone.

None of the above is performed as part of this plan-writing pass.

## 8. Risks

- **Correctness (the main risk)**: the four comparison-site flips in
  section 1.1 are exactly the kind of change that's easy to get
  half-right (e.g. flipping the sentinel but not the strict-inequality
  check, or vice versa) and would silently produce a "worst case" that's
  actually just a slightly-suboptimal best case, or crashes on real data
  via a stray `NEG_INFINITY` leaking into `endingBalance`. Mitigated by:
  the invariant test in section 6 (`worst <= optimal`, always true by
  construction), the recommended write-time cross-check in section 2.5
  (catches this class of bug even in production, not just in tests), and
  keeping `computeLevel`'s existing max-direction test suite as an
  unchanged regression guard.
- **Perf**: accepted by the issue itself as "roughly doubles nightly
  optimizer wall-clock, still cheap" for the window path (relying on the
  existing ~330ms/range benchmark). The intraday path's doubling is
  _not_ separately benchmarked anywhere in this codebase's existing
  notes -- flagged in section 7 as needing a real measurement, not
  assumed safe by analogy alone, even though there's good reason to
  expect it's also cheap (small per-day `T`).
- **Blast radius**: touches all four packages (`packages/core`'s
  optimizer + two schema files, `apps/pipeline`'s two result-builders,
  `apps/web`'s API types + two new/changed UI call sites) and bumps the
  shared schema version -- comparable in shape to issue #28's own
  schema-2 rollout, including the same "must write all 5 keys before/
  atomically with the web deploy" hazard (section 5). This is a
  moderately wide diff for what reads as a small feature, mirroring why
  issue #28 got the same plan-first treatment.
- **Judgment calls this plan made that a reviewer should explicitly
  sign off on** (collected from throughout this document, not new):
  section 1.4's edge case (worst case can theoretically still be a net
  gain), section 2.4 (not reusing `OptimizationResult` verbatim), 3.2
  (touching `optimizeIntradayDays`'s body rather than keeping it
  untouched the way `optimizeTrades` stays untouched), 3.3 (not changing
  `mergeDaysByGranularity`'s selection criterion), 4.1 (no code change
  needed in `results-api.ts` despite the issue text), 4.2 (fixed vs.
  dynamic coloring for the new stat; trades-list narration out of
  scope), and 4.3 (gating the worst-case stat behind the existing guess
  reveal in the intraday-daily model).
