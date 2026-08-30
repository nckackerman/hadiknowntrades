// Shared arithmetic behind a single trade's return and the running,
// fully-reinvested portfolio balance across a sequence of trades --
// extracted (code review on issue #32's PR) because this exact math was
// independently re-derived in three places: TradeRow.tsx's per-trade
// return/gain-loss coloring, narrate-trades.ts's own copy of the same
// return computation plus its own running-balance loop, and
// portfolio-series.ts's appendTradeSteps compounding loop for the chart.
// All three now call into this module instead of re-deriving the
// arithmetic, so there's exactly one implementation to get right (and to
// cross-check in trade-math.test.ts) rather than three that can drift
// apart silently.
//
// Issue #13 adds a `direction` parameter to both functions below,
// required (not optional/defaulted) specifically so no future call site
// can silently fall back to long-only math by omission -- the same
// "silent correctness bug" class this file's own InvalidTradePriceError
// already guards against for bad prices. A short's math mirrors
// optimizer.ts's own reciprocal-price payoff exactly (openPrice/closePrice
// instead of closePrice/openPrice) so a rendered trade's return/balance
// always matches what the optimizer itself used to compound
// endingBalance -- no drift between two implementations of the same math.

import { isValidPrice, type TradeDirection } from "@hadiknowntrades/core";

export interface TradeReturn {
  /** closePrice / openPrice - 1 for a long, openPrice / closePrice - 1 for a short. Negative for a loss leg. */
  returnFraction: number;
  /** returnFraction >= 0 -- flat (exactly breaking even) counts as a gain, the established convention every caller of this helper shares. */
  isGain: boolean;
}

/**
 * Thrown by both helpers below for a non-finite or non-positive
 * openPrice/closePrice (found in code review, issue #32's PR): unlike
 * `packages/core`'s optimizer.ts, which validates `endingBalance` is
 * finite before ever returning a result, and the pipeline's own
 * write-time `validatePrecomputedResult` (issue #47), this app's read
 * path (`results-api.ts`) only checks `schemaVersion`/`model` on a
 * stored result -- it never re-validates field-level values like
 * individual trade prices. A zero/non-finite `openPrice` reaching either
 * helper here (a partial/non-atomic S3 write, or an older pre-#47 stored
 * result) would otherwise silently produce `Infinity`/`NaN` --
 * particularly dangerous for `isGain`, since `Infinity >= 0` is `true`,
 * which would render a corrupted leg in "gain" green with garbage
 * figures instead of surfacing the problem. Throwing here means it's a
 * caught, visible failure (`app/error.tsx`/`app/global-error.tsx`,
 * issue #46, already exist to catch exactly this kind of render-time
 * throw) rather than a silently-wrong number in the UI.
 */
export class InvalidTradePriceError extends Error {
  constructor(label: string, value: number) {
    super(`trade-math: expected a finite, positive ${label}, got ${value}`);
    this.name = "InvalidTradePriceError";
  }
}

function assertValidPrice(value: number, label: string): void {
  // Delegates to packages/core's own isValidPrice (Number.isFinite(v) &&
  // v > 0) rather than re-deriving the same check a third time --
  // beat-the-bench.ts/call-board-scoring.ts already made this same call
  // for the identical predicate; this file's own historical duplicate
  // (from before that precedent existed) is fixed here to match.
  if (!isValidPrice(value)) {
    throw new InvalidTradePriceError(label, value);
  }
}

/**
 * A single trade's return fraction and gain/loss classification, given
 * its open/close price and direction. Shared by TradeRow.tsx (the
 * row/table rendering) and narrate-trades.ts (the prose narration) --
 * both color a trade's percent the same way and must agree on what
 * counts as a gain.
 *
 * `direction` is required, not optional/defaulted -- so no future call
 * site can silently fall back to long-only math by omission (issue #13).
 * A long's return is closePrice/openPrice - 1 (unchanged from before this
 * issue); a short's is openPrice/closePrice - 1, mirroring
 * optimizer.ts's own reciprocal-price payoff exactly.
 *
 * @throws {InvalidTradePriceError} if openPrice or closePrice is
 * non-finite or <= 0 -- see that class's doc comment for why this
 * validates rather than silently computing Infinity/NaN.
 */
export function computeTradeReturn(
  openPrice: number,
  closePrice: number,
  direction: TradeDirection,
): TradeReturn {
  assertValidPrice(openPrice, "openPrice");
  assertValidPrice(closePrice, "closePrice");
  const returnFraction =
    direction === "long" ? closePrice / openPrice - 1 : openPrice / closePrice - 1;
  return { returnFraction, isGain: returnFraction >= 0 };
}

