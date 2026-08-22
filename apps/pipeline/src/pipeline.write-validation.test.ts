// Integration coverage for issue #47's write-time self-validation, kept
// in its own file (rather than folded into pipeline.test.ts) because it
// needs to mock @hadiknowntrades/core's validatePrecomputedResult for
// one specific range -- doing that in pipeline.test.ts would affect
// every other test in that file, since vi.mock applies module-wide.
//
// results-schema.test.ts already covers validatePrecomputedResult's own
// pass/fail logic in isolation (valid/invalid WindowResult and
// IntradayResult fixtures); this file instead checks the *wiring*: that
// runPipeline calls it per-result immediately before that result's own
// putObject, and that a validation failure for one range doesn't
// prevent the pipeline's other, still-valid ranges from writing (see
// apps/pipeline/CLAUDE.md's "write whatever succeeded, then still
// throw" guarantee, which this must not break).

import { toDateString, type DailyClose, type IntradayBar } from "@hadiknowntrades/core";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ failRange: null as string | null }));

vi.mock("@hadiknowntrades/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@hadiknowntrades/core")>();
  return {
    ...actual,
    validatePrecomputedResult: (result: unknown) => {
      const range = (result as { range: string }).range;
      if (range === state.failRange) {
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

afterEach(() => {
  state.failRange = null;
});

describe("runPipeline: write-time self-validation (issue #47)", () => {
  it("throws before putObject for a result that fails self-validation, without blocking other ranges' writes", async () => {
    state.failRange = "MAX";

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
    const store = memoryStore();

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
    // ...but every other, independently-valid range still was, exactly
    // the "write whatever succeeded" guarantee this must not break.
    expect(store.objects.has("results/5Y.json")).toBe(true);
    expect(store.objects.has("results/1M.json")).toBe(true);
    expect(store.objects.has("results/3M.json")).toBe(true);
    expect(store.objects.has("results/1Y.json")).toBe(true);
    expect(store.objects.size).toBe(4);
  });
});
