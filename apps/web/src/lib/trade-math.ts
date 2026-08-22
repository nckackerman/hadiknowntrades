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

export interface TradeReturn {
  /** sellPrice / buyPrice - 1. Negative for a loss leg. */
  returnFraction: number;
  /** returnFraction >= 0 -- flat (exactly breaking even) counts as a gain, the established convention every caller of this helper shares. */
  isGain: boolean;
}

/**
 * Thrown by both helpers below for a non-finite or non-positive
 * buyPrice/sellPrice (found in code review, issue #32's PR): unlike
 * `packages/core`'s optimizer.ts, which validates `endingBalance` is
 * finite before ever returning a result, and the pipeline's own
 * write-time `validatePrecomputedResult` (issue #47), this app's read
 * path (`results-api.ts`) only checks `schemaVersion`/`model` on a
 * stored result -- it never re-validates field-level values like
 * individual trade prices. A zero/non-finite `buyPrice` reaching either
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
 * its buy and sell price. Shared by TradeRow.tsx (the row/table
 * rendering) and narrate-trades.ts (the prose narration) -- both color a
 * trade's percent the same way and must agree on what counts as a gain.
 *
 * @throws {InvalidTradePriceError} if buyPrice or sellPrice is non-finite
 * or <= 0 -- see that class's doc comment for why this validates rather
 * than silently computing Infinity/NaN.
 */
export function computeTradeReturn(buyPrice: number, sellPrice: number): TradeReturn {
  assertValidPrice(buyPrice, "buyPrice");
  assertValidPrice(sellPrice, "sellPrice");
  const returnFraction = sellPrice / buyPrice - 1;
  return { returnFraction, isGain: returnFraction >= 0 };
}

/**
 * Compounds a starting balance through one all-in, fully-reinvested
 * trade leg: the whole balance buys in at buyPrice and sells out at
 * sellPrice, so the balance scales by the same sellPrice/buyPrice ratio
 * as the trade's own return. Shared by portfolio-series.ts's
 * appendTradeSteps (the chart's step-function series) and
 * narrate-trades.ts (the prose's running "turning your $X into $Y"
 * balance) -- both need the identical single-step compounding rule
 * applied per trade in sequence.
 *
 * @throws {InvalidTradePriceError} if buyPrice or sellPrice is non-finite
 * or <= 0 -- validated independently of computeTradeReturn's own check
 * since portfolio-series.ts calls this without going through
 * computeTradeReturn first.
 */
export function compoundBalance(startBalance: number, buyPrice: number, sellPrice: number): number {
  assertValidPrice(buyPrice, "buyPrice");
  assertValidPrice(sellPrice, "sellPrice");
  return startBalance * (sellPrice / buyPrice);
}
