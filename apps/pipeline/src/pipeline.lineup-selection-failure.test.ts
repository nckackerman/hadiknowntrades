// Regression coverage for a code-review finding on PR #211 (issue #208):
// buildLineupResult()'s own call site in runPipeline used to run with no
// try/catch, before any write job runs -- so an unexpected throw from
// selectLineupTickers/mergeLineupHistory (e.g. a genuine bug, not the
// "known" too-few-candidates outcome buildLineupResult already reports
// gracefully via its own return value) would propagate out of
// runPipeline entirely, aborting the whole nightly run before any
// preset-range/custom-anchor/Beat-the-Bench write job ever got a chance
// to run. A bug confined to this brand-new feature could otherwise break
// a nightly run for every other, already-working game type.
//
// Kept in its own file, mirroring pipeline.write-validation.test.ts's
// own precedent, since it needs to mock @hadiknowntrades/core's
// selectLineupTickers specifically -- doing that in pipeline.lineup.test.ts
// (or pipeline.test.ts) would affect every other test in that file,
// since vi.mock applies module-wide.
//
// pipeline.lineup.test.ts already covers readLineupHistory's own real
// error-propagation fix (a store whose getObject throws a genuine,
// non-missing-key failure) being contained one level up, at this exact
// same call site -- this file covers the sibling case: a throw from the
// selection/merge logic itself, once a real history read has already
// succeeded.

import { toDateString, type DailyClose, type IntradayBar } from "@hadiknowntrades/core";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ forceThrow: false }));

vi.mock("@hadiknowntrades/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@hadiknowntrades/core")>();
  return {
    ...actual,
    selectLineupTickers: (
      ...args: Parameters<typeof actual.selectLineupTickers>
    ): ReturnType<typeof actual.selectLineupTickers> => {
      if (state.forceThrow) {
        throw new Error("simulated unexpected selectLineupTickers failure (test)");
      }
      return actual.selectLineupTickers(...args);
    },
  };
});

import { runPipeline, type ResultStore } from "./pipeline.js";

const ASOF = new Date("2026-08-27T12:00:00Z");

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
    async getObject() {
      return null;
    },
  };
}

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
const noIntradayData = async (): Promise<IntradayBar[]> => [];

afterEach(() => {
  state.forceThrow = false;
});

describe("runPipeline: an unexpected Lineup-selection throw is contained (code review follow-up, issue #208)", () => {
  it("does not abort the run -- every other write job still lands, and no Lineup data is written this run", async () => {
    state.forceThrow = true;
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

    // The run itself did not throw -- a Lineup-selection failure (even a
    // genuinely unexpected exception, not just the "known" too-few-
    // candidates outcome) is non-fatal, same posture as a Beat the Bench
    // session-fetch failure.
    expect(summary.results.length).toBeGreaterThan(0);
    // Every real preset-range write job still landed, confirming the
    // rest of the run genuinely wasn't taken down by this.
    expect(store.objects.has("results/5Y.json")).toBe(true);
    expect(store.objects.has("results/MAX.json")).toBe(true);
    expect(store.objects.has("results/1W.json")).toBe(true);
    expect(store.objects.has("results/1M.json")).toBe(true);
    expect(store.objects.has("results/3M.json")).toBe(true);
    expect(store.objects.has("results/1Y.json")).toBe(true);

    // No Lineup data was written this run -- the failure was contained,
    // not silently ignored into a half-built write.
    expect([...store.objects.keys()].some((key) => key.startsWith("results/lineup/"))).toBe(false);
  });

  it("does not wedge a subsequent run -- the mocked failure clears and the next run's selection call proceeds normally (no throw)", async () => {
    state.forceThrow = true;
    const store = memoryStore();
    await runPipeline({
      tickers: ["AAPL"],
      fetchDailyCloses: async (symbol) => dailyFixture.get(symbol) ?? [],
      fetchIntradayBars: async (symbol) => intradayFixture.get(symbol) ?? [],
      fetchFiveMinuteBars: noIntradayData,
      fetchIntraday1mBars: noIntradayData,
      store,
      asOf: ASOF,
    });

    // Once the underlying failure clears, the very next run's own
    // selection call goes through the real (non-throwing)
    // selectLineupTickers again -- containment on one run must not leave
    // any dangling state that breaks a later run.
    state.forceThrow = false;
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
    ).resolves.toBeDefined();
  });
});