/**
 * Compounds a starting balance through one all-in, fully-reinvested
 * trade leg: the whole balance opens at openPrice and closes at
 * closePrice, so the balance scales by the same ratio as the trade's own
 * return (see computeTradeReturn) -- closePrice/openPrice for a long,
 * openPrice/closePrice for a short. Shared by portfolio-series.ts's
 * appendTradeSteps (the chart's step-function series) and
 * narrate-trades.ts (the prose's running "turning your $X into $Y"
 * balance) -- both need the identical single-step compounding rule
 * applied per trade in sequence.
 *
 * `direction` is required for the same reason as computeTradeReturn's
 * own parameter -- no silent long-only fallback by omission (issue #13).
 *
 * @throws {InvalidTradePriceError} if openPrice or closePrice is
 * non-finite or <= 0 -- validated independently of computeTradeReturn's
 * own check since portfolio-series.ts calls this without going through
 * computeTradeReturn first.
 */
export function compoundBalance(
  startBalance: number,
  openPrice: number,
  closePrice: number,
  direction: TradeDirection,
): number {
  assertValidPrice(openPrice, "openPrice");
  assertValidPrice(closePrice, "closePrice");
  return startBalance * (direction === "long" ? closePrice / openPrice : openPrice / closePrice);
}

/** A direction's open/close verb pair, in one of two grammatical registers -- see `tradeVerbs`/`tradeVerbsPast`, which both build on this. */
export interface TradeVerbs {
  openVerb: string;
  closeVerb: string;
}

/**
 * "Buy"/"Sell" for a long, "Short"/"Cover" for a short (issue #13,
 * standard finance terminology) -- the capitalized, present-tense verb
 * pair for a "Buy TICKER ... Sell ..." style label. Extracted (code
 * review follow-up to issue #13) because this exact pair was
 * independently hand-rolled in three places that had started to
 * comment, correctly, that they were "reusing the same wording" without
 * actually sharing any code: TradeRow.tsx's own `verbsFor`, and
 * PortfolioChart.tsx's `eventLabelVerb`. One implementation now backs
 * both, the same reasoning this module's own header comment already
 * gives for `computeTradeReturn`/`compoundBalance`.
 */
export function tradeVerbs(direction: TradeDirection): TradeVerbs {
  return direction === "long"
    ? { openVerb: "Buy", closeVerb: "Sell" }
    : { openVerb: "Short", closeVerb: "Cover" };
}

/**
 * "bought"/"sold" for a long, "shorted"/"covered" for a short -- the
 * lowercase, past-tense verb pair for a completed-trade sentence ("...you
 * bought TICKER..."). Same extraction reasoning as `tradeVerbs` above;
 * this one replaces narrate-trades.ts's own `verbsFor` and
 * PortfolioChart.tsx's `eventTooltipVerb`.
 */
export function tradeVerbsPast(direction: TradeDirection): TradeVerbs {
  return direction === "long"
    ? { openVerb: "bought", closeVerb: "sold" }
    : { openVerb: "shorted", closeVerb: "covered" };
}

/** Capitalizes a single word's first letter -- the one bit of logic `tradeVerbsPastCapitalized` below needs that `tradeVerbsPast` doesn't already give it. */
function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/**
 * "Bought"/"Sold" for a long, "Shorted"/"Covered" for a short -- the
 * capitalized, past-tense verb pair for the start of a standalone
 * sentence ("Bought AAPL on Mar 12, 2025 at $142.00."), e.g.
 * TradeReplay.tsx's own playback callouts (issue #96). Distinct from
 * both `tradeVerbs` above (capitalized, present tense -- "Buy"/"Sell",
 * a label prefix) and `tradeVerbsPast` above (lowercase, past tense --
 * "bought"/"sold", mid-sentence prose): this is the one register
 * neither of those two already covers. Extracted here rather than a
 * one-off `capitalize()` helper in a component file, per this module's
 * own header comment on why this exact class of verb-pair fragmentation
 * gets centralized once instead of re-derived per caller.
 *
 * **Derived from `tradeVerbsPast` (code review, issue #96 follow-up round
 * 3), not a third independent long/short branch.** The first version of
 * this function re-encoded the same "long -> X/Y, short -> A/B" branching
 * a third time instead of building on the sibling that already has the
 * exact same words, just lowercase -- exactly the class of duplication
 * this module's own header comment warns against, ironically inside the
 * function whose own doc comment above already argues for centralizing
 * verb-pair logic.
 */
export function tradeVerbsPastCapitalized(direction: TradeDirection): TradeVerbs {
  const { openVerb, closeVerb } = tradeVerbsPast(direction);
  return { openVerb: capitalize(openVerb), closeVerb: capitalize(closeVerb) };
}
