// Dedicated tests for The Order's puzzle (issue #207) -- kept separate
// from pipeline.test.ts the same way pipeline.custom-range.test.ts and
// pipeline.write-validation.test.ts already are: this needs its own
// focused Magnificent Seven fixture set, distinct from the rest of that
// file's window/intraday-path fixtures.

import type { DailyClose, IntradayBar } from "@hadiknowntrades/core";
import { MAG_SEVEN_TICKERS, THE_ORDER_KEY } from "@hadiknowntrades/core";
import { describe, expect, it } from "vitest";

import { runPipeline, type ResultStore } from "./pipeline.js";

const ASOF = new Date("2026-08-27T06:00:00Z");

function daily(date: string, close: number): DailyClose {
  return { date, close };
}

function memoryStore(): ResultStore & { objects: Map<string, string> } {
  const objects = new Map<string, string>();
  return {
    objects,
    async putObject(key, body) {
      objects.set(key, body);
    },
  };
}

const noIntradayData = async (): Promise<IntradayBar[]> => [];

/** The window (5Y/MAX) and intraday (1W/1M/3M/1Y) paths are both required -- runPipeline throws if either produces zero usable data. A minimal single-ticker fixture for each, independent of the Magnificent Seven fixture below. */
function requiredPathFixtures(): {
  daily: Map<string, DailyClose[]>;
  intraday: Map<string, IntradayBar[]>;
} {
  return {
    daily: new Map([["ZZZ", [daily("2026-08-20", 10), daily("2026-08-26", 12)]]]),
    intraday: new Map([
      [
        "ZZZ",
        [
          { date: "2026-08-26T09:30:00", close: 10 },
          { date: "2026-08-26T10:30:00", close: 11 },
        ],
      ],
    ]),
  };
}

/**
 * A real, well-differentiated Magnificent Seven day: close-to-close
 * returns spanning a wide enough spread/gap to clear the guardrails
 * (packages/core's order-selection.ts) via the primary "exclude 2
 * smallest abs return" rule, no widening needed.
 *
 * Prior-day closes are all 100; "today"'s closes below give the 7 real
 * returns: TSLA -3.1%, AAPL -0.42%, MSFT 0.55%, META 1.85%, NVDA 3.2%
 * (kept) and GOOGL 0.05%, AMZN -0.1% (smallest abs -- excluded).
 */
function magSevenFixture(): Map<string, DailyClose[]> {
  const prior = "2026-08-25";
  const today = "2026-08-26";
  return new Map([
    ["TSLA", [daily(prior, 100), daily(today, 96.9)]],
    ["AAPL", [daily(prior, 100), daily(today, 99.58)]],
    ["MSFT", [daily(prior, 100), daily(today, 100.55)]],
    ["META", [daily(prior, 100), daily(today, 101.85)]],
    ["NVDA", [daily(prior, 100), daily(today, 103.2)]],
    ["GOOGL", [daily(prior, 100), daily(today, 100.05)]],
    ["AMZN", [daily(prior, 100), daily(today, 99.9)]],
  ]);
}

function combinedFetch(
  ...maps: Map<string, DailyClose[]>[]
): (symbol: string) => Promise<DailyClose[]> {
  return async (symbol) => {
    for (const map of maps) {
      const closes = map.get(symbol);
      if (closes) return closes;
    }
    return [];
  };
}

