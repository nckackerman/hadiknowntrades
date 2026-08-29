// Issue #208's coverage for The Lineup's daily-selection pipeline
// integration: buildLineupResult's own wiring into runPipeline (which
// day gets picked, the repeat-avoidance history round-trip, the
// non-fatal degrade when too few real candidates exist, and the
// getObject-unsupported-store fallback). The pure selection algorithm
// itself (packages/core's selectLineupTickers/mergeLineupHistory) is
// covered directly in packages/core/src/lineup-selection.test.ts -- this
// file only exercises the pipeline's own plumbing around it: reading
// prior history back via ResultStore.getObject, writing the two new
// objects, and folding a selection failure into the aggregated
// non-fatal status line rather than the run.
//
// Kept in its own file, mirroring pipeline.beat-the-bench.test.ts's own
// precedent, since it drives runPipeline with its own fixture shape
// (real 3-/4-letter S&P 500 tickers, chosen for known abs-return
// ordering) unrelated to pipeline.test.ts's.

import {
  LINEUP_HISTORY_KEY,
  LINEUP_LATEST_KEY,
  lineupResultKey,
  RESULTS_SCHEMA_VERSION,
  toDateString,
  type DailyClose,
  type IntradayBar,
} from "@hadiknowntrades/core";
import { describe, expect, it } from "vitest";

import { runPipeline, type ResultStore } from "./pipeline.js";

const ASOF = new Date("2026-08-27T12:00:00Z");

function daysBack(days: number) {
  return (asOf: Date) => {
    const d = new Date(asOf);
    d.setUTCDate(d.getUTCDate() - days);
    return d;
  };
}

const DAY = toDateString(daysBack(1)(ASOF));
const PREVIOUS_DAY = toDateString(daysBack(2)(ASOF));

/** Six real S&P 500 3-/4-letter tickers with known, distinct abs-return ordering -- the smallest (AFL, 0.5%) always falls out of the top 5. */
function dailyFixture(): Map<string, DailyClose[]> {
  const closes: Record<string, [previous: number, today: number]> = {
    AEE: [100, 150], // +50% -- biggest mover
    ALL: [100, 80], // -20%
    AES: [100, 90], // -10%
    AMGN: [100, 105], // +5%
    ACN: [100, 101], // +1%
    AFL: [100, 100.5], // +0.5% -- smallest, drops out of the top 5
  };
  const map = new Map<string, DailyClose[]>();
  for (const [ticker, [previous, today]] of Object.entries(closes)) {
    map.set(ticker, [
      { date: PREVIOUS_DAY, close: previous },
      { date: DAY, close: today },
    ]);
  }
  return map;
}

const TICKERS = ["AEE", "ALL", "AES", "AMGN", "ACN", "AFL"];
const EXPECTED_ORDER = ["AEE", "ALL", "AES", "AMGN", "ACN"];

const noIntradayData = async () => [];

/**
 * A couple of real-shaped 60-minute bars, the same for every ticker --
 * irrelevant to what's under test (The Lineup's own selection is purely
 * a window-path/daily-close computation), but needed so the intraday
 * path also produces usable data. Without this, `fetchIntradayBars`
 * returning nothing for every ticker trips runPipeline's own "neither/
 * either path produced usable data" fatal check, which would fail these
 * tests for a reason that has nothing to do with The Lineup.
 */
async function someIntradayBars(): Promise<IntradayBar[]> {
  return [
    { date: `${PREVIOUS_DAY}T09:30:00`, close: 10 },
    { date: `${PREVIOUS_DAY}T10:30:00`, close: 11 },
  ];
}

function memoryStore(
  seed: Record<string, string> = {},
): ResultStore & { objects: Map<string, string> } {
  const objects = new Map<string, string>(Object.entries(seed));
  return {
    objects,
    async putObject(key, body) {
      objects.set(key, body);
    },
    async getObject(key) {
      return objects.get(key) ?? null;
    },
  };
}

