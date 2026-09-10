// The Cut's core selection algorithm (issue #231) -- see
// docs/design/the-cut-2026-09/README.md's "The mechanic" section for the
// full derivation this file implements. Pure and framework-free, same
// posture as lineup-selection.ts/order-selection.ts: no I/O, no fetching,
// no pipeline wiring (that's the follow-on pipeline-integration issue) --
// just the domain arithmetic, directly unit-testable against synthetic
// fixtures.
//
// The mechanic: companies are ranked #1..#500 by real S&P index weight
// (descending). A candidate portfolio of prefix length N holds companies
// #1..N, capital allocated in proportion to their real weights,
// renormalized among just the N held (not equal-split). For prefix
// length N:
//
//   portfolioReturn(N) = cumWeightedReturn[N] / cumWeight[N]
//   cumWeightedReturn[N] = sum_{i<=N} effectiveWeight_i * ratio_i
//   cumWeight[N]         = sum_{i<=N} effectiveWeight_i
//
// where ratio_i is ticker i's window buy-and-hold return (end close /
// start close -- the same computation apps/pipeline's computeBenchmark
// already does for SPY, generalized here across the whole universe), and
// effectiveWeight_i is the ticker's real weight if it has valid start/end
// closes for the window, else 0 (excluded from that prefix -- dividing by
// cumWeight[N] rather than a fixed denominator is exactly what
// renormalizes the remaining held weights, no separate step needed).
//
// The whole N=1..length curve is computed via two O(n) prefix-sum arrays
// built in one pass -- no DP, no per-N recomputation from scratch.

import { isValidPrice } from "./is-valid-price";
import type { DailyClose } from "./yahoo-client";

/** One ticker's rank input: its symbol (must match a key in closesByTicker) and its real S&P weight. */
export interface Sp500PrefixTicker {
  /** Ticker symbol, matching a key in Sp500PrefixSelectionInput.closesByTicker. */
  symbol: string;
  /**
   * Real S&P weight, e.g. SP500Constituent.weight (a raw percentage-point
   * value, not a 0-1 fraction) -- this module never assumes weights sum
   * to 100 or to 1, since renormalization happens per-prefix via
   * cumWeight[N] regardless of the input's own total.
   */
  weight: number;
}

export interface Sp500PrefixSelectionInput {
  /**
   * Companies ranked #1..#N by real weight, descending -- this module
   * trusts the given order and does no sorting of its own (the caller's
   * responsibility, e.g. `[...SP500_CONSTITUENTS].sort((a, b) => b.weight - a.weight)`).
   */
  orderedTickers: readonly Sp500PrefixTicker[];
  /**
   * Each ticker's own daily-close history, keyed by symbol (matching
   * orderedTickers[i].symbol). A symbol absent from this map is treated
   * identically to one present whose history lacks a close on
   * rangeStartString or endDateString -- excluded (effectiveWeight 0),
   * never an error -- same "skip what's missing" posture
   * lineup-selection.ts's computeCandidates already takes for a missing
   * ticker.
   */
  closesByTicker: ReadonlyMap<string, readonly DailyClose[]>;
  /**
   * The window's start date, YYYY-MM-DD. Unlike apps/pipeline's
   * computeBenchmark (whose own rangeStartString is `string | null`, null
   * meaning "no lower bound" for the MAX range), this module always
   * requires a concrete date: a ticker's ratio is only valid when its
   * history has an exact close on this date (see the module-level "Exact
   * boundary-date matching" note below) -- there's no well-defined
   * "no lower bound" case for an exact-match rule. The caller (the
   * follow-on pipeline-integration issue) is responsible for resolving
   * MAX's own start into a real date before calling this, e.g. the
   * earliest date common to the fetched universe.
   */
  rangeStartString: string;
  /**
   * The window's end date, YYYY-MM-DD -- same exact-match requirement as
   * rangeStartString. In practice this should be a real, observed
   * trading date (e.g. the pipeline's own `dataAsOf`), not a nominal
   * boundary that might land on a weekend/holiday no ticker ever has a
   * close on.
   */
  endDateString: string;
  /** Starting capital for the endingBalance figures below (this app's convention is $20 -- see apps/pipeline's DEFAULT_STARTING_CAPITAL -- but not hardcoded here). */
  startingCapital: number;
}

/** One point on the N=1..length reveal-chart curve -- only emitted for an N where cumWeight[N] > 0 (see computeSp500PrefixSelection's own doc comment). */
export interface Sp500PrefixCurvePoint {
  /** Prefix length (rank cutoff), 1-based. */
  n: number;
  /** portfolioReturn(n) = cumWeightedReturn[n] / cumWeight[n]. */
  portfolioReturn: number;
  /** startingCapital * portfolioReturn(n). */
  endingBalance: number;
  /** cumWeight[n] -- how much of orderedTickers[0..n-1]'s combined real weight actually had valid window data (for callers that want to show "N holdings, weighted coverage" alongside the curve). */
  cumWeight: number;
}

export interface Sp500PrefixSelectionResult {
  /**
   * argmax over portfolioReturn(N) for every N where cumWeight[N] > 0,
   * ties broken by smallest N (a determinism rule, not an economic claim
   * -- same spirit as optimizer.ts's alphabetical tie-break). `null` only
   * when every N from 1..orderedTickers.length has cumWeight[N] === 0
   * (every company in the universe lacks window data) -- an explicit,
   * typed guard rather than silently scoring a meaningless 0/NaN best.
   */
  bestN: number | null;
  /** portfolioReturn(bestN), or null iff bestN is null. */
  bestPortfolioReturn: number | null;
  /** startingCapital * bestPortfolioReturn, or null iff bestN is null. */
  bestEndingBalance: number | null;
  /**
   * One entry per N in 1..orderedTickers.length where cumWeight[N] > 0 --
   * an N whose entire prefix lacks window data is skipped entirely, not
   * emitted as a 0/NaN point. Ordered ascending by n.
   */
  curve: Sp500PrefixCurvePoint[];
}

