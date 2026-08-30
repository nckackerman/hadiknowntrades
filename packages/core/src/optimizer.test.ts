import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildCalendar,
  collectTradingDates,
  optimizeTrades,
  optimizeWorstTrades,
  optimizeAllVariants,
  OptimizerInputError,
  type Calendar,
} from "./optimizer.js";
import type { DailyClose } from "./yahoo-client.js";

// Backstop against a spy leaking into later tests if an assertion throws
// before a test's own `warnSpy.mockRestore()` line is reached.
afterEach(() => {
  vi.restoreAllMocks();
});

const EPSILON = 1e-9;

function series(prices: (number | null)[], startDate = "2024-01-01"): DailyClose[] {
  const start = new Date(startDate);
  const out: DailyClose[] = [];
  prices.forEach((close, i) => {
    if (close === null) return;
    const d = new Date(start);
    d.setUTCDate(d.getUTCDate() + i);
    const iso = d.toISOString().slice(0, 10);
    out.push({ date: iso, close });
  });
  return out;
}

function multiplier(startingCapital: number, endingBalance: number): number {
  return endingBalance / startingCapital;
}

describe("optimizeTrades: hand-verified fixtures", () => {
  it("single ticker, one trade: picks the single best buy/sell pair", () => {
    // prices: [10, 20, 15, 30] -- best is buy day0 (10) sell day3 (30) = 3x.
    const prices = new Map([["A", series([10, 20, 15, 30])]]);

    const result = optimizeTrades(prices, { startingCapital: 20, maxTrades: 1 });

    expect(multiplier(20, result.endingBalance)).toBeCloseTo(3, 6);
    expect(result.trades).toEqual([
      {
        ticker: "A",
        direction: "long",
        openDate: "2024-01-01",
        openPrice: 10,
        closeDate: "2024-01-04",
        closePrice: 30,
      },
    ]);
  });

  it("single ticker, two trades: compounding across a dip beats one trade spanning it", () => {
    // prices: [10, 30, 5, 40].
    // 1 trade:  buy@10 sell@40 = 4x.
    // 2 trades: buy@10 sell@30 (3x) then buy@5 sell@40 (8x) = 24x -- much better.
    const prices = new Map([["A", series([10, 30, 5, 40])]]);

    const result = optimizeTrades(prices, { startingCapital: 20, maxTrades: 2 });

    expect(multiplier(20, result.endingBalance)).toBeCloseTo(24, 6);
    expect(result.trades).toEqual([
      {
        ticker: "A",
        direction: "long",
        openDate: "2024-01-01",
        openPrice: 10,
        closeDate: "2024-01-02",
        closePrice: 30,
      },
      {
        ticker: "A",
        direction: "long",
        openDate: "2024-01-03",
        openPrice: 5,
        closeDate: "2024-01-04",
        closePrice: 40,
      },
    ]);
  });

  it("picks the better ticker, not just the first one", () => {
    // Ticker A: 10 -> 20 (2x). Ticker B: 5 -> 25 (5x). Should pick B.
    const prices = new Map([
      ["A", series([10, 20])],
      ["B", series([5, 25])],
    ]);

    const result = optimizeTrades(prices, { startingCapital: 20, maxTrades: 1 });

    expect(multiplier(20, result.endingBalance)).toBeCloseTo(5, 6);
    expect(result.trades).toEqual([
      {
        ticker: "B",
        direction: "long",
        openDate: "2024-01-01",
        openPrice: 5,
        closeDate: "2024-01-02",
        closePrice: 25,
      },
    ]);
  });

  it("switches tickers between trades, including a ticker with no data on early days", () => {
    // Ticker A: [10, 20, 8] -- best trade is buy d0 sell d1 = 2x.
    // Ticker B: [null, null, 5, 25] -- only has data from day 2, buy d2 sell d3 = 5x.
    // With 2 trades: A's 2x (d0->d1) then B's 5x (d2->d3) = 10x, non-overlapping.
    const prices = new Map([
      ["A", series([10, 20, 8])],
      ["B", series([null, null, 5, 25])],
    ]);

    const result = optimizeTrades(prices, { startingCapital: 20, maxTrades: 2 });

    expect(multiplier(20, result.endingBalance)).toBeCloseTo(10, 6);
    expect(result.trades).toEqual([
      {
        ticker: "A",
        direction: "long",
        openDate: "2024-01-01",
        openPrice: 10,
        closeDate: "2024-01-02",
        closePrice: 20,
      },
      {
        ticker: "B",
        direction: "long",
        openDate: "2024-01-03",
        openPrice: 5,
        closeDate: "2024-01-04",
        closePrice: 25,
      },
    ]);
  });

  it("takes fewer than maxTrades when no profitable trade exists (at-most-k, not exactly-k)", () => {
    // Strictly declining prices -- every possible trade loses money, so the
    // optimizer should take zero trades rather than force a loss.
    const prices = new Map([["A", series([30, 20, 10])]]);

    const result = optimizeTrades(prices, { startingCapital: 20, maxTrades: 3 });

    expect(result.endingBalance).toBeCloseTo(20, 6);
    expect(result.trades).toEqual([]);
  });

  it("uses fewer than maxTrades when only some trades are profitable", () => {
    // One profitable trade (10 -> 30) followed by a strict decline
    // (30 -> 5 -> 1). A second trade would only lose money, so with
    // maxTrades=2 the optimizer should still take exactly one trade.
    const prices = new Map([["A", series([10, 30, 5, 1])]]);

    const result = optimizeTrades(prices, { startingCapital: 20, maxTrades: 2 });

    expect(multiplier(20, result.endingBalance)).toBeCloseTo(3, 6);
    expect(result.trades).toEqual([
      {
        ticker: "A",
        direction: "long",
        openDate: "2024-01-01",
        openPrice: 10,
        closeDate: "2024-01-02",
        closePrice: 30,
      },
    ]);
  });
});

