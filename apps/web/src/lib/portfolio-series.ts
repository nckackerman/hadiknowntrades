// Derives a client-side "portfolio value over time" step-function series
// from a PrecomputedResult's trade sequence. The results API (see
// ../app/api/results/route.ts) only ever returns the buy/sell points
// themselves -- there's no daily mark-to-market series in the stored
// data -- so the chart (see ../components/PortfolioChart.tsx) needs this
// derived client-side.
//
// Shape of the derivation, in order:
//   - Flat at startingCapital from the window's start date up to the
//     first trade's buy date (sitting in cash).
//   - A "buy" annotation point at the buy date. Buying doesn't change
//     total value -- cash converts into an equal-value position -- so
//     this never causes a jump, only a chart annotation.
//   - Flat at the pre-trade value through the entire holding period, up
//     to the sell date. We only have entry/exit prices, not a daily
//     price series while holding, so there's no honest way to draw an
//     interim mark-to-market line -- flat-until-realized is the
//     defensible reading of "we don't know."
//   - A "sell" annotation point at the sell date where the value jumps
//     (up or down) by the trade's sellPrice/buyPrice ratio -- the one
//     point where money actually changes hands in the model.
//   - Flat at the final value from the last sell (or the window start,
//     if there were no trades) through the window's end date.
//
// Consecutive trades that touch (one sellDate equals the next buyDate)
// naturally produce two points at the same date/value -- that's fine,
// it's a zero-length flat segment, not a bug.

import type { Trade } from "@hadiknowntrades/core";

export type PortfolioEvent =
  { type: "buy"; ticker: string; price: number } | { type: "sell"; ticker: string; price: number };

export interface PortfolioPoint {
  /** ISO date (YYYY-MM-DD) this point falls on. */
  date: string;
  /** Portfolio value at this point. */
  value: number;
  /** The trade event this point annotates, if any. */
  event: PortfolioEvent | null;
}

/**
 * Builds the step-function series described above. `startDate` may be
 * null (the "MAX" range's unbounded window) -- in that case the series
 * starts at the first trade's buy date, or at `endDate` if there were no
 * trades at all (nothing to plot but a single flat point).
 */
export function derivePortfolioSeries(
  startingCapital: number,
  startDate: string | null,
  endDate: string,
  trades: readonly Trade[],
): PortfolioPoint[] {
  const points: PortfolioPoint[] = [];
  let value = startingCapital;

  const firstDate = startDate ?? trades[0]?.buyDate ?? endDate;
  points.push({ date: firstDate, value, event: null });

  for (const trade of trades) {
    points.push({
      date: trade.buyDate,
      value,
      event: { type: "buy", ticker: trade.ticker, price: trade.buyPrice },
    });

    points.push({ date: trade.sellDate, value, event: null });

    value = value * (trade.sellPrice / trade.buyPrice);
    points.push({
      date: trade.sellDate,
      value,
      event: { type: "sell", ticker: trade.ticker, price: trade.sellPrice },
    });
  }

  const last = points[points.length - 1];
  if (!last || last.date !== endDate) {
    points.push({ date: endDate, value, event: null });
  }

  return points;
}
