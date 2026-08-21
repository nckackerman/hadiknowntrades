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
        schemaVersion: 2,
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
        schemaVersion: 2,
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
          store,
          asOf,
        }),
      ).rejects.toThrow(/wrote 2 of 5 ranges/);

      expect(store.objects.has("results/1M.json")).toBe(false);
      expect(store.objects.has("results/3M.json")).toBe(false);
      expect(store.objects.has("results/1Y.json")).toBe(false);
      expect(store.objects.size).toBe(2); // 5Y/MAX still wrote successfully
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
        store,
        asOf,
      }),
    ).rejects.toThrow(/neither the daily-close nor intraday fetch/);

    expect(store.objects.size).toBe(0);
  });
});