describe("optimizeTrades: edge cases", () => {
  it("returns the starting capital unchanged for an empty universe", () => {
    const result = optimizeTrades(new Map(), { startingCapital: 20, maxTrades: 3 });

    expect(result.endingBalance).toBe(20);
    expect(result.trades).toEqual([]);
  });

  it("returns the starting capital unchanged when maxTrades is 0", () => {
    const prices = new Map([["A", series([10, 100])]]);

    const result = optimizeTrades(prices, { startingCapital: 20, maxTrades: 0 });

    expect(result.endingBalance).toBe(20);
    expect(result.trades).toEqual([]);
  });

  it("returns the starting capital unchanged with only a single day of data (no possible trade)", () => {
    const prices = new Map([["A", series([10])]]);

    const result = optimizeTrades(prices, { startingCapital: 20, maxTrades: 3 });

    expect(result.endingBalance).toBe(20);
    expect(result.trades).toEqual([]);
  });

  it("handles a ticker whose entire series is null-free but another ticker is all-null on overlapping days", () => {
    const prices = new Map([
      ["A", series([10, 20])],
      ["B", series([null, null])],
    ]);

    const result = optimizeTrades(prices, { startingCapital: 20, maxTrades: 1 });

    expect(multiplier(20, result.endingBalance)).toBeCloseTo(2, 6);
  });

  it.each([-1, 1.5, NaN, Infinity, 51])(
    "rejects an invalid maxTrades (%s) with a typed error instead of crashing or hanging",
    (maxTrades) => {
      const prices = new Map([["A", series([10, 20])]]);

      expect(() => optimizeTrades(prices, { startingCapital: 20, maxTrades })).toThrow(
        OptimizerInputError,
      );
    },
  );

  it.each([0, -20, NaN, Infinity, -Infinity])(
    "rejects a non-positive or non-finite startingCapital (%s) instead of silently propagating garbage",
    (startingCapital) => {
      const prices = new Map([["A", series([10, 20])]]);

      expect(() => optimizeTrades(prices, { startingCapital, maxTrades: 1 })).toThrow(
        OptimizerInputError,
      );
    },
  );

  it("ignores a non-positive or non-finite close instead of dividing by it and producing Infinity", () => {
    // Ticker A's only valid closing price is on day 1 (day 0 is a corrupt
    // zero) -- with a single valid day, no trade is possible for A at all
    // (a ratio would need to divide by the invalid zero buy price, which
    // is exactly what filtering it out must prevent). Ticker B is a
    // normal, smaller opportunity that should win by default.
    const prices = new Map([
      ["A", series([0, 30])],
      ["B", series([10, 12, 14])],
    ]);

    const result = optimizeTrades(prices, { startingCapital: 20, maxTrades: 1 });

    expect(Number.isFinite(result.endingBalance)).toBe(true);
    expect(multiplier(20, result.endingBalance)).toBeCloseTo(1.4, 6); // B: 10 -> 14
    expect(result.trades[0]?.ticker).toBe("B");
  });

  it("breaks a tie between equally-good tickers deterministically (alphabetically first), regardless of Map insertion order", () => {
    const pricesAB = new Map([
      ["A", series([10, 20])],
      ["B", series([10, 20])],
    ]);
    const pricesBA = new Map([
      ["B", series([10, 20])],
      ["A", series([10, 20])],
    ]);

    const resultAB = optimizeTrades(pricesAB, { startingCapital: 20, maxTrades: 1 });
    const resultBA = optimizeTrades(pricesBA, { startingCapital: 20, maxTrades: 1 });

    expect(resultAB.trades[0]?.ticker).toBe("A");
    expect(resultBA.trades[0]?.ticker).toBe("A");
    expect(resultAB.endingBalance).toBe(resultBA.endingBalance);
  });
});

// --- optimizeWorstTrades (issue #31): the same DP's min-direction search.
// See computeLevel's own doc comment (optimizer.ts) for exactly which
// four comparison sites/sentinels flip between "max" and "min" -- these
// tests exercise the min-direction behavior directly rather than trusting
// that documentation alone.

