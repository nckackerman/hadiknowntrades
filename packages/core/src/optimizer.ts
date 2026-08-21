// The core "had I known" optimizer: given daily closing prices for many
// tickers over a date range, finds the sequence of up to N sequential,
// all-in, long-only round-trip trades (buy on a close, sell on a later
// close, full balance reinvested each time, can switch tickers between
// trades) that maximizes the ending balance.
//
// Algorithm: a backward DP generalizing the classic "best time to buy and
// sell stock IV" problem across many tickers instead of one.
//
// Let bestValue[k][d] = the best achievable growth multiplier using at
// most k trades, where any trade's buy day must be on or after day d.
// bestValue[0][d] = 1 for all d (no trades left).
//
// bestValue[k][d] = max(
//   bestValue[k-1][d],                          // don't use this trade slot
//   max over ticker t, buyIdx >= d, sellIdx > buyIdx (both with a known
//     price for t) of (price_t[sellIdx] / price_t[buyIdx]) * bestValue[k-1][sellIdx+1]
// )
//
// Computed efficiently per level via a suffix-max pass per ticker (see
// computeLevel below), giving O(days * tickers * maxTrades) total time —
// no brute force needed even across the full S&P 500 and decades of data.
//
// The DP tracks which branch won at each (k, d) so the actual trade
// sequence can be reconstructed afterward, not just the final value.

import { isValidPrice } from "./is-valid-price";
import type { DailyClose } from "./yahoo-client";

export interface Trade {
  ticker: string;
  buyDate: string;
  buyPrice: number;
  sellDate: string;
  sellPrice: number;
}

export interface OptimizationResult {
  startingCapital: number;
  endingBalance: number;
  trades: Trade[];
}

export interface OptimizeOptions {
  startingCapital: number;
  /** Maximum number of trades allowed (the optimizer may use fewer if that's better, though with real price data across many tickers it essentially always uses the full budget). */
  maxTrades: number;
}

/** Thrown when OptimizeOptions fails validation (invalid maxTrades or startingCapital), or the DP produces a non-finite result. */
export class OptimizerInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OptimizerInputError";
  }
}

/** A trading-day calendar (the union of every date present across all tickers, sorted) with each ticker's price reindexed onto it — null where that ticker has no price for that day. */
export interface Calendar {
  dates: string[];
  pricesByTicker: Map<string, (number | null)[]>;
}

/**
 * Builds the unified trading calendar the DP operates over: the sorted
 * union of every date present in any ticker's series, with each ticker's
 * prices reindexed onto that shared axis (null on days that ticker has
 * no data for — before its IPO, after delisting, a data gap, etc).
 */
export function buildCalendar(priceSeriesByTicker: Map<string, DailyClose[]>): Calendar {
  const dateSet = new Set<string>();
  for (const series of priceSeriesByTicker.values()) {
    for (const point of series) dateSet.add(point.date);
  }
  const dates = [...dateSet].sort();
  const dateIndex = new Map(dates.map((date, i) => [date, i]));

  const pricesByTicker = new Map<string, (number | null)[]>();
  for (const [ticker, series] of priceSeriesByTicker) {
    const prices = new Array<number | null>(dates.length).fill(null);
    for (const point of series) {
      // A non-positive or non-finite close is never legitimate data --
      // treat it as missing rather than letting it divide-by-zero or
      // propagate Infinity/NaN through the whole DP. Defense in depth:
      // the Yahoo client filters these too, but buildCalendar accepts
      // data from any caller.
      if (!isValidPrice(point.close)) {
        console.warn(
          `[optimizer] ignoring invalid close for ${ticker} on ${point.date}: ${point.close}`,
        );
        continue;
      }
      const i = dateIndex.get(point.date);
      if (i === undefined) {
        // Not currently reachable (dateIndex is built from the same data
        // being iterated here), but warn like every other data-loss path
        // in this loop in case that ever changes under a future refactor.
        console.warn(
          `[optimizer] ${ticker} has a price for ${point.date}, which isn't in the built calendar -- dropping it`,
        );
        continue;
      }
      if (prices[i] !== null) {
        console.warn(
          `[optimizer] duplicate price for ${ticker} on ${point.date} -- keeping the last value seen (${point.close}, discarding ${prices[i]})`,
        );
      }
      prices[i] = point.close;
    }
    pricesByTicker.set(ticker, prices);
  }

  return { dates, pricesByTicker };
}

