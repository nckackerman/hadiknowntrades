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

import { optimizeTrades, type Trade } from "./optimizer";
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
   * 60 for 60-minute bars, 5 for 5-minute bars) -- stamped from
   * OptimizeIntradayOptions.barIntervalMinutes onto every day a given
   * optimizeIntradayDays() call produces. Added in issue #30, which
   * introduced a second granularity: the 3M range's per-day results are
   * now assembled from *two separate optimizeIntradayDays() calls* (one
   * over 60-minute bars, one over 5-minute bars for the most recent ~60
   * days) merged together by apps/pipeline's buildIntradayResults, so a
   * ticker's 3M day list can genuinely mix 5 and 60 here depending on
   * how old each day is. This field exists specifically so that's
   * visible in the output itself rather than only inferable from a
   * day's date relative to "now" -- not obvious otherwise, per issue
   * #30's own scope note. 1M and 1Y are unaffected by #30 and always
   * carry 60 here.
   */
  barIntervalMinutes: number;
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
    const optimized = optimizeTrades(dayBars, { startingCapital, maxTrades: maxTradesPerDay });
    return {
      date,
      startingCapital,
      endingBalance: optimized.endingBalance,
      barIntervalMinutes,
      trades: optimized.trades.map(toIntradayTrade),
    };
  });
}
