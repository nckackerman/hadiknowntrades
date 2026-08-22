# Plan: issue #13 - short-selling mode

Status: **plan only, not implemented**. Written against `main` at
`2d2e48f` (post-#57, SPY benchmark). Per this repo's working agreement,
this issue touches `packages/core/src/optimizer.ts` -- this repo's own
highest-stakes file (the one that earned a dedicated `xhigh` review) --
plus the stored data shape (`RESULTS_SCHEMA_VERSION` bump), so it gets a
plan-first, review-before-implementation pass, matching
`docs/plans/issue-28-plan.md`, `docs/plans/issue-31-plan.md`, and
`docs/plans/issue-12-plan.md`.

**Read `packages/core/src/optimizer.ts` in full before touching anything
below** -- this plan is written against its actual current shape (post-#31's
`direction` parameter), not a guess from the issue text.

## 0. One-paragraph summary

Add short trades to the DP's per-ticker search by giving every ticker/day
a _second_ set of suffix-best/running-best passes, structurally identical
to the existing long-only pass but built from a reciprocal-price
formulation (`P_open / P_close` instead of `P_close / P_open`) that stays
separable and keeps the DP at the same `O(days x tickers x maxTrades)`
shape -- just roughly double the per-level constant, matching the issue's
own "doubling the search space" framing. This is a **real design choice,
not the only possible one** -- section 1.2 works through why a more
"realistic" short model (fixed share count, unbounded downside) is
rejected as needing a fundamentally different, more expensive algorithm.
Building on that choice, section 1.4 resolves the issue's two flagged open
questions (worst-case extension, tie-break) directly from the chosen
model's actual mathematical properties rather than by assumption. Schema:
a new `direction: "long" | "short"` field plus renamed, direction-neutral
`Trade` fields (`openDate/openPrice/closeDate/closePrice`, replacing
`buyDate/buyPrice/sellDate/sellPrice`), and a new sibling `longShort`
field (mirroring issue #31's `worstCase` sibling-field precedent) on
`WindowResult`/`IntradayDayResult`, leaving every existing top-level field
untouched in meaning -- `RESULTS_SCHEMA_VERSION` bumps 4 -> 5. Every
existing long-only code path in `optimizer.ts` is **not modified**, only
extended with an `includeShorts`-gated block that's skipped entirely (zero
new work, zero new branches evaluated) unless explicitly engaged --
chosen specifically so "long-only behavior is provably unchanged" (the
issue's own acceptance criterion) is true by construction, not by
re-testing. `apps/pipeline` computes and stores both variants every run
(all 4 direction x instrument-set combinations, one shared calendar/
ticker-sort per range/day via a new `optimizeAllVariants`); `apps/web`
gets a `?mode=long|long-short` URL toggle and every dollar-figure/trade-
list consumer is audited (section 4) to read the right variant and render
short trades comprehensibly.

## 1. The DP change (`packages/core/src/optimizer.ts`)

### 1.1 What a "short trade" needs to mean in this DP, worked from first principles

The existing DP's core move: taking a long trade from `buyIdx` to
`sellIdx` multiplies the running balance by `P[sellIdx] / P[buyIdx]`, and
this is only tractable in `O(days)` per ticker per level because that
ratio **factors**: `P[sellIdx] / P[buyIdx] = (1/P[buyIdx]) * P[sellIdx]`,
a product of a term depending only on `buyIdx` and a term depending only
on `sellIdx`. That's what lets `computeLevel` precompute
`g[i] = P[i] * prevValue[i+1]` once, take a **suffix-best of `g`**, and
then for each candidate `buyIdx` just do `suffixBestG[buyIdx+1] /
P[buyIdx]` -- an `O(1)` lookup per `buyIdx`, `O(days)` total per ticker.

A short trade needs its own "growth multiplier" for opening at
`openIdx` and covering at `closeIdx`. Two candidate definitions exist,
and they are **not** equivalent -- this plan evaluates both explicitly
rather than picking one silently, because they have genuinely different
algorithmic and product implications:

**Option A -- fixed-notional / textbook short mechanics.** Model it the
way a real cash-secured short works: your balance buys `N = balance /
P[open]` "share-equivalents" worth of short exposure at the open price
(same "how many shares does my balance represent" logic the existing
long side already uses, just applied to the entry price instead of
`P[buy]`), profit = `N * (P[open] - P[close])`, so the ending balance is
`balance * (2 - P[close]/P[open])`. This is a **real-world-accurate**
model, and it has the property the issue's own Background section
describes: unbounded downside. If `P[close] > 2 * P[open]` (price more
than doubles against the short), the multiplier goes negative -- the
position is worth _less than nothing_, a real short-selling risk this
formula faithfully reproduces.

The problem: `2 - P[close]/P[open]` is **not separable** the way the long
ratio is. The quantity to maximize over `close` for a fixed `open` is
`2*prevValue[close+1] - (P[close]/P[open]) * prevValue[close+1]` -- a sum
of a term depending only on `close` and a _second_ term that depends on
`close` **scaled by a factor that varies with `open`**
(`1/P[open]`). Framed as a family of lines in `x = 1/P[open]`-space (one
line per candidate `close`: `-B(close)*x + A(close)`, with `B(close) =
P[close]*prevValue[close+1]`, `A(close) = 2*prevValue[close+1]`), finding
the best `close` for every possible `open` is the classic "upper envelope
of lines" problem -- it needs a convex-hull trick / Li Chao tree, an
`O(days log days)` structure this codebase has no precedent for anywhere,
not a simple suffix-max pass. This is a materially different algorithmic
component, not a bigger constant on the existing one.

**Option B -- reciprocal-price / inverse-compounding short (recommended).**
Define the short's growth multiplier as `P[open] / P[close]` -- literally
run the _existing_ long formula on the reciprocal price series `1/P(t)`
(a long on `1/P`: buy `1/P[open]`, sell `1/P[close]`, ratio =
`(1/P[close]) / (1/P[open]) = P[open]/P[close]`). This is exactly what
the issue's own Background bullet gestures at ("buy/sell inverted"). It
**is** separable: the quantity to maximize is `P[open] *
(prevValue[close+1] / P[close])`, a product of a term depending only on
`open` (`P[open]`, used as a multiplier now instead of a divisor) and a
term depending only on `close` (`prevValue[close+1] / P[close]`) -- the
exact same suffix-best-then-`O(1)`-lookup shape as the long side, just
with a second `g` array (`g_short[i] = prevValue[i+1] / P[i]`) and the
roles of "divide" and "multiply" swapped. No new algorithmic technique;
`O(days)` per ticker per level, same as today.

Economically, Option B is **not** the literal fixed-share-count short --
it's mathematically identical to a continuously-value-preserving inverse
position (the same math that underlies how a daily-rebalanced inverse
ETF compounds, adapted to this app's atomic multi-day open/close
trades rather than genuinely daily rebalancing). Its downside is
**bounded**, not unbounded: `P[open]/P[close] > 0` always (both are real
positive prices, guarded by `isValidPrice`), and as `P[close] ->
infinity` (price rises without limit against the short), the ratio ->
`0`, i.e. the position can lose up to but never past 100% of its value --
structurally identical to a long's own bounded-100%-loss floor, not the
unbounded downside the issue's Background section assumes a short would
have.

**Recommendation: Option B**, for one dominant reason -- it keeps this
change at the complexity the issue itself scopes it as ("doubling the
search space," `O(days x tickers x maxTrades)` unchanged, just a larger
constant), where Option A would require introducing a genuinely new
`O(days log days)` algorithmic primitive to this codebase's single
highest-stakes file, a categorically bigger and riskier change than what
either the issue or this repo's usual incremental-plan cadence
anticipates. **This is a real, load-bearing judgment call, flagged
explicitly for the reviewer**: Option A is more "realistic" and matches
the issue's own unbounded-downside framing; Option B trades that realism
for tractability and (as section 1.4 below shows) a cleaner answer to the
issue's own worst-case question. If a reviewer wants Option A's realism
badly enough to accept a convex-hull-trick rewrite of `computeLevel`,
that is a materially larger, separately-scoped effort than the rest of
this plan assumes, and should be re-scoped as such rather than folded
into this issue's "roughly doubles" cost estimate.

### 1.2 Mechanical DP changes (`computeLevel`)

Per ticker, per level, `computeLevel`'s existing body (the `g`/
`suffixBestG`/`runningBestValue` long pass) is **left completely
untouched**. A new, `includeShorts`-gated second pass is appended
immediately after it, per ticker:

```ts
// existing long pass, byte-identical to today -- computes g, suffixBestG,
// runningBestValue/runningBestBuyIdx/runningBestSellIdx, and updates
// value[d]/choice[d] with { ticker, direction: "long", buyIdx, sellIdx }
// exactly as it does today (just tag direction: "long" onto the choice).

if (includeShorts) {
  // g_short[i] = value of covering this ticker's short on day i, given
  // the best (worst, for "min") remaining path starting the day after.
  const gShort = new Array<number>(T);
  for (let i = 0; i < T; i++) {
    const p = prices[i]!;
    gShort[i] = p === null ? worstSentinel : prevValue[i + 1]! / p;
  }

  // suffixBestGShort[i] = best(gShort[i..T-1]) -- same suffix-best
  // machinery as the long pass, over a different underlying array.
  const suffixBestGShort = new Array<number>(T + 1).fill(worstSentinel);
  const suffixBestCoverIdx = new Array<number>(T + 1).fill(-1);
  for (let i = T - 1; i >= 0; i--) {
    if (isBetterOrEqual(gShort[i]!, suffixBestGShort[i + 1]!)) {
      suffixBestGShort[i] = gShort[i]!;
      suffixBestCoverIdx[i] = i;
    } else {
      suffixBestGShort[i] = suffixBestGShort[i + 1]!;
      suffixBestCoverIdx[i] = suffixBestCoverIdx[i + 1]!;
    }
  }

  // runningBestShort[d] = best over openIdx >= d of (P[openIdx] *
  // suffixBestGShort[openIdx+1]) -- note *multiply* by price here,
  // mirroring the long pass's *divide*: opening a short "sells" at the
  // open price the same structural role buying "divides by" for a long.
  let runningBestShortValue = worstSentinel;
  let runningBestOpenIdx = -1;
  let runningBestCoverIdx = -1;
  for (let d = T - 1; d >= 0; d--) {
    const p = prices[d]!;
    const bestCoverValue = suffixBestGShort[d + 1]!;
    if (p !== null && bestCoverValue !== worstSentinel) {
      const candidateShortRatio = p * bestCoverValue;
      if (isBetterOrEqual(candidateShortRatio, runningBestShortValue)) {
        runningBestShortValue = candidateShortRatio;
        runningBestOpenIdx = d;
        runningBestCoverIdx = suffixBestCoverIdx[d + 1]!;
      }
    }
    if (runningBestOpenIdx !== -1 && isStrictlyBetter(runningBestShortValue, value[d]!)) {
      value[d] = runningBestShortValue;
      choice[d] = {
        ticker,
        direction: "short",
        buyIdx: runningBestOpenIdx,
        sellIdx: runningBestCoverIdx,
      };
    }
  }
}
```

Key properties of this design, stated explicitly:

- **`includeShorts: false` executes exactly today's code, nothing more.**
  The entire short block is behind one `if`, per ticker -- no new
  allocation, no new comparison evaluated, when the flag is off. This is
  _why_ "existing long-only behavior is provably unchanged" (the issue's
  acceptance criterion) can be a structural guarantee, not a claim that
  needs re-proving by exhaustive testing: the long-only call path
  literally doesn't reach the new code at all.
- **No new sentinel/comparison-flip axis.** The short block reuses
  `worstSentinel`/`isBetterOrEqual`/`isStrictlyBetter` exactly as
  parameterized by `direction` already -- there is nothing short-specific
  to add to computeLevel's existing "four things that flip for min vs.
  max" doc comment; the short pass is just a second application of the
  same three direction-derived primitives to a second `g` array.
- **Per-ticker cost roughly doubles** (two suffix passes + two
  running-best passes instead of one each), not the asymptotic shape --
  still `O(days)` per ticker per level, so the whole DP stays `O(days x
tickers x maxTrades)`. See section 5 for what this costs in wall-clock
  terms.
- **`TradeChoice` gains `direction: "long" | "short"`.** Internal-only
  type, no consumer impact; `buyIdx`/`sellIdx` field names are kept
  as-is internally (generic "earlier index"/"later index," direction-
  agnostic) rather than renamed to `openIdx`/`closeIdx` -- a cosmetic,
  low-stakes choice, not flagged as an open question.

### 1.3 `Trade`'s public shape: rename to direction-neutral fields

`Trade`'s current fields (`buyDate`, `buyPrice`, `sellDate`, `sellPrice`)
are **long-specific verbs baked into field names**. Reusing them
unchanged for a short trade would be actively misleading: a short's
"buyDate" would hold the date the position was _opened_ (economically a
sell), and "sellDate" the date it was _covered_ (economically a buy) --
exactly backwards from what the field names say. Two options:

- **(Rejected) Keep `buyDate`/`sellDate`/etc., add only `direction`.**
  Smaller diff, but ships a permanently confusing contract: every future
  reader of a short `Trade` has to remember "buyDate means openDate here,
  because direction is short" -- a footgun baked into the schema forever,
  not a one-time cost.
- **(Recommended) Rename to `openDate`/`openPrice`/`closeDate`/
  `closePrice`, add `direction: "long" | "short"`.** Chronological,
  direction-agnostic field names (`openIdx < closeIdx` always, regardless
  of direction) -- a reader interprets economic meaning via `direction`
  alone, never via which field holds which date. This is a breaking
  rename, but **every consumer that would need touching for the rename is
  already required to change for direction-aware return math regardless**
  (section 4) -- the rename adds marginal cost on top of files already
  being edited, not a new set of files. It also happens to make
  `runOptimizerForDirection`'s trade-construction step (today's lines
  374-392) **not need an if/else on direction at all**: `openDate`/
  `openPrice` always come from `c.buyIdx`'s date/price and `closeDate`/
  `closePrice` always come from `c.sellIdx`'s, regardless of whether
  `c.direction` is `"long"` or `"short"` -- only the returned object's
  `direction` field differs. This is a genuine judgment call (blast
  radius vs. permanent clarity), **flagged explicitly for the reviewer**,
  but this plan recommends the rename given the "cost is already being
  paid" argument above.

