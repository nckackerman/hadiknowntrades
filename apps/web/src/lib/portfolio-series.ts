// Derives a client-side "portfolio value over time" step-function series
// from a PrecomputedResult's trade sequence. The results API (see
// ../app/api/results/route.ts) only ever returns the open/close points
// themselves -- there's no daily mark-to-market series in the stored
// data -- so the chart (see ../components/PortfolioChart.tsx) needs this
// derived client-side.
//
// Shape of the derivation, in order:
//   - Flat at startingCapital from the window's start date up to the
//     first trade's open date (sitting in cash).
//   - An "open" annotation point at the open date. Opening a position
//     (long or short) doesn't change total value -- cash converts into
//     an equal-value position -- so this never causes a jump, only a
//     chart annotation.
//   - Flat at the pre-trade value through the entire holding period, up
//     to the close date. We only have entry/exit prices, not a daily
//     price series while holding, so there's no honest way to draw an
//     interim mark-to-market line -- flat-until-realized is the
//     defensible reading of "we don't know."
//   - A "close" annotation point at the close date where the value jumps
//     (up or down) by the trade's compounding ratio (see trade-math.ts's
//     compoundBalance) -- the one point where money actually changes
//     hands in the model.
//   - Flat at the final value from the last close (or the window start,
//     if there were no trades) through the window's end date.
//
// Consecutive trades that touch (one closeDate equals the next openDate)
// naturally produce two points at the same date/value -- that's fine,
// it's a zero-length flat segment, not a bug.

import type { IntradayTrade, Trade, TradeDirection } from "@hadiknowntrades/core";

import { compoundBalance } from "./trade-math";

/**
 * A trade's "open" event (issue #13: a long's buy or a short's open,
 * neither of which change total portfolio value in this all-in model)
 * or "close" event (a long's sell or a short's cover, the point where
 * value actually jumps) -- `direction` disambiguates which economic
 * action a given `type` actually is, since "open"/"close" alone are
 * direction-neutral by design (see optimizer.ts's own Trade rename).
 */
export type PortfolioEvent = {
  type: "open" | "close";
  direction: TradeDirection;
  ticker: string;
  price: number;
};

export interface PortfolioPoint {
  /**
   * Either a plain calendar date (YYYY-MM-DD, the window model) or a
   * full local datetime (YYYY-MM-DDTHH:MM:SS, an intraday day's chart --
   * see deriveIntradayPortfolioSeries below) this point falls on.
   * PortfolioChart's toTimestamp/formatDateTime both detect which one
   * they've been given via format-date.ts's isPortfolioDatetime.
   */
  date: string;
  /** Portfolio value at this point. */
  value: number;
  /** The trade event this point annotates, if any. */
  event: PortfolioEvent | null;
}

/**
 * Appends the open/flat/close steps for each trade in sequence to
 * `points` (mutated in place), compounding (direction-aware, issue #13 --
 * see trade-math.ts's compoundBalance) and returning the running value --
 * the mechanical part shared by derivePortfolioSeries and
 * deriveIntradayPortfolioSeries below, which only differ in how a
 * trade's open/close *labels* are derived (a calendar date vs. a full
 * intraday datetime) and in their own start/end boundary-point handling
 * around this shared middle section.
 */
function appendTradeSteps(
  points: PortfolioPoint[],
  startingValue: number,
  trades: readonly {
    ticker: string;
    direction: TradeDirection;
    buyPrice: number;
    sellPrice: number;
  }[],
  labelsFor: (index: number) => { buyLabel: string; sellLabel: string },
): number {
  let value = startingValue;

  trades.forEach((trade, index) => {
    const { buyLabel, sellLabel } = labelsFor(index);

    points.push({
      date: buyLabel,
      value,
      event: {
        type: "open",
        direction: trade.direction,
        ticker: trade.ticker,
        price: trade.buyPrice,
      },
    });

    points.push({ date: sellLabel, value, event: null });

    value = compoundBalance(value, trade.buyPrice, trade.sellPrice, trade.direction);
    points.push({
      date: sellLabel,
      value,
      event: {
        type: "close",
        direction: trade.direction,
        ticker: trade.ticker,
        price: trade.sellPrice,
      },
    });
  });

  return value;
}

/**
 * Builds the step-function series described above. `startDate` may be
 * null (the "MAX" range's unbounded window) -- in that case the series
 * starts at the first trade's open date, or at `endDate` if there were no
 * trades at all (nothing to plot but a single flat point).
 */
export function derivePortfolioSeries(
  startingCapital: number,
  startDate: string | null,
  endDate: string,
  trades: readonly Trade[],
): PortfolioPoint[] {
  const points: PortfolioPoint[] = [];

  const firstDate = startDate ?? trades[0]?.openDate ?? endDate;
  points.push({ date: firstDate, value: startingCapital, event: null });

  const value = appendTradeSteps(
    points,
    startingCapital,
    trades.map((trade) => ({
      ticker: trade.ticker,
      direction: trade.direction,
      buyPrice: trade.openPrice,
      sellPrice: trade.closePrice,
    })),
    (index) => ({
      buyLabel: trades[index]!.openDate,
      sellLabel: trades[index]!.closeDate,
    }),
  );

  const last = points[points.length - 1];
  if (!last || last.date !== endDate) {
    points.push({ date: endDate, value, event: null });
  }

  return points;
}

