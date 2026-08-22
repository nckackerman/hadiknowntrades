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
//
// Issue #13 adds a third axis, orthogonal to direction: short trades.
// Every trade slot can now be either a "long" (buy low, sell high --
// today's only mode, ratio P[close]/P[open]) or a "short" (profit when
// the price falls -- ratio P[open]/P[close], see below) -- gated behind
// an `includeShorts` flag threaded into computeLevel, off by default so
// every existing long-only call path is byte-identical to before this
// issue (see optimizeTrades/optimizeWorstTrades/optimizeBothDirections
// below, which all still pass includeShorts: false).
//
// Short trades are modeled as reciprocal-price longs, not literal
// fixed-share-count short-selling (docs/plans/issue-13-plan.md section
// 1.1 works through why the literal model needs a fundamentally
// different, more expensive algorithm and was rejected): a short opened
// at P[open] and covered at P[close] multiplies the running balance by
// P[open]/P[close], exactly the ratio a *long* on the reciprocal price
// series 1/P(t) would produce. This is separable the same way the long
// ratio is (P[open] * (1/P[close]), a term depending only on `open`
// times a term depending only on `close`), so it reuses the exact same
// suffix-best-then-O(1)-lookup shape as the long pass -- just a second
// `g` array and the roles of "divide" and "multiply" swapped. No new
// algorithmic technique, no change to the DP's O(days * tickers *
// maxTrades) shape, just a larger per-ticker constant when
// includeShorts is on.
//
// A short's payoff (P[open]/P[close]) is bounded below by 0 -- never
// negative, unlike a real short's unbounded-downside risk -- since both
// prices are real positive numbers (guarded by isValidPrice) and a
// ratio of two positive numbers can't go negative. This is exactly why
// it's safe to extend optimizeWorstTrades to shorts too (see that
// function's own doc comment): a min search over this candidate set can
// never produce an impossible negative balance the way it would under a
// literal unbounded-downside short model.
//
// Fun/expected quirk this unlocks, worth knowing before building
// display/formatting around it (see packages/core/CLAUDE.md's existing
// "$716M from $20" MAX-range note for the long-only precedent): a
// short's payoff is unbounded *above* as the covering price approaches
// zero (P[open]/P[close] -> infinity as P[close] -> 0), so the
// long+short MAX-direction search can in principle land on an even
// larger astronomical ending balance than the long-only search already
// does over the same window -- not a bug, just the same "real perfect-
// hindsight compounding" effect from the other direction.

import { isValidPrice } from "./is-valid-price";
import type { DailyClose } from "./yahoo-client";

/** "long" (buy low, sell high -- every trade before issue #13) or "short" (profit when the price falls, modeled as a reciprocal-price long -- see this file's own header comment for why). */
export type TradeDirection = "long" | "short";