describe("The Lineup (issue #208)", () => {
  it("writes a LineupResult for the window path's own most recent trading day, and folds it into a fresh LineupHistory", async () => {
    const fixture = dailyFixture();
    const store = memoryStore();

    await runPipeline({
      tickers: TICKERS,
      fetchDailyCloses: async (symbol) => fixture.get(symbol) ?? [],
      fetchIntradayBars: someIntradayBars,
      fetchFiveMinuteBars: noIntradayData,
      fetchIntraday1mBars: noIntradayData,
      store,
      asOf: ASOF,
    });

    expect(store.objects.has(lineupResultKey(DAY))).toBe(true);
    const result = JSON.parse(store.objects.get(lineupResultKey(DAY))!);
    expect(result.schemaVersion).toBe(RESULTS_SCHEMA_VERSION);
    expect(result.date).toBe(DAY);
    expect(result.tickers).toEqual(EXPECTED_ORDER);

    // Byte-identical, under the fixed "latest" key apps/web actually reads.
    expect(store.objects.get(LINEUP_LATEST_KEY)).toBe(store.objects.get(lineupResultKey(DAY)));

    expect(store.objects.has(LINEUP_HISTORY_KEY)).toBe(true);
    const history = JSON.parse(store.objects.get(LINEUP_HISTORY_KEY)!);
    expect(history.schemaVersion).toBe(RESULTS_SCHEMA_VERSION);
    expect(history.entries).toEqual([{ date: DAY, tickers: EXPECTED_ORDER }]);
  });

  it("reads back a prior run's history via ResultStore.getObject and avoids repeating a recently-published ticker", async () => {
    const fixture = dailyFixture();
    const priorDate = toDateString(daysBack(3)(ASOF)); // well within the 14-day repeat-avoidance window
    const seededHistory = {
      schemaVersion: RESULTS_SCHEMA_VERSION,
      generatedAt: "2026-08-24T06:00:00.000Z",
      entries: [{ date: priorDate, tickers: ["AEE", "XYZ", "WMT", "GEV", "DOW"] }],
    };
    const store = memoryStore({ [LINEUP_HISTORY_KEY]: JSON.stringify(seededHistory) });

    await runPipeline({
      tickers: TICKERS,
      fetchDailyCloses: async (symbol) => fixture.get(symbol) ?? [],
      fetchIntradayBars: someIntradayBars,
      fetchFiveMinuteBars: noIntradayData,
      fetchIntraday1mBars: noIntradayData,
      store,
      asOf: ASOF,
    });

    const result = JSON.parse(store.objects.get(lineupResultKey(DAY))!);
    // AEE (the biggest real mover) was published 3 days ago -- excluded,
    // so the next-best mover (AFL, the one that otherwise drops out)
    // takes its place.
    expect(result.tickers).not.toContain("AEE");
    expect(result.tickers).toEqual(["ALL", "AES", "AMGN", "ACN", "AFL"]);

    // The merged history keeps the seeded entry AND adds today's --
    // ascending by date, no duplication.
    const history = JSON.parse(store.objects.get(LINEUP_HISTORY_KEY)!);
    expect(history.entries).toEqual([
      { date: priorDate, tickers: ["AEE", "XYZ", "WMT", "GEV", "DOW"] },
      { date: DAY, tickers: ["ALL", "AES", "AMGN", "ACN", "AFL"] },
    ]);
  });

  it("degrades non-fatally (no throw, nothing written) when fewer than 5 real candidates exist -- a small local-dev ticker sample, not a production shape", async () => {
    const store = memoryStore();
    const smallFixture = new Map<string, DailyClose[]>([
      [
        "AAPL",
        [
          { date: PREVIOUS_DAY, close: 100 },
          { date: DAY, close: 101 },
        ],
      ],
    ]);

    const summary = await runPipeline({
      tickers: ["AAPL"],
      fetchDailyCloses: async (symbol) => smallFixture.get(symbol) ?? [],
      fetchIntradayBars: someIntradayBars,
      fetchFiveMinuteBars: noIntradayData,
      fetchIntraday1mBars: noIntradayData,
      store,
      asOf: ASOF,
    });

    // The run itself still succeeds -- a Lineup selection failure is
    // non-fatal, same posture as a Beat the Bench session-fetch failure.
    expect(summary.results.length).toBeGreaterThan(0);
    expect(store.objects.has(lineupResultKey(DAY))).toBe(false);
    expect(store.objects.has(LINEUP_LATEST_KEY)).toBe(false);
    expect(store.objects.has(LINEUP_HISTORY_KEY)).toBe(false);
  });

  it("treats a store with no getObject method as having no prior history, rather than throwing", async () => {
    const fixture = dailyFixture();
    const objects = new Map<string, string>();
    // Deliberately omits getObject -- exercises ResultStore's own
    // optional-method fallback (see readLineupHistory's doc comment),
    // not memoryStore's usual shape.
    const store: ResultStore = {
      async putObject(key, body) {
        objects.set(key, body);
      },
    };

    await runPipeline({
      tickers: TICKERS,
      fetchDailyCloses: async (symbol) => fixture.get(symbol) ?? [],
      fetchIntradayBars: someIntradayBars,
      fetchFiveMinuteBars: noIntradayData,
      fetchIntraday1mBars: noIntradayData,
      store,
      asOf: ASOF,
    });

    const result = JSON.parse(objects.get(lineupResultKey(DAY))!);
    expect(result.tickers).toEqual(EXPECTED_ORDER);
    const history = JSON.parse(objects.get(LINEUP_HISTORY_KEY)!);
    expect(history.entries).toEqual([{ date: DAY, tickers: EXPECTED_ORDER }]);
  });
});
