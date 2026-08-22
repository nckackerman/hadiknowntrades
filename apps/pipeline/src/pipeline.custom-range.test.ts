// Dedicated tests for issue #11's coarsened custom-date-range anchors --
// kept separate from pipeline.test.ts (which covers the 5 preset ranges
// and doesn't pass customRangeAnchors at all, per RunPipelineOptions's
// own doc comment) the same way pipeline.write-validation.test.ts is its
// own file: this needs a distinct, focused fixture set rather than
// bolting anchor assertions onto every existing preset-range test.

import type { DailyClose, IntradayBar } from "@hadiknowntrades/core";
import { describe, expect, it } from "vitest";

import { runPipeline, type ResultStore } from "./pipeline.js";

const ASOF = new Date("2024-06-15T00:00:00Z");

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

describe("runPipeline custom-range anchors (issue #11)", () => {
  it("computes and writes a CustomWindowResult for each requested anchor, reusing the window path's own fetched history", async () => {
    const dailyFixture = new Map<string, DailyClose[]>([
      [
        "AAPL",
        [
          daily("2018-01-02", 5),
          daily("2019-01-02", 10),
          daily("2019-05-01", 20),
          daily("2024-06-14", 50),
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
      customRangeAnchors: ["2019-01", "2017-01"],
    });

    expect(summary.customResults).toHaveLength(2);
    expect(store.objects.has("results/custom/2019-01.json")).toBe(true);
    expect(store.objects.has("results/custom/2017-01.json")).toBe(true);

    const jan2019 = JSON.parse(store.objects.get("results/custom/2019-01.json")!);
    expect(jan2019).toMatchObject({
      model: "custom-window",
      anchorMonth: "2019-01",
      // startDate is the anchor's own literal calendar boundary
      // ("2019-01-01"), not forward-snapped to the nearest real trading
      // day -- same convention every preset range's own WindowResult
      // .startDate already follows (see buildWindowResults). The actual
      // trade data below is what naturally reflects the forward-snap,
      // via the same >= slicing filter every preset range's window also
      // goes through.
      startDate: "2019-01-01",
      endDate: "2024-06-15",
      startingCapital: 20,
      maxTrades: 3,
    });
    expect(Array.isArray(jan2019.trades)).toBe(true);
    // The earliest bar actually >= the anchor's boundary is 2019-01-02
    // (2019-01-01 itself has no bar in the fixture) -- confirms the
    // slicing filter's forward-snap behavior end to end, not just as a
    // documented claim.
    expect(jan2019.trades[0].buyDate).toBe("2019-01-02");

    // 2017-01 predates AAPL's fixture history entirely -- the slicing
    // filter naturally includes every bar from the earliest one present
    // onward, same "MAX-style, use whatever's earliest" behavior
    // presetRangeStartDate("MAX", ...) already gets for an unbounded
    // window (see buildWindowResults' own startDateString handling).
    const jan2017 = JSON.parse(store.objects.get("results/custom/2017-01.json")!);
    expect(jan2017.startDate).toBe("2017-01-01");
    expect(jan2017.trades[0].buyDate).toBe("2018-01-02");

    // The preset ranges (5) are unaffected/still written normally
    // alongside the 2 custom anchors.
    expect(summary.results).toHaveLength(5);
    expect(store.objects.size).toBe(7);
  });

  it("defaults to zero custom anchors when customRangeAnchors is omitted", async () => {
    const dailyFixture = new Map<string, DailyClose[]>([
      ["AAPL", [daily("2019-01-02", 10), daily("2024-06-14", 50)]],
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
    expect(store.objects.size).toBe(5);
    expect([...store.objects.keys()].some((key) => key.startsWith("results/custom/"))).toBe(false);
  });

  it("produces no custom results when the window path itself has no usable data", async () => {
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
        customRangeAnchors: ["2019-01"],
      }),
    ).rejects.toThrow();

    expect([...store.objects.keys()].some((key) => key.startsWith("results/custom/"))).toBe(false);
  });

  it("skips a malformed anchor string rather than crashing the whole run", async () => {
    const dailyFixture = new Map<string, DailyClose[]>([
      ["AAPL", [daily("2019-01-02", 10), daily("2024-06-14", 50)]],
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
      customRangeAnchors: ["not-a-month", "2019-01"],
    });

    expect(summary.customResults).toHaveLength(1);
    expect(summary.customResults[0]!.anchorMonth).toBe("2019-01");
    expect(store.objects.has("results/custom/not-a-month.json")).toBe(false);
  });

  it("skips an anchor whose start date is later than the requested end date", async () => {
    const dailyFixture = new Map<string, DailyClose[]>([
      ["AAPL", [daily("2019-01-02", 10), daily("2024-06-14", 50)]],
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
      customRangeAnchors: ["2024-07"], // after ASOF (2024-06-15)
    });

    expect(summary.customResults).toEqual([]);
    expect(store.objects.has("results/custom/2024-07.json")).toBe(false);
  });

  it("computes each anchor's own benchmark from its own start date, not a preset range's", async () => {
    const dailyFixture = new Map<string, DailyClose[]>([
      ["AAPL", [daily("2019-01-02", 10), daily("2024-06-14", 50)]],
      ["SPY", [daily("2015-01-02", 200), daily("2019-01-02", 250), daily("2024-06-14", 500)]],
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
      customRangeAnchors: ["2019-01"],
    });

    const [custom] = summary.customResults;
    expect(custom!.benchmark).not.toBeNull();
    expect(custom!.benchmark!.startDate).toBe("2019-01-02");
    expect(custom!.benchmark!.truncated).toBe(false);
  });

  it("is idempotent: running twice for the same day produces byte-identical custom-anchor content", async () => {
    const dailyFixture = new Map<string, DailyClose[]>([
      ["AAPL", [daily("2019-01-02", 10), daily("2024-06-14", 50)]],
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
      customRangeAnchors: ["2019-01"],
    };

    await runPipeline(options);
    const first = store.objects.get("results/custom/2019-01.json")!;
    await runPipeline(options);
    const second = store.objects.get("results/custom/2019-01.json")!;

    const stripGeneratedAt = (raw: string) =>
      JSON.parse(raw, (key, value) => (key === "generatedAt" ? undefined : value));
    expect(stripGeneratedAt(first)).toEqual(stripGeneratedAt(second));
  });

  it("a custom-anchor write failure aggregates into the same thrown error as a preset failure, without blocking sibling writes", async () => {
    const dailyFixture = new Map<string, DailyClose[]>([
      ["AAPL", [daily("2019-01-02", 10), daily("2024-06-14", 50)]],
    ]);
    const intradayFixture = validIntradayFixture();
    const objects = new Map<string, string>();
    const store: ResultStore = {
      async putObject(key, body) {
        if (key === "results/custom/2019-01.json") {
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
      customRangeAnchors: ["2019-01"],
    }).then(
      () => {
        throw new Error("expected runPipeline to reject");
      },
      (rejection: unknown) => rejection as Error,
    );

    expect(error.message).toMatch(/custom:2019-01: simulated S3 failure/);
    // The 5 preset ranges still landed despite the one custom-anchor
    // write failure -- "write whatever succeeded" is preserved across
    // both families, not just within the preset-range set.
    expect(objects.size).toBe(5);
    expect(objects.has("results/custom/2019-01.json")).toBe(false);
  });
});