describe("optimizeWorstTrades: hand-verified fixtures", () => {
  it("single ticker, one trade: picks the single worst buy/sell pair", () => {
    // prices: [10, 20, 15, 30] -- worst is buy day1 (20) sell day2 (15) = 0.75x.
    const prices = new Map([["A", series([10, 20, 15, 30])]]);

    const result = optimizeWorstTrades(prices, { startingCapital: 20, maxTrades: 1 });

    expect(multiplier(20, result.endingBalance)).toBeCloseTo(0.75, 6);
    expect(result.trades).toEqual([
      {
        ticker: "A",
        direction: "long",
        openDate: "2024-01-02",
        openPrice: 20,
        closeDate: "2024-01-03",
        closePrice: 15,
      },
    ]);
  });

  it("picks the worse ticker, not just the first one", () => {
    // Ticker A: 10 -> 5 (0.5x). Ticker B: 20 -> 4 (0.2x). Should pick B.
    const prices = new Map([
      ["A", series([10, 5])],
      ["B", series([20, 4])],
    ]);

    const result = optimizeWorstTrades(prices, { startingCapital: 20, maxTrades: 1 });

    expect(multiplier(20, result.endingBalance)).toBeCloseTo(0.2, 6);
    expect(result.trades).toEqual([
      {
        ticker: "B",
        direction: "long",
        openDate: "2024-01-01",
        openPrice: 20,
        closeDate: "2024-01-02",
        closePrice: 4,
      },
    ]);
  });

  it("chains multiple losing trades across tickers to compound a worse result than any single trade", () => {
    // Ticker A: [20, 5] -- worst trade 0.25x. Ticker B: [null, null, 30, 3] --
    // only has data from day 2, worst trade 0.1x. Two non-overlapping
    // losing trades compound to 0.025x, worse than either alone.
    const prices = new Map([
      ["A", series([20, 5])],
      ["B", series([null, null, 30, 3])],
    ]);

    const result = optimizeWorstTrades(prices, { startingCapital: 20, maxTrades: 2 });

    expect(multiplier(20, result.endingBalance)).toBeCloseTo(0.025, 6);
    expect(result.trades).toEqual([
      {
        ticker: "A",
        direction: "long",
        openDate: "2024-01-01",
        openPrice: 20,
        closeDate: "2024-01-02",
        closePrice: 5,
      },
      {
        ticker: "B",
        direction: "long",
        openDate: "2024-01-03",
        openPrice: 30,
        closeDate: "2024-01-04",
        closePrice: 3,
      },
    ]);
  });

  it("takes fewer than maxTrades when every available trade would be a gain (the rare 'still a gain' edge case, issue #31 plan section 1.4)", () => {
    // Strictly rising prices -- every possible trade gains money, so the
    // worst-case optimizer should take zero trades (multiplier 1) rather
    // than force a gain into the "worst case" slot.
    const prices = new Map([["A", series([10, 20, 30])]]);

    const result = optimizeWorstTrades(prices, { startingCapital: 20, maxTrades: 3 });

    expect(result.endingBalance).toBeCloseTo(20, 6);
    expect(result.trades).toEqual([]);
  });

  it("uses fewer than maxTrades when only some trades are losing", () => {
    // One losing trade (30 -> 5) followed by a strict rise (5 -> 40 -> 100).
    // A second trade would only gain money, so with maxTrades=2 the
    // worst-case optimizer should still take exactly one trade.
    const prices = new Map([["A", series([30, 5, 40, 100])]]);

    const result = optimizeWorstTrades(prices, { startingCapital: 20, maxTrades: 2 });

    expect(multiplier(20, result.endingBalance)).toBeCloseTo(1 / 6, 6);
    expect(result.trades).toEqual([
      {
        ticker: "A",
        direction: "long",
        openDate: "2024-01-01",
        openPrice: 30,
        closeDate: "2024-01-02",
        closePrice: 5,
      },
    ]);
  });

  it("breaks a tie between equally-bad tickers deterministically (alphabetically first), same rule as the max direction", () => {
    const pricesAB = new Map([
      ["A", series([20, 10])],
      ["B", series([20, 10])],
    ]);
    const pricesBA = new Map([
      ["B", series([20, 10])],
      ["A", series([20, 10])],
    ]);

    const resultAB = optimizeWorstTrades(pricesAB, { startingCapital: 20, maxTrades: 1 });
    const resultBA = optimizeWorstTrades(pricesBA, { startingCapital: 20, maxTrades: 1 });

    expect(resultAB.trades[0]?.ticker).toBe("A");
    expect(resultBA.trades[0]?.ticker).toBe("A");
    expect(resultAB.endingBalance).toBe(resultBA.endingBalance);
  });
});