`Trade` becomes:

```ts
export interface Trade {
  ticker: string;
  direction: "long" | "short";
  openDate: string;
  openPrice: number;
  closeDate: string;
  closePrice: number;
}
```

Since this is bundled with a `RESULTS_SCHEMA_VERSION` bump regardless (a
short trade is itself a shape change every reader needs to know about),
there is no reader that needs to handle both the old and new `Trade`
shape simultaneously -- the version bump is the same all-or-nothing
migration boundary this repo has used for every prior schema change.

### 1.4 Resolving the issue's two flagged open questions

**(a) Does short-selling extend to `optimizeWorstTrades` too?**

Under Option A (unbounded downside), this would be a real problem: the
worst-case (min) search actively _seeks_ the minimum, and an unbounded-
downside candidate would let it find an arbitrarily catastrophic negative
multiplier -- a worst-case `endingBalance` of, say, negative ten billion
dollars from a $20 start is nonsensical for this app's "starting capital"
framing (there's no margin-call/stop-loss mechanism modeled, nothing
capping the loss), and would need an ad hoc floor/clamp decision with no
principled value to pick.

Under Option B (the recommended model), **this problem does not exist**:
`P[open]/P[close]` is bounded to `(0, +infinity)` regardless of direction
searched, identical in shape to the long ratio's own `(0, +infinity)`
bound. Extending the min-direction search to include short candidates is
mechanically identical to section 1.2's max-direction extension (same
`if (includeShorts)` block, same `worstSentinel`/comparison primitives,
now instantiated with `direction: "min"`), and produces a worst case that
can be a severe loss (ratio approaching 0, mirroring how a long's own
worst case can approach total loss) but never an impossible negative
balance. **Recommendation: yes, extend `optimizeWorstTrades` to include
shorts too** -- there is no asymmetry to account for once Option B is
the chosen model, which is itself a direct, non-obvious consequence of
which of the two option-A/option-B models was picked in section 1.1 --
this is the concrete resolution the issue asks for, not an assumption of
symmetry: the symmetry holds _because_ Option B was chosen, and would
_not_ hold under Option A (where the honest answer would likely be "no,
don't extend it, or extend it with an explicit loss floor" -- flagged as
the counterfactual, not adopted).