/**
 * Same derivation as derivePortfolioSeries above, but for one intraday
 * day's trades (issue #28): IntradayTrade carries separate openTime/
 * closeTime (not openDate/closeDate, since every trade is same-day by
 * construction), so points use a full local datetime (`date` +
 * openTime/closeTime) instead of a calendar date, letting PortfolioChart
 * plot intraday spacing within the day.
 *
 * Unlike the window model, there's no known session-start/session-end
 * time to anchor a flat line on the way startDate/endDate do above (an
 * IntradayDayResult only carries realized trades, not the day's full
 * price series) -- a day with zero trades is a single point instead of
 * a padded flat line; PortfolioChart already handles a single-point
 * domain (see its dayMs padding).
 */
export function deriveIntradayPortfolioSeries(
  startingCapital: number,
  date: string,
  trades: readonly IntradayTrade[],
): PortfolioPoint[] {
  if (trades.length === 0) {
    return [{ date: `${date}T12:00:00`, value: startingCapital, event: null }];
  }

  const points: PortfolioPoint[] = [];
  points.push({ date: `${date}T${trades[0]!.openTime}`, value: startingCapital, event: null });

  appendTradeSteps(
    points,
    startingCapital,
    trades.map((trade) => ({
      ticker: trade.ticker,
      direction: trade.direction,
      buyPrice: trade.openPrice,
      sellPrice: trade.closePrice,
    })),
    (index) => ({
      buyLabel: `${date}T${trades[index]!.openTime}`,
      sellLabel: `${date}T${trades[index]!.closeTime}`,
    }),
  );

  return points;
}

/**
 * Whether a chart series spans more than one calendar day (issue #91) --
 * `true` for deriveWholeRangeIntradaySeries's own output (many days
 * chained together), `false` for deriveIntradayPortfolioSeries's (one
 * day). PortfolioChart uses this to decide whether formatDateTime should
 * include the calendar date alongside the time -- see that function's
 * own doc comment for why a bare time is ambiguous on a multi-day chart.
 * Harmless (always `true`, and simply unused) if ever called against
 * derivePortfolioSeries's plain-calendar-date output instead --
 * formatDateTime already always shows the date for that series
 * regardless of this flag.
 */
export function spansMultipleDays(points: readonly PortfolioPoint[]): boolean {
  const dayOf = (date: string) => (date.includes("T") ? date.slice(0, date.indexOf("T")) : date);
  const first = points[0];
  if (!first) return false;
  return points.some((p) => dayOf(p.date) !== dayOf(first.date));
}

/**
 * Chains every day in an intraday-daily range's result into one
 * continuous series (issue #91) -- the whole-range counterpart to
 * deriveIntradayPortfolioSeries above, which only ever plots a single
 * day in isolation. Each day keeps its own real intraday spacing (via
 * the same appendTradeSteps helper), but instead of resetting to a flat
 * `startingCapital` at the top of every day, the running value simply
 * carries forward from wherever the previous day's own trades left it --
 * the same chaining WholeRangeBalance's own final-balance rescale
 * already relies on (issue #84), now expressed as a full point series
 * instead of just a start/end pair. Overnight (last close of one day to
 * first point of the next) is rendered flat, consistent with this
 * module's own "flat until realized" philosophy for any stretch with no
 * known interim price.
 *
 * Callers pass each day's already mode-selected trades (see
 * ResultsPanel.tsx's selectVariant) -- this function has no opinion on
 * long-only vs. long+short, the same division of responsibility
 * derivePortfolioSeries/deriveIntradayPortfolioSeries already keep.
 */
export function deriveWholeRangeIntradaySeries(
  startingCapital: number,
  days: readonly { date: string; trades: readonly IntradayTrade[] }[],
): PortfolioPoint[] {
  const points: PortfolioPoint[] = [];
  let value = startingCapital;

  for (const day of days) {
    if (day.trades.length === 0) {
      points.push({ date: `${day.date}T12:00:00`, value, event: null });
      continue;
    }

    points.push({ date: `${day.date}T${day.trades[0]!.openTime}`, value, event: null });

    value = appendTradeSteps(
      points,
      value,
      day.trades.map((trade) => ({
        ticker: trade.ticker,
        direction: trade.direction,
        buyPrice: trade.openPrice,
        sellPrice: trade.closePrice,
      })),
      (index) => ({
        buyLabel: `${day.date}T${day.trades[index]!.openTime}`,
        sellLabel: `${day.date}T${day.trades[index]!.closeTime}`,
      }),
    );
  }

  return points;
}