describe("optimizeWorstTrades: edge cases", () => {
  it("returns the starting capital unchanged for an empty universe", () => {
    const result = optimizeWorstTrades(new Map(), { startingCapital: 20, maxTrades: 3 });

    expect(result.endingBalance).toBe(20);
    expect(result.trades).toEqual([]);
  });

  it("returns the starting capital unchanged when maxTrades is 0", () => {
    const prices = new Map([["A", series([10, 1])]]);

    const result = optimizeWorstTrades(prices, { startingCapital: 20, maxTrades: 0 });

    expect(result.endingBalance).toBe(20);
    expect(result.trades).toEqual([]);
  });

  it("ignores a non-positive or non-finite close instead of dividing by it and producing garbage", () => {
    const prices = new Map([
      ["A", series([0, 30])],
      ["B", series([10, 8, 6])],
    ]);

    const result = optimizeWorstTrades(prices, { startingCapital: 20, maxTrades: 1 });

    expect(Number.isFinite(result.endingBalance)).toBe(true);
    expect(multiplier(20, result.endingBalance)).toBeCloseTo(0.6, 6); // B: 10 -> 6
    expect(result.trades[0]?.ticker).toBe("B");
  });

  it.each([-1, 1.5, NaN, Infinity, 51])(
    "rejects an invalid maxTrades (%s) with a typed error instead of crashing or hanging",
    (maxTrades) => {
      const prices = new Map([["A", series([10, 20])]]);

      expect(() => optimizeWorstTrades(prices, { startingCapital: 20, maxTrades })).toThrow(
        OptimizerInputError,
      );
    },
  );

  it.each([0, -20, NaN, Infinity, -Infinity])(
    "rejects a non-positive or non-finite startingCapital (%s) instead of silently propagating garbage",
    (startingCapital) => {
      const prices = new Map([["A", series([10, 20])]]);

      expect(() => optimizeWorstTrades(prices, { startingCapital, maxTrades: 1 })).toThrow(
        OptimizerInputError,
      );
    },
  );
});

describe("buildCalendar", () => {
  it("unions dates across tickers and reindexes each ticker's prices, nulling gaps", () => {
    const prices = new Map([
      ["A", series([10, 20], "2024-01-01")], // 01-01, 01-02
      ["B", series([5, 6], "2024-01-02")], // 01-02, 01-03
    ]);

    const calendar: Calendar = buildCalendar(prices);

    expect(calendar.dates).toEqual(["2024-01-01", "2024-01-02", "2024-01-03"]);
    expect(calendar.pricesByTicker.get("A")).toEqual([10, 20, null]);
    expect(calendar.pricesByTicker.get("B")).toEqual([null, 5, 6]);
  });

  it("skips non-positive or non-finite closes and warns instead of admitting bad data", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const prices = new Map([
      [
        "A",
        [
          { date: "2024-01-01", close: 10 },
          { date: "2024-01-02", close: 0 },
          { date: "2024-01-03", close: -5 },
          { date: "2024-01-04", close: NaN },
          { date: "2024-01-05", close: 20 },
        ],
      ],
    ]);

    const calendar = buildCalendar(prices);

    expect(calendar.pricesByTicker.get("A")).toEqual([10, null, null, null, 20]);
    expect(warnSpy).toHaveBeenCalledTimes(3);
    warnSpy.mockRestore();
  });

  it("warns (but doesn't throw) on a duplicate date for one ticker, keeping the last value seen", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const prices = new Map([
      [
        "A",
        [
          { date: "2024-01-01", close: 10 },
          { date: "2024-01-01", close: 999 },
        ],
      ],
    ]);

    const calendar = buildCalendar(prices);

    expect(calendar.pricesByTicker.get("A")).toEqual([999]);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/duplicate/i));
    warnSpy.mockRestore();
  });
});