**(b) Does a long-vs-short tie need its own tie-break rule?**

Yes -- worked through with a concrete scenario, not asserted.

_Cross-ticker tie (no new rule needed)._ Universe of two tickers, one
day-pair, `maxTrades = 1`: AAPL priced `$100 -> $105` (long ratio =
`1.05`), MSFT priced `$110 -> $104.7619048` (chosen so `110 /
104.7619048 = 1.05` exactly, i.e. MSFT's _short_ ratio ties AAPL's
_long_ ratio). Sorted tickers: AAPL before MSFT. Processing AAPL first
(long pass: ratio 1.05, strictly beats the carry-forward baseline of 1,
updates `value[0]`/`choice[0]` to AAPL-long; short pass: AAPL short
ratio = `100/105 = 0.9524`, a loss, doesn't beat 1.05, no update). Then
MSFT (long pass: `104.76/110 = 0.9524`, doesn't beat 1.05; short pass:
`110/104.76 = 1.05`, _tied_ with the current record, and the update
check is strict `>`, so the tie does **not** overwrite). Result: AAPL-long
wins, purely because AAPL sorts alphabetically before MSFT -- the
existing cross-ticker tie-break (section 1.1's `sortedTickers` order,
already documented in `computeLevel`'s own doc comment) already resolves
this correctly, unmodified, since the short pass is just one more
candidate source competing for the same strict-`>`-gated `value[d]` slot.

_Same-ticker tie (a genuinely new axis, resolved by processing order)._
Single ticker AAPL, three days: `$100` (day 0), `$105` (day 1),
`$95.2381` (day 2, chosen so `100/95.2381 = 1.05`). Long candidate
(buy day 0, sell day 1): ratio `1.05`. Short candidate (open day 0,
cover day 2): ratio `100/95.2381 = 1.05` -- an exact tie, **same
ticker**, same opening day. Section 1.2's design processes the long pass
to completion (including its own `value[d]`/`choice[d]` update) _before_
the short pass even begins for that ticker -- so at the moment the short
pass's own strict-`>` check runs, `value[0]` already holds the long
candidate's `1.05`, and the short candidate's `1.05` fails to beat it
(tie, not strict). **Long wins.** This is a genuinely new rule this
issue introduces (the existing three tie-break axes, per
`packages/core/CLAUDE.md`, are cross-ticker order, cross-day order within
one ticker, and trade-vs-carry-forward -- none of them is "long vs.
short for the same ticker/day"), and it falls out for free from the
processing order chosen for implementation reasons (each ticker's short
pass being a separate, appended block after its long pass) rather than
from any principled preference for long over short. **Explicitly an
arbitrary-but-deterministic tie-break, flagged for the reviewer**, same
character as the existing three (per issue #31's own plan doc's framing
of those: "not about maximizing... about determinism given an otherwise-
tied objective"). No alternative (short-wins, or a combined single-pass
merge) is recommended over this one; this is simply the rule that falls
out of the simplest correct implementation, documented rather than
fought.

## 2. Top-level API (`packages/core/src/optimizer.ts`)

`optimizeTrades`, `optimizeWorstTrades`, and `optimizeBothDirections`
**are not modified** -- they keep calling into `runOptimizerForDirection`
exactly as today, which internally passes `includeShorts: false` (a fixed
constant at those three call sites, never threaded from a caller-supplied
option) so their behavior is pinned, not merely defaulted. A new function
covers what the pipeline actually needs -- all 4 direction x instrument-set
combinations, sharing one built `OptimizerState`, mirroring
`optimizeBothDirections`'s own existing "share the calendar/ticker-sort"
design:

```ts
export function optimizeAllVariants(
  priceSeriesByTicker: Map<string, DailyClose[]>,
  options: OptimizeOptions, // unchanged shape: startingCapital + maxTrades
): {
  longOnly: { best: OptimizationResult; worst: OptimizationResult };
  longShort: { best: OptimizationResult; worst: OptimizationResult };
} {
  validateOptimizeOptions(options);
  const state = buildOptimizerState(priceSeriesByTicker);
  return {
    longOnly: {
      best: runOptimizerForDirection(state, options, "max", false),
      worst: runOptimizerForDirection(state, options, "min", false),
    },
    longShort: {
      best: runOptimizerForDirection(state, options, "max", true),
      worst: runOptimizerForDirection(state, options, "min", true),
    },
  };
}
```

`runOptimizerForDirection` gains an `includeShorts: boolean` parameter
threaded straight into every `computeLevel` call it makes across the
`k = 1..maxTrades` loop; `computeLevel` itself gains the same parameter
(section 1.2). `OptimizeOptions` itself is **not** changed (no
`includeShorts` field added there) -- the flag only exists at the
internal `runOptimizerForDirection`/`computeLevel` layer, reachable
externally only through `optimizeAllVariants`. This keeps `optimizeTrades`/
`optimizeWorstTrades`/`optimizeBothDirections`'s public signatures
byte-identical to today, which is itself part of the "provably unchanged"
argument -- there is no new optional field on their shared options type
whose absence a caller could get wrong.

## 3. Schema change (`packages/core/src/results-schema.ts`,

`packages/core/src/intraday-optimizer.ts`)

### 3.1 `RESULTS_SCHEMA_VERSION`: 4 -> 5

No parallel-planning collision risk this time (unlike #31/#12, which
landed the 2->3 and 3->4 bumps in parallel against each other) -- both
have already merged sequentially per current `main`, so this plan bumps
cleanly from the current value of 4.

### 3.2 New/changed types

```ts
// optimizer.ts
export interface Trade {
  ticker: string;
  direction: "long" | "short";
  openDate: string;
  openPrice: number;
  closeDate: string;
  closePrice: number;
}
```

```ts
// results-schema.ts -- mirrors WorstCaseResult's own flattening
// convention (no redundant startingCapital, see issue #31's own
// reasoning, unchanged here).
export interface LongShortResult {
  endingBalance: number;
  trades: Trade[];
  /** Same "worst achievable" meaning as the sibling top-level worstCase, but searched over the long+short candidate set (issue #13) -- see optimizer.ts's section-1.4 reasoning for why this is safe to include (bounded downside under the chosen short model). */
  worstCase: WorstCaseResult;
}
```

`WindowResult` gains: `longShort: LongShortResult`. `IntradayDayResult`
(`intraday-optimizer.ts`) gains the same field, typed
`IntradayLongShortResult` (mirroring the existing
`IntradayWorstCaseResult` split for the intraday `Trade`-equivalent
shape). **Deliberately additive, not a restructure.** The alternative --
replacing the flat `endingBalance`/`trades`/`worstCase` fields with a
`variants: { longOnly, longShort }` wrapper -- was considered and
rejected: it would touch _every_ existing consumer of those flat fields
(`HeroStat`, `PortfolioChart` via `portfolio-series.ts`, `TradeList`,
`WorstCaseStat`, the OG card route, `BenchmarkStat`'s
`startingCapital` reference) purely to relocate data that doesn't need
relocating, directly working against the acceptance criterion that
existing long-only behavior must be provably unchanged. Keeping
`endingBalance`/`trades`/`worstCase` as the long-only canonical figures
(unchanged meaning, unchanged field names) and adding `longShort` as a
pure sibling is the same shape issue #31's own `worstCase` field already
established as this schema's precedent for "a second, alternative
computation over the same window" -- explicitly named in the issue's own
Background section as the closest existing precedent.

`IntradayTrade` (`intraday-optimizer.ts`) gets the same rename +
`direction` field: `date`, `openTime`, `openPrice`, `closeTime`,
`closePrice`, `direction`. `toIntradayTrade` (the `Trade` ->
`IntradayTrade` converter) is updated to pass `trade.direction` through
and rename the split fields accordingly -- structurally unchanged
otherwise (it already splits date from time-of-day; that logic doesn't
depend on direction).

### 3.3 `validatePrecomputedResult` additions

- `validateTrade`/`validateIntradayTrade`: rename every field check to
  match the new names, and add `direction === "long" || direction ===
"short"`.
- New `validateLongShortResult` (mirrors `validateWorstCaseResultWith`'s
  existing shape -- reuse it directly, since `LongShortResult` and
  `WorstCaseResult` now differ only in `LongShortResult` nesting its own
  `worstCase`; this plan recommends `validateWorstCaseResultWith` grow an
  optional third check for a nested `worstCase`, or a thin wrapper
  function that calls it twice -- an implementation-detail choice, not a
  design one).
- **Recommended new cross-checks** (mirroring issue #31's own "recommended
  addition beyond what the issue asks for" pattern -- the worst<=optimal
  invariant), both **provably true by construction** regardless of real
  price data, both specifically valuable because a violation is exactly
  the signature a short-search implementation bug would produce:
  - `longShort.endingBalance >= endingBalance` (the long-only figure).
    The long+short max-search explores a strict superset of the
    candidate trade set the long-only max-search does (every long
    candidate remains available, plus shorts) -- a max search over a
    superset can never do worse.
  - `longShort.worstCase.endingBalance <= worstCase.endingBalance` (the
    long-only worst-case figure). Same superset argument, inverted for a
    min search: it can never find a _higher_ (less bad) minimum than a
    min search over a subset could.
  - Both checks apply to `WindowResult` and to each `IntradayDayResult`
    the same way the existing `worstCase <= endingBalance` check already
    does at both levels.
- **A recommended, optional extra guard** (lower priority, flagged as
  "nice to have" rather than required): every entry in the _top-level_
  `trades`/`worstCase.trades` arrays (the long-only variant) should have
  `direction === "long"` -- a long-only search can never legitimately
  produce a short trade, so a `"short"` direction appearing there would
  itself indicate a bug (e.g. `includeShorts` accidentally wired to
  `true` for a call site that should be `false`). Cheap, catches exactly
  the class of "the gate that's supposed to keep long-only behavior
  unchanged silently stopped gating" regression this plan's whole
  provably-unchanged argument depends on.

## 4. `apps/pipeline` wiring (`apps/pipeline/src/pipeline.ts`)

### 4.1 Window path: `buildWindowResults`

Replace the existing `optimizeBothDirections(windowed, {...})` call with
`optimizeAllVariants(windowed, {...})`, destructure `{ longOnly,
longShort }`. `optimized = longOnly.best` and `worst = longOnly.worst`
keep their current names/usage completely unchanged (every existing
field in the returned object literal -- `endingBalance`, `trades`,
`worstCase` -- is built from these exactly as today). Add one new field:

```ts
longShort: {
  endingBalance: longShort.best.endingBalance,
  trades: longShort.best.trades,
  worstCase: { endingBalance: longShort.worst.endingBalance, trades: longShort.worst.trades },
},
```

### 4.2 Intraday path: `optimizeIntradayDays` (`packages/core`), same as

issue #31's own precedent

Same reasoning issue #31's plan already recorded for `worstCase`:
`IntradayDayResult` is one combined per-day record built inside
`optimizeIntradayDays`'s own `.map()`, so there's no way to attach
`longShort` to it without touching that function's body (unlike
`optimizeTrades`/`optimizeWorstTrades`, which stay untouched).
`optimizeIntradayDays` swaps its existing `optimizeBothDirections(dayBars,
...)` call for `optimizeAllVariants(dayBars, ...)` and folds `longShort`
into the returned object the same way section 4.1 does for the window
path, reusing `toIntradayTrade` for the long+short trades exactly as it
already does for the long-only ones. **No changes needed in
`pipeline.ts` for the intraday path** -- `buildIntradayResults` already
treats `IntradayDayResult` as opaque (`mergeDaysByGranularity`, the final
`days` array), so `longShort` flows through every call site automatically
once `IntradayDayResult` itself carries it.

### 4.3 `mergeDaysByGranularity`: unchanged, same reasoning as issue #31

Selection criterion stays "whichever day-record's (long-only)
`endingBalance` is higher" -- unchanged code, same as issue #31's own
plan concluded for `worstCase`. Whichever day-record wins carries its own
`longShort` field along for free, with no per-field merge logic added.
Same judgment call, same rationale (a self-consistent day-record from one
coherent dataset beats independently merging every field), flagged again
here rather than silently assumed -- a future reviewer re-reading only
this plan shouldn't have to cross-reference #31's plan to find this
reasoning.

## 5. Risk: performance (the compounded-doubling ask)

Quantified analytically (not benchmarked -- no live run performed as part
of this plan-writing pass; live benchmarking is required during
implementation, per this repo's working agreement, before treating any of
this as confirmed):

- **`packages/core/CLAUDE.md`'s existing baseline**: a single long-only
  direction (`optimizeTrades` alone, pre-#31) costs ~330ms for the full
  S&P 500 over the 21-year "Max" window on realistic synthetic data.
  Post-#31, both long-only directions together (`optimizeBothDirections`,
  sharing one calendar build) cost ~575ms -- about a 23% saving over
  naively running both directions separately (~745ms), from the shared
  calendar/ticker-sort alone.
- **This issue's `longShort` variant, each direction**: per section 1.2,
  each direction's own per-level cost roughly doubles when
  `includeShorts: true` (two suffix + two running-best passes per ticker
  instead of one). Both `longShort` directions together, sharing the same
  built `OptimizerState` `optimizeAllVariants` already reuses across all
  4 runs (not rebuilt per variant, same sharing principle as
  `optimizeBothDirections`), land in the same "cheaper than the naive sum"
  regime the existing #31 benchmark already demonstrated for calendar-
  sharing -- but the _level-building_ work itself (not the calendar/sort)
  genuinely doubles per direction, since that part isn't shared across
  the long-only vs. long+short axis the way it is across the max-vs-min
  axis.
- **Rough combined estimate for the window path, per range**: ~575ms
  (long-only, both directions, unchanged from today) + roughly 2x that
  again for `longShort`'s own two directions (each direction's level-
  building work doubling, partially offset by the same one-time-
  calendar-build saving) -- a ballpark of **~1.6-1.8 seconds per range**,
  roughly **2.8-3x** today's post-#31 per-range cost, or roughly **5x**
  the original pre-#31 baseline. This is the single largest per-run cost
  increase this optimizer has taken across its documented history (#31's
  own 1.6-1.7x was itself flagged as the largest at the time) -- still
  comfortably "cheap" in absolute terms for a nightly batch job (on the
  order of single-digit seconds across all 5 ranges for the window path
  alone), but the multiplier is real and compounding on top of #31's own
  doubling, exactly as the issue's own text anticipates ("roughly doubling
  the pipeline compute again, on top of #31's own doubling"). **Not yet
  measured live -- flagged as a required live-verification step (section
  7), not assumed safe by extrapolation alone.**
