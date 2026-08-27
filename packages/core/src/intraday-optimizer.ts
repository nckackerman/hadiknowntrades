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
//
// Issue #13 folds in a third axis, long+short, the same way: swaps
// optimizeBothDirections() for optimizeAllVariants() (4 runs instead of
// 2, still sharing one built calendar/ticker-sort per day), and each
// day's IntradayDayResult additionally carries a longShort field
// alongside its long-only endingBalance/trades/worstCase, mirroring how
// WindowResult's own longShort field (results-schema.ts) sits alongside
// its long-only fields.

import { optimizeAllVariants, type Trade, type TradeDirection } from "./optimizer";
import type { IntradayBar } from "./yahoo-client";

export interface IntradayTrade {
  ticker: string;
  direction: TradeDirection;
  /** Calendar date this trade happened on, YYYY-MM-DD -- the same for open and close, since intraday trades never cross a day boundary by construction (see toIntradayTrade). */
  date: string;
  /** Local time of day the position was opened, HH:MM:SS. */
  openTime: string;
  openPrice: number;
  /** Local time of day the position was closed, HH:MM:SS. */
  closeTime: string;
  closePrice: number;
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
  /**
   * The long+short counterpart to this day's own long-only endingBalance/
   * trades/worstCase (issue #13) -- same shape as this day's own fields,
   * solved over the same day's bars but with short trades also available
   * to the search. See results-schema.ts's LongShortResult (the window
   * model's own sibling field) for the full reasoning; this is its
   * per-day equivalent.
   */
  longShort: IntradayLongShortResult;
}

/**
 * Per-day worst-case counterpart to IntradayDayResult's own
 * endingBalance/trades (issue #31).
 *
 * `startingCapital` (issue #84) was originally omitted here on the
 * reasoning that it was always identical to the sibling
 * IntradayDayResult.startingCapital (both searches started from the same
 * flat, reset-every-day capital, so storing it twice would just be a
 * value that could drift with nothing enforcing it matched). That
 * reasoning no longer holds once apps/pipeline's per-track capital
 * chaining (see that package's own CLAUDE.md) lets this track's own
 * running balance diverge from the long-only track's day by day -- this
 * field is this track's own chained starting capital, independently
 * readable without cross-referencing IntradayDayResult.startingCapital.
 */
export interface IntradayWorstCaseResult {
  startingCapital: number;
  endingBalance: number;
  trades: IntradayTrade[];
}

/**
 * Per-day long+short counterpart to IntradayDayResult's own long-only
 * endingBalance/trades/worstCase (issue #13) -- mirrors
 * IntradayWorstCaseResult's own flattening convention, plus a nested
 * worstCase since the long+short variant has both a best and worst case
 * of its own, same as the top-level long-only fields do.
 *
 * `startingCapital` (issue #84) is this track's own (long-short-best)
 * chained starting capital -- see IntradayWorstCaseResult's own doc
 * comment above for why this is no longer safely inferable from the
 * sibling IntradayDayResult.startingCapital once per-track chaining
 * exists. The nested `worstCase.startingCapital` is the long-short-worst
 * track's own value, reusing IntradayWorstCaseResult's field for free.
 */
export interface IntradayLongShortResult {
  startingCapital: number;
  endingBalance: number;
  trades: IntradayTrade[];
  worstCase: IntradayWorstCaseResult;
}