/**
 * One ticker's window buy-and-hold return ratio (end close / start
 * close), generalizing apps/pipeline's computeBenchmark (which computes
 * exactly this for a single ticker, SPY) across an arbitrary ticker.
 *
 * **Exact boundary-date matching, deliberately stricter than
 * computeBenchmark's own "earliest/latest point that happens to fall
 * inside [rangeStartString, endDateString]" scan.** computeBenchmark
 * accepts a truncated window for its one ticker and flags it via a
 * separate `truncated` field; this function has no such field and
 * instead must decide per ticker whether it's usable *at all* for a
 * given prefix (see effectiveWeight_i's own definition on
 * Sp500PrefixSelectionInput). Requiring a close on the exact
 * rangeStartString/endDateString dates -- rather than merely "some close
 * somewhere in between" -- is what correctly excludes a ticker that
 * hadn't IPO'd yet by rangeStartString, had already delisted by
 * endDateString, or hit a fetch failure on either boundary date: any of
 * those leaves a gap at one of the two exact dates every other
 * continuously-listed ticker has a close on, without needing a shared
 * trading calendar to detect it.
 *
 * Returns `null` if either boundary date is missing from `closes`, or
 * either close found there isn't a valid positive finite price.
 */
function tickerWindowRatio(
  closes: readonly DailyClose[] | undefined,
  rangeStartString: string,
  endDateString: string,
): number | null {
  if (!closes) return null;
  let startClose: number | null = null;
  let endClose: number | null = null;
  for (const point of closes) {
    if (point.date === rangeStartString) startClose = point.close;
    if (point.date === endDateString) endClose = point.close;
  }
  if (startClose === null || endClose === null) return null;
  if (!isValidPrice(startClose) || !isValidPrice(endClose)) return null;
  return endClose / startClose;
}

/**
 * Computes The Cut's whole N=1..orderedTickers.length prefix curve and
 * its best N, via two O(n) prefix-sum arrays built in a single pass over
 * `orderedTickers` -- no DP, no per-N recomputation from scratch (each of
 * the three loops below is O(n); nothing here is O(n^2)).
 *
 * Ties in portfolioReturn across different N break toward the smallest
 * N: the argmax loop only replaces its running best on a *strict*
 * improvement (`>`, never `>=`), so among several N tied for the same
 * maximum, the first (smallest) one encountered is the one that sticks.
 */
export function computeSp500PrefixSelection(
  input: Sp500PrefixSelectionInput,
): Sp500PrefixSelectionResult {
  const { orderedTickers, closesByTicker, rangeStartString, endDateString, startingCapital } =
    input;
  const n = orderedTickers.length;

  // Pass 1: each ticker's own effectiveWeight_i/ratio_i, independent of
  // every other ticker.
  const effectiveWeights = new Array<number>(n);
  const ratios = new Array<number>(n); // ratio_i where effectiveWeight_i > 0; unused (0) otherwise
  for (let i = 0; i < n; i++) {
    const ratio = tickerWindowRatio(
      closesByTicker.get(orderedTickers[i]!.symbol),
      rangeStartString,
      endDateString,
    );
    effectiveWeights[i] = ratio === null ? 0 : orderedTickers[i]!.weight;
    ratios[i] = ratio ?? 0;
  }

  // Pass 2: the two O(n) prefix-sum arrays -- cumWeight[i]/cumWeightedReturn[i]
  // cover prefix length i+1 (companies ranked 1..i+1).
  const cumWeight = new Array<number>(n);
  const cumWeightedReturn = new Array<number>(n);
  let runningWeight = 0;
  let runningWeightedReturn = 0;
  for (let i = 0; i < n; i++) {
    runningWeight += effectiveWeights[i]!;
    runningWeightedReturn += effectiveWeights[i]! * ratios[i]!;
    cumWeight[i] = runningWeight;
    cumWeightedReturn[i] = runningWeightedReturn;
  }

  // Pass 3: read portfolioReturn(N) off the prefix sums for every N with
  // cumWeight[N] > 0, tracking the curve and the (smallest-N-wins) argmax.
  const curve: Sp500PrefixCurvePoint[] = [];
  let bestN: number | null = null;
  let bestPortfolioReturn = -Infinity;
  for (let i = 0; i < n; i++) {
    const weight = cumWeight[i]!;
    if (weight <= 0) continue; // guard: this prefix's every company lacks window data -- excluded entirely, not scored as 0/NaN
    const portfolioReturn = cumWeightedReturn[i]! / weight;
    curve.push({
      n: i + 1,
      portfolioReturn,
      endingBalance: startingCapital * portfolioReturn,
      cumWeight: weight,
    });
    if (portfolioReturn > bestPortfolioReturn) {
      bestPortfolioReturn = portfolioReturn;
      bestN = i + 1;
    }
  }

  return {
    bestN,
    bestPortfolioReturn: bestN === null ? null : bestPortfolioReturn,
    bestEndingBalance: bestN === null ? null : startingCapital * bestPortfolioReturn,
    curve,
  };
}