describe("collectTradingDates", () => {
  it("returns the sorted union of every date present in any ticker's series", () => {
    const prices = new Map([
      ["A", series([10, 20], "2024-01-01")], // 01-01, 01-02
      ["B", series([5, 6], "2024-01-02")], // 01-02, 01-03
    ]);

    expect(collectTradingDates(prices)).toEqual(["2024-01-01", "2024-01-02", "2024-01-03"]);
  });

  it("matches buildCalendar's own dates field exactly, for the same input (issue #75 code review finding -- the two must not drift)", () => {
    const prices = new Map([
      ["A", series([10, 20, 30], "2024-01-01")],
      ["B", series([5, 6], "2024-02-15")],
    ]);

    expect(collectTradingDates(prices)).toEqual(buildCalendar(prices).dates);
  });

  it("returns an empty array for an empty input", () => {
    expect(collectTradingDates(new Map())).toEqual([]);
  });

  it("does not warn or drop a date for a non-positive/non-finite close -- unlike buildCalendar's own pricesByTicker reindex, it doesn't inspect price validity at all", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const prices = new Map([
      [
        "A",
        [
          { date: "2024-01-01", close: 10 },
          { date: "2024-01-02", close: NaN },
        ],
      ],
    ]);

    expect(collectTradingDates(prices)).toEqual(["2024-01-01", "2024-01-02"]);
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

// --- Brute-force cross-check -----------------------------------------
//
// An exhaustive (exponential) reference implementation of the same
// "at most maxTrades sequential, all-in, long-only trades across many
// tickers" problem, used only in tests against small fixtures to
// validate the DP's efficient implementation actually computes the same
// answer as trying every possibility.

/**
 * @param direction "max" (the default, matching optimizeTrades) or "min"
 *   (matching optimizeWorstTrades, issue #31) -- the exhaustive search
 *   itself is direction-agnostic other than which of Math.max/Math.min
 *   picks a winner at each branch point, so both directions share one
 *   brute-force implementation rather than two copies.
 * @param includeShorts (issue #13) when true, every (open, close) pair is
 *   also considered as a short candidate with ratio
 *   `prices[open] / prices[close]` (the reciprocal-price payoff, see
 *   optimizer.ts's own header comment) alongside the existing long
 *   candidate `prices[close] / prices[open]` -- both compete for the same
 *   `pick` at every branch point, exactly mirroring computeLevel's own
 *   "long pass then short pass, same value[]/choice[] slot" structure.
 */
function bruteForceMultiplier(
  calendar: Calendar,
  maxTrades: number,
  direction: "max" | "min" = "max",
  includeShorts = false,
): number {
  const T = calendar.dates.length;
  const tickers = [...calendar.pricesByTicker.entries()];
  const pick = direction === "max" ? Math.max : Math.min;

  function best(tradesLeft: number, minDay: number): number {
    if (tradesLeft === 0 || minDay >= T) return 1;
    let bestVal = best(tradesLeft - 1, minDay); // take no trade at this level
    for (const [, prices] of tickers) {
      for (let buy = minDay; buy < T; buy++) {
        const openPrice = prices[buy];
        if (openPrice === null || openPrice === undefined) continue;
        for (let sell = buy + 1; sell < T; sell++) {
          const closePrice = prices[sell];
          if (closePrice === null || closePrice === undefined) continue;
          const rest = best(tradesLeft - 1, sell + 1);
          const longVal = (closePrice / openPrice) * rest;
          bestVal = pick(bestVal, longVal);
          if (includeShorts) {
            const shortVal = (openPrice / closePrice) * rest;
            bestVal = pick(bestVal, shortVal);
          }
        }
      }
    }
    return bestVal;
  }

  return best(maxTrades, 0);
}

// Small, fixed (not randomly generated, for determinism), varied price
// grids to cross-check. Kept intentionally tiny -- brute force is
// exponential in maxTrades.
const CROSS_CHECK_FIXTURES: {
  name: string;
  prices: Record<string, (number | null)[]>;
  maxTrades: number;
}[] = [
  {
    name: "single ticker, zigzag",
    prices: { A: [10, 15, 8, 22, 6, 30] },
    maxTrades: 3,
  },
  {
    name: "two tickers, interleaved opportunities",
    prices: {
      A: [10, 25, 12, 18, 9, 40],
      B: [20, 18, 35, 15, 45, 22],
    },
    maxTrades: 3,
  },
  {
    name: "three tickers, some overlapping gaps",
    prices: {
      A: [5, 12, 7, 20, null, 25],
      B: [null, 8, 15, 6, 30, 10],
      C: [50, 30, 60, 45, 55, 90],
    },
    maxTrades: 3,
  },
  {
    name: "mostly declining, one good window",
    prices: {
      A: [100, 90, 80, 70, 60, 200, 50, 40],
    },
    maxTrades: 2,
  },
  {
    name: "more trades allowed than realistically useful",
    prices: {
      A: [10, 20],
      B: [5, 6],
    },
    maxTrades: 5,
  },
  {
    name: "flat/no-opportunity ticker mixed with a real one",
    prices: {
      A: [10, 10, 10, 10],
      B: [3, 9, 4, 12],
    },
    maxTrades: 2,
  },
];

describe("optimizeTrades: brute-force cross-check", () => {
  for (const fixture of CROSS_CHECK_FIXTURES) {
    it(`matches brute force: ${fixture.name} (maxTrades=${fixture.maxTrades})`, () => {
      const priceSeriesByTicker = new Map(
        Object.entries(fixture.prices).map(([ticker, prices]) => [ticker, series(prices)]),
      );
      const calendar = buildCalendar(priceSeriesByTicker);
      const expectedMultiplier = bruteForceMultiplier(calendar, fixture.maxTrades);

      const result = optimizeTrades(priceSeriesByTicker, {
        startingCapital: 1,
        maxTrades: fixture.maxTrades,
      });

      expect(result.endingBalance).toBeGreaterThanOrEqual(expectedMultiplier - EPSILON);
      expect(result.endingBalance).toBeCloseTo(expectedMultiplier, 6);
    });
  }
});

describe("optimizeWorstTrades: brute-force cross-check (issue #31)", () => {
  for (const fixture of CROSS_CHECK_FIXTURES) {
    it(`matches brute force in the min direction: ${fixture.name} (maxTrades=${fixture.maxTrades})`, () => {
      const priceSeriesByTicker = new Map(
        Object.entries(fixture.prices).map(([ticker, prices]) => [ticker, series(prices)]),
      );
      const calendar = buildCalendar(priceSeriesByTicker);
      const expectedMultiplier = bruteForceMultiplier(calendar, fixture.maxTrades, "min");

      const result = optimizeWorstTrades(priceSeriesByTicker, {
        startingCapital: 1,
        maxTrades: fixture.maxTrades,
      });

      expect(result.endingBalance).toBeLessThanOrEqual(expectedMultiplier + EPSILON);
      expect(result.endingBalance).toBeCloseTo(expectedMultiplier, 6);
    });
  }
});

describe("optimizeWorstTrades: never beats optimizeTrades (worst <= optimal by construction)", () => {
  // The min-search explores a subset of the same trade-sequence space the
  // max-search does, so optimizeWorstTrades's endingBalance must never
  // exceed optimizeTrades's for the same input -- exactly the invariant
  // results-schema.ts's write-time validation also cross-checks. This is
  // a strong, cheap regression guard against a comparator-flip mistake in
  // computeLevel's direction parameterization.
  for (const fixture of CROSS_CHECK_FIXTURES) {
    it(`worst <= optimal: ${fixture.name} (maxTrades=${fixture.maxTrades})`, () => {
      const priceSeriesByTicker = new Map(
        Object.entries(fixture.prices).map(([ticker, prices]) => [ticker, series(prices)]),
      );

      const best = optimizeTrades(priceSeriesByTicker, {
        startingCapital: 20,
        maxTrades: fixture.maxTrades,
      });
      const worst = optimizeWorstTrades(priceSeriesByTicker, {
        startingCapital: 20,
        maxTrades: fixture.maxTrades,
      });

      expect(worst.endingBalance).toBeLessThanOrEqual(best.endingBalance + EPSILON);
    });
  }
});

// --- Fuzz test against the brute-force oracle -------------------------
//
// A deterministic (seeded, not Math.random -- reproducible in CI, never
// flaky) PRNG generating many small random fixtures, cross-checked
// against the same brute-force oracle above. This complements the fixed
// fixtures by sampling a much wider space of price shapes and gap
// patterns than anyone would think to hand-write.

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomFixture(rand: () => number): {
  prices: Record<string, (number | null)[]>;
  maxTrades: number;
} {
  const numTickers = 1 + Math.floor(rand() * 3); // 1-3
  const numDays = 2 + Math.floor(rand() * 7); // 2-8
  const maxTrades = 1 + Math.floor(rand() * 3); // 1-3

  const prices: Record<string, (number | null)[]> = {};
  for (let t = 0; t < numTickers; t++) {
    const ticker = String.fromCharCode(65 + t); // A, B, C
    const values: (number | null)[] = [];
    for (let d = 0; d < numDays; d++) {
      // ~15% chance of a gap (no data that day for this ticker).
      values.push(rand() < 0.15 ? null : Math.round(rand() * 100 * 100) / 100 + 0.01);
    }
    prices[ticker] = values;
  }
  return { prices, maxTrades };
}

describe("optimizeTrades: fuzz test against brute force", () => {
  const rand = mulberry32(0xc0ffee);
  const FUZZ_ITERATIONS = 300;

  for (let i = 0; i < FUZZ_ITERATIONS; i++) {
    const fixture = randomFixture(rand);

    it(`fuzz case ${i}: ${JSON.stringify(fixture)}`, () => {
      const priceSeriesByTicker = new Map(
        Object.entries(fixture.prices).map(([ticker, prices]) => [ticker, series(prices)]),
      );
      const calendar = buildCalendar(priceSeriesByTicker);
      const expectedMultiplier = bruteForceMultiplier(calendar, fixture.maxTrades);

      const result = optimizeTrades(priceSeriesByTicker, {
        startingCapital: 1,
        maxTrades: fixture.maxTrades,
      });

      expect(result.endingBalance).toBeCloseTo(expectedMultiplier, 6);
    });
  }
});

describe("optimizeWorstTrades: fuzz test against brute force and the worst<=optimal invariant (issue #31)", () => {
  // A separate seed from the max-direction fuzz test above -- not sharing
  // one PRNG instance/seed keeps the two describe blocks' fixture sets
  // independent of each other's iteration order or count.
  const rand = mulberry32(0x5eed31);
  const FUZZ_ITERATIONS = 300;

  for (let i = 0; i < FUZZ_ITERATIONS; i++) {
    const fixture = randomFixture(rand);

    it(`fuzz case ${i}: ${JSON.stringify(fixture)}`, () => {
      const priceSeriesByTicker = new Map(
        Object.entries(fixture.prices).map(([ticker, prices]) => [ticker, series(prices)]),
      );
      const calendar = buildCalendar(priceSeriesByTicker);
      const expectedMultiplier = bruteForceMultiplier(calendar, fixture.maxTrades, "min");

      const worst = optimizeWorstTrades(priceSeriesByTicker, {
        startingCapital: 1,
        maxTrades: fixture.maxTrades,
      });
      const best = optimizeTrades(priceSeriesByTicker, {
        startingCapital: 1,
        maxTrades: fixture.maxTrades,
      });

      expect(worst.endingBalance).toBeCloseTo(expectedMultiplier, 6);
      expect(worst.endingBalance).toBeLessThanOrEqual(best.endingBalance + EPSILON);
    });
  }
});

// --- optimizeAllVariants (issue #13): long+short DP correctness --------
//
// The Option B (reciprocal-price) short model, see optimizer.ts's own
// header comment and docs/plans/issue-13-plan.md section 1.1. These
// tests cross-check the DP's short pass the same way #31's own tests
// cross-checked the min-direction pass: hand-verified fixtures, the two
// structural invariants (results-schema.ts's own write-time checks),
// the plan's own worked tie-break examples, and a brute-force/fuzz
// cross-check extended to include short candidates.

describe("optimizeAllVariants: hand-verified fixtures (issue #13)", () => {
  it("a purely declining ticker is only profitable via a short, captured only by the longShort variant", () => {
    // A: 100 -> 50. No long trade can profit (every ratio < 1), so
    // longOnly.best should take zero trades. A short (open @100, cover
    // @50) has payoff 100/50 = 2x, which longShort.best should find.
    const prices = new Map([["A", series([100, 50])]]);

    const { longOnly, longShort } = optimizeAllVariants(prices, {
      startingCapital: 20,
      maxTrades: 1,
    });

    expect(longOnly.best.trades).toEqual([]);
    expect(longOnly.best.endingBalance).toBe(20);

    expect(longShort.best.trades).toEqual([
      {
        ticker: "A",
        direction: "short",
        openDate: "2024-01-01",
        openPrice: 100,
        closeDate: "2024-01-02",
        closePrice: 50,
      },
    ]);
    expect(multiplier(20, longShort.best.endingBalance)).toBeCloseTo(2, 6);
  });

  it("longShort.best never does worse than longOnly.best (superset invariant) across the shared cross-check fixtures", () => {
    for (const fixture of CROSS_CHECK_FIXTURES) {
      const priceSeriesByTicker = new Map(
        Object.entries(fixture.prices).map(([ticker, prices]) => [ticker, series(prices)]),
      );
      const { longOnly, longShort } = optimizeAllVariants(priceSeriesByTicker, {
        startingCapital: 20,
        maxTrades: fixture.maxTrades,
      });
      expect(longShort.best.endingBalance).toBeGreaterThanOrEqual(
        longOnly.best.endingBalance - EPSILON,
      );
    }
  });

  it("longShort.worst never does better (i.e. never higher) than longOnly.worst (superset invariant) across the shared cross-check fixtures", () => {
    for (const fixture of CROSS_CHECK_FIXTURES) {
      const priceSeriesByTicker = new Map(
        Object.entries(fixture.prices).map(([ticker, prices]) => [ticker, series(prices)]),
      );
      const { longOnly, longShort } = optimizeAllVariants(priceSeriesByTicker, {
        startingCapital: 20,
        maxTrades: fixture.maxTrades,
      });
      expect(longShort.worst.endingBalance).toBeLessThanOrEqual(
        longOnly.worst.endingBalance + EPSILON,
      );
    }
  });

  it("same-ticker long/short exact tie resolves in the long's favor (a corrected version of docs/plans/issue-13-plan.md section 1.4(b)'s worked example -- see the note below)", () => {
    // A: 8 (d0), 10 (d1), 10 (d2), 8 (d3). The long bought d0/sold d1 has
    // ratio 10/8 = 1.25; a short opened d1 (or d2) and covered d3 has the
    // same ratio (10/8 = 1.25 either way) -- an exact tie in floating
    // point, empirically confirmed (not just asserted) to round-trip
    // bit-for-bit equal. No other long or short candidate in this fixture
    // beats 1.25, so this really is the tie the DP has to break.
    //
    // Note: the plan's own worked example for this scenario ($100/$105/
    // $95.2381) turns out not to actually produce the claimed tie once
    // every candidate is checked -- a short opened on day 1 (not day 0)
    // and covered on day 2 (105/95.2381 ~= 1.1025) strictly beats both
    // the intended tied candidates, so the plan's own numbers don't
    // exercise this tie-break rule at all (verified empirically, not
    // just by re-deriving the plan's algebra by hand). This fixture
    // reproduces the same *rule* (long pass completes, including its own
    // value[]/choice[] update, before the short pass for the same ticker
    // even starts, so an exact tie for the same value[d] slot resolves
    // to the long) with numbers that were actually checked against every
    // candidate first.
    const prices = new Map([["A", series([8, 10, 10, 8])]]);

    const { longShort } = optimizeAllVariants(prices, { startingCapital: 20, maxTrades: 1 });

    expect(longShort.best.trades).toEqual([
      {
        ticker: "A",
        direction: "long",
        openDate: "2024-01-01",
        openPrice: 8,
        closeDate: "2024-01-02",
        closePrice: 10,
      },
    ]);
  });

  it("cross-ticker long/short exact tie resolves alphabetically (AAPL's long beats MSFT's short, docs/plans/issue-13-plan.md section 1.4(b))", () => {
    // AAPL: 100 -> 105 (long ratio 1.05). MSFT: 110 -> 104.76190476190476
    // (short ratio 110/104.76190476190476 ties AAPL's long ratio exactly
    // in floating point). AAPL sorts before MSFT, so AAPL's long pass
    // updates the record first; MSFT's short pass then ties but doesn't
    // beat it (strict > required).
    const prices = new Map([
      ["AAPL", series([100, 105])],
      ["MSFT", series([110, 104.76190476190476])],
    ]);

    const { longShort } = optimizeAllVariants(prices, { startingCapital: 20, maxTrades: 1 });

    expect(longShort.best.trades).toEqual([
      {
        ticker: "AAPL",
        direction: "long",
        openDate: "2024-01-01",
        openPrice: 100,
        closeDate: "2024-01-02",
        closePrice: 105,
      },
    ]);
  });

  it("includeShorts: false call paths (optimizeTrades/optimizeWorstTrades) never produce a short trade -- long-only behavior provably unchanged", () => {
    // A ticker that's only profitable via a short (see the first test
    // above) -- optimizeTrades itself (not optimizeAllVariants) must
    // still find nothing, proving includeShorts stays false on this path.
    const prices = new Map([["A", series([100, 50])]]);
    const result = optimizeTrades(prices, { startingCapital: 20, maxTrades: 1 });
    expect(result.trades).toEqual([]);
    expect(result.endingBalance).toBe(20);

    // optimizeWorstTrades over the same fixture is a genuinely different
    // case, not just a second call to the same assertion: the long trade
    // (100 -> 50, a real 0.5x loss) is *worse* than not trading at all
    // (1x), so the worst-case search actually picks it -- unlike
    // optimizeTrades' own "finds nothing" case above. What this proves
    // is narrower and just as important: the trade it picks is a LONG,
    // never the SHORT that would be profitable here (and therefore never
    // the worst outcome) -- confirming includeShorts stays pinned false
    // on this path too, not merely that this fixture happens to produce
    // no trade at all.
    const worst = optimizeWorstTrades(prices, { startingCapital: 20, maxTrades: 1 });
    expect(worst.trades).toHaveLength(1);
    expect(worst.trades[0]?.direction).toBe("long");
    expect(worst.endingBalance).toBe(10);
  });
});

describe("optimizeAllVariants: brute-force cross-check, long+short (issue #13)", () => {
  for (const fixture of CROSS_CHECK_FIXTURES) {
    it(`matches brute force with shorts included: ${fixture.name} (maxTrades=${fixture.maxTrades})`, () => {
      const priceSeriesByTicker = new Map(
        Object.entries(fixture.prices).map(([ticker, prices]) => [ticker, series(prices)]),
      );
      const calendar = buildCalendar(priceSeriesByTicker);
      const expectedBest = bruteForceMultiplier(calendar, fixture.maxTrades, "max", true);
      const expectedWorst = bruteForceMultiplier(calendar, fixture.maxTrades, "min", true);

      const { longShort } = optimizeAllVariants(priceSeriesByTicker, {
        startingCapital: 1,
        maxTrades: fixture.maxTrades,
      });

      expect(longShort.best.endingBalance).toBeCloseTo(expectedBest, 6);
      expect(longShort.worst.endingBalance).toBeCloseTo(expectedWorst, 6);
    });
  }
});

describe("optimizeAllVariants: fuzz test against brute force and the superset invariants (issue #13)", () => {
  // A separate seed from the other fuzz describe blocks above.
  const rand = mulberry32(0x13000d);
  const FUZZ_ITERATIONS = 300;

  for (let i = 0; i < FUZZ_ITERATIONS; i++) {
    const fixture = randomFixture(rand);

    it(`fuzz case ${i}: ${JSON.stringify(fixture)}`, () => {
      const priceSeriesByTicker = new Map(
        Object.entries(fixture.prices).map(([ticker, prices]) => [ticker, series(prices)]),
      );
      const calendar = buildCalendar(priceSeriesByTicker);
      const expectedBest = bruteForceMultiplier(calendar, fixture.maxTrades, "max", true);
      const expectedWorst = bruteForceMultiplier(calendar, fixture.maxTrades, "min", true);

      const { longOnly, longShort } = optimizeAllVariants(priceSeriesByTicker, {
        startingCapital: 1,
        maxTrades: fixture.maxTrades,
      });

      expect(longShort.best.endingBalance).toBeCloseTo(expectedBest, 6);
      expect(longShort.worst.endingBalance).toBeCloseTo(expectedWorst, 6);
      expect(longShort.best.endingBalance).toBeGreaterThanOrEqual(
        longOnly.best.endingBalance - EPSILON,
      );
      expect(longShort.worst.endingBalance).toBeLessThanOrEqual(
        longOnly.worst.endingBalance + EPSILON,
      );
      for (const trade of longShort.best.trades) {
        expect(["long", "short"]).toContain(trade.direction);
      }
    });
  }
});
