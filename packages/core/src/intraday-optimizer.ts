// The per-day intraday optimizer (issue #28): given 60-minute price bars
// for many tickers across a date window, finds the best up-to-N
// same-day trades for *each trading day independently* -- unlike
// optimizer.ts's whole-window DP, no state (capital, trade budget)
// carries across days, since every position must open and close within
// the same trading day (see issue #28's "Computational note": solving
// one big DP across the whole window would be quadratic in window
// length and infeasible; solving each day independently and
// concatenating is linear in the number of days).
//
// No new DP is needed here. optimizeTrades() (optimizer.ts) operates on
// Map<string, { date: string, close: number }[]> where `date` is just an
// opaque, sortable, unique string key -- it never assumes calendar-day
// semantics. So a "per-day optimizer" is: group a window's IntradayBar[]
// by calendar day, and call optimizeTrades() once per day with just that
// day's bars. IntradayBar's `date` field is a full local datetime string
// (see yahoo-client.ts), which sorts correctly within a day and is
// unique per bar -- exactly what optimizeTrades needs from it, without
// modification.
//
// Issue #31 folds a second, min-direction search (the same DP, see
// optimizer.ts) into this same per-day loop via optimizeBothDirections()
// (a code-review follow-up replaced an original two-call
// optimizeTrades()+optimizeWorstTrades() pattern here with this single
// call, so the two directions share one built calendar/ticker-sort per
// day instead of each rebuilding it -- see optimizer.ts's own
// OptimizerState doc comment): each day's IntradayDayResult carries a
// worstCase field alongside its own optimal-case endingBalance/trades,
// solved over the exact same day's bars.

import { optimizeBothDirections, type Trade } from "./optimizer";
import type { IntradayBar } from "./yahoo-client";

export interface IntradayTrade {
  ticker: string;
  /** Calendar date this trade happened on, YYYY-MM-DD -- the same for buy and sell, since intraday trades never cross a day boundary by construction (see toIntradayTrade). */
  date: string;
  /** Local time of day the position was opened, HH:MM:SS. */
  buyTime: string;
  buyPrice: number;
  /** Local time of day the position was closed, HH:MM:SS. */
  sellTime: string;
  sellPrice: number;
}

export interface IntradayDayResult {
  /** YYYY-MM-DD. */
  date: string;
  startingCapital: number;
  endingBalance: number;
  /**
   * Which bar granularity produced this day's numbers, in minutes (e.g.
   * 60 for 60-minute bars, 5 for 5-minute bars, 1 for 1-minute bars) --
   * stamped from OptimizeIntradayOptions.barIntervalMinutes onto every
   * day a given optimizeIntradayDays() call produces. Added in issue
   * #30, which introduced a second granularity: a range's per-day
   * results can be assembled from *two separate optimizeIntradayDays()
   * calls* (one over 60-minute bars, one over a finer granularity scoped
   * to a shorter lookback) merged together by apps/pipeline's
   * buildIntradayResults, so a ticker's day list can genuinely mix
   * granularities depending on how old each day is. This field exists
   * specifically so that's visible in the output itself rather than
   * only inferable from a day's date relative to "now" -- not obvious
   * otherwise, per issue #30's own scope note. As of issue #29, both 3M
   * (mixing 5 and 60) and 1M (mixing 1 and 60) genuinely have mixed
   * granularities within one range's day list -- only 1Y is unaffected
   * and always carries 60 here. See packages/core/CLAUDE.md's
   * "Mixed-granularity 1M/3M assembly" section for the full mechanism.
   */
  barIntervalMinutes: number;
  trades: IntradayTrade[];
  /**
   * The worst achievable up-to-`maxTradesPerDay` outcome for this same
   * day (issue #31) -- same shape as this day's own endingBalance/trades,
   * solved via optimizeWorstTrades over the exact same day's bars. Always
   * `worstCase.endingBalance <= endingBalance` by construction (the
   * min-search explores a subset of the same trade-sequence space the
   * max-search does).
   */
  worstCase: IntradayWorstCaseResult;
}

/**
 * Per-day worst-case counterpart to IntradayDayResult's own
 * endingBalance/trades (issue #31) -- deliberately not a nested
 * OptimizationResult, which would also carry its own startingCapital;
 * that value is always identical to the sibling IntradayDayResult.
 * startingCapital (both searches start from the same capital), so
 * storing it twice would just be a value that could drift out of sync
 * with nothing enforcing it matches. Same flattening convention
 * IntradayDayResult itself already uses for endingBalance/trades.
 */
export interface IntradayWorstCaseResult {
  endingBalance: number;
  trades: IntradayTrade[];
}

