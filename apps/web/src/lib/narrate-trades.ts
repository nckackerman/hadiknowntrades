// Pure prose-narration logic behind TradeList (issue #32) -- deliberately
// decoupled from React and from *which* date/time formatter the caller
// used to produce buyLabel/sellLabel, so this is reusable by
// IntradayTradeList too (see TradeList.tsx's doc comment for why that
// isn't wired up yet). All formatting of the numbers this returns (the
// dollar figures, the percent) stays the caller's job -- this module only
// computes the values and the per-trade "lead-in" phrase.

/**
 * The minimum a trade needs to carry to be narrated: a ticker, already
 * pre-formatted buy/sell labels (a calendar date for TradeList, a
 * time-of-day for a future IntradayTradeList use), and the two prices.
 * Deliberately not `Trade` itself -- keeping this shape narrow (and
 * label-formatting the caller's job) is what lets one function serve
 * both the window model's date-labeled trades and the intraday model's
 * time-labeled ones without an adapter.
 */
export interface NarratableTrade {
  ticker: string;
  buyLabel: string;
  buyPrice: number;
  sellLabel: string;
  sellPrice: number;
}

export interface TradeNarration {
  key: string;
  /** "Had you known, you'd have" (first trade) / "Then you'd have" (a middle trade) / "Finally, you'd have" (the last trade, including the last of a 2-trade sequence) -- see leadInFor below for why this doesn't need special-casing per trade count. */
  leadIn: string;
  ticker: string;
  buyLabel: string;
  buyPrice: number;
  sellLabel: string;
  sellPrice: number;
  /** The running (fully-reinvested) portfolio balance immediately before this trade -- startingCapital for the first trade, the previous trade's endBalance otherwise. */
  startBalance: number;
  /**
   * The running balance immediately after this trade sells, compounding
   * every prior trade in the sequence -- exactly the same multiplicative
   * chain optimizer.ts uses to derive `endingBalance` (startBalance *
   * sellPrice / buyPrice), so the last trade's endBalance matches the
   * result's own endingBalance (modulo floating-point noise). This is
   * the value that can land on the Max-range's astronomically large
   * numbers (see packages/core/CLAUDE.md's "Fun/expected product quirk"
   * note) -- callers must format it with formatHeroCurrency (or
   * equivalent), never a bare template-literal `$`, so it degrades to a
   * compact/scientific form instead of a wall of digits.
   */
  endBalance: number;
  /** sellPrice / buyPrice - 1 -- identical to this trade's own portfolio-return fraction (an all-in, fully-reinvested trade means the ticker's own price return *is* the portfolio's return for that leg), so there's no separate "portfolio return" to compute. Negative for a loss leg -- today's optimizer never produces one, but this isn't assumed here (see TradeRow.tsx's own identical, pre-existing computation, which this mirrors). */
  returnFraction: number;
  /** returnFraction >= 0 -- matches TradeRow.tsx's own established "flat counts as a gain" convention, reused here rather than re-derived, so the two don't drift apart on what counts as good/bad. */
  isGain: boolean;
}

/**
 * "Had you known, you'd have" for the first trade, "Finally, you'd have"
 * for the last (checked *after* the first-trade case, so a 1-trade
 * sequence gets "Had you known" rather than "Finally"), "Then you'd
 * have" for anything in between. Reads correctly for 1, 2, or 3 trades
 * without per-count branching: a 2-trade sequence's second trade is both
 * "not first" and "last", so it gets "Finally" -- which reads fine as
 * "lastly", not just "the final of >=3".
 */
function leadInFor(index: number, total: number): string {
  if (index === 0) return "Had you known, you'd have";
  if (index === total - 1) return "Finally, you'd have";
  return "Then you'd have";
}

/**
 * Builds one TradeNarration per trade, in sequence order. Returns `[]`
 * for an empty `trades` array rather than throwing -- TradeList.tsx's own
 * contract still expects a non-empty sequence (ResultsPanel owns the
 * empty-state copy), but this function itself stays defensive so it
 * can't crash if that contract is ever violated by a future caller.
 */
export function narrateTrades(
  trades: readonly NarratableTrade[],
  startingCapital: number,
): TradeNarration[] {
  let runningBalance = startingCapital;
  return trades.map((trade, index) => {
    const startBalance = runningBalance;
    const returnFraction = trade.sellPrice / trade.buyPrice - 1;
    runningBalance = startBalance * (trade.sellPrice / trade.buyPrice);
    return {
      key: `${trade.ticker}-${trade.buyLabel}-${index}`,
      leadIn: leadInFor(index, trades.length),
      ticker: trade.ticker,
      buyLabel: trade.buyLabel,
      buyPrice: trade.buyPrice,
      sellLabel: trade.sellLabel,
      sellPrice: trade.sellPrice,
      startBalance,
      endBalance: runningBalance,
      returnFraction,
      isGain: returnFraction >= 0,
    };
  });
}