interface TradeChoice {
  ticker: string;
  buyIdx: number;
  sellIdx: number;
}

interface Level {
  /** bestValue[d] for this k, length T+1 (index T = "no days left"). */
  value: number[];
  /** The trade taken at bestValue[d] if the "take a trade" branch won; null if the "carry forward k-1" branch won (or won the tie). Length T+1. */
  choice: (TradeChoice | null)[];
}

const NEG_INFINITY = Number.NEGATIVE_INFINITY;
// Well beyond any realistic product use (the app always requests 3) --
// exists to reject an obviously-wrong caller value (e.g. a bug passing a
// day count instead of a trade count) before it runs an unbounded number
// of O(days * tickers) DP levels.
const MAX_REASONABLE_TRADES = 50;

/**
 * Computes one level of the DP (bestValue[k] from bestValue[k-1]) via a
 * suffix-max pass per ticker, merged incrementally across tickers so
 * peak extra memory is O(days) rather than O(days * tickers).
 *
 * @param sortedTickers Pre-sorted (alphabetically by ticker symbol) —
 *   this is both a performance concern (avoids re-sorting on every one
 *   of up to MAX_REASONABLE_TRADES calls, since ticker order never
 *   changes between levels) and a correctness one: iterating in a fixed,
 *   documented order gives the cross-ticker merge below a deterministic
 *   tie-break (the alphabetically-first ticker wins an exact tie)
 *   instead of depending on Map insertion order, which a caller
 *   building the input map differently could otherwise change. Sorted
 *   with plain `<`/`>` (code-point order), not localeCompare, since
 *   localeCompare is locale-dependent and not straightforward ASCII
 *   order (e.g. "a" sorts before "B" under the default locale).
 */
function computeLevel(
  T: number,
  sortedTickers: [string, (number | null)[]][],
  prevValue: number[],
): Level {
  // value/choice start as a copy of "carry forward k-1" for every day —
  // the ticker loop below then overwrites entries in place wherever a
  // trade beats that baseline, so there's no separate accumulator array
  // or later merge pass.
  const value = new Array<number>(T + 1);
  const choice = new Array<TradeChoice | null>(T + 1);
  for (let d = 0; d <= T; d++) {
    value[d] = prevValue[d]!;
    choice[d] = null; // carry forward: recurse into k-1 at the same day
  }

  for (const [ticker, prices] of sortedTickers) {
    // g[sellIdx] = value of selling this ticker on sellIdx, given the
    // best remaining path (k-1 trades) starting the day after.
    // All array accesses below are within statically-known loop bounds
    // against arrays pre-sized to exactly T (or T+1) elements — genuinely
    // safe, just not provable to noUncheckedIndexedAccess, hence the `!`.
    const g = new Array<number>(T);
    for (let i = 0; i < T; i++) {
      const p = prices[i]!;
      g[i] = p === null ? NEG_INFINITY : p * prevValue[i + 1]!;
    }

    // suffixMaxG[i] = max(g[i..T-1]), with the sellIdx that achieves it.
    const suffixMaxG = new Array<number>(T + 1).fill(NEG_INFINITY);
    const suffixMaxSellIdx = new Array<number>(T + 1).fill(-1);
    for (let i = T - 1; i >= 0; i--) {
      if (g[i]! >= suffixMaxG[i + 1]!) {
        suffixMaxG[i] = g[i]!;
        suffixMaxSellIdx[i] = i;
      } else {
        suffixMaxG[i] = suffixMaxG[i + 1]!;
        suffixMaxSellIdx[i] = suffixMaxSellIdx[i + 1]!;
      }
    }

    // runningBest[d] = max over buyIdx >= d of (candidate ratio buying on
    // buyIdx). candidateRatio for a given buyIdx is only ever needed once,
    // right here, so it's computed inline rather than staged into its own
    // array first.
    let runningBestValue = NEG_INFINITY;
    let runningBestBuyIdx = -1;
    let runningBestSellIdx = -1;
    for (let d = T - 1; d >= 0; d--) {
      const p = prices[d]!;
      const bestSellValue = suffixMaxG[d + 1]!;
      if (p !== null && bestSellValue !== NEG_INFINITY) {
        const candidateRatio = bestSellValue / p;
        if (candidateRatio >= runningBestValue) {
          runningBestValue = candidateRatio;
          runningBestBuyIdx = d;
          runningBestSellIdx = suffixMaxSellIdx[d + 1]!;
        }
      }
      if (runningBestBuyIdx !== -1 && runningBestValue > value[d]!) {
        value[d] = runningBestValue;
        choice[d] = { ticker, buyIdx: runningBestBuyIdx, sellIdx: runningBestSellIdx };
      }
    }
  }

  return { value, choice };
}