- **Intraday path**: same relative multiplier applies per-day (up to
  ~252 days for 1Y), but per-day `T` is tiny (one day's bar count, not a
  multi-year range), so absolute per-day cost should stay cheap the same
  way #31's own doubling did there -- **also unmeasured**, same caveat
  issue #31's own plan flagged for its own intraday-path doubling
  ("should be measured, not assumed, during implementation"), now with
  one more multiplicative factor stacked on top.
- **Memory**: low incremental risk, distinct from the CPU-time risk
  above. Each `runOptimizerForDirection` call builds and discards its own
  `levels` array independently -- nothing forces all 4 variants'
  intermediate DP state to be resident simultaneously, so peak memory
  shouldn't scale with the number of variants the way wall-clock time
  does. The _pipeline's_ Lambda memory ceiling is a real, live, already-
  documented concern (`apps/pipeline/CLAUDE.md`: 903MB/1024MB pre-#29,
  proactively bumped to 2048MB for #29's not-yet-deployed 1-minute bars),
  but this issue's addition is primarily 4 sequential result objects
  (trades + a few numbers each) held in memory to assemble one range's
  JSON, not a multiplied working set -- worth confirming with a real
  memory measurement during live verification (section 7), but not
  expected to meaningfully compound the existing #29 memory concern the
  way it compounds the CPU-time one.

## 6. `apps/web` wiring: every consumer that assumes long-only, by file

Audited directly (not just the issue's own Background bullet, which
misses `portfolio-series.ts`/`PortfolioChart.tsx` entirely -- found by
grepping every call site of `buyDate`/`sellDate`/`buyPrice`/`sellPrice`/
`buyTime`/`sellTime` across `apps/web/src`, not assumed from the issue
text):

### 6.1 `apps/web/src/lib/trade-math.ts`

`computeTradeReturn(openPrice, closePrice, direction)` and
`compoundBalance(startBalance, openPrice, closePrice, direction)` both
gain a **required** `direction` parameter (not optional/defaulted) --
required specifically so no future call site can silently fall back to
long-only math by omission, which would be exactly the kind of silent
correctness bug this repo's `InvalidTradePriceError` precedent already
guards against for bad prices.

```ts
returnFraction = direction === "long" ? closePrice / openPrice - 1 : openPrice / closePrice - 1;
```

```ts
newBalance =
  direction === "long"
    ? startBalance * (closePrice / openPrice)
    : startBalance * (openPrice / closePrice);
```

Both mirror section 1.1's Option B ratio exactly, so a trade's own
narrated/rendered return always matches what the optimizer itself used to
compound `endingBalance` -- the same "no drift between two
implementations of the same math" property `trade-math.ts`'s own header
comment already documents as the reason this module exists.
`assertValidPrice`'s check (finite, positive) is unchanged -- still
applies to both prices regardless of direction.

### 6.2 `apps/web/src/lib/narrate-trades.ts`

`NarratableTrade` gains `direction: "long" | "short"`. `leadInFor`'s
existing lead-in phrases ("Had you known, you'd have" / "Then you'd
have" / "Finally, you'd have") are direction-agnostic and unchanged --
only the _verb_ that follows needs to branch: today's hardcoded "bought
... and sold ..." becomes direction-aware ("bought ... and sold ..." for
long, "shorted ... and covered ..." for short). `narrateTrades` passes
`direction` through to `computeTradeReturn`/`compoundBalance` (section
6.1) instead of calling them with an implicit long assumption.

### 6.3 `apps/web/src/components/TradeRow.tsx`

Gains a `direction: "long" | "short"` prop alongside the existing
`preposition`. Verb pair becomes direction-aware: `"Buy"`/`"Sell"` for
long, `"Short"`/`"Cover"` for short (standard finance terminology --
flagged as a UI copy choice, not load-bearing, a reviewer/screenshot pass
can adjust wording without affecting this plan's technical design).
`buyLabel`/`sellLabel` props rename to `openLabel`/`closeLabel` to match
section 1.3's schema rename.

### 6.4 `apps/web/src/components/TradeList.tsx`

Maps `Trade`'s renamed fields (`openDate`/`openPrice`/`closeDate`/
`closePrice`/`direction`) into `NarratableTrade` instead of today's
`buyDate`/etc. mapping -- otherwise unchanged (still one `<ol>` of prose
`<li>`s, still reuses `formatDate`/`formatHeroCurrency`/`formatPercent`
as-is).

### 6.5 `apps/web/src/components/IntradayTradeList.tsx`

Maps `IntradayTrade`'s renamed fields into `TradeRow`'s renamed props,
including the new `direction` prop -- otherwise unchanged.

### 6.6 `apps/web/src/lib/portfolio-series.ts` -- found via file audit, not

named in the issue's own Background section

`appendTradeSteps`'s `compoundBalance(value, trade.buyPrice,
trade.sellPrice)` call needs `direction` threaded through (it currently
assumes long compounding unconditionally). `PortfolioEvent`'s type union
(`"buy" | "sell"`) needs generalizing -- recommended:
`{ type: "open" | "close"; direction: "long" | "short"; ticker: string;
price: number }`, so a short's "open" event (visually: no value jump,
same as today's "buy" annotation -- opening a short doesn't change total
portfolio value in this all-in model any more than buying does) and
"close" event (the point value actually jumps, mirroring "sell") stay
structurally analogous to the existing long annotations, just relabeled.
`derivePortfolioSeries`/`deriveIntradayPortfolioSeries` update their
field references (`trade.buyDate` -> `trade.openDate`, etc.) to match
section 1.3/3.2's rename.

### 6.7 `apps/web/src/components/PortfolioChart.tsx` -- found via file

audit, four call sites

Directly branches on `event.type === "buy"` in four places (confirmed by
line number, not inferred): the marker's above/below positioning logic,
the marker `<g>` key, the marker's own label text ("Buy " / "Sell "), the
hover tooltip's verb ("bought"/"sold"), and the accessible title text
("Buy"/"Sell ... @ ..."). Each needs a direction-aware label pair
("Short"/"Cover" alongside "Buy"/"Sell") once `PortfolioEvent.type`
becomes `"open" | "close"` (section 6.6) -- this is a real, non-trivial
piece of UI work this plan's audit surfaced that the issue's own text
does not mention at all, flagged explicitly so it isn't missed during
implementation scoping.

### 6.8 Frontend toggle: `?mode=long|long-short` URL state

Placed near `RangeSelector` per the issue's own scope, mirroring
`RangeSelector`'s existing pill-button pattern (`ResultsPage.tsx`, which
already owns `range`/`day` as URL state via `URLSearchParams`).
**Recommendation: URL state (`?mode=`), not a persisted localStorage
preference** (unlike `use-starting-capital.ts`'s pattern) -- "which
trade set is being shown" is core, shareable content state, the same
category `?range=`/`?day=` already occupy, not a personal display
preference like starting capital. Defaults to `long` (long-only) for a
fresh visit -- so an existing shared link with no `mode` param keeps
showing exactly what it shows today, a real backward-compatibility
property worth stating explicitly. **Flagged as a judgment call**: a
localStorage-persisted preference (mirroring `use-starting-capital.ts`)
is a defensible alternative if a reviewer weighs "remembers your last
choice across visits" over "shareable via URL" -- this plan leans URL
state for the shareability precedent, not because the issue text forces
either choice.

### 6.9 `apps/web/src/components/ResultsPanel.tsx`: variant selection, the

largest actual refactor surface in `apps/web`

Every current read of `data.endingBalance`/`data.trades`/`data.worstCase`
(window branch) or `activeDay.endingBalance`/`activeDay.trades`/
`activeDay.worstCase` (intraday-daily branch) needs to become mode-aware.
Recommended: one small selection helper,

```ts
function selectVariant(
  base: { endingBalance: number; trades: Trade[]; worstCase: WorstCaseResult },
  longShort: LongShortResult,
  mode: "long" | "long-short",
) {
  return mode === "long" ? base : longShort;
}
```

called once per branch, its result threaded into `HeroStat`,
`PortfolioChart` (via `portfolio-series.ts`), `TradeList`/
`IntradayTradeList`, and `WorstCaseStat` instead of the raw top-level
fields each currently reads directly. This mirrors the exact shape of
mistake `apps/web/CLAUDE.md` already documents happening _twice_ for
`effectiveStartingCapital` (issue #15) -- a component quietly reading the
un-rescaled raw field instead of the thread-through value, caught only in
code review, not by a test that didn't exist yet. **Recommendation: add
the equivalent regression tests up front this time** (render with
`mode=long-short` and assert the `longShort` variant's figures appear,
not the long-only ones) rather than relying on a second code-review catch
of the same class of bug.

### 6.10 `daily-guess-storage.ts`/`useDailyGuess` (issue #34): key must

also include `mode`

`apps/web/CLAUDE.md` already documents that a guess is keyed by
`(range, date)`, not just `date`, because the _same_ calendar date can
carry a genuinely different result depending on range (different
granularity overrides). **The identical argument applies to `mode`**: the
same `(range, date)` can now carry a genuinely different `endingBalance`
depending on whether long-only or long+short is selected. Without
extending the key to `(range, date, mode)`, a guess submitted under
`mode=long` would incorrectly satisfy the guess-gate for the same
`(range, date)` under `mode=long-short` too -- skipping straight to a
reveal the user never actually guessed against, exactly the bug class
that file's own existing note already warns about for range. **Required
extension, not optional** -- flagged prominently since it's the kind of
gap that's easy to miss (the mode toggle and the guessing game are
different features, landed in different issues, with no obvious reason
for an implementer of _this_ issue to re-open `daily-guess-storage.ts`
unless this cross-reference is made explicit).

### 6.11 OG share card (`/api/og/[range]`, issue #33): scope call, not

resolved

The OG card is already scoped to the `"window"` model only, and always
renders the long-only figures today (`buildOgCardContent` reads
`data.endingBalance`/`data.trades` directly). **Recommendation: leave it
long-only-only for this issue** -- adding a `mode` dimension would double
its own cached-variant matrix (5 ranges -> 10 range x mode combos, each
its own ISR cache slot) for a share-card feature the issue's own scope
never mentions. **Flagged as an explicit judgment call, not resolved
definitively** -- a reviewer who wants a long+short-aware share card
should treat that as a follow-up, not something silently bundled into
this plan's scope.

### 6.12 `apps/web/src/lib/results-api.ts`: no code change expected

Same precedent both #31 and #12's plans already established and
verified: this route is a pure passthrough of `PrecomputedResult` JSON,
never inspecting field-level shape beyond `schemaVersion`/`model`. The
new `longShort` field (and the renamed `Trade` fields) flow through
automatically once `packages/core`'s types update -- no edit needed here.

## 7. Live verification plan (not performed in this planning phase)

Per this repo's working agreement ("verify live... at least once per
feature") and the issue's own explicit acceptance criterion:

1. A real pipeline run (local invocation against real Yahoo data,
   no S3 write needed for this check) confirming: `longShort.endingBalance
   > = endingBalance`and`longShort.worstCase.endingBalance <=
   > worstCase.endingBalance`hold for all 5 ranges on real data (the two
cross-checks from section 3.3), and that at least one real short trade
actually appears somewhere in`longShort.trades` across the 5 ranges
   > (a real S&P 500 universe over any meaningfully long window should have
   > _some_ declining stretch a short profits from -- if none appears
   > anywhere, that's worth investigating before treating the feature as
   > working, not just shrugging it off as "long-only would've won anyway").
2. A real wall-clock timing measurement of `optimizeAllVariants` against
   the full S&P 500 universe, confirming or correcting section 5's
   analytical ~1.6-1.8s/range, ~2.8-3x estimate -- required, not assumed,
   per this repo's stated preference for benchmarking over estimating.
   Cover both the window path (5 ranges) and the intraday path (up to
   ~252 days for 1Y), since #31's own plan already flagged the intraday
   path's doubling as unmeasured and this issue stacks a further
   multiplier on exactly that unmeasured cost.
3. A real memory measurement (a local run reporting peak RSS, or a real
   Lambda invoke once deployed) confirming section 5's "low incremental
   memory risk" claim, given the existing, already-tight #29 memory
   ceiling this pipeline runs under.
4. A screenshot pass (the established throwaway-debug-route technique,
   `apps/web/CLAUDE.md`'s "Screenshotting a component locally" section)
   of: the `?mode=` toggle itself, a short trade rendered in `TradeList`'s
   prose and in `IntradayTradeList`'s rows, `PortfolioChart`'s short-aware
   open/close markers, and `WorstCaseStat` under `mode=long-short` -- in
   both light and dark themes, confirming the direction-aware copy (Short/
   Cover) reads comprehensibly to a first-time viewer, which is a genuine
   product/legibility question this plan can't settle from code alone.
5. This is a real-AWS action once it reaches an actual pipeline write
   (`RESULTS_SCHEMA_VERSION` bump means every range key must be rewritten
   before or atomically with deploying a schema-5-reading `apps/web`,
   same rollout hazard every prior schema bump in this repo has
   documented) -- needs the user's explicit go-ahead per root `CLAUDE.md`'s
   working agreement, not performed as part of this plan.

None of the above is performed as part of this plan-writing pass.

## 8. Testing plan (not performed in this planning phase)

- **`packages/core/src/optimizer.test.ts`**: new fixtures for
  `optimizeAllVariants` proving (a) a synthetic short-favorable scenario
  (a ticker that only declines) is only captured by the `longShort`
  variant, never `longOnly`; (b) the two cross-checks from section 3.3
  hold on several small hand-computable fixtures; (c) the long/short
  same-ticker tie-break from section 1.4(b), with the exact worked
  numbers from that section; (d) the cross-ticker tie-break, same
  numbers; (e) **regression requirement**: the full existing
  `optimizer.test.ts` suite (today's long-only behavior via
  `optimizeTrades`/`optimizeWorstTrades`/`optimizeBothDirections`) keeps
  passing byte-for-byte unchanged -- the proof that the `includeShorts`
  gate genuinely doesn't touch the old path.
- **`packages/core/src/intraday-optimizer.test.ts`**: extend to assert
  `IntradayDayResult.longShort` is present per day and satisfies the same
  two cross-checks.
- **`packages/core/src/results-schema.test.ts`**: extend
  `validatePrecomputedResult` tests for `longShort` on both `WindowResult`
  and `IntradayDayResult` paths (missing fails; malformed nested trade
  fails; each cross-check's violation fails); update every hardcoded
  `schemaVersion: 4` fixture to `5`; update every hardcoded `Trade`
  fixture to the renamed fields.
- **`apps/pipeline/src/pipeline.test.ts`**: extend window/intraday
  result-building tests to assert `longShort` populates correctly per
  range/day.
- **`apps/web`**: `trade-math.test.ts` extended for short-direction
  return/compounding math (including the InvalidTradePriceError path,
  unchanged); `narrate-trades.test.ts`/`TradeList.test.tsx`/
  `IntradayTradeList.test.tsx`/`TradeRow` tests extended for short
  rendering; `portfolio-series.test.ts` extended for short-leg
  compounding and the renamed `PortfolioEvent` shape; `PortfolioChart`
  tests extended for the four direction-aware label sites (section 6.7);
  `ResultsPanel.test.tsx` extended for `mode=long-short` variant
  selection across every consumer named in section 6.9 (the regression-
  test recommendation made there); `daily-guess-storage.test.ts`/
  `use-daily-guess.test.ts` extended for the `mode`-inclusive key
  (section 6.10).

## 9. Consolidated list of judgment calls / open questions for the reviewer

Collected from throughout this document, not new:

1. **Section 1.1**: Option B (reciprocal-price, bounded downside) over
   Option A (fixed-notional, unbounded downside, needs a convex-hull-trick
   rewrite) -- the single biggest design decision in this plan, and the
   one everything else (section 1.4's answers, section 3.3's cross-
   checks) is downstream of.
2. **Section 1.3**: renaming `Trade`'s fields to direction-neutral
   `openDate`/`openPrice`/`closeDate`/`closePrice` rather than keeping
   `buyDate`/`sellDate`/etc. and only adding `direction`.
3. **Section 1.4(b)**: the long-before-short same-ticker tie-break is a
   genuinely new, previously-nonexistent tie-break axis, arbitrary but
   deterministic, falling out of implementation/processing order rather
   than a principled preference.
4. **Section 3.2**: `longShort` as an additive sibling field (matching
   issue #31's `worstCase` precedent) rather than restructuring into a
   `variants: {...}` wrapper that would touch every existing consumer.
5. **Section 6.8**: URL state (`?mode=`) for the toggle, not a persisted
   localStorage preference.
6. **Section 6.11**: OG share card stays long-only-only for this issue,
   not extended to a `mode`-aware cache matrix.
7. **Section 3.3**: the "top-level trades must all have `direction ===
"long""" guard is recommended but explicitly lower-priority than the
two `>=`/`<=` cross-checks.

