// Integration coverage for issue #47's write-time self-validation, kept
// in its own file (rather than folded into pipeline.test.ts) because it
// needs to mock @hadiknowntrades/core's validatePrecomputedResult for
// specific ranges -- doing that in pipeline.test.ts would affect every
// other test in that file, since vi.mock applies module-wide.
//
// results-schema.test.ts already covers validatePrecomputedResult's own
// pass/fail logic in isolation (valid/invalid WindowResult and
// IntradayResult fixtures); this file instead checks the *wiring*: that
// runPipeline calls it per-result immediately before that result's own
// putObject, and that a validation failure for one (or more) range(s)
// doesn't prevent the pipeline's other, still-valid ranges from writing
// (see apps/pipeline/CLAUDE.md's "write whatever succeeded, then still
// throw" guarantee, which this must not break) -- and that the write
// loop uses Promise.allSettled, not Promise.all, so (a) every valid
// range's write is actually given the chance to finish even when it's
// slower than a sibling range's near-instant validation failure, and
// (b) multiple simultaneous failures are ALL reported in the thrown
// error, not just the first one Promise.all would have surfaced.

import { toDateString, type DailyClose, type IntradayBar } from "@hadiknowntrades/core";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ failRanges: new Set<string>() }));

vi.mock("@hadiknowntrades/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@hadiknowntrades/core")>();
  return {
    ...actual,
    validatePrecomputedResult: (result: unknown) => {
      const range = (result as { range: string }).range;
      if (state.failRanges.has(range)) {
        throw new actual.ResultValidationError(`forced validation failure for ${range} (test)`);
      }
      return actual.validatePrecomputedResult(result as never);
    },
  };
});

import { runPipeline, type ResultStore } from "./pipeline.js";

const ASOF = new Date("2024-06-15T00:00:00Z");

function daysBack(days: number) {
  return (asOf: Date) => {
    const d = new Date(asOf);
    d.setUTCDate(d.getUTCDate() - days);
    return d;
  };
}

function daily(dateFromAsOf: (asOf: Date) => Date, close: number): DailyClose {
  return { date: toDateString(dateFromAsOf(ASOF)), close };
}

function bar(dateFromAsOf: (asOf: Date) => Date, time: string, close: number): IntradayBar {
  return { date: `${toDateString(dateFromAsOf(ASOF))}T${time}`, close };
}

/**
 * A configurable per-key delay lets a test simulate real S3 latency: a
 * range whose validation fails rejects almost instantly (validation is
 * synchronous), while a sibling range's putObject can be made to resolve
 * only after that rejection has already happened. Promise.allSettled
 * (unlike Promise.all) still waits for the delayed write to finish
 * before runPipeline decides anything -- this is what distinguishes the
 * two implementations in a way a delay-free store never could.
 */
function memoryStore(delays: Record<string, number> = {}): ResultStore & {
  objects: Map<string, string>;
} {
  const objects = new Map<string, string>();
  return {
    objects,
    async putObject(key, body) {
      const delay = delays[key] ?? 0;
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      objects.set(key, body);
    },
  };
}

const noIntradayData = async (): Promise<IntradayBar[]> => [];

afterEach(() => {
  state.failRanges = new Set();
});

describe("runPipeline: write-time self-validation (issue #47)", () => {
  it("throws before putObject for a result that fails self-validation, without blocking other, slower-to-write ranges", async () => {
    state.failRanges = new Set(["MAX"]);

    const dailyFixture = new Map<string, DailyClose[]>([
      ["AAPL", [daily(daysBack(2000), 1), daily(daysBack(200), 8), daily(daysBack(10), 50)]],
    ]);
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
    // Every valid range's write is deliberately slower than MAX's
    // near-instant validation failure -- with a plain Promise.all this
    // would race the rejection against these still-in-flight writes;
    // with Promise.allSettled (what runPipeline actually uses) every one
    // of these still lands in the store regardless.
    const store = memoryStore({
      "results/5Y.json": 20,
      "results/1M.json": 20,
      "results/3M.json": 20,
      "results/1Y.json": 20,
    });

    await expect(
      runPipeline({
        tickers: ["AAPL"],
        fetchDailyCloses: async (symbol) => dailyFixture.get(symbol) ?? [],
        fetchIntradayBars: async (symbol) => intradayFixture.get(symbol) ?? [],
        fetchFiveMinuteBars: noIntradayData,
        fetchIntraday1mBars: noIntradayData,
        store,
        asOf: ASOF,
      }),
    ).rejects.toThrow("forced validation failure for MAX");

    // The failing range's own key was never written...
    expect(store.objects.has("results/MAX.json")).toBe(false);
    // ...but every other, independently-valid (and deliberately slower)
    // range still was, exactly the "write whatever succeeded" guarantee
    // this must not break.
    expect(store.objects.has("results/5Y.json")).toBe(true);
    expect(store.objects.has("results/1M.json")).toBe(true);
    expect(store.objects.has("results/3M.json")).toBe(true);
    expect(store.objects.has("results/1Y.json")).toBe(true);
    expect(store.objects.size).toBe(4);
  });

  it("reports every independently-failing range, not just the first, while still writing every other valid range", async () => {
    // Two ranges fail self-validation in the same run -- both should
    // appear in the thrown error (a plain Promise.all, or a naive
    // "throw on the first rejection" loop, would only ever surface one).
    state.failRanges = new Set(["MAX", "1Y"]);

    const dailyFixture = new Map<string, DailyClose[]>([
      ["AAPL", [daily(daysBack(2000), 1), daily(daysBack(200), 8), daily(daysBack(10), 50)]],
    ]);
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
    const store = memoryStore({
      "results/5Y.json": 20,
      "results/1M.json": 20,
      "results/3M.json": 20,
    });

    let thrown: unknown;
    try {
      await runPipeline({
        tickers: ["AAPL"],
        fetchDailyCloses: async (symbol) => dailyFixture.get(symbol) ?? [],
        fetchIntradayBars: async (symbol) => intradayFixture.get(symbol) ?? [],
        fetchFiveMinuteBars: noIntradayData,
        fetchIntraday1mBars: noIntradayData,
        store,
        asOf: ASOF,
      });
      throw new Error("expected runPipeline to throw");
    } catch (error) {
      thrown = error;
    }

    const message = (thrown as Error).message;
    // Both forced failures are named, not just whichever happened to
    // reject first.
    expect(message).toMatch(/MAX: forced validation failure for MAX/);
    expect(message).toMatch(/1Y: forced validation failure for 1Y/);

    // Neither failing range's key was written...
    expect(store.objects.has("results/MAX.json")).toBe(false);
    expect(store.objects.has("results/1Y.json")).toBe(false);
    // ...but every other, independently-valid range still was.
    expect(store.objects.has("results/5Y.json")).toBe(true);
    expect(store.objects.has("results/1M.json")).toBe(true);
    expect(store.objects.has("results/3M.json")).toBe(true);
    expect(store.objects.size).toBe(3);
  });
});
