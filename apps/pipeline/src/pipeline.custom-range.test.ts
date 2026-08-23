// Dedicated tests for issue #11's coarsened custom-date-range anchors
// (day-granularity real trading-day anchors since issue #75) -- kept
// separate from pipeline.test.ts (which covers the 6 preset ranges and
// doesn't pass computeCustomAnchors at all, per RunPipelineOptions's own
// doc comment) the same way pipeline.write-validation.test.ts is its own
// file: this needs a distinct, focused fixture set rather than bolting
// anchor assertions onto every existing preset-range test.
//
// **Issue #75 rewrote every fixture in this file, not just renamed
// fields**: the old month scheme let a test pass an arbitrary
// customRangeAnchors: AnchorMonth[] list independent of the fixture's own
// price history. Day-granularity anchors are now *derived* from the
// fixture's own fetched daily-close history (via
// customRangeAnchors(buildCalendar(windowFetch.history).dates, asOf)
// inside runPipeline itself, opted into by computeCustomAnchors: true),
// so a fixture's price-history dates and its expected anchor list can no
// longer be specified independently -- every anchor below is a real date
// present in that test's own dailyFixture.

import type { DailyClose, IntradayBar } from "@hadiknowntrades/core";
import { describe, expect, it } from "vitest";

import { runPipeline, type ResultStore } from "./pipeline.js";

// CUSTOM_RANGE_ANCHOR_YEARS_BACK is 5 (packages/core/src/custom-range-
// anchors.ts) -- ASOF minus 5 years is the real cutoff every fixture
// below is built against.
const ASOF = new Date("2024-06-15T00:00:00Z");
const CUTOFF = "2019-06-15";

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

/**
 * The intraday (1M/3M/1Y) path is a *required* path -- runPipeline
 * throws if it produces no usable data, independent of anything about
 * custom-range anchors (see pipeline.ts's "at least one path failed"
 * check). Every test below that expects a successful run needs this
 * path to have real data too, not just the daily-close fixture the
 * custom-anchor feature itself actually reuses.
 */
function validIntradayFixture(): Map<string, IntradayBar[]> {
  return new Map([
    [
      "AAPL",
      [
        { date: "2024-06-10T09:30:00", close: 10 },
        { date: "2024-06-10T10:30:00", close: 20 },
      ],
    ],
  ]);
}