describe("runPipeline: The Order's daily puzzle (issue #207)", () => {
  it("computes and writes a real puzzle from real Magnificent Seven closes", async () => {
    const required = requiredPathFixtures();
    const store = memoryStore();

    await runPipeline({
      tickers: ["ZZZ"],
      fetchDailyCloses: combinedFetch(required.daily, magSevenFixture()),
      fetchIntradayBars: async (symbol) => required.intraday.get(symbol) ?? [],
      fetchFiveMinuteBars: noIntradayData,
      fetchIntraday1mBars: noIntradayData,
      store,
      asOf: ASOF,
    });

    const raw = store.objects.get(THE_ORDER_KEY);
    expect(raw).toBeDefined();
    const puzzle = JSON.parse(raw!);
    expect(puzzle.date).toBe("2026-08-26");
    expect(puzzle.tickers).toHaveLength(5);
    // GOOGL and AMZN have the smallest absolute returns -- excluded.
    const tickers = puzzle.tickers.map((t: { ticker: string }) => t.ticker);
    expect(tickers).not.toContain("GOOGL");
    expect(tickers).not.toContain("AMZN");
    expect(tickers).toEqual(["TSLA", "AAPL", "MSFT", "META", "NVDA"]);
    // Strictly ascending by pctReturn (worst-to-best), and every company
    // name is real (not just the bare ticker echoed back).
    let previous = -Infinity;
    for (const t of puzzle.tickers) {
      expect(t.pctReturn).toBeGreaterThan(previous);
      previous = t.pctReturn;
      expect(t.companyName).not.toBe(t.ticker);
    }
  });

  it("degrades gracefully (no write, no run failure) when a Magnificent Seven ticker's fetch fails", async () => {
    const required = requiredPathFixtures();
    const magSeven = magSevenFixture();
    const store = memoryStore();

    // NVDA (a real fetch failure) still leaves 6 candidates -- well above
    // the 5 computeOrderSelection needs, so a puzzle still gets written.
    await runPipeline({
      tickers: ["ZZZ"],
      fetchDailyCloses: async (symbol) => {
        if (symbol === "NVDA") throw new Error("simulated Yahoo failure");
        return combinedFetch(required.daily, magSeven)(symbol);
      },
      fetchIntradayBars: async (symbol) => required.intraday.get(symbol) ?? [],
      fetchFiveMinuteBars: noIntradayData,
      fetchIntraday1mBars: noIntradayData,
      store,
      asOf: ASOF,
    });

    const raw = store.objects.get(THE_ORDER_KEY);
    expect(raw).toBeDefined();
    const puzzle = JSON.parse(raw!);
    expect(puzzle.tickers.map((t: { ticker: string }) => t.ticker)).not.toContain("NVDA");
  });

  it("writes nothing (and does not fail the run) when fewer than 5 Magnificent Seven tickers have usable data", async () => {
    const required = requiredPathFixtures();
    const store = memoryStore();

    // Only 4 of the 7 fetch successfully -- computeOrderSelection needs
    // at least 5 candidates.
    const sparse = new Map([...magSevenFixture()].slice(0, 4));

    const summary = await runPipeline({
      tickers: ["ZZZ"],
      fetchDailyCloses: combinedFetch(required.daily, sparse),
      fetchIntradayBars: async (symbol) => required.intraday.get(symbol) ?? [],
      fetchFiveMinuteBars: noIntradayData,
      fetchIntraday1mBars: noIntradayData,
      store,
      asOf: ASOF,
    });

    // The run itself still succeeds -- The Order's own fetch/compute is
    // non-fatal (see buildTheOrderPuzzle's own doc comment).
    expect(summary).toBeDefined();
    expect(store.objects.has(THE_ORDER_KEY)).toBe(false);
  });

  it("holds the previous day's puzzle by simply not overwriting it (no explicit 'hold' logic)", async () => {
    const required = requiredPathFixtures();
    const store = memoryStore();
    // Seed the store with a previous run's puzzle, as if a prior nightly
    // run had already published one.
    store.objects.set(THE_ORDER_KEY, JSON.stringify({ date: "2026-08-25", tickers: [] }));

    const sparse = new Map([...magSevenFixture()].slice(0, 3)); // too few candidates
    await runPipeline({
      tickers: ["ZZZ"],
      fetchDailyCloses: combinedFetch(required.daily, sparse),
      fetchIntradayBars: async (symbol) => required.intraday.get(symbol) ?? [],
      fetchFiveMinuteBars: noIntradayData,
      fetchIntraday1mBars: noIntradayData,
      store,
      asOf: ASOF,
    });

    const raw = store.objects.get(THE_ORDER_KEY);
    expect(raw).toBeDefined();
    expect(JSON.parse(raw!).date).toBe("2026-08-25"); // untouched
  });

  it("fetches all seven Magnificent Seven tickers regardless of options.tickers", async () => {
    const required = requiredPathFixtures();
    const requested: string[] = [];
    const store = memoryStore();

    await runPipeline({
      tickers: ["ZZZ"], // deliberately does NOT include any Magnificent Seven ticker
      fetchDailyCloses: async (symbol) => {
        requested.push(symbol);
        return combinedFetch(required.daily, magSevenFixture())(symbol);
      },
      fetchIntradayBars: async (symbol) => required.intraday.get(symbol) ?? [],
      fetchFiveMinuteBars: noIntradayData,
      fetchIntraday1mBars: noIntradayData,
      store,
      asOf: ASOF,
    });

    for (const ticker of MAG_SEVEN_TICKERS) {
      expect(requested).toContain(ticker);
    }
  });
});