export interface OptimizeIntradayOptions {
  /**
   * Applied fresh every day -- this function itself never compounds
   * results across days (each day is solved as its own independent "what
   * was the best possible outcome starting from this much cash"
   * scenario); every day's ratio (endingBalance / startingCapital) is
   * capital-invariant, a function of that day's own prices only. As of
   * issue #84, apps/pipeline's buildIntradayResults *does* chain balances
   * across days, but strictly as a post-processing pass applied to this
   * function's already-returned `days` array (after the per-range slice
   * and granularity-override merge) -- this function's own contract is
   * unchanged, and every day it returns still carries the same flat
   * startingCapital across all four tracks, exactly as before. See
   * apps/pipeline/CLAUDE.md's "Chained per-day starting capital" section.
   */
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

/**
 * Splits an IntradayBar's `date` field ("2026-08-21T14:30:00") into its
 * calendar-date and time-of-day parts.
 *
 * Exported at module level -- but deliberately NOT re-exported from
 * `index.ts`, so this package's public API is unchanged -- so
 * `intraday-sessions.ts` (issue #127) can reuse the exact same parse
 * instead of hand-rolling a second `.split("T")` with its own idea of
 * what a malformed datetime looks like. Separating a bar's date from its
 * time-of-day is the entire mechanism behind that file's mystery-day
 * secrecy guarantee, so it needs precisely this split and nothing more.
 */
export function splitLocalDateTime(datetime: string): { date: string; time: string } {
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
 * Converts one optimizeTrades()-shaped Trade (whose openDate/closeDate
 * literally contain the full local-datetime strings we fed it, since it
 * just echoes back whatever date string the caller supplied) into the
 * public IntradayTrade shape, with date and time split apart explicitly
 * -- deliberately not reusing Trade's openDate/closeDate fields as-is for
 * intraday output, since apps/web's existing consumers of Trade
 * (TradeList, PortfolioChart, format-date.ts) all assume openDate/closeDate
 * are plain calendar dates and would silently mis-render a full
 * datetime string passed through unmodified. `direction` passes straight
 * through unchanged (issue #13) -- splitting date from time-of-day
 * doesn't depend on which direction the trade was.
 */
function toIntradayTrade(trade: Trade): IntradayTrade {
  const open = splitLocalDateTime(trade.openDate);
  const close = splitLocalDateTime(trade.closeDate);
  if (open.date !== close.date) {
    // Should be unreachable: optimizeTrades is only ever called here
    // (see optimizeIntradayDays) with a single day's bars, so every
    // trade it returns must open and close within that same day.
    throw new Error(
      `internal error: intraday trade for ${trade.ticker} spans open date ${open.date} and close date ${close.date}`,
    );
  }
  return {
    ticker: trade.ticker,
    direction: trade.direction,
    date: open.date,
    openTime: open.time,
    openPrice: trade.openPrice,
    closeTime: close.time,
    closePrice: trade.closePrice,
  };
}

/**
 * optimizeIntradayDays' own return shape (issue #13 code review follow-up)
 * -- `days` alone used to be the whole return value, but a single day's
 * optimizeAllVariants call can throw (most plausibly OptimizerInputError's
 * non-finite-endingBalance overflow guard, reachable here since a short's
 * reciprocal-price payoff is unbounded above as the covering price
 * approaches zero -- see optimizer.ts's own header comment). Without a
 * side channel to report it, the only options were "let it propagate and
 * abort every other day's already-computable result too" (the original
 * bug) or "swallow it silently" (defeats this system's only alerting
 * mechanism -- see apps/pipeline/CLAUDE.md's "Two independent paths"
 * section). `skippedDays` is that side channel, mirroring the
 * `{history, skipped, ...}` sibling-array shape apps/pipeline's own
 * `fetchUniverseHistory` already established for the identical
 * "per-item failure shouldn't abort the whole batch, but must still be
 * reported" problem.
 */
export interface OptimizeIntradayResult {
  /** Every day that solved successfully, ascending by date -- see optimizeIntradayDays' own doc comment. */
  days: IntradayDayResult[];
  /**
   * One entry per day that failed to solve at all this call, formatted
   * `"YYYY-MM-DD: <error message>"` (mirroring apps/pipeline's own
   * "range: message"/"date: message" failure-reporting convention) --
   * empty in the overwhelmingly common case where every day solves.
   * apps/pipeline's buildIntradayResults folds a *base* (60-minute)
   * call's skippedDays into its own must-fail-the-run aggregated error
   * (the same day is then genuinely missing for every range covering
   * it); a *granularity override*'s (5-minute/1-minute) skippedDays are
   * treated as non-fatal instead, since mergeDaysByGranularity already
   * gracefully falls back to the base 60-minute day for any date the
   * override doesn't cover -- see apps/pipeline/CLAUDE.md for the full
   * reasoning.
   */
  skippedDays: string[];
}

/**
 * Finds, for every trading day present in `barsByTicker`, the best
 * sequence of up to `maxTradesPerDay` same-day round-trip trades across
 * all provided tickers -- each day solved independently via
 * optimizeTrades(), starting fresh from `startingCapital` every day (no
 * compounding across days).
 *
 * Days are returned (in `days`, ascending date order) for every date that
 * solved successfully; a day with no bars for any ticker (a market
 * holiday, or a data gap) simply doesn't appear -- there's nothing to
 * solve for it. A day whose own optimizeAllVariants call throws is
 * caught, logged, and excluded from `days` too, but -- unlike the
 * "nothing to solve" case -- is reported via `skippedDays` (see
 * OptimizeIntradayResult's own doc comment): that day's data existed and
 * genuinely couldn't be solved, which is a real, alert-worthy problem for
 * apps/pipeline to surface, not a benign absence. Containing the failure
 * per-day here (rather than letting it propagate out of this whole call)
 * is what stops one outlier day's overflow from taking down every other
 * day's already-computable result -- see apps/pipeline/CLAUDE.md's "Two
 * independent paths" section for why the pipeline still needs to *know*
 * about it, just not have it abort everything.
 */
export function optimizeIntradayDays(
  barsByTicker: Map<string, IntradayBar[]>,
  options: OptimizeIntradayOptions,
): OptimizeIntradayResult {
  const { startingCapital, maxTradesPerDay, barIntervalMinutes } = options;
  const byDate = groupByDate(barsByTicker);
  const dates = [...byDate.keys()].sort();

  const days: IntradayDayResult[] = [];
  const skippedDays: string[] = [];
  for (const date of dates) {
    const dayBars = byDate.get(date)!;
    try {
      // Same day's bars, same startingCapital/maxTrades for all 4
      // direction x instrument-set combinations, so optimizeAllVariants
      // builds this day's calendar/ticker-sort once and reuses it for
      // all 4 runs instead of separate calls -- a real saving here
      // specifically, since this runs once per trading day (up to ~252
      // times for 1Y) rather than once per range.
      const { longOnly, longShort } = optimizeAllVariants(dayBars, {
        startingCapital,
        maxTrades: maxTradesPerDay,
      });
      days.push({
        date,
        startingCapital,
        endingBalance: longOnly.best.endingBalance,
        barIntervalMinutes,
        trades: longOnly.best.trades.map(toIntradayTrade),
        worstCase: {
          startingCapital,
          endingBalance: longOnly.worst.endingBalance,
          trades: longOnly.worst.trades.map(toIntradayTrade),
        },
        longShort: {
          startingCapital,
          endingBalance: longShort.best.endingBalance,
          trades: longShort.best.trades.map(toIntradayTrade),
          worstCase: {
            startingCapital,
            endingBalance: longShort.worst.endingBalance,
            trades: longShort.worst.trades.map(toIntradayTrade),
          },
        },
      });
    } catch (error) {
      // console.error, not .warn: unlike a routine per-ticker skip (a
      // single ticker's data being unavailable is expected and benign),
      // a day that can't be solved at all is a genuine data/correctness
      // problem for that day -- see this function's own doc comment for
      // why apps/pipeline still needs to be able to fail the run over
      // this, not just log it.
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[intraday-optimizer] skipping ${date}: ${message}`);
      skippedDays.push(`${date}: ${message}`);
    }
  }

  return { days, skippedDays };
}
