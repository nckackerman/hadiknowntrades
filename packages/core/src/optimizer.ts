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
//
// Issue #31 adds a second, "worst case" mode: the same DP with every
// max/best replaced by min/worst (worstValue[k][d] = MIN of the same two
// branches above), exposed as optimizeWorstTrades. computeLevel takes a
// `direction: "max" | "min"` parameter rather than being duplicated --
// every comparison site and its sentinel is parameterized, not
// hand-copied with the operators flipped. See that parameter's own doc
// comment for exactly what changes and why (in particular, why the "no
// price here" sentinel must flip from -Infinity to +Infinity for a min
// search, not just the comparison operators).

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
const POS_INFINITY = Number.POSITIVE_INFINITY;
// Well beyond any realistic product use (the app always requests 3) --
// exists to reject an obviously-wrong caller value (e.g. a bug passing a
// day count instead of a trade count) before it runs an unbounded number
// of O(days * tickers) DP levels.
const MAX_REASONABLE_TRADES = 50;

/**
 * "max" is the original best-case search (optimizeTrades); "min" is the
 * worst-case search (optimizeWorstTrades, issue #31) -- see computeLevel's
 * own doc comment for exactly what flips between the two.
 */
type Direction = "max" | "min";

/**
 * Computes one level of the DP (bestValue[k] from bestValue[k-1] in the
 * "max" direction, worstValue[k] from worstValue[k-1] in "min") via a
 * suffix pass per ticker, merged incrementally across tickers so peak
 * extra memory is O(days) rather than O(days * tickers).
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
 *   order (e.g. "a" sorts before "B" under the default locale). Same
 *   tie-break rule is kept, unchanged, for both directions -- see issue
 *   #31's plan doc (docs/plans/issue-31-plan.md section 1.3) for why
 *   this determinism-only rule doesn't need inverting for "min".
 * @param direction "max" (optimizeTrades) or "min" (optimizeWorstTrades,
 *   issue #31). Four things flip between the two, all mechanical, none
 *   optional:
 *     1. The "no price here" sentinel: -Infinity for "max" (so a missing
 *        price never wins a max search), +Infinity for "min" (so it
 *        never wins a min search either -- reusing -Infinity here would
 *        trivially "win" every min comparison and corrupt the result).
 *     2. The suffix-best comparison (`g[i] >= suffixBestG[i+1]` for
 *        "max") becomes `<=` for "min", so it tracks a suffix *min*
 *        instead of max.
 *     3. The running-best comparison (`candidateRatio >= runningBestValue`
 *        for "max") becomes `<=` for "min", same reasoning.
 *     4. The "does this trade replace the carry-forward baseline" check
 *        (`runningBestValue > value[d]`, strict, for "max") becomes
 *        strict `<` for "min": a trade is only taken if it's *strictly
 *        worse* than not trading, mirroring "only taken if strictly
 *        better" for "max". Must stay strict in both directions -- an
 *        `<=`/`>=` here would force a trade even when it's exactly as
 *        good/bad as carrying forward, changing "at most N trades"
 *        semantics, not just a tie-break identity.
 *   All four are derived from `direction` below rather than hand-copied
 *   with operators flipped, so there's exactly one place each rule lives.
 */
