import {
  BlockedError,
  PRESET_RANGES,
  TickerNotFoundError,
  toDateString,
  TransientFetchError,
  UnexpectedResponseError,
  type DailyClose,
  type IntradayBar,
} from "@hadiknowntrades/core";
import { describe, expect, it } from "vitest";

import { runPipeline, type ResultStore } from "./pipeline.js";

const ASOF = new Date("2024-06-15T00:00:00Z");

function daily(dateFromAsOf: (asOf: Date) => Date, close: number): DailyClose {
  return { date: toDateString(dateFromAsOf(ASOF)), close };
}

/** Builds one intraday bar at a given time-of-day on a date relative to ASOF. */
function bar(dateFromAsOf: (asOf: Date) => Date, time: string, close: number): IntradayBar {
  return { date: `${toDateString(dateFromAsOf(ASOF))}T${time}`, close };
}

/** In-memory ResultStore, so tests can inspect exactly what was written. */
function memoryStore(): ResultStore & { objects: Map<string, string> } {
  const objects = new Map<string, string>();
  return {
    objects,
    async putObject(key, body) {
      objects.set(key, body);
    },
  };
}

function daysBack(days: number) {
  return (asOf: Date) => {
    const d = new Date(asOf);
    d.setUTCDate(d.getUTCDate() - days);
    return d;
  };
}

/** A fetcher that returns no data for every ticker -- used where a test only cares about the *other* path, and wants this path to independently produce nothing rather than error. */
const noDailyData = async (): Promise<DailyClose[]> => [];
const noIntradayData = async (): Promise<IntradayBar[]> => [];

/** Awaits a promise expected to reject, returning the rejection reason (typed as Error, for asserting on `.message`). Throws if the promise unexpectedly resolves. */
async function rejectionOf(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected the promise to reject, but it resolved");
}