export interface OptimizeIntradayOptions {
  /** Applied fresh every day -- results do not compound across days, by design (each day is its own independent "what was the best possible outcome starting from this much cash" scenario). */
  startingCapital: number;
  /** Maximum number of same-day trades allowed per day (the optimizer may use fewer if that's better, though with real intraday data it essentially always uses the full budget -- same caveat as OptimizeOptions.maxTrades in optimizer.ts). */
  maxTradesPerDay: number;
  /**
   * The bar granularity (in minutes) of every bar passed in this call --
   * stamped onto every IntradayDayResult.barIntervalMinutes this call
   * produces (see that field's own doc comment). Required rather than
   * inferred from the data, since optimizeIntradayDays has no way to
   * measure a bar's own interval from a single { date, close } point --
   * the caller already knows which fetch (fetchIntradayBars vs.
   * fetchFiveMinuteBars) it got this data from.
   */
  barIntervalMinutes: number;
}

/** Splits an IntradayBar's `date` field ("2026-08-21T14:30:00") into its calendar-date and time-of-day parts. */
function splitLocalDateTime(datetime: string): { date: string; time: string } {
  const [date, time] = datetime.split("T");
  if (!date || !time) {
    throw new Error(
      `internal error: malformed intraday datetime "${datetime}" (expected YYYY-MM-DDTHH:MM:SS)`,
    );
  }
  return { date, time };
}

/**
 * Groups a window's intraday bars, per ticker, by the calendar date each
 * bar falls on -- the unit optimizeTrades() is called once per, below.
 */
function groupByDate(
  barsByTicker: Map<string, IntradayBar[]>,
): Map<string, Map<string, IntradayBar[]>> {
  const byDate = new Map<string, Map<string, IntradayBar[]>>();
  for (const [ticker, bars] of barsByTicker) {
    for (const bar of bars) {
      const { date } = splitLocalDateTime(bar.date);
      let dayMap = byDate.get(date);
      if (!dayMap) {
        dayMap = new Map();
        byDate.set(date, dayMap);
      }
      let tickerBars = dayMap.get(ticker);
      if (!tickerBars) {
        tickerBars = [];
        dayMap.set(ticker, tickerBars);
      }
      tickerBars.push(bar);
    }
  }
  return byDate;
}

/**
 * Converts one optimizeTrades()-shaped Trade (whose buyDate/sellDate
 * literally contain the full local-datetime strings we fed it, since it
 * just echoes back whatever date string the caller supplied) into the
 * public IntradayTrade shape, with date and time split apart explicitly
 * -- deliberately not reusing Trade's buyDate/sellDate fields as-is for
 * intraday output, since apps/web's existing consumers of Trade
 * (TradeList, PortfolioChart, format-date.ts) all assume buyDate/sellDate
 * are plain calendar dates and would silently mis-render a full
 * datetime string passed through unmodified.
 */
function toIntradayTrade(trade: Trade): IntradayTrade {
  const buy = splitLocalDateTime(trade.buyDate);
  const sell = splitLocalDateTime(trade.sellDate);
  if (buy.date !== sell.date) {
    // Should be unreachable: optimizeTrades is only ever called here
    // (see optimizeIntradayDays) with a single day's bars, so every
    // trade it returns must buy and sell within that same day.
    throw new Error(
      `internal error: intraday trade for ${trade.ticker} spans buy date ${buy.date} and sell date ${sell.date}`,
    );
  }
  return {
    ticker: trade.ticker,
    date: buy.date,
    buyTime: buy.time,
    buyPrice: trade.buyPrice,
    sellTime: sell.time,
    sellPrice: trade.sellPrice,
  };
}

/**
 * Finds, for every trading day present in `barsByTicker`, the best
 * sequence of up to `maxTradesPerDay` same-day round-trip trades across
 * all provided tickers -- each day solved independently via
 * optimizeTrades(), starting fresh from `startingCapital` every day (no
 * compounding across days).
 *
 * Days are returned in ascending date order. A day with no bars for any
 * ticker (a market holiday, or a data gap) simply doesn't appear in the
 * result -- there's nothing to solve for it.
 */
export function optimizeIntradayDays(
  barsByTicker: Map<string, IntradayBar[]>,
  options: OptimizeIntradayOptions,
): IntradayDayResult[] {
  const { startingCapital, maxTradesPerDay, barIntervalMinutes } = options;
  const byDate = groupByDate(barsByTicker);
  const dates = [...byDate.keys()].sort();

  return dates.map((date) => {
    const dayBars = byDate.get(date)!;
    // Same day's bars, same startingCapital/maxTrades for both the best-
    // and worst-case (min-direction, issue #31) searches, so
    // optimizeBothDirections builds this day's calendar/ticker-sort once
    // and reuses it for both instead of the two separate optimizeTrades/
    // optimizeWorstTrades calls this used to be -- a real saving here
    // specifically, since this runs once per trading day (up to ~252
    // times for 1Y) rather than once per range.
    const { best: optimized, worst } = optimizeBothDirections(dayBars, {
      startingCapital,
      maxTrades: maxTradesPerDay,
    });
    return {
      date,
      startingCapital,
      endingBalance: optimized.endingBalance,
      barIntervalMinutes,
      trades: optimized.trades.map(toIntradayTrade),
      worstCase: {
        endingBalance: worst.endingBalance,
        trades: worst.trades.map(toIntradayTrade),
      },
    };
  });
}