function computeLevel(
  T: number,
  sortedTickers: [string, (number | null)[]][],
  prevValue: number[],
  direction: Direction,
): Level {
  const worstSentinel = direction === "max" ? NEG_INFINITY : POS_INFINITY;
  const isBetterOrEqual =
    direction === "max" ? (a: number, b: number) => a >= b : (a: number, b: number) => a <= b;
  const isStrictlyBetter =
    direction === "max" ? (a: number, b: number) => a > b : (a: number, b: number) => a < b;

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
    // best (worst, for direction="min") remaining path (k-1 trades)
    // starting the day after.
    // All array accesses below are within statically-known loop bounds
    // against arrays pre-sized to exactly T (or T+1) elements — genuinely
    // safe, just not provable to noUncheckedIndexedAccess, hence the `!`.
    const g = new Array<number>(T);
    for (let i = 0; i < T; i++) {
      const p = prices[i]!;
      g[i] = p === null ? worstSentinel : p * prevValue[i + 1]!;
    }

    // suffixBestG[i] = best(g[i..T-1]) -- max for direction="max", min for
    // "min" -- with the sellIdx that achieves it.
    const suffixBestG = new Array<number>(T + 1).fill(worstSentinel);
    const suffixBestSellIdx = new Array<number>(T + 1).fill(-1);
    for (let i = T - 1; i >= 0; i--) {
      if (isBetterOrEqual(g[i]!, suffixBestG[i + 1]!)) {
        suffixBestG[i] = g[i]!;
        suffixBestSellIdx[i] = i;
      } else {
        suffixBestG[i] = suffixBestG[i + 1]!;
        suffixBestSellIdx[i] = suffixBestSellIdx[i + 1]!;
      }
    }

    // runningBest[d] = best (max, or min for "min") over buyIdx >= d of
    // (candidate ratio buying on buyIdx). candidateRatio for a given
    // buyIdx is only ever needed once, right here, so it's computed
    // inline rather than staged into its own array first.
    let runningBestValue = worstSentinel;
    let runningBestBuyIdx = -1;
    let runningBestSellIdx = -1;
    for (let d = T - 1; d >= 0; d--) {
      const p = prices[d]!;
      const bestSellValue = suffixBestG[d + 1]!;
      if (p !== null && bestSellValue !== worstSentinel) {
        const candidateRatio = bestSellValue / p;
        if (isBetterOrEqual(candidateRatio, runningBestValue)) {
          runningBestValue = candidateRatio;
          runningBestBuyIdx = d;
          runningBestSellIdx = suffixBestSellIdx[d + 1]!;
        }
      }
      if (runningBestBuyIdx !== -1 && isStrictlyBetter(runningBestValue, value[d]!)) {
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
 * Shared body behind optimizeTrades ("max") and optimizeWorstTrades
 * ("min", issue #31): validation, calendar-building, ticker sort, the
 * level-building loop, trade reconstruction, and the finite-endingBalance
 * check are all direction-agnostic -- only computeLevel's own comparisons
 * (see its doc comment) depend on `direction`. reconstructTrades itself
 * needs no direction-awareness either: it only follows `choice` pointers
 * that computeLevel already computed correctly for whichever direction
 * was requested.
 */
function runOptimizer(
  priceSeriesByTicker: Map<string, DailyClose[]>,
  options: OptimizeOptions,
  direction: Direction,
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

  // Level 0 (no trades left) is always multiplier 1 regardless of
  // direction -- "carry forward with zero trades remaining" means
  // holding cash, which is the same fixed point whether searching for
  // the best or worst achievable outcome.
  const level0: Level = {
    value: new Array(T + 1).fill(1),
    choice: new Array(T + 1).fill(null),
  };
  const levels: Level[] = [level0];
  for (let k = 1; k <= maxTrades; k++) {
    levels.push(computeLevel(T, sortedTickers, levels[k - 1]!.value, direction));
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

/**
 * Finds the sequence of up to `maxTrades` sequential, all-in, long-only
 * round-trip trades across all provided tickers that maximizes the
 * ending balance starting from `startingCapital`.
 */
export function optimizeTrades(
  priceSeriesByTicker: Map<string, DailyClose[]>,
  options: OptimizeOptions,
): OptimizationResult {
  return runOptimizer(priceSeriesByTicker, options, "max");
}

/**
 * The worst-case counterpart to optimizeTrades (issue #31): finds the
 * sequence of up to `maxTrades` sequential, all-in, long-only round-trip
 * trades across all provided tickers that *minimizes* the ending
 * balance starting from `startingCapital` -- the same DP, same
 * validation, same reconstruction, just searching for the worst
 * achievable outcome instead of the best (see computeLevel's `direction`
 * parameter). A contrast stat, not a prediction: shows how badly this
 * same "at most N trades" budget could have gone if every choice had
 * been wrong, alongside the best-case optimizeTrades result.
 *
 * Because "don't trade" (multiplier 1, i.e. holding cash) is always an
 * available option and a trade is only taken if it's *strictly* worse
 * than not trading, it's mathematically possible (though vanishingly
 * unlikely with real S&P 500 data across many tickers) for this to
 * still report a net gain, or use fewer than `maxTrades` trades, if
 * every remaining ticker/day option in a slot only has winning trades
 * available.
 */
export function optimizeWorstTrades(
  priceSeriesByTicker: Map<string, DailyClose[]>,
  options: OptimizeOptions,
): OptimizationResult {
  return runOptimizer(priceSeriesByTicker, options, "min");
}