describe("runPipeline", () => {
  const asOf = ASOF;

  it("writes results for every range whose path has usable data, with the correct per-model schema", async () => {
    const dailyFixture = new Map<string, DailyClose[]>([
      ["AAPL", [daily(daysBack(2000), 1), daily(daysBack(200), 8), daily(daysBack(10), 50)]],
    ]);
    // Two trading days within the last month, each with a clear buy/sell.
    const intradayFixture = new Map<string, IntradayBar[]>([
      [
        "AAPL",
        [
          bar(daysBack(5), "09:30:00", 10),
          bar(daysBack(5), "10:30:00", 20),
          bar(daysBack(2), "09:30:00", 15),
          bar(daysBack(2), "10:30:00", 30),
        ],
      ],
    ]);
    const store = memoryStore();

    const summary = await runPipeline({
      tickers: ["AAPL"],
      fetchDailyCloses: async (symbol) => dailyFixture.get(symbol) ?? [],
      fetchIntradayBars: async (symbol) => intradayFixture.get(symbol) ?? [],
      fetchFiveMinuteBars: noIntradayData,
      fetchIntraday1mBars: noIntradayData,
      store,
      asOf,
    });

    expect(store.objects.size).toBe(5);
    expect(summary.results).toHaveLength(5);

    const generatedAts = new Set<string>();
    for (const range of ["5Y", "MAX"]) {
      const parsed = JSON.parse(store.objects.get(`results/${range}.json`)!);
      generatedAts.add(parsed.generatedAt);
      expect(parsed).toMatchObject({
        schemaVersion: 4,
        model: "window",
        range,
        maxTrades: 3,
        startingCapital: 20,
        endDate: "2024-06-15",
      });
      expect(Array.isArray(parsed.trades)).toBe(true);
    }

    for (const range of ["1M", "3M", "1Y"]) {
      const parsed = JSON.parse(store.objects.get(`results/${range}.json`)!);
      generatedAts.add(parsed.generatedAt);
      expect(parsed).toMatchObject({
        schemaVersion: 4,
        model: "intraday-daily",
        range,
        maxTradesPerDay: 3,
        startingCapital: 20,
        endDate: "2024-06-15",
      });
      expect(Array.isArray(parsed.days)).toBe(true);
      expect(parsed.days.length).toBeGreaterThan(0);
      for (const day of parsed.days) {
        expect(typeof day.date).toBe("string");
        expect(day.startingCapital).toBe(20);
        expect(Array.isArray(day.trades)).toBe(true);
      }
    }

    // A single generatedAt shared across every successfully-written
    // result -- window and intraday paths alike.
    expect(generatedAts.size).toBe(1);

    // The window path (5Y/MAX) and intraday path (1M/3M/1Y) between them
    // cover every PresetRange exactly once -- if a future range is ever
    // added to PRESET_RANGES without also assigning it to one of the two
    // paths' range lists, this catches it (it would otherwise silently
    // never get written, with no error and no other test noticing).
    const writtenRanges = [...store.objects.keys()]
      .map((key) => key.replace("results/", "").replace(".json", ""))
      .sort();
    expect(writtenRanges).toEqual([...PRESET_RANGES].sort());
  });

  it("is idempotent: running twice for the same day produces the same content", async () => {
    const dailyFixture = new Map<string, DailyClose[]>([
      ["AAPL", [daily(daysBack(20), 10), daily(daysBack(1), 30)]],
    ]);
    const intradayFixture = new Map<string, IntradayBar[]>([
      ["AAPL", [bar(daysBack(5), "09:30:00", 10), bar(daysBack(5), "10:30:00", 20)]],
    ]);
    const store = memoryStore();
    const run = () =>
      runPipeline({
        tickers: ["AAPL"],
        fetchDailyCloses: async (symbol) => dailyFixture.get(symbol) ?? [],
        fetchIntradayBars: async (symbol) => intradayFixture.get(symbol) ?? [],
        fetchFiveMinuteBars: noIntradayData,
        fetchIntraday1mBars: noIntradayData,
        store,
        asOf,
      });

    await run();
    const firstPass = new Map(store.objects);
    await run();

    expect(store.objects.size).toBe(firstPass.size);
    for (const [key, body] of firstPass) {
      const before = JSON.parse(body);
      const after = JSON.parse(store.objects.get(key)!);
      // generatedAt legitimately differs between runs; everything else shouldn't.
      delete before.generatedAt;
      delete after.generatedAt;
      expect(after).toEqual(before);
    }
  });

  describe("window path (5Y/MAX)", () => {
    it("slices each ticker's daily-close history to the correct window per range", async () => {
      const dailyFixture = new Map<string, DailyClose[]>([
        [
          "AAPL",
          [
            { date: "2015-01-01", close: 1 }, // only visible in MAX
            daily(daysBack(2000), 5), // beyond 5Y, visible in MAX only
            daily(daysBack(200), 8), // visible in 5Y and MAX
            daily(daysBack(10), 50), // visible in both
          ],
        ],
      ]);
      const store = memoryStore();

      // The intraday path deliberately has no data here and now makes
      // the overall run reject (see the dedicated "still fails the run"
      // tests below) -- irrelevant to this test, which only cares about
      // the window path's own slicing, so the rejection is swallowed.
      await runPipeline({
        tickers: ["AAPL"],
        fetchDailyCloses: async (symbol) => dailyFixture.get(symbol) ?? [],
        fetchIntradayBars: noIntradayData,
        fetchFiveMinuteBars: noIntradayData,
        fetchIntraday1mBars: noIntradayData,
        store,
        asOf,
      }).catch(() => {});

      const fiveYear = JSON.parse(store.objects.get("results/5Y.json")!);
      const max = JSON.parse(store.objects.get("results/MAX.json")!);

      // 5Y can't see the 2015 or 2000-days-back points -> a smaller
      // multiplier than MAX, which sees the full spread from 1 up to 50.
      expect(max.endingBalance).toBeGreaterThan(fiveYear.endingBalance);
      expect(fiveYear.endingBalance).toBeGreaterThan(20);
    });

    it("excludes data points after the requested asOf, even if the fetch client returns them", async () => {
      const dailyFixture = new Map<string, DailyClose[]>([
        [
          "AAPL",
          [daily(daysBack(5), 10), daily(daysBack(0), 20), { date: "2024-06-16", close: 999 }],
        ],
      ]);
      const store = memoryStore();

      // See the comment on the previous test -- the intraday path's
      // deliberate lack of data now makes the run reject, which this
      // test doesn't care about.
      await runPipeline({
        tickers: ["AAPL"],
        fetchDailyCloses: async (symbol) => dailyFixture.get(symbol) ?? [],
        fetchIntradayBars: noIntradayData,
        fetchFiveMinuteBars: noIntradayData,
        fetchIntraday1mBars: noIntradayData,
        store,
        asOf,
      }).catch(() => {});

      const max = JSON.parse(store.objects.get("results/MAX.json")!);
      expect(max.dataAsOf).toBe("2024-06-15"); // not 2024-06-16
      expect(max.trades.every((t: { sellDate: string }) => t.sellDate <= "2024-06-15")).toBe(true);
    });

    it("writes the intraday path's results even when the window path independently has no data, but still fails the run (for alerting)", async () => {
      const intradayFixture = new Map<string, IntradayBar[]>([
        ["AAPL", [bar(daysBack(5), "09:30:00", 10), bar(daysBack(5), "10:30:00", 20)]],
      ]);
      const store = memoryStore();

      await expect(
        runPipeline({
          tickers: ["AAPL"],
          fetchDailyCloses: noDailyData,
          fetchIntradayBars: async (symbol) => intradayFixture.get(symbol) ?? [],
          fetchFiveMinuteBars: noIntradayData,
          fetchIntraday1mBars: noIntradayData,
          store,
          asOf,
        }),
      ).rejects.toThrow(/wrote 3 of 5 ranges/);

      // The intraday path's real results were still written -- a single
      // failed path doesn't hold the other path's good data hostage --
      // but the run still rejects so a real, persistent single-path
      // failure doesn't go unnoticed indefinitely (see runPipeline's own
      // comment on why this must still fail the Lambda invocation).
      expect(store.objects.has("results/5Y.json")).toBe(false);
      expect(store.objects.has("results/MAX.json")).toBe(false);
      expect(store.objects.size).toBe(3);
    });

    it("computes a worst-case counterpart alongside the optimal window result, never better than it (issue #31)", async () => {
      const dailyFixture = new Map<string, DailyClose[]>([
        ["UP", [daily(daysBack(2000), 10), daily(daysBack(10), 200)]], // 20x
        ["DOWN", [daily(daysBack(2000), 200), daily(daysBack(10), 10)]], // 0.05x
      ]);
      const store = memoryStore();

      await runPipeline({
        tickers: ["UP", "DOWN"],
        fetchDailyCloses: async (symbol) => dailyFixture.get(symbol) ?? [],
        fetchIntradayBars: noIntradayData,
        fetchFiveMinuteBars: noIntradayData,
        fetchIntraday1mBars: noIntradayData,
        store,
        asOf,
      }).catch(() => {});

      const max = JSON.parse(store.objects.get("results/MAX.json")!);
      expect(max.worstCase).toBeDefined();
      expect(max.worstCase.endingBalance).toBeLessThan(max.endingBalance);
      expect(max.worstCase.endingBalance).toBeLessThanOrEqual(max.startingCapital);
      expect(max.worstCase.trades).toEqual([
        expect.objectContaining({ ticker: "DOWN", buyPrice: 200, sellPrice: 10 }),
      ]);
      // The optimal-case picked the *other* ticker, so the two results'
      // trades genuinely differ, not just their endingBalance.
      expect(max.trades).toEqual([
        expect.objectContaining({ ticker: "UP", buyPrice: 10, sellPrice: 200 }),
      ]);
    });
  });

  describe("intraday path (1M/3M/1Y)", () => {
    it("groups bars by trading day and slices each ticker's intraday history to the correct window per range", async () => {
      const intradayFixture = new Map<string, IntradayBar[]>([
        [
          "AAPL",
          [
            // Within 1M, 3M, and 1Y.
            bar(daysBack(5), "09:30:00", 10),
            bar(daysBack(5), "10:30:00", 20),
            // Within 3M and 1Y, but older than 1M.
            bar(daysBack(60), "09:30:00", 10),
            bar(daysBack(60), "10:30:00", 15),
            // Within 1Y only, older than 3M.
            bar(daysBack(200), "09:30:00", 10),
            bar(daysBack(200), "10:30:00", 12),
          ],
        ],
      ]);
      const store = memoryStore();

      // The window path deliberately has no data here and now makes the
      // overall run reject -- irrelevant to this test, which only cares
      // about the intraday path's own day-bucketing/slicing.
      await runPipeline({
        tickers: ["AAPL"],
        fetchDailyCloses: noDailyData,
        fetchIntradayBars: async (symbol) => intradayFixture.get(symbol) ?? [],
        fetchFiveMinuteBars: noIntradayData,
        fetchIntraday1mBars: noIntradayData,
        store,
        asOf,
      }).catch(() => {});

      const oneMonth = JSON.parse(store.objects.get("results/1M.json")!);
      const threeMonth = JSON.parse(store.objects.get("results/3M.json")!);
      const oneYear = JSON.parse(store.objects.get("results/1Y.json")!);

      expect(oneMonth.days).toHaveLength(1);
      expect(threeMonth.days).toHaveLength(2);
      expect(oneYear.days).toHaveLength(3);

      // Each day is solved independently, so every day's trade shows the
      // full multiplier available that day, not a compounded one.
      for (const day of oneYear.days) {
        expect(day.startingCapital).toBe(20);
      }
    });

    it("does not compound endingBalance across days -- every day starts fresh from startingCapital", async () => {
      const intradayFixture = new Map<string, IntradayBar[]>([
        [
          "AAPL",
          [
            bar(daysBack(5), "09:30:00", 10),
            bar(daysBack(5), "10:30:00", 100), // a huge day-1 gain
            bar(daysBack(2), "09:30:00", 10),
            bar(daysBack(2), "10:30:00", 20),
          ],
        ],
      ]);
      const store = memoryStore();

      // See the comment on the previous test -- the window path's
      // deliberate lack of data now makes the run reject, which this
      // test doesn't care about.
      await runPipeline({
        tickers: ["AAPL"],
        fetchDailyCloses: noDailyData,
        fetchIntradayBars: async (symbol) => intradayFixture.get(symbol) ?? [],
        fetchFiveMinuteBars: noIntradayData,
        fetchIntraday1mBars: noIntradayData,
        store,
        asOf,
      }).catch(() => {});

      const oneMonth = JSON.parse(store.objects.get("results/1M.json")!);
      const [firstDay, secondDay] = oneMonth.days;

      expect(firstDay.startingCapital).toBe(20);
      expect(secondDay.startingCapital).toBe(20); // not firstDay.endingBalance
    });

    it("writes the window path's results even when the intraday path independently has no data, but still fails the run (for alerting)", async () => {
      const dailyFixture = new Map<string, DailyClose[]>([
        ["AAPL", [daily(daysBack(2000), 5), daily(daysBack(10), 50)]],
      ]);
      const store = memoryStore();

      await expect(
        runPipeline({
          tickers: ["AAPL"],
          fetchDailyCloses: async (symbol) => dailyFixture.get(symbol) ?? [],
          fetchIntradayBars: noIntradayData,
          fetchFiveMinuteBars: noIntradayData,
          fetchIntraday1mBars: noIntradayData,
          store,
          asOf,
        }),
      ).rejects.toThrow(/wrote 2 of 5 ranges/);

      expect(store.objects.has("results/1M.json")).toBe(false);
      expect(store.objects.has("results/3M.json")).toBe(false);
      expect(store.objects.has("results/1Y.json")).toBe(false);
      expect(store.objects.size).toBe(2); // 5Y/MAX still wrote successfully
    });

    it("computes a per-day worst-case counterpart, never better than that day's optimal endingBalance (issue #31)", async () => {
      const intradayFixture = new Map<string, IntradayBar[]>([
        ["UP", [bar(daysBack(5), "09:30:00", 10), bar(daysBack(5), "10:30:00", 100)]],
        ["DOWN", [bar(daysBack(5), "09:30:00", 100), bar(daysBack(5), "10:30:00", 10)]],
      ]);
      const store = memoryStore();

      await runPipeline({
        tickers: ["UP", "DOWN"],
        fetchDailyCloses: noDailyData,
        fetchIntradayBars: async (symbol) => intradayFixture.get(symbol) ?? [],
        fetchFiveMinuteBars: noIntradayData,
        fetchIntraday1mBars: noIntradayData,
        store,
        asOf,
      }).catch(() => {});

      const oneMonth = JSON.parse(store.objects.get("results/1M.json")!);
      expect(oneMonth.days).toHaveLength(1);
      const day = oneMonth.days[0];
      expect(day.worstCase).toBeDefined();
      expect(day.worstCase.endingBalance).toBeLessThan(day.endingBalance);
      expect(day.worstCase.trades).toEqual([
        expect.objectContaining({ ticker: "DOWN", buyPrice: 100, sellPrice: 10 }),
      ]);
      expect(day.trades).toEqual([
        expect.objectContaining({ ticker: "UP", buyPrice: 10, sellPrice: 100 }),
      ]);
    });
  });

  describe("5-minute path (3M's recent days, issue #30)", () => {
    it("mixes granularities within 3M across the day-boundary between the two fetches: a recent day (within the 5-minute lookback) uses 5-minute bars, an older day in the same 3M window falls back to 60-minute bars", async () => {
      // Same ticker/day has *different* prices in the two fixtures, so
      // whichever multiplier shows up in the result proves which
      // dataset actually won for that day.
      const intradayFixture = new Map<string, IntradayBar[]>([
        [
          "AAPL",
          [
            // Recent day: within both the 1M/3M/1Y intraday fetch and
            // the 5-minute fetch's lookback window. 60-minute version: 2x.
            bar(daysBack(5), "09:30:00", 10),
            bar(daysBack(5), "10:30:00", 20),
            // Older day: within 3M/1Y but outside 1M and outside the
            // 5-minute fetch's ~59-day lookback -- 5-minute data was
            // never fetched for it, so it can only ever come from here.
            bar(daysBack(80), "09:30:00", 10),
            bar(daysBack(80), "10:30:00", 15),
          ],
        ],
      ]);
      const fiveMinuteFixture = new Map<string, IntradayBar[]>([
        [
          "AAPL",
          [
            // Same recent day, deliberately different price -> 5x, not
            // the 60-minute fixture's 2x.
            bar(daysBack(5), "09:30:00", 10),
            bar(daysBack(5), "10:30:00", 50),
          ],
        ],
      ]);
      const store = memoryStore();

      await runPipeline({
        tickers: ["AAPL"],
        fetchDailyCloses: noDailyData,
        fetchIntradayBars: async (symbol) => intradayFixture.get(symbol) ?? [],
        fetchFiveMinuteBars: async (symbol) => fiveMinuteFixture.get(symbol) ?? [],
        fetchIntraday1mBars: noIntradayData,
        store,
        asOf,
      }).catch(() => {
        // The window path has no data here and independently fails the
        // run -- irrelevant to this test, which only cares about the
        // intraday/5-minute paths' own assembly.
      });

      const threeMonth = JSON.parse(store.objects.get("results/3M.json")!);
      expect(threeMonth.days).toHaveLength(2);

      const recentDay = threeMonth.days.find(
        (d: { date: string }) => d.date === toDateString(daysBack(5)(asOf)),
      );
      const olderDay = threeMonth.days.find(
        (d: { date: string }) => d.date === toDateString(daysBack(80)(asOf)),
      );

      expect(recentDay.barIntervalMinutes).toBe(5);
      expect(recentDay.trades[0].sellPrice).toBe(50); // from the 5-minute fixture, not the 60-minute one's 20
      expect(recentDay.endingBalance / recentDay.startingCapital).toBeCloseTo(5, 6);

      expect(olderDay.barIntervalMinutes).toBe(60);
      expect(olderDay.trades[0].sellPrice).toBe(15);
      expect(olderDay.endingBalance / olderDay.startingCapital).toBeCloseTo(1.5, 6);
    });

    it("1M and 1Y are unaffected by 5-minute data -- they always read the pure 60-minute day results, even for a day the 5-minute fetch also covers", async () => {
      const intradayFixture = new Map<string, IntradayBar[]>([
        ["AAPL", [bar(daysBack(5), "09:30:00", 10), bar(daysBack(5), "10:30:00", 20)]], // 2x
      ]);
      const fiveMinuteFixture = new Map<string, IntradayBar[]>([
        ["AAPL", [bar(daysBack(5), "09:30:00", 10), bar(daysBack(5), "10:30:00", 50)]], // 5x -- must not leak into 1M/1Y
      ]);
      const store = memoryStore();

      await runPipeline({
        tickers: ["AAPL"],
        fetchDailyCloses: noDailyData,
        fetchIntradayBars: async (symbol) => intradayFixture.get(symbol) ?? [],
        fetchFiveMinuteBars: async (symbol) => fiveMinuteFixture.get(symbol) ?? [],
        fetchIntraday1mBars: noIntradayData,
        store,
        asOf,
      }).catch(() => {});

      for (const range of ["1M", "1Y"]) {
        const parsed = JSON.parse(store.objects.get(`results/${range}.json`)!);
        expect(parsed.days).toHaveLength(1);
        expect(parsed.days[0].barIntervalMinutes).toBe(60);
        expect(parsed.days[0].trades[0].sellPrice).toBe(20); // the 60-minute price, not the 5-minute fixture's 50
        expect(parsed.days[0].endingBalance / parsed.days[0].startingCapital).toBeCloseTo(2, 6);
      }
    });

    it("requests the 5-minute fetch from exactly FIVE_MINUTE_LOOKBACK_DAYS (59) days before asOf", async () => {
      const froms: Date[] = [];
      const store = memoryStore();

      await runPipeline({
        tickers: ["AAPL"],
        fetchDailyCloses: noDailyData,
        fetchIntradayBars: noIntradayData,
        fetchFiveMinuteBars: async (_symbol, from) => {
          froms.push(from);
          return [];
        },
        fetchIntraday1mBars: noIntradayData,
        store,
        asOf,
      }).catch(() => {});

      expect(froms).toHaveLength(1);
      expect(toDateString(froms[0]!)).toBe(toDateString(daysBack(59)(asOf)));
    });

    it("gracefully degrades when the 5-minute fetch aborts (BlockedError): does NOT fail the run over it, and 3M falls back to 60-minute bars for every day, identical to 3M's pre-#30 behavior", async () => {
      const dailyFixture = new Map<string, DailyClose[]>([
        ["AAPL", [daily(daysBack(2000), 5), daily(daysBack(10), 50)]],
      ]);
      const intradayFixture = new Map<string, IntradayBar[]>([
        ["AAPL", [bar(daysBack(5), "09:30:00", 10), bar(daysBack(5), "10:30:00", 20)]],
      ]);
      const store = memoryStore();

      // Both the window and intraday paths succeed; only the 5-minute
      // fetch is blocked -- the whole run must still succeed.
      const summary = await runPipeline({
        tickers: ["AAPL"],
        fetchDailyCloses: async (symbol) => dailyFixture.get(symbol) ?? [],
        fetchIntradayBars: async (symbol) => intradayFixture.get(symbol) ?? [],
        fetchFiveMinuteBars: async () => {
          throw new BlockedError("AAPL", 403);
        },
        fetchIntraday1mBars: noIntradayData,
        store,
        asOf,
      });

      expect(summary.results).toHaveLength(5);
      const threeMonth = JSON.parse(store.objects.get("results/3M.json")!);
      expect(threeMonth.days).toHaveLength(1);
      expect(threeMonth.days[0].barIntervalMinutes).toBe(60);
      expect(threeMonth.days[0].endingBalance / threeMonth.days[0].startingCapital).toBeCloseTo(
        2,
        6,
      );
    });

    it("a ticker skipped only on the 5-minute fetch surfaces in 3M's skippedTickers, but not 1M/1Y's", async () => {
      const intradayFixture = new Map<string, IntradayBar[]>([
        ["AAPL", [bar(daysBack(5), "09:30:00", 10), bar(daysBack(5), "10:30:00", 20)]],
      ]);
      const store = memoryStore();

      await runPipeline({
        tickers: ["AAPL"],
        fetchDailyCloses: noDailyData,
        fetchIntradayBars: async (symbol) => intradayFixture.get(symbol) ?? [],
        fetchFiveMinuteBars: async () => {
          throw new TickerNotFoundError("AAPL", "no 5-minute data");
        },
        fetchIntraday1mBars: noIntradayData,
        store,
        asOf,
      }).catch(() => {});

      const threeMonth = JSON.parse(store.objects.get("results/3M.json")!);
      const oneMonth = JSON.parse(store.objects.get("results/1M.json")!);
      expect(threeMonth.skippedTickers).toEqual(["AAPL"]);
      expect(oneMonth.skippedTickers).toEqual([]);
    });

    it("keeps whichever granularity's day result is actually better -- does NOT blindly prefer 5-minute data when it has worse ticker coverage than 60-minute for the same day (code review fix: a real bug in the original merge)", async () => {
      // Ticker B's much better trade only appears in the 60-minute
      // fixture for this day (simulating B's 5-minute fetch failing for
      // just this ticker/day while its 60-minute fetch succeeded).
      // Ticker A appears in both, with a smaller gain in each.
      const intradayFixture = new Map<string, IntradayBar[]>([
        ["A", [bar(daysBack(5), "09:30:00", 10), bar(daysBack(5), "10:30:00", 20)]], // 2x
        ["B", [bar(daysBack(5), "09:30:00", 10), bar(daysBack(5), "10:30:00", 100)]], // 10x -- the best trade, 60-minute only
      ]);
      const fiveMinuteFixture = new Map<string, IntradayBar[]>([
        // A's 5-minute number is even better than its own 60-minute one
        // (2.5x vs 2x) -- but B is entirely missing from this fetch, so
        // the 5-minute day's *best achievable* outcome (2.5x) is still
        // far worse than the 60-minute day's (10x, via B).
        ["A", [bar(daysBack(5), "09:30:00", 10), bar(daysBack(5), "10:30:00", 25)]],
      ]);
      const store = memoryStore();

      await runPipeline({
        tickers: ["A", "B"],
        fetchDailyCloses: noDailyData,
        fetchIntradayBars: async (symbol) => intradayFixture.get(symbol) ?? [],
        fetchFiveMinuteBars: async (symbol) => fiveMinuteFixture.get(symbol) ?? [],
        fetchIntraday1mBars: noIntradayData,
        store,
        asOf,
      }).catch(() => {});

      const threeMonth = JSON.parse(store.objects.get("results/3M.json")!);
      const day = threeMonth.days.find(
        (d: { date: string }) => d.date === toDateString(daysBack(5)(asOf)),
      );

      // The 60-minute day (endingBalance 200, via ticker B) beats the
      // 5-minute-only day (endingBalance 50, ticker A only) -- the merge
      // must keep the 60-minute version despite 5-minute data existing
      // for this exact date.
      expect(day.barIntervalMinutes).toBe(60);
      expect(day.trades[0].ticker).toBe("B");
      expect(day.endingBalance / day.startingCapital).toBeCloseTo(10, 6);
    });

    it("3M's dataAsOf reflects the more recent of the 60-minute and 5-minute fetches, not just the 60-minute one (code review fix)", async () => {
      const intradayFixture = new Map<string, IntradayBar[]>([
        ["AAPL", [bar(daysBack(5), "09:30:00", 10), bar(daysBack(3), "09:30:00", 20)]],
      ]);
      // The 5-minute fetch found data all the way up through "today"
      // (daysBack(0)), more recent than the 60-minute fetch's most
      // recent bar (daysBack(3)).
      const fiveMinuteFixture = new Map<string, IntradayBar[]>([
        ["AAPL", [bar(daysBack(0), "09:30:00", 10), bar(daysBack(0), "10:30:00", 15)]],
      ]);
      const store = memoryStore();

      await runPipeline({
        tickers: ["AAPL"],
        fetchDailyCloses: noDailyData,
        fetchIntradayBars: async (symbol) => intradayFixture.get(symbol) ?? [],
        fetchFiveMinuteBars: async (symbol) => fiveMinuteFixture.get(symbol) ?? [],
        fetchIntraday1mBars: noIntradayData,
        store,
        asOf,
      }).catch(() => {});

      const threeMonth = JSON.parse(store.objects.get("results/3M.json")!);
      const oneMonth = JSON.parse(store.objects.get("results/1M.json")!);

      // 3M folds in the 5-minute fetch's freshness...
      expect(threeMonth.dataAsOf).toBe(toDateString(daysBack(0)(asOf)));
      // ...but 1M never reads 5-minute data, so it stays anchored to the
      // 60-minute fetch's own (older) most-recent date.
      expect(oneMonth.dataAsOf).toBe(toDateString(daysBack(3)(asOf)));
    });
  });

  describe("1-minute path (1M, issue #29)", () => {
    it("mixes granularities within 1M across the retention boundary between the two fetches: a recent day (within the 1-minute lookback) uses 1-minute bars, an older day within 1M's own (slightly wider) window falls back to 60-minute bars", async () => {
      const intradayFixture = new Map<string, IntradayBar[]>([
        [
          "AAPL",
          [
            // Recent day: within both the 60-minute intraday fetch and
            // the 1-minute fetch's ~29-day lookback window. 60-minute
            // version: 2x.
            bar(daysBack(5), "09:30:00", 10),
            bar(daysBack(5), "10:30:00", 20),
            // Oldest day still inside 1M's own ~31-day window (asOf is
            // 2024-06-15, 1M's own start date is 2024-05-15, so
            // daysBack(30) = 2024-05-16 is still >= that start date) but
            // one day past the 1-minute fetch's own ~29-day lookback --
            // 1-minute data was never fetched (let alone found) for it,
            // so it can only ever come from here. This is the exact
            // retention-mismatch case this issue's plan review flagged:
            // 1M's own window can outreach the 1-minute retention wall.
            bar(daysBack(30), "09:30:00", 10),
            bar(daysBack(30), "10:30:00", 15),
          ],
        ],
      ]);
      const oneMinuteFixture = new Map<string, IntradayBar[]>([
        [
          "AAPL",
          [
            // Same recent day, deliberately different price -> 5x, not
            // the 60-minute fixture's 2x.
            bar(daysBack(5), "09:30:00", 10),
            bar(daysBack(5), "10:30:00", 50),
          ],
        ],
      ]);
      const store = memoryStore();

      await runPipeline({
        tickers: ["AAPL"],
        fetchDailyCloses: noDailyData,
        fetchIntradayBars: async (symbol) => intradayFixture.get(symbol) ?? [],
        fetchFiveMinuteBars: noIntradayData,
        fetchIntraday1mBars: async (symbol) => oneMinuteFixture.get(symbol) ?? [],
        store,
        asOf,
      }).catch(() => {
        // The window path has no data here and independently fails the
        // run -- irrelevant to this test, which only cares about the
        // intraday/1-minute paths' own assembly.
      });

      const oneMonth = JSON.parse(store.objects.get("results/1M.json")!);
      expect(oneMonth.days).toHaveLength(2);

      const recentDay = oneMonth.days.find(
        (d: { date: string }) => d.date === toDateString(daysBack(5)(asOf)),
      );
      const olderDay = oneMonth.days.find(
        (d: { date: string }) => d.date === toDateString(daysBack(30)(asOf)),
      );

      expect(recentDay.barIntervalMinutes).toBe(1);
      expect(recentDay.trades[0].sellPrice).toBe(50); // from the 1-minute fixture, not the 60-minute one's 20
      expect(recentDay.endingBalance / recentDay.startingCapital).toBeCloseTo(5, 6);

      expect(olderDay.barIntervalMinutes).toBe(60);
      expect(olderDay.trades[0].sellPrice).toBe(15);
      expect(olderDay.endingBalance / olderDay.startingCapital).toBeCloseTo(1.5, 6);
    });

    it("3M and 1Y are unaffected by 1-minute data -- they always read the pure 60-minute day results, even for a day the 1-minute fetch also covers", async () => {
      const intradayFixture = new Map<string, IntradayBar[]>([
        ["AAPL", [bar(daysBack(5), "09:30:00", 10), bar(daysBack(5), "10:30:00", 20)]], // 2x
      ]);
      const oneMinuteFixture = new Map<string, IntradayBar[]>([
        ["AAPL", [bar(daysBack(5), "09:30:00", 10), bar(daysBack(5), "10:30:00", 50)]], // 5x -- must not leak into 3M/1Y
      ]);
      const store = memoryStore();

      await runPipeline({
        tickers: ["AAPL"],
        fetchDailyCloses: noDailyData,
        fetchIntradayBars: async (symbol) => intradayFixture.get(symbol) ?? [],
        fetchFiveMinuteBars: noIntradayData,
        fetchIntraday1mBars: async (symbol) => oneMinuteFixture.get(symbol) ?? [],
        store,
        asOf,
      }).catch(() => {});

      for (const range of ["3M", "1Y"]) {
        const parsed = JSON.parse(store.objects.get(`results/${range}.json`)!);
        expect(parsed.days).toHaveLength(1);
        expect(parsed.days[0].barIntervalMinutes).toBe(60);
        expect(parsed.days[0].trades[0].sellPrice).toBe(20); // the 60-minute price, not the 1-minute fixture's 50
        expect(parsed.days[0].endingBalance / parsed.days[0].startingCapital).toBeCloseTo(2, 6);
      }
    });

    it('requests the 1-minute fetch from exactly ONE_MINUTE_LOOKBACK_DAYS (29) days before asOf, not presetRangeStartDate("1M", asOf) (which can land 31 days back)', async () => {
      const froms: Date[] = [];
      const store = memoryStore();

      await runPipeline({
        tickers: ["AAPL"],
        fetchDailyCloses: noDailyData,
        fetchIntradayBars: noIntradayData,
        fetchFiveMinuteBars: noIntradayData,
        fetchIntraday1mBars: async (_symbol, from) => {
          froms.push(from);
          return [];
        },
        store,
        asOf,
      }).catch(() => {});

      expect(froms).toHaveLength(1);
      expect(toDateString(froms[0]!)).toBe(toDateString(daysBack(29)(asOf)));
      // Regression check for the real bug this issue's plan review
      // caught: presetRangeStartDate("1M", asOf) for this exact asOf
      // (2024-06-15) lands on 2024-05-15 -- 31 days back, one day past
      // the retention wall -- so the 1-minute fetch must NOT be using
      // that unclamped value.
      expect(toDateString(froms[0]!)).not.toBe(toDateString(daysBack(31)(asOf)));
    });

    it("gracefully degrades when the 1-minute fetch aborts (BlockedError): does NOT fail the run over it, and 1M falls back to 60-minute bars for every day, identical to 1M's pre-#29 behavior", async () => {
      const dailyFixture = new Map<string, DailyClose[]>([
        ["AAPL", [daily(daysBack(2000), 5), daily(daysBack(10), 50)]],
      ]);
      const intradayFixture = new Map<string, IntradayBar[]>([
        ["AAPL", [bar(daysBack(5), "09:30:00", 10), bar(daysBack(5), "10:30:00", 20)]],
      ]);
      const store = memoryStore();

      // Window, daily-intraday, and 5-minute all succeed (5-minute
      // trivially, since it fetches nothing here); only the 1-minute
      // fetch is blocked -- the whole run must still succeed.
      const summary = await runPipeline({
        tickers: ["AAPL"],
        fetchDailyCloses: async (symbol) => dailyFixture.get(symbol) ?? [],
        fetchIntradayBars: async (symbol) => intradayFixture.get(symbol) ?? [],
        fetchFiveMinuteBars: noIntradayData,
        fetchIntraday1mBars: async () => {
          throw new BlockedError("AAPL", 403);
        },
        store,
        asOf,
      });

      expect(summary.results).toHaveLength(5);
      const oneMonth = JSON.parse(store.objects.get("results/1M.json")!);
      expect(oneMonth.days).toHaveLength(1);
      expect(oneMonth.days[0].barIntervalMinutes).toBe(60);
      expect(oneMonth.days[0].endingBalance / oneMonth.days[0].startingCapital).toBeCloseTo(2, 6);
    });

    it("a ticker skipped only on the 1-minute fetch surfaces in 1M's skippedTickers, but not 3M/1Y's", async () => {
      const intradayFixture = new Map<string, IntradayBar[]>([
        ["AAPL", [bar(daysBack(5), "09:30:00", 10), bar(daysBack(5), "10:30:00", 20)]],
      ]);
      const store = memoryStore();

      await runPipeline({
        tickers: ["AAPL"],
        fetchDailyCloses: noDailyData,
        fetchIntradayBars: async (symbol) => intradayFixture.get(symbol) ?? [],
        fetchFiveMinuteBars: noIntradayData,
        fetchIntraday1mBars: async () => {
          throw new TickerNotFoundError("AAPL", "no 1-minute data");
        },
        store,
        asOf,
      }).catch(() => {});

      const oneMonth = JSON.parse(store.objects.get("results/1M.json")!);
      const threeMonth = JSON.parse(store.objects.get("results/3M.json")!);
      expect(oneMonth.skippedTickers).toEqual(["AAPL"]);
      expect(threeMonth.skippedTickers).toEqual([]);
    });

    it("keeps whichever granularity's day result is actually better -- does NOT blindly prefer 1-minute data when it has worse ticker coverage than 60-minute for the same day", async () => {
      const intradayFixture = new Map<string, IntradayBar[]>([
        ["A", [bar(daysBack(5), "09:30:00", 10), bar(daysBack(5), "10:30:00", 20)]], // 2x
        ["B", [bar(daysBack(5), "09:30:00", 10), bar(daysBack(5), "10:30:00", 100)]], // 10x -- the best trade, 60-minute only
      ]);
      const oneMinuteFixture = new Map<string, IntradayBar[]>([
        // A's 1-minute number is even better than its own 60-minute one
        // (2.5x vs 2x) -- but B is entirely missing from this fetch, so
        // the 1-minute day's *best achievable* outcome (2.5x) is still
        // far worse than the 60-minute day's (10x, via B).
        ["A", [bar(daysBack(5), "09:30:00", 10), bar(daysBack(5), "10:30:00", 25)]],
      ]);
      const store = memoryStore();

      await runPipeline({
        tickers: ["A", "B"],
        fetchDailyCloses: noDailyData,
        fetchIntradayBars: async (symbol) => intradayFixture.get(symbol) ?? [],
        fetchFiveMinuteBars: noIntradayData,
        fetchIntraday1mBars: async (symbol) => oneMinuteFixture.get(symbol) ?? [],
        store,
        asOf,
      }).catch(() => {});

      const oneMonth = JSON.parse(store.objects.get("results/1M.json")!);
      const day = oneMonth.days.find(
        (d: { date: string }) => d.date === toDateString(daysBack(5)(asOf)),
      );

      expect(day.barIntervalMinutes).toBe(60);
      expect(day.trades[0].ticker).toBe("B");
      expect(day.endingBalance / day.startingCapital).toBeCloseTo(10, 6);
    });

    it("1M's dataAsOf reflects the more recent of the 60-minute and 1-minute fetches, not just the 60-minute one", async () => {
      const intradayFixture = new Map<string, IntradayBar[]>([
        ["AAPL", [bar(daysBack(5), "09:30:00", 10), bar(daysBack(3), "09:30:00", 20)]],
      ]);
      const oneMinuteFixture = new Map<string, IntradayBar[]>([
        ["AAPL", [bar(daysBack(0), "09:30:00", 10), bar(daysBack(0), "10:30:00", 15)]],
      ]);
      const store = memoryStore();

      await runPipeline({
        tickers: ["AAPL"],
        fetchDailyCloses: noDailyData,
        fetchIntradayBars: async (symbol) => intradayFixture.get(symbol) ?? [],
        fetchFiveMinuteBars: noIntradayData,
        fetchIntraday1mBars: async (symbol) => oneMinuteFixture.get(symbol) ?? [],
        store,
        asOf,
      }).catch(() => {});

      const oneMonth = JSON.parse(store.objects.get("results/1M.json")!);
      const threeMonth = JSON.parse(store.objects.get("results/3M.json")!);

      // 1M folds in the 1-minute fetch's freshness...
      expect(oneMonth.dataAsOf).toBe(toDateString(daysBack(0)(asOf)));
      // ...but 3M never reads 1-minute data, so it stays anchored to the
      // 60-minute fetch's own (older) most-recent date.
      expect(threeMonth.dataAsOf).toBe(toDateString(daysBack(3)(asOf)));
    });
  });

  describe("benchmark (issue #12)", () => {
    // Reused across most of this describe block -- just enough AAPL data
    // to keep both the window and intraday paths writing real results,
    // since a benchmark-only fixture with nothing else would make the
    // whole run fail before ever reaching a written range to assert on.
    const aaplDaily = new Map<string, DailyClose[]>([
      ["AAPL", [daily(daysBack(2000), 1), daily(daysBack(200), 8), daily(daysBack(10), 50)]],
    ]);
    const aaplIntraday = new Map<string, IntradayBar[]>([
      ["AAPL", [bar(daysBack(5), "09:30:00", 10), bar(daysBack(5), "10:30:00", 20)]],
    ]);

    it("attaches a benchmark to every range, both window and intraday-daily models alike", async () => {
      const dailyFixture = new Map<string, DailyClose[]>([
        ...aaplDaily,
        // Only the second point falls inside any bounded range's window
        // (1M/3M/1Y/5Y) -- the first predates even 5Y's own start by a
        // wide margin, so it's only ever picked up by MAX's unbounded
        // window.
        ["SPY", [daily(daysBack(2500), 100), daily(daysBack(1), 400)]],
      ]);
      const store = memoryStore();

      await runPipeline({
        tickers: ["AAPL"],
        fetchDailyCloses: async (symbol) => dailyFixture.get(symbol) ?? [],
        fetchIntradayBars: async (symbol) => aaplIntraday.get(symbol) ?? [],
        fetchFiveMinuteBars: noIntradayData,
        fetchIntraday1mBars: noIntradayData,
        store,
        asOf,
      });

      for (const range of PRESET_RANGES) {
        const parsed = JSON.parse(store.objects.get(`results/${range}.json`)!);
        expect(parsed.benchmark).toMatchObject({ ticker: "SPY" });
        expect(parsed.benchmark.endDate).toBe(toDateString(daysBack(1)(asOf)));
        expect(parsed.benchmark.endPrice).toBe(400);
      }

      // MAX reaches all the way back to the earliest SPY point at all,
      // and is unconditionally truncated (an unbounded window can never
      // be fully covered by SPY's own finite history -- see
      // computeBenchmark's own doc comment).
      const max = JSON.parse(store.objects.get("results/MAX.json")!);
      expect(max.benchmark.startDate).toBe(toDateString(daysBack(2500)(asOf)));
      expect(max.benchmark.startPrice).toBe(100);
      expect(max.benchmark.endingBalance).toBeCloseTo(20 * (400 / 100), 5);
      expect(max.benchmark.truncated).toBe(true);

      // Every bounded range's own window only overlaps the recent SPY
      // point (the far-back one falls outside all of their windows), and
      // none of them are truncated -- SPY's overall earliest fetched
      // date (2500 days back) comfortably predates every bounded range's
      // own requested start.
      for (const range of ["1M", "3M", "1Y", "5Y"]) {
        const parsed = JSON.parse(store.objects.get(`results/${range}.json`)!);
        expect(parsed.benchmark.startDate).toBe(toDateString(daysBack(1)(asOf)));
        expect(parsed.benchmark.truncated).toBe(false);
      }
    });

    it("does not flag truncated for a bounded range whose nominal start lands on a non-trading day, even though the actually-used start is later (regression: a naive start.date-vs-rangeStart comparison false-positives here)", async () => {
      // asOf (2024-06-15) is itself a Saturday, and 5Y back from it
      // (2019-06-15) is *also* a Saturday -- not a real trading day, so
      // no SPY bar exists exactly on that date; live-checked that this
      // "nominal boundary lands on a weekend" case hits roughly 28% of
      // days across a 2-year sample for every bounded range, not some
      // rare edge case.
      const dailyFixture = new Map<string, DailyClose[]>([
        ...aaplDaily,
        [
          "SPY",
          [
            { date: "1993-01-29", close: 43.5 }, // SPY's real inception -- decades before 5Y's requested start
            { date: "2019-06-17", close: 280 }, // the nearest real trading day at-or-after 2019-06-15 (Sat) -- the Monday after
            daily(daysBack(1), 500),
          ],
        ],
      ]);
      const store = memoryStore();

      await runPipeline({
        tickers: ["AAPL"],
        fetchDailyCloses: async (symbol) => dailyFixture.get(symbol) ?? [],
        fetchIntradayBars: async (symbol) => aaplIntraday.get(symbol) ?? [],
        fetchFiveMinuteBars: noIntradayData,
        fetchIntraday1mBars: noIntradayData,
        store,
        asOf,
      });

      const fiveYear = JSON.parse(store.objects.get("results/5Y.json")!);
      // Pulled forward from the nominal 2019-06-15 (a Saturday) to the
      // nearest actual trading day...
      expect(fiveYear.benchmark.startDate).toBe("2019-06-17");
      // ...but NOT truncated: SPY's overall history reaches back to
      // 1993, decades before 5Y's own requested start, so this is just a
      // weekend, not a genuine historical-depth gap.
      expect(fiveYear.benchmark.truncated).toBe(false);
    });

    it("flags truncated for a bounded range when SPY's own history genuinely doesn't reach back to the range's requested start (a hypothetical data gap, not the routine MAX case)", async () => {
      const dailyFixture = new Map<string, DailyClose[]>([
        ...aaplDaily,
        // SPY's own earliest fetched data (100 days back) is well inside
        // 1Y's own requested start (~365 days back) -- a genuine gap,
        // not a weekend/holiday misalignment.
        ["SPY", [daily(daysBack(100), 300), daily(daysBack(1), 400)]],
      ]);
      const store = memoryStore();

      await runPipeline({
        tickers: ["AAPL"],
        fetchDailyCloses: async (symbol) => dailyFixture.get(symbol) ?? [],
        fetchIntradayBars: async (symbol) => aaplIntraday.get(symbol) ?? [],
        fetchFiveMinuteBars: noIntradayData,
        fetchIntraday1mBars: noIntradayData,
        store,
        asOf,
      });

      const oneYear = JSON.parse(store.objects.get("results/1Y.json")!);
      expect(oneYear.benchmark.startDate).toBe(toDateString(daysBack(100)(asOf)));
      expect(oneYear.benchmark.truncated).toBe(true);
    });

    it("attaches benchmark: null to every range when SPY has no fetched data at all", async () => {
      const store = memoryStore();

      await runPipeline({
        tickers: ["AAPL"],
        fetchDailyCloses: async (symbol) => aaplDaily.get(symbol) ?? [],
        fetchIntradayBars: async (symbol) => aaplIntraday.get(symbol) ?? [],
        fetchFiveMinuteBars: noIntradayData,
        fetchIntraday1mBars: noIntradayData,
        store,
        asOf,
      });

      for (const range of PRESET_RANGES) {
        const parsed = JSON.parse(store.objects.get(`results/${range}.json`)!);
        expect(parsed.benchmark).toBeNull();
      }
    });

    it("a benchmark fetch failure (SPY throws) is non-fatal -- the run still succeeds and writes benchmark: null for every range", async () => {
      const store = memoryStore();

      const summary = await runPipeline({
        tickers: ["AAPL"],
        fetchDailyCloses: async (symbol) => {
          if (symbol === "SPY") throw new Error("simulated SPY fetch failure");
          return aaplDaily.get(symbol) ?? [];
        },
        fetchIntradayBars: async (symbol) => aaplIntraday.get(symbol) ?? [],
        fetchFiveMinuteBars: noIntradayData,
        fetchIntraday1mBars: noIntradayData,
        store,
        asOf,
      });

      expect(summary.results).toHaveLength(5);
      for (const range of PRESET_RANGES) {
        const parsed = JSON.parse(store.objects.get(`results/${range}.json`)!);
        expect(parsed.benchmark).toBeNull();
      }
    });
  });

  it("skips a ticker on TickerNotFoundError and continues, recording it as skipped", async () => {
    const store = memoryStore();

    const summary = await runPipeline({
      tickers: ["GOOD", "MISSING"],
      fetchDailyCloses: async (symbol) => {
        if (symbol === "MISSING") throw new TickerNotFoundError(symbol, "no data");
        return [daily(daysBack(20), 10), daily(daysBack(1), 40)];
      },
      fetchIntradayBars: async (symbol) => {
        if (symbol === "MISSING") throw new TickerNotFoundError(symbol, "no data");
        return [bar(daysBack(5), "09:30:00", 10), bar(daysBack(5), "10:30:00", 40)];
      },
      fetchFiveMinuteBars: noIntradayData,
      fetchIntraday1mBars: noIntradayData,
      store,
      asOf,
    });

    expect(summary.skippedTickers).toEqual(["MISSING"]);
    const max = JSON.parse(store.objects.get("results/MAX.json")!);
    expect(max.skippedTickers).toEqual(["MISSING"]);
    expect(max.endingBalance).toBeGreaterThan(20); // GOOD still contributes
  });

  it("skips a ticker on TransientFetchError and continues", async () => {
    const store = memoryStore();

    const summary = await runPipeline({
      tickers: ["GOOD", "FLAKY"],
      fetchDailyCloses: async (symbol) => {
        if (symbol === "FLAKY") throw new TransientFetchError(symbol, new Error("network"));
        return [daily(daysBack(20), 10), daily(daysBack(1), 40)];
      },
      fetchIntradayBars: async (symbol) => {
        if (symbol === "FLAKY") throw new TransientFetchError(symbol, new Error("network"));
        return [bar(daysBack(5), "09:30:00", 10), bar(daysBack(5), "10:30:00", 40)];
      },
      fetchFiveMinuteBars: noIntradayData,
      fetchIntraday1mBars: noIntradayData,
      store,
      asOf,
    });

    expect(summary.skippedTickers).toEqual(["FLAKY"]);
  });

  it("a ticker skipped on only one path still fails the run, but the skipped ticker and the other path's results are preserved", async () => {
    const store = memoryStore();

    const error = await rejectionOf(
      runPipeline({
        tickers: ["GOOD"],
        fetchDailyCloses: async () => {
          throw new TickerNotFoundError("GOOD", "no daily data");
        },
        fetchIntradayBars: async () => [
          bar(daysBack(5), "09:30:00", 10),
          bar(daysBack(5), "10:30:00", 40),
        ],
        fetchFiveMinuteBars: noIntradayData,
        fetchIntraday1mBars: noIntradayData,
        store,
        asOf,
      }),
    );

    // The thrown error still surfaces the skipped-ticker bookkeeping,
    // even though it's no longer available via a returned summary (the
    // call rejected) -- real per-ticker information shouldn't vanish
    // just because the overall run also fails for a different reason.
    expect(error.message).toMatch(/Skipped tickers: GOOD/);
    // Window path had zero usable data (its only ticker was skipped) --
    // no window results written -- but the intraday path still succeeded
    // and its real results are still in the store.
    expect(store.objects.has("results/MAX.json")).toBe(false);
    const oneMonth = JSON.parse(store.objects.get("results/1M.json")!);
    expect(oneMonth.days[0].endingBalance).toBeGreaterThan(20);
  });

  it("aborts only the window path on a window-fetch BlockedError, still writing (but failing the run over) the intraday path's results", async () => {
    const store = memoryStore();

    await expect(
      runPipeline({
        tickers: ["AAPL"],
        fetchDailyCloses: async () => {
          throw new BlockedError("AAPL", 403);
        },
        fetchIntradayBars: async () => [
          bar(daysBack(5), "09:30:00", 10),
          bar(daysBack(5), "10:30:00", 40),
        ],
        fetchFiveMinuteBars: noIntradayData,
        fetchIntraday1mBars: noIntradayData,
        store,
        asOf,
      }),
    ).rejects.toThrow(/wrote 3 of 5 ranges/);

    expect(store.objects.has("results/5Y.json")).toBe(false);
    expect(store.objects.has("results/MAX.json")).toBe(false);
    expect(store.objects.size).toBe(3);
  });

  it("aborts only the intraday path on an intraday-fetch UnexpectedResponseError, still writing (but failing the run over) the window path's results", async () => {
    const store = memoryStore();

    await expect(
      runPipeline({
        tickers: ["AAPL"],
        fetchDailyCloses: async () => [daily(daysBack(20), 10), daily(daysBack(1), 40)],
        fetchIntradayBars: async () => {
          throw new UnexpectedResponseError("AAPL", 400);
        },
        fetchFiveMinuteBars: noIntradayData,
        fetchIntraday1mBars: noIntradayData,
        store,
        asOf,
      }),
    ).rejects.toThrow(/wrote 2 of 5 ranges/);

    expect(store.objects.has("results/1M.json")).toBe(false);
    expect(store.objects.has("results/3M.json")).toBe(false);
    expect(store.objects.has("results/1Y.json")).toBe(false);
    expect(store.objects.size).toBe(2);
  });

  it("aborts the entire run and writes nothing when BOTH paths fail", async () => {
    const store = memoryStore();

    await expect(
      runPipeline({
        tickers: ["AAPL", "MSFT"],
        fetchDailyCloses: async () => {
          throw new BlockedError("AAPL", 403);
        },
        fetchIntradayBars: async () => {
          throw new BlockedError("AAPL", 403);
        },
        fetchFiveMinuteBars: noIntradayData,
        fetchIntraday1mBars: noIntradayData,
        store,
        asOf,
      }),
    ).rejects.toThrow(/neither the daily-close nor intraday fetch/);

    expect(store.objects.size).toBe(0);
  });

  it("preserves per-ticker skips that happened before an abort, instead of discarding them along with the untrusted partial data", async () => {
    const store = memoryStore();
    // Serial (concurrency 1) so the fetch order is deterministic: two
    // tickers fail individually for an unrelated per-ticker reason
    // *before* the third one triggers a systemic abort.
    const error = await rejectionOf(
      runPipeline({
        tickers: ["MISSING1", "MISSING2", "BLOCKED"],
        fetchConcurrency: 1,
        fetchDailyCloses: async (symbol) => {
          if (symbol === "MISSING1" || symbol === "MISSING2") {
            throw new TickerNotFoundError(symbol, "no data");
          }
          throw new BlockedError(symbol, 403);
        },
        fetchIntradayBars: async () => [
          bar(daysBack(5), "09:30:00", 10),
          bar(daysBack(5), "10:30:00", 40),
        ],
        fetchFiveMinuteBars: noIntradayData,
        fetchIntraday1mBars: noIntradayData,
        store,
        asOf,
      }),
    );

    // Both individually-skipped tickers survive the later abort on the
    // same path, not just tickers skipped on the (unrelated, succeeding)
    // intraday path.
    expect(error.message).toMatch(/Skipped tickers:.*MISSING1/);
    expect(error.message).toMatch(/Skipped tickers:.*MISSING2/);
  });

  it("stops starting new fetches once a worker hits BlockedError, instead of every worker running to completion", async () => {
    const store = memoryStore();
    const attempted: string[] = [];
    const tickers = Array.from({ length: 20 }, (_, i) => `T${i}`);

    await runPipeline({
      tickers,
      fetchConcurrency: 4,
      fetchDailyCloses: async (symbol) => {
        attempted.push(symbol);
        if (symbol === "T0") throw new BlockedError(symbol, 403);
        // Small delay so the block has a chance to propagate before
        // every ticker gets a chance to start.
        await new Promise((resolve) => setTimeout(resolve, 5));
        return [daily(daysBack(20), 10), daily(daysBack(1), 40)];
      },
      fetchIntradayBars: noIntradayData,
      fetchFiveMinuteBars: noIntradayData,
      fetchIntraday1mBars: noIntradayData,
      store,
      asOf,
    }).catch(() => {
      // expected to reject (both paths end up empty: the window path
      // aborts, and noIntradayData never produces any intraday data
      // either) -- asserting on `attempted` below is the point.
    });

    // Without the fix, all 20 tickers would eventually be attempted
    // (each of the 4 workers keeps pulling new work). With the fix,
    // workers stop pulling new tickers once the block is detected, so
    // only a small handful (bounded by concurrency + in-flight timing)
    // should ever have started.
    expect(attempted.length).toBeLessThan(tickers.length);
  });

  it("refuses to write empty results and throws when every ticker fails on both paths", async () => {
    const store = memoryStore();

    await expect(
      runPipeline({
        tickers: ["A", "B"],
        fetchDailyCloses: async (symbol) => {
          throw new TickerNotFoundError(symbol, "no data");
        },
        fetchIntradayBars: async (symbol) => {
          throw new TickerNotFoundError(symbol, "no data");
        },
        fetchFiveMinuteBars: noIntradayData,
        fetchIntraday1mBars: noIntradayData,
        store,
        asOf,
      }),
    ).rejects.toThrow(/neither the daily-close nor intraday fetch/);

    expect(store.objects.size).toBe(0);
  });
});
