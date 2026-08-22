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

import type { TradeDirection } from "@hadiknowntrades/core";

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
  if (!Number.isFinite(value) || value <= 0) {
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