## 10. Risks (summary)

- **Correctness**: the highest risk in this plan is Option B's
  reciprocal-price short being subtly mis-implemented (e.g. multiplying
  where the long pass divides, or vice versa) -- mitigated by the two
  structural cross-checks in section 3.3 (both true by construction,
  both would fail loudly on a sign/direction bug) and the same
  "unchanged existing test suite" regression requirement issue #31 used
  for its own `direction` parameter.
- **Perf**: real, quantified in section 5 as the largest single per-run
  cost increase this optimizer has taken, still analytically "cheap" in
  absolute terms but **unverified live** -- the single most important
  unresolved item before this plan should be treated as safe to
  implement at face value.
- **Blast radius**: the widest of any plan in this repo's history --
  touches `optimizer.ts` (this repo's designated highest-stakes file),
  both schema files, both pipeline result-builders, and a long list of
  `apps/web` consumers (section 6, several of them found only by direct
  file audit, not named in the issue's own text) -- comparable in shape
  to issue #28's original schema-2 rollout but with a materially larger
  algorithmic core change than any prior issue in this repo's plan
  history.
- **Product/legibility risk**: distinct from the above -- a short trade
  rendered in prose/chart form is a genuinely new kind of statement this
  app has never made before ("had you known, you'd have shorted X and
  covered..."), and whether that reads clearly to a first-time viewer
  (who this app already goes out of its way to keep from being misled,
  per its own "not investment advice" framing) is a real open question
  this plan flags but can't settle without the screenshot pass in
  section 7.
