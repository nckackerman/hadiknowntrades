import { afterEach, describe, expect, it, vi } from "vitest";

import { buildCalendar, optimizeTrades, type Calendar } from "./optimizer.js";
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
      { ticker: "A", buyDate: "2024-01-01", buyPrice: 10, sellDate: "2024-01-04", sellPrice: 30 },
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
      { ticker: "A", buyDate: "2024-01-01", buyPrice: 10, sellDate: "2024-01-02", sellPrice: 30 },
      { ticker: "A", buyDate: "2024-01-03", buyPrice: 5, sellDate: "2024-01-04", sellPrice: 40 },
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
      { ticker: "B", buyDate: "2024-01-01", buyPrice: 5, sellDate: "2024-01-02", sellPrice: 25 },
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
      { ticker: "A", buyDate: "2024-01-01", buyPrice: 10, sellDate: "2024-01-02", sellPrice: 20 },
      { ticker: "B", buyDate: "2024-01-03", buyPrice: 5, sellDate: "2024-01-04", sellPrice: 25 },
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
      { ticker: "A", buyDate: "2024-01-01", buyPrice: 10, sellDate: "2024-01-02", sellPrice: 30 },
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
    "rejects an invalid maxTrades (%s) with a clear error instead of crashing or hanging",
    (maxTrades) => {
      const prices = new Map([["A", series([10, 20])]]);

      expect(() => optimizeTrades(prices, { startingCapital: 20, maxTrades })).toThrow(/maxTrades/);
    },
  );

  it.each([NaN, Infinity, -Infinity])(
    "rejects a non-finite startingCapital (%s) instead of silently propagating garbage",
    (startingCapital) => {
      const prices = new Map([["A", series([10, 20])]]);

      expect(() => optimizeTrades(prices, { startingCapital, maxTrades: 1 })).toThrow(
        /startingCapital/,
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

// --- Brute-force cross-check -----------------------------------------
//
// An exhaustive (exponential) reference implementation of the same
// "at most maxTrades sequential, all-in, long-only trades across many
// tickers" problem, used only in tests against small fixtures to
// validate the DP's efficient implementation actually computes the same
// answer as trying every possibility.

function bruteForceMultiplier(calendar: Calendar, maxTrades: number): number {
  const T = calendar.dates.length;
  const tickers = [...calendar.pricesByTicker.entries()];

  function best(tradesLeft: number, minDay: number): number {
    if (tradesLeft === 0 || minDay >= T) return 1;
    let bestVal = best(tradesLeft - 1, minDay); // take no trade at this level
    for (const [, prices] of tickers) {
      for (let buy = minDay; buy < T; buy++) {
        const buyPrice = prices[buy];
        if (buyPrice === null || buyPrice === undefined) continue;
        for (let sell = buy + 1; sell < T; sell++) {
          const sellPrice = prices[sell];
          if (sellPrice === null || sellPrice === undefined) continue;
          const val = (sellPrice / buyPrice) * best(tradesLeft - 1, sell + 1);
          if (val > bestVal) bestVal = val;
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