function reconstructTrades(levels: Level[], maxTrades: number): TradeChoice[] {
  const trades: TradeChoice[] = [];
  let k = maxTrades;
  let d = 0;
  while (k > 0) {
    const level = levels[k]!;
    const c = level.choice[d];
    if (!c) {
      k -= 1;
    } else {
      trades.push(c);
      d = c.sellIdx + 1;
      k -= 1;
    }
  }
  return trades;
}

/**
 * Finds the sequence of up to `maxTrades` sequential, all-in, long-only
 * round-trip trades across all provided tickers that maximizes the
 * ending balance starting from `startingCapital`.
 */
export function optimizeTrades(
  priceSeriesByTicker: Map<string, DailyClose[]>,
  options: OptimizeOptions,
): OptimizationResult {
  const { startingCapital, maxTrades } = options;

  if (!Number.isInteger(maxTrades) || maxTrades < 0 || maxTrades > MAX_REASONABLE_TRADES) {
    throw new OptimizerInputError(
      `maxTrades must be a non-negative integer no greater than ${MAX_REASONABLE_TRADES}, got ${maxTrades}`,
    );
  }
  if (!Number.isFinite(startingCapital) || startingCapital <= 0) {
    throw new OptimizerInputError(
      `startingCapital must be a positive finite number, got ${startingCapital}`,
    );
  }

  const calendar = buildCalendar(priceSeriesByTicker);
  const T = calendar.dates.length;
  // Sorted once here (not inside computeLevel, which is called up to
  // maxTrades times) since ticker order is invariant across levels —
  // also the source of the deterministic tie-break documented below.
  const sortedTickers = [...calendar.pricesByTicker.entries()].sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );

  const level0: Level = {
    value: new Array(T + 1).fill(1),
    choice: new Array(T + 1).fill(null),
  };
  const levels: Level[] = [level0];
  for (let k = 1; k <= maxTrades; k++) {
    levels.push(computeLevel(T, sortedTickers, levels[k - 1]!.value));
  }

  const finalMultiplier = levels[maxTrades]!.value[0]!;
  const tradeChoices = reconstructTrades(levels, maxTrades);

  const trades: Trade[] = tradeChoices.map((c) => {
    const prices = calendar.pricesByTicker.get(c.ticker);
    const buyPrice = prices?.[c.buyIdx];
    const sellPrice = prices?.[c.sellIdx];
    if (buyPrice == null || sellPrice == null) {
      // Should be unreachable: computeLevel only ever selects indices
      // where this ticker has a known price.
      throw new Error(
        `internal error: reconstructed trade for ${c.ticker} references a day with no price`,
      );
    }
    return {
      ticker: c.ticker,
      buyDate: calendar.dates[c.buyIdx] as string,
      buyPrice,
      sellDate: calendar.dates[c.sellIdx] as string,
      sellPrice,
    };
  });

  const endingBalance = startingCapital * finalMultiplier;
  if (!Number.isFinite(endingBalance)) {
    // Guards the implicit "a valid result is always finite" invariant
    // the input validation above establishes -- e.g. an extreme
    // startingCapital overflowing on multiplication by a large multiplier.
    throw new OptimizerInputError(
      `computed a non-finite endingBalance (${endingBalance}) from startingCapital=${startingCapital}`,
    );
  }

  return {
    startingCapital,
    endingBalance,
    trades,
  };
}