describe("runPipeline custom-range anchors (issue #11, day-granularity since issue #75)", () => {
  it("computes and writes a CustomWindowResult for every real trading day within the lookback window, plus a manifest", async () => {
    const dailyFixture = new Map<string, DailyClose[]>([
      [
        "AAPL",
        [
          daily("2018-01-02", 5), // before CUTOFF -- never becomes an anchor
          daily("2019-06-14", 8), // one day before CUTOFF -- also excluded
          daily("2019-07-01", 10), // a real trading-day anchor, inside the window
          daily("2019-08-01", 12),
          daily("2024-06-14", 50), // the most recent trading day
        ],
      ],
    ]);
    const intradayFixture = validIntradayFixture();
    const store = memoryStore();

    const summary = await runPipeline({
      tickers: ["AAPL"],
      fetchDailyCloses: async (symbol) => dailyFixture.get(symbol) ?? [],
      fetchIntradayBars: async (symbol) => intradayFixture.get(symbol) ?? [],
      fetchFiveMinuteBars: noIntradayData,
      fetchIntraday1mBars: noIntradayData,
      store,
      asOf: ASOF,
      computeCustomAnchors: true,
    });

    // Exactly the 3 dates within [CUTOFF, ASOF] -- "2018-01-02" and
    // "2019-06-14" are both excluded.
    expect(summary.customResults).toHaveLength(3);
    expect(store.objects.has("results/custom/2019-07-01.json")).toBe(true);
    expect(store.objects.has("results/custom/2019-08-01.json")).toBe(true);
    expect(store.objects.has("results/custom/2024-06-14.json")).toBe(true);
    expect(store.objects.has("results/custom/2018-01-02.json")).toBe(false);
    expect(store.objects.has("results/custom/2019-06-14.json")).toBe(false);

    const jul2019 = JSON.parse(store.objects.get("results/custom/2019-07-01.json")!);
    expect(jul2019).toMatchObject({
      model: "custom-window",
      anchorDate: "2019-07-01",
      // startDate is exactly the anchor itself -- every anchor is
      // already a real trading day (issue #75), so there's no forward
      // snapping like the old month scheme needed.
      startDate: "2019-07-01",
      endDate: "2024-06-15",
      startingCapital: 20,
      maxTrades: 3,
    });
    expect(Array.isArray(jul2019.trades)).toBe(true);
    expect(jul2019.trades[0].openDate).toBe("2019-07-01");

    // The newest anchor's own window has only one price point (itself),
    // so no trade is possible -- a real, expected edge case, not a bug.
    const jun2024 = JSON.parse(store.objects.get("results/custom/2024-06-14.json")!);
    expect(jun2024.trades).toEqual([]);
    expect(jun2024.endingBalance).toBe(20);

    // The preset ranges (6) are unaffected/still written normally
    // alongside the 3 custom anchors, plus the new manifest object.
    expect(summary.results).toHaveLength(6);
    expect(store.objects.size).toBe(6 + 3 + 1);

    // The manifest publishes exactly the 3 written anchors, ascending.
    const manifest = JSON.parse(store.objects.get("results/custom/index.json")!);
    expect(manifest.anchors).toEqual(["2019-07-01", "2019-08-01", "2024-06-14"]);
  });

  // Regression test for the issue #11/#13 integration: buildCustomWindowResults
  // used to call the long-only-only optimizeBothDirections (issue #31's
  // best/worst sharing), predating issue #13's short-selling mode --
  // merging the two features means it now calls the same
  // optimizeAllVariants-backed computeWindowOptimization buildWindowResults
  // does, so every CustomWindowResult carries a real longShort field with
  // its own genuine short trades, not just the long-only fields.
  it("computes a real longShort field with a genuine short trade for a custom anchor (issue #11/#13 integration)", async () => {
    const dailyFixture = new Map<string, DailyClose[]>([
      // A pure price decline across the whole anchor window: no long
      // trade here can ever be profitable (only two bars, price only
      // falls), so the long-only search correctly makes zero trades
      // (endingBalance stays at startingCapital) -- but shorting the
      // same decline (open 100, close 10 -> payoff 100/10 = 10x) is
      // exactly what the long+short search should find instead.
      ["AAPL", [daily("2019-07-01", 100), daily("2024-06-14", 10)]],
    ]);
    const intradayFixture = validIntradayFixture();
    const store = memoryStore();

    const summary = await runPipeline({
      tickers: ["AAPL"],
      fetchDailyCloses: async (symbol) => dailyFixture.get(symbol) ?? [],
      fetchIntradayBars: async (symbol) => intradayFixture.get(symbol) ?? [],
      fetchFiveMinuteBars: noIntradayData,
      fetchIntraday1mBars: noIntradayData,
      store,
      asOf: ASOF,
      computeCustomAnchors: true,
    });

    const custom = summary.customResults.find((r) => r.anchorDate === "2019-07-01");
    expect(custom).toBeDefined();
    // Long-only: no trade beats holding cash on a pure decline.
    expect(custom!.trades).toEqual([]);
    expect(custom!.endingBalance).toBe(20);
    // Long+short: a real short trade, and it beats the long-only result.
    expect(custom!.longShort.trades).toHaveLength(1);
    expect(custom!.longShort.trades[0]!.direction).toBe("short");
    expect(custom!.longShort.trades[0]!.ticker).toBe("AAPL");
    expect(custom!.longShort.endingBalance).toBe(200); // 20 * (100/10)
    expect(custom!.longShort.endingBalance).toBeGreaterThan(custom!.endingBalance);

    // Round-trips through the actual written+parsed JSON too, confirming
    // this passed validateCustomWindowResult's own longShort cross-checks
    // (see results-schema.ts) at write time, not just an in-memory shape.
    const stored = JSON.parse(store.objects.get("results/custom/2019-07-01.json")!);
    expect(stored.longShort.endingBalance).toBe(200);
    expect(stored.longShort.trades[0].direction).toBe("short");
  });

  it("defaults to zero custom anchors, and writes no manifest, when computeCustomAnchors is omitted", async () => {
    const dailyFixture = new Map<string, DailyClose[]>([
      ["AAPL", [daily("2019-07-01", 10), daily("2024-06-14", 50)]],
    ]);
    const intradayFixture = validIntradayFixture();
    const store = memoryStore();

    const summary = await runPipeline({
      tickers: ["AAPL"],
      fetchDailyCloses: async (symbol) => dailyFixture.get(symbol) ?? [],
      fetchIntradayBars: async (symbol) => intradayFixture.get(symbol) ?? [],
      fetchFiveMinuteBars: noIntradayData,
      fetchIntraday1mBars: noIntradayData,
      store,
      asOf: ASOF,
    });

    expect(summary.customResults).toEqual([]);
    expect(store.objects.size).toBe(6);
    expect([...store.objects.keys()].some((key) => key.startsWith("results/custom/"))).toBe(false);
  });

  it("produces no custom results or manifest when the window path itself has no usable data", async () => {
    const intradayFixture = validIntradayFixture();
    const store = memoryStore();
    const noDailyData = async (): Promise<DailyClose[]> => [];

    await expect(
      runPipeline({
        tickers: ["AAPL"],
        fetchDailyCloses: noDailyData,
        fetchIntradayBars: async (symbol) => intradayFixture.get(symbol) ?? [],
        fetchFiveMinuteBars: noIntradayData,
        fetchIntraday1mBars: noIntradayData,
        store,
        asOf: ASOF,
        computeCustomAnchors: true,
      }),
    ).rejects.toThrow();

    expect([...store.objects.keys()].some((key) => key.startsWith("results/custom/"))).toBe(false);
  });

  it("computes each anchor's own benchmark from its own start date, not a preset range's", async () => {
    const dailyFixture = new Map<string, DailyClose[]>([
      ["AAPL", [daily("2019-07-01", 10), daily("2024-06-14", 50)]],
      ["SPY", [daily("2015-01-02", 200), daily("2019-07-01", 250), daily("2024-06-14", 500)]],
    ]);
    const intradayFixture = validIntradayFixture();
    const store = memoryStore();

    const summary = await runPipeline({
      tickers: ["AAPL"],
      fetchDailyCloses: async (symbol) => dailyFixture.get(symbol) ?? [],
      fetchIntradayBars: async (symbol) => intradayFixture.get(symbol) ?? [],
      fetchFiveMinuteBars: noIntradayData,
      fetchIntraday1mBars: noIntradayData,
      store,
      asOf: ASOF,
      computeCustomAnchors: true,
    });

    const custom = summary.customResults.find((r) => r.anchorDate === "2019-07-01");
    expect(custom!.benchmark).not.toBeNull();
    expect(custom!.benchmark!.startDate).toBe("2019-07-01");
    expect(custom!.benchmark!.truncated).toBe(false);
  });

  it("is idempotent: running twice for the same day produces byte-identical custom-anchor content", async () => {
    const dailyFixture = new Map<string, DailyClose[]>([
      ["AAPL", [daily("2019-07-01", 10), daily("2024-06-14", 50)]],
    ]);
    const intradayFixture = validIntradayFixture();
    const store = memoryStore();
    const options = {
      tickers: ["AAPL"],
      fetchDailyCloses: async (symbol: string) => dailyFixture.get(symbol) ?? [],
      fetchIntradayBars: async (symbol: string) => intradayFixture.get(symbol) ?? [],
      fetchFiveMinuteBars: noIntradayData,
      fetchIntraday1mBars: noIntradayData,
      store,
      asOf: ASOF,
      computeCustomAnchors: true,
    };

    await runPipeline(options);
    const first = store.objects.get("results/custom/2019-07-01.json")!;
    const firstManifest = store.objects.get("results/custom/index.json")!;
    await runPipeline(options);
    const second = store.objects.get("results/custom/2019-07-01.json")!;
    const secondManifest = store.objects.get("results/custom/index.json")!;

    const stripGeneratedAt = (raw: string) =>
      JSON.parse(raw, (key, value) => (key === "generatedAt" ? undefined : value));
    expect(stripGeneratedAt(first)).toEqual(stripGeneratedAt(second));
    expect(firstManifest).toBe(secondManifest);
  });

  it("a custom-anchor write failure aggregates into the same thrown error as a preset failure, without blocking sibling writes", async () => {
    const dailyFixture = new Map<string, DailyClose[]>([
      ["AAPL", [daily("2019-07-01", 10), daily("2024-06-14", 50)]],
    ]);
    const intradayFixture = validIntradayFixture();
    const objects = new Map<string, string>();
    const store: ResultStore = {
      async putObject(key, body) {
        if (key === "results/custom/2019-07-01.json") {
          throw new Error("simulated S3 failure for this one key");
        }
        objects.set(key, body);
      },
    };

    const error = await runPipeline({
      tickers: ["AAPL"],
      fetchDailyCloses: async (symbol) => dailyFixture.get(symbol) ?? [],
      fetchIntradayBars: async (symbol) => intradayFixture.get(symbol) ?? [],
      fetchFiveMinuteBars: noIntradayData,
      fetchIntraday1mBars: noIntradayData,
      store,
      asOf: ASOF,
      computeCustomAnchors: true,
    }).then(
      () => {
        throw new Error("expected runPipeline to reject");
      },
      (rejection: unknown) => rejection as Error,
    );

    expect(error.message).toMatch(/custom:2019-07-01: simulated S3 failure/);
    // The 6 preset ranges, the other custom anchor, and the manifest all
    // still landed despite the one custom-anchor write failure -- "write
    // whatever succeeded" is preserved across every family, not just
    // within the preset-range set.
    expect(objects.size).toBe(6 + 1 + 1);
    expect(objects.has("results/custom/2019-07-01.json")).toBe(false);
    expect(objects.has("results/custom/2024-06-14.json")).toBe(true);
    expect(objects.has("results/custom/index.json")).toBe(true);
  });
});