export interface Trade {
  ticker: string;
  direction: TradeDirection;
  /** The date the position was opened -- a buy for a long, economically a sell for a short. Always the earlier of the two dates regardless of direction. */
  openDate: string;
  openPrice: number;
  /** The date the position was closed -- a sell for a long, economically a buy (covering) for a short. Always the later of the two dates regardless of direction. */
  closeDate: string;
  closePrice: number;
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
  direction: TradeDirection;
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

// The long pass's g/ratio formulas -- module-level constants (not
// closures allocated inside computeLevel's per-ticker loop) since
// neither captures anything ticker- or level-specific; see
// runCandidatePass's own doc comment for what these compute.
const longG = (price: number, prevAtNext: number): number => price * prevAtNext;
const longRatio = (price: number, bestSuffixG: number): number => bestSuffixG / price;
// The short pass's own formulas (issue #13) -- the reciprocal-price
// derivation from this file's header comment: "roles of divide and
// multiply swapped" relative to the long pass above.
const shortG = (price: number, prevAtNext: number): number => prevAtNext / price;
const shortRatio = (price: number, bestSuffixG: number): number => price * bestSuffixG;

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
 * @param includeShorts Issue #13 -- when true, a second pass runs per
 *   ticker after the (unmodified) long pass, searching short candidates
 *   (open at P[open], cover at P[close], payoff P[open]/P[close] -- see
 *   this file's own header comment for the reciprocal-price derivation)
 *   for the same value[]/choice[] slots. When false (every call site
 *   before this issue, and optimizeTrades/optimizeWorstTrades/
 *   optimizeBothDirections still today), this function's behavior is
 *   byte-identical to before issue #13 -- the short block is skipped
 *   entirely, no new allocation or comparison evaluated. Because the long
 *   pass always runs to completion (including its own value[]/choice[]
 *   update) before the short pass for the same ticker even starts, an
 *   exact tie between a long and a short candidate for the same ticker
 *   and the same day resolves in the long's favor -- a new, genuinely
 *   arbitrary-but-deterministic tie-break axis this issue introduces (see
 *   docs/plans/issue-13-plan.md section 1.4(b) for the worked example).
 *   The existing three tie-break rules (cross-ticker alphabetical,
 *   cross-day earliest-wins, trade-vs-carry-forward strict inequality)
 *   are unaffected: a short candidate is just one more source competing
 *   for the same strict-inequality-gated value[d] slot.
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
/**
 * Runs one direction-of-trade's (long or short) candidate pass for a
 * single ticker within one DP level, mutating value[]/choice[] in place
 * wherever this ticker's best (long or short) candidate beats the
 * current baseline at that day. Factored out (code review follow-up to
 * issue #13) because the short pass computeLevel originally hand-rolled
 * here was a near-verbatim structural duplicate of the long pass --
 * identical suffix-best/running-best/sentinel/tie-break machinery,
 * differing only in the g/ratio formula (see gAt/ratioAt below) and the
 * emitted TradeChoice.direction -- a real drift risk (buyIdx/sellIdx vs.
 * an earlier draft's openIdx/coverIdx for the same conceptual slot had
 * already diverged once between the two hand-copied blocks). One
 * parameterized implementation now backs both, so a future edit to the
 * shared mechanics (the suffix-best scan, the tie-break comparisons)
 * can't be applied to only one of the two directions by accident.
 *
 * @param gAt g[sellIdx] (or coverIdx, for a short) -- the payoff of
 *   closing this ticker's position on day i, given the best (worst, for
 *   a "min" direction) remaining path (k-1 trades) starting the day
 *   after -- `price * prevValue[i+1]` for a long (longG), `prevValue[i+1]
 *   / price` for a short (shortG); see this file's header comment for
 *   the reciprocal-price derivation.
 * @param ratioAt The candidate ratio for opening on day d, given that
 *   day's price and the best suffix g-value starting the day after --
 *   `bestSuffixG / price` for a long (longRatio), `price * bestSuffixG`
 *   for a short (shortRatio) -- dividing vs. multiplying by the open
 *   price is exactly the "roles of divide and multiply swapped" this
 *   file's header comment describes.
 */
function runCandidatePass(
  T: number,
  prices: (number | null)[],
  prevValue: number[],
  value: number[],
  choice: (TradeChoice | null)[],
  ticker: string,
  tradeDirection: TradeDirection,
  worstSentinel: number,
  isBetterOrEqual: (a: number, b: number) => boolean,
  isStrictlyBetter: (a: number, b: number) => boolean,
  gAt: (price: number, prevAtNext: number) => number,
  ratioAt: (price: number, bestSuffixG: number) => number,
): void {
  // g[sellIdx] = value of closing this ticker on sellIdx -- see gAt's
  // own doc comment above.
  // All array accesses below are within statically-known loop bounds
  // against arrays pre-sized to exactly T (or T+1) elements — genuinely
  // safe, just not provable to noUncheckedIndexedAccess, hence the `!`.
  const g = new Array<number>(T);
  for (let i = 0; i < T; i++) {
    const p = prices[i]!;
    g[i] = p === null ? worstSentinel : gAt(p, prevValue[i + 1]!);
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
      const candidateRatio = ratioAt(p, bestSellValue);
      if (isBetterOrEqual(candidateRatio, runningBestValue)) {
        runningBestValue = candidateRatio;
        runningBestBuyIdx = d;
        runningBestSellIdx = suffixBestSellIdx[d + 1]!;
      }
    }
    if (runningBestBuyIdx !== -1 && isStrictlyBetter(runningBestValue, value[d]!)) {
      value[d] = runningBestValue;
      choice[d] = {
        ticker,
        direction: tradeDirection,
        buyIdx: runningBestBuyIdx,
        sellIdx: runningBestSellIdx,
      };
    }
  }
}

function computeLevel(
  T: number,
  sortedTickers: [string, (number | null)[]][],
  prevValue: number[],
  direction: Direction,
  includeShorts: boolean,
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
    runCandidatePass(
      T,
      prices,
      prevValue,
      value,
      choice,
      ticker,
      "long",
      worstSentinel,
      isBetterOrEqual,
      isStrictlyBetter,
      longG,
      longRatio,
    );

    // Issue #13: a second, short-candidate pass for this same ticker,
    // run immediately after the long pass above and only when
    // includeShorts is set -- so this same ticker's value[]/choice[] is
    // already fully updated by its own long pass before its short pass
    // (if any) even starts, which is exactly what makes an exact tie
    // between a long and a short candidate resolve in the long's favor
    // (see includeShorts's own doc comment above).
    if (includeShorts) {
      runCandidatePass(
        T,
        prices,
        prevValue,
        value,
        choice,
        ticker,
        "short",
        worstSentinel,
        isBetterOrEqual,
        isStrictlyBetter,
        shortG,
        shortRatio,
      );
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
 * Everything a DP run needs that depends only on the input price data --
 * not on `direction`, and not on a particular call's `OptimizeOptions` --
 * (issue #31 perf follow-up): the built calendar and the sorted ticker
 * list. Building this once and reusing it across both a "max" and a
 * "min" run over the *same* price data (as every current caller does,
 * via optimizeBothDirections below) avoids redundantly rebuilding the
 * calendar and re-sorting tickers for the second run, since neither step
 * depends on which direction is being searched.
 */
interface OptimizerState {
  calendar: Calendar;
  /**
   * Sorted once here (not inside computeLevel, which is called up to
   * maxTrades times per direction) since ticker order is invariant across
   * both levels and direction -- also the source of the deterministic
   * tie-break documented on computeLevel's own `sortedTickers` param.
   */
  sortedTickers: [string, (number | null)[]][];
}

/** Validates OptimizeOptions -- independent of any price data or direction, so callers that share one OptimizerState across two directions (see optimizeBothDirections) only need to call this once. */
function validateOptimizeOptions(options: OptimizeOptions): void {
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
}

/** Builds the direction-independent, options-independent state (calendar + sorted tickers) a DP run needs -- see OptimizerState's own doc comment for why this is worth sharing across a "max" and a "min" run over the same price data. */
function buildOptimizerState(priceSeriesByTicker: Map<string, DailyClose[]>): OptimizerState {
  const calendar = buildCalendar(priceSeriesByTicker);
  const sortedTickers = [...calendar.pricesByTicker.entries()].sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return { calendar, sortedTickers };
}

/**
 * Runs the DP (in the given direction) off an already-built OptimizerState:
 * the level-building loop, trade reconstruction, and the finite-
 * endingBalance check -- all direction-agnostic except for computeLevel's
 * own comparisons (see its doc comment), which depend on `direction`.
 * reconstructTrades itself needs no direction-awareness either: it only
 * follows `choice` pointers that computeLevel already computed correctly
 * for whichever direction was requested. Assumes `options` was already
 * validated by the caller (both callers below validate once, up front,
 * rather than once per direction).
 */
function runOptimizerForDirection(
  state: OptimizerState,
  options: OptimizeOptions,
  direction: Direction,
  includeShorts: boolean,
): OptimizationResult {
  const { startingCapital, maxTrades } = options;
  const { calendar, sortedTickers } = state;
  const T = calendar.dates.length;

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
    levels.push(computeLevel(T, sortedTickers, levels[k - 1]!.value, direction, includeShorts));
  }

  const finalMultiplier = levels[maxTrades]!.value[0]!;
  const tradeChoices = reconstructTrades(levels, maxTrades);

  // openDate/openPrice always come from c.buyIdx's date/price and
  // closeDate/closePrice always come from c.sellIdx's, regardless of
  // c.direction -- only the returned object's own `direction` field
  // differs (issue #13's plan section 1.3: the buyIdx/sellIdx-to-open/
  // close mapping is direction-agnostic by construction, no if/else
  // needed here).
  const trades: Trade[] = tradeChoices.map((c) => {
    const prices = calendar.pricesByTicker.get(c.ticker);
    const openPrice = prices?.[c.buyIdx];
    const closePrice = prices?.[c.sellIdx];
    if (openPrice == null || closePrice == null) {
      // Should be unreachable: computeLevel only ever selects indices
      // where this ticker has a known price.
      throw new Error(
        `internal error: reconstructed trade for ${c.ticker} references a day with no price`,
      );
    }
    return {
      ticker: c.ticker,
      direction: c.direction,
      openDate: calendar.dates[c.buyIdx] as string,
      openPrice,
      closeDate: calendar.dates[c.sellIdx] as string,
      closePrice,
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
 * Validates options, builds a fresh OptimizerState from the given price
 * data, and runs the DP once in the given direction -- the single-call
 * path behind optimizeTrades/optimizeWorstTrades below. A caller that
 * needs *both* directions over the *same* price data should call
 * optimizeBothDirections instead, so the calendar/ticker-sort work isn't
 * done twice (see OptimizerState's own doc comment).
 */
function runOptimizer(
  priceSeriesByTicker: Map<string, DailyClose[]>,
  options: OptimizeOptions,
  direction: Direction,
): OptimizationResult {
  validateOptimizeOptions(options);
  const state = buildOptimizerState(priceSeriesByTicker);
  // includeShorts is always false here -- optimizeTrades/
  // optimizeWorstTrades/optimizeBothDirections (the only callers of this
  // function) are pinned to long-only, not merely defaulted, so their
  // behavior stays provably unchanged by issue #13 (see optimizeAllVariants
  // below for the only path that can reach includeShorts: true).
  return runOptimizerForDirection(state, options, direction, false);
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

/**
 * Runs both optimizeTrades ("max") and optimizeWorstTrades ("min") over
 * the *same* `priceSeriesByTicker`/`options`, sharing one built
 * OptimizerState (the calendar + sorted ticker list) between the two
 * runs instead of rebuilding it twice (issue #31 perf follow-up -- see
 * OptimizerState's own doc comment for why that work is safe to share).
 *
 * Every current call site (apps/pipeline's buildWindowResults,
 * packages/core's optimizeIntradayDays) always calls both directions
 * back-to-back on identical input, so this is a drop-in replacement for
 * "call optimizeTrades, then call optimizeWorstTrades" wherever that
 * pattern shows up -- same two OptimizationResults, just computed
 * without the redundant calendar-build/ticker-sort the two separate
 * calls used to each do independently.
 */
export function optimizeBothDirections(
  priceSeriesByTicker: Map<string, DailyClose[]>,
  options: OptimizeOptions,
): { best: OptimizationResult; worst: OptimizationResult } {
  validateOptimizeOptions(options);
  const state = buildOptimizerState(priceSeriesByTicker);
  return {
    best: runOptimizerForDirection(state, options, "max", false),
    worst: runOptimizerForDirection(state, options, "min", false),
  };
}

/**
 * Runs all 4 direction x instrument-set combinations over the *same*
 * `priceSeriesByTicker`/`options` (issue #13): long-only best/worst (the
 * exact same results optimizeBothDirections would produce -- see
 * `longOnly` below) and long+short best/worst, sharing one built
 * OptimizerState across all 4 runs the same way optimizeBothDirections
 * shares it across 2 (see OptimizerState's own doc comment).
 *
 * This is the *only* path that can ever reach computeLevel with
 * `includeShorts: true` -- optimizeTrades/optimizeWorstTrades/
 * optimizeBothDirections all still call runOptimizerForDirection with a
 * fixed `includeShorts: false`, never threaded from a caller-supplied
 * option, so their own behavior stays provably unchanged by this
 * function's existence. `OptimizeOptions` itself gained no new field for
 * this -- the flag lives only at this internal layer.
 *
 * `longShort.best.endingBalance >= longOnly.best.endingBalance` and
 * `longShort.worst.endingBalance <= longOnly.worst.endingBalance` always
 * hold by construction: the long+short search explores a strict superset
 * of the long-only candidate trade set (every long candidate stays
 * available, plus shorts), so a max search over a superset can never do
 * worse and a min search over a superset can never do better (i.e. can
 * only find an equal-or-lower minimum). See results-schema.ts's
 * validatePrecomputedResult, which checks exactly this invariant on
 * every stored result.
 *
 * **Known, documented, bounded inefficiency (code review follow-up, not
 * fixed -- lower priority than this codebase's other reuse/efficiency
 * findings, and judged not clean enough to be worth fixing): the k=1
 * level's long-candidate-pass work is computed redundantly, twice per
 * direction, here.** `runOptimizerForDirection`'s k=1 call always starts
 * from the identical all-ones level0.value (see that function's own
 * comment: "Level 0 ... is always multiplier 1 regardless of
 * direction"), and the long pass itself has no dependency on
 * `includeShorts` -- so the long-only run's k=1 level and the long+short
 * run's k=1 level (same `state`, same `options`, same `direction`) do
 * byte-for-byte identical long-pass work before the long+short run's k=1
 * additionally runs its own short pass. This redundant work is paid on
 * every call to this function (once per window range in apps/pipeline,
 * up to ~251x per intraday-day run) but is bounded to k=1 specifically
 * -- levels k=2..maxTrades genuinely diverge between the two runs (each
 * level's own prevValue already reflects whether shorts contributed at
 * the previous level), so there's no equivalent redundancy to reclaim
 * there. Sharing just the k=1 long pass would need
 * `computeLevel`/`runCandidatePass` to accept an already-computed
 * baseline level instead of always initializing value/choice fresh from
 * `prevValue` and running the long pass inline -- judged, on balance,
 * not clean enough to be worth the added surface area on this function's
 * otherwise-simple single-entry-point shape for a saving bounded to one
 * of up to `maxTrades` levels per run. Revisit if `computeLevel` is ever
 * restructured for an unrelated reason that would make exposing that
 * seam cheap.
 */
export function optimizeAllVariants(
  priceSeriesByTicker: Map<string, DailyClose[]>,
  options: OptimizeOptions,
): {
  longOnly: { best: OptimizationResult; worst: OptimizationResult };
  longShort: { best: OptimizationResult; worst: OptimizationResult };
} {
  validateOptimizeOptions(options);
  const state = buildOptimizerState(priceSeriesByTicker);
  return {
    longOnly: {
      best: runOptimizerForDirection(state, options, "max", false),
      worst: runOptimizerForDirection(state, options, "min", false),
    },
    longShort: {
      best: runOptimizerForDirection(state, options, "max", true),
      worst: runOptimizerForDirection(state, options, "min", true),
    },
  };
}
