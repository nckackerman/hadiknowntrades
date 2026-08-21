import {
  BlockedError,
  TickerNotFoundError,
  toDateString,
  TransientFetchError,
  UnexpectedResponseError,
  type DailyClose,
} from "@hadiknowntrades/core";
import { describe, expect, it } from "vitest";

import { runPipeline, type ResultStore } from "./pipeline.js";

function daily(dateFromAsOf: (asOf: Date) => Date, close: number): DailyClose {
  return { date: toDateString(dateFromAsOf(new Date("2024-06-15"))), close };
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

describe("runPipeline", () => {
  const asOf = new Date("2024-06-15T00:00:00Z");

  it("writes one result per preset range, with the correct schema", async () => {
    const fixtureData = new Map<string, DailyClose[]>([
      ["AAPL", [daily(daysBack(20), 10), daily(daysBack(10), 15), daily(daysBack(2), 20)]],
    ]);
    const store = memoryStore();

    const summary = await runPipeline({
      tickers: ["AAPL"],
      fetchDailyCloses: async (symbol) => fixtureData.get(symbol) ?? [],
      store,
      asOf,
    });

    expect(store.objects.size).toBe(5);
    for (const range of ["1M", "3M", "1Y", "5Y", "MAX"]) {
      const raw = store.objects.get(`results/${range}.json`);
      expect(raw).toBeDefined();
      const parsed = JSON.parse(raw!);
      expect(parsed).toMatchObject({
        schemaVersion: 1,
        range,
        // The most recent point in the fixture is 2 days before asOf --
        // dataAsOf reflects the actual data, not the requested asOf.
        dataAsOf: "2024-06-13",
        endDate: "2024-06-15",
        startingCapital: 20,
      });
      expect(typeof parsed.generatedAt).toBe("string");
      expect(Array.isArray(parsed.trades)).toBe(true);
    }
    expect(summary.results).toHaveLength(5);
  });

  it("is idempotent: running twice for the same day produces the same content", async () => {
    const fixtureData = new Map<string, DailyClose[]>([
      ["AAPL", [daily(daysBack(20), 10), daily(daysBack(1), 30)]],
    ]);
    const store = memoryStore();
    const run = () =>
      runPipeline({
        tickers: ["AAPL"],
        fetchDailyCloses: async (symbol) => fixtureData.get(symbol) ?? [],
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

  it("computes a single generatedAt for the whole run, shared across all 5 results", async () => {
    const fixtureData = new Map<string, DailyClose[]>([
      ["AAPL", [daily(daysBack(20), 10), daily(daysBack(1), 30)]],
    ]);
    const store = memoryStore();

    await runPipeline({
      tickers: ["AAPL"],
      fetchDailyCloses: async (symbol) => fixtureData.get(symbol) ?? [],
      store,
      asOf,
    });

    const generatedAts = new Set(
      [...store.objects.values()].map((body) => JSON.parse(body).generatedAt),
    );
    expect(generatedAts.size).toBe(1);
  });

  it("slices each ticker's history to the correct window per range", async () => {
    // Prices spread across 1M, 1Y, and beyond-5Y windows, each distinct
    // enough that the chosen range changes which points are visible.
    const fixtureData = new Map<string, DailyClose[]>([
      [
        "AAPL",
        [
          { date: "2015-01-01", close: 1 }, // only visible in MAX
          { date: "2022-01-01", close: 5 }, // visible in 5Y, MAX
          daily(daysBack(200), 8), // visible in 1Y, 5Y, MAX
          daily(daysBack(10), 50), // visible in every range
        ],
      ],
    ]);
    const store = memoryStore();

    await runPipeline({
      tickers: ["AAPL"],
      fetchDailyCloses: async (symbol) => fixtureData.get(symbol) ?? [],
      store,
      asOf,
    });

    const oneMonth = JSON.parse(store.objects.get("results/1M.json")!);
    const max = JSON.parse(store.objects.get("results/MAX.json")!);

    // 1M only has the single most-recent point -> no possible trade (need 2+ points).
    expect(oneMonth.trades).toEqual([]);
    expect(oneMonth.endingBalance).toBe(20);
    // MAX sees the full spread, from 1 up to 50 -> a very large multiplier is possible.
    expect(max.endingBalance).toBeGreaterThan(20);
  });

  it("excludes data points after the requested asOf, even if the fetch client returns them", async () => {
    // A fetch client that (incorrectly, or via Yahoo's own end-of-day
    // padding) returns a point after the requested asOf shouldn't leak
    // into the computed window.
    const fixtureData = new Map<string, DailyClose[]>([
      [
        "AAPL",
        [daily(daysBack(5), 10), daily(daysBack(0), 20), { date: "2024-06-16", close: 999 }],
      ],
    ]);
    const store = memoryStore();

    await runPipeline({
      tickers: ["AAPL"],
      fetchDailyCloses: async (symbol) => fixtureData.get(symbol) ?? [],
      store,
      asOf,
    });

    const max = JSON.parse(store.objects.get("results/MAX.json")!);
    expect(max.dataAsOf).toBe("2024-06-15"); // not 2024-06-16
    expect(max.trades.every((t: { sellDate: string }) => t.sellDate <= "2024-06-15")).toBe(true);
  });

  it("skips a ticker on TickerNotFoundError and continues, recording it as skipped", async () => {
    const store = memoryStore();

    const summary = await runPipeline({
      tickers: ["GOOD", "MISSING"],
      fetchDailyCloses: async (symbol) => {
        if (symbol === "MISSING") throw new TickerNotFoundError(symbol, "no data");
        return [daily(daysBack(20), 10), daily(daysBack(1), 40)];
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
      store,
      asOf,
    });

    expect(summary.skippedTickers).toEqual(["FLAKY"]);
  });

  it("aborts the entire run on BlockedError without writing any results", async () => {
    const store = memoryStore();

    await expect(
      runPipeline({
        tickers: ["AAPL", "MSFT"],
        fetchDailyCloses: async () => {
          throw new BlockedError("AAPL", 403);
        },
        store,
        asOf,
      }),
    ).rejects.toThrow(BlockedError);

    expect(store.objects.size).toBe(0);
  });

  it("aborts the entire run on UnexpectedResponseError without writing any results", async () => {
    const store = memoryStore();

    await expect(
      runPipeline({
        tickers: ["AAPL", "MSFT"],
        fetchDailyCloses: async () => {
          throw new UnexpectedResponseError("AAPL", 400);
        },
        store,
        asOf,
      }),
    ).rejects.toThrow(UnexpectedResponseError);

    expect(store.objects.size).toBe(0);
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
      store,
      asOf,
    }).catch(() => {
      // expected to reject; asserting on `attempted` below is the point
    });

    // Without the fix, all 20 tickers would eventually be attempted
    // (each of the 4 workers keeps pulling new work). With the fix,
    // workers stop pulling new tickers once the block is detected, so
    // only a small handful (bounded by concurrency + in-flight timing)
    // should ever have started.
    expect(attempted.length).toBeLessThan(tickers.length);
  });

  it("refuses to write empty results and throws when every ticker fails", async () => {
    const store = memoryStore();

    await expect(
      runPipeline({
        tickers: ["A", "B"],
        fetchDailyCloses: async (symbol) => {
          throw new TickerNotFoundError(symbol, "no data");
        },
        store,
        asOf,
      }),
    ).rejects.toThrow(/no ticker data/);

    expect(store.objects.size).toBe(0);
  });
});
