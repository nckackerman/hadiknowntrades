// Regression coverage for a code-review-caught crash risk in
// mergeDayVariants (apps/pipeline/src/pipeline.ts, ~line 569 as of the
// review): it picks the long-only bundle and the long+short bundle for a
// merged intraday day *independently*, each from whichever of the two
// source granularities wins that bundle's own endingBalance comparison,
// then defensively re-checks the two results-schema.ts-style cross-checks
// (`longShort.endingBalance >= endingBalance`,
// `longShort.worstCase.endingBalance <= worstCase.endingBalance`). A prior
// version threw a bare Error on violation, with no try/catch anywhere
// between this function and buildIntradayResults -- a real violation
// would have crashed the *entire* runPipeline invocation, discarding
// every other already-computed range's and day's results too.
//
// apps/pipeline/CLAUDE.md's own "mergeDaysByGranularity and long+short"
// section documents the corrected proof: the cross-check this test
// exercises (the worstCase one) is provably safe *by construction* for
// any real optimizeAllVariants/optimizeIntradayDays output (confirmed
// both by a corrected hand proof and a 20,000-trial randomized brute-force
// check against the real optimizer, 0 violations) -- so this scenario
// cannot arise organically from real price data. This file forces it
// anyway, via a mocked optimizeIntradayDays returning two hand-crafted,
// internally-self-consistent-but-mutually-incompatible day results (the
// same shape as the code review's own counterexample), specifically to
// exercise the *defense-in-depth* fallback path: if this proof or one of
// its premises is ever wrong in the future, the run must degrade
// gracefully (fall back to one source's day wholesale, fail the run via
// the normal alerting channel) instead of crashing.
//
// Kept in its own file (mirroring pipeline.override-solve-failure.test.ts's
// own precedent) because it needs to mock @hadiknowntrades/core's
// optimizeIntradayDays to inject exact, hand-picked numbers -- vi.mock
// applies module-wide, so doing this in pipeline.test.ts would affect
// every other test there.

import {
  toDateString,
  type IntradayBar,
  type IntradayDayResult,
  type IntradayTrade,
} from "@hadiknowntrades/core";
import { describe, expect, it, vi } from "vitest";

const ASOF = new Date("2024-06-15T00:00:00Z");

function daysBack(days: number) {
  return (asOf: Date) => {
    const d = new Date(asOf);
    d.setUTCDate(d.getUTCDate() - days);
    return d;
  };
}

const FORCED_DATE = toDateString(daysBack(5)(ASOF));
const STARTING_CAPITAL = 20;

function trade(ticker: string, openPrice: number, closePrice: number): IntradayTrade {
  return {
    ticker,
    direction: "long",
    date: FORCED_DATE,
    openTime: "09:30:00",
    openPrice,
    closeTime: "10:30:00",
    closePrice,
  };
}

// The base 60-minute source's own day for FORCED_DATE: wins the long-only
// slot (200 > the override's 100 below), has a real long-only worst-case
// loss (50), and its own longShort bundle is internally self-consistent
// (220 >= 200, 40 <= 50) but loses the longShort slot to the override
// below (220 < 300).
const BASE_DAY: IntradayDayResult = {
  date: FORCED_DATE,
  startingCapital: STARTING_CAPITAL,
  endingBalance: 200,
  barIntervalMinutes: 60,
  trades: [trade("GOOD", 10, 100)],
  worstCase: {
    startingCapital: STARTING_CAPITAL,
    endingBalance: 50,
    trades: [trade("GOOD", 100, 25)],
  },
  longShort: {
    startingCapital: STARTING_CAPITAL,
    endingBalance: 220,
    trades: [trade("GOOD", 10, 110)],
    worstCase: {
      startingCapital: STARTING_CAPITAL,
      endingBalance: 40,
      trades: [trade("GOOD", 100, 20)],
    },
  },
};

// The 5-minute override source's own day for the *same* FORCED_DATE, from
// a different ticker (a realistic granularity-override scenario -- the
// two fetches can see different ticker universes for the same day, see
// apps/pipeline/CLAUDE.md's "Granularity overrides" section): loses the
// long-only slot to BASE_DAY (100 < 200), but wins the longShort slot
// (300 > 220). Its own longShort.worstCase (60) is <= its own longShort
// bundle's own worst (65) -- satisfies this source's own internal
// invariant -- but 60 > BASE_DAY.worstCase.endingBalance (50), which is
// exactly the cross-source combination mergeDayVariants' defense-in-depth
// check exists to catch. (This exact combination cannot come from a real
// optimizeAllVariants call -- see this file's own header comment -- hence
// forcing it here via a mock instead of real price data.)
const OVERRIDE_DAY: IntradayDayResult = {
  date: FORCED_DATE,
  startingCapital: STARTING_CAPITAL,
  endingBalance: 100,
  barIntervalMinutes: 5,
  trades: [trade("OTHER", 10, 50)],
  worstCase: {
    startingCapital: STARTING_CAPITAL,
    endingBalance: 65,
    trades: [trade("OTHER", 100, 92.85714285714286)],
  },
  longShort: {
    startingCapital: STARTING_CAPITAL,
    endingBalance: 300,
    trades: [trade("OTHER", 100, 5)],
    worstCase: {
      startingCapital: STARTING_CAPITAL,
      endingBalance: 60,
      trades: [trade("OTHER", 100, 84.61538461538461)],
    },
  },
};

vi.mock("@hadiknowntrades/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@hadiknowntrades/core")>();
  return {
    ...actual,
    optimizeIntradayDays: (
      barsByTicker: Map<string, IntradayBar[]>,
      options: { startingCapital: number; maxTradesPerDay: number; barIntervalMinutes: number },
    ) => {
      if (options.barIntervalMinutes === 60) return { days: [BASE_DAY], skippedDays: [] };
      if (options.barIntervalMinutes === 5) return { days: [OVERRIDE_DAY], skippedDays: [] };
      // The 1-minute (1M) override: no fixture data is provided for it
      // in this test, so let the real implementation run over whatever
      // (empty) bars it's given -- this scenario is specific to 3M's
      // 5-minute override, not 1M's.
      return actual.optimizeIntradayDays(barsByTicker, options);
    },
  };
});

import { runPipeline, type ResultStore } from "./pipeline.js";

function memoryStore(): ResultStore & { objects: Map<string, string> } {
  const objects = new Map<string, string>();
  return {
    objects,
    async putObject(key, body) {
      objects.set(key, body);
    },
  };
}

const noDailyData = async (): Promise<never[]> => [];
const noIntradayData = async (): Promise<IntradayBar[]> => [];

async function rejectionOf(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected the promise to reject, but it resolved");
}

// Real (if uninteresting) bars, just so the underlying fetch paths
// succeed and buildIntradayResults actually gets a chance to run -- the
// mocked optimizeIntradayDays above ignores this data entirely and
// always returns BASE_DAY/OVERRIDE_DAY regardless of what's fetched.
const intradayFixture = new Map<string, IntradayBar[]>([
  ["GOOD", [{ date: `${FORCED_DATE}T09:30:00`, close: 10 }]],
  ["OTHER", [{ date: `${FORCED_DATE}T09:30:00`, close: 10 }]],
]);

describe("runPipeline: mergeDayVariants' cross-check violation is contained, not a crash (code review follow-up)", () => {
  it("falls back to the long-only winner's own day wholesale, reports the violation as a fatal compute failure, and never lets the throw propagate out of runPipeline uncontained", async () => {
    const store = memoryStore();

    const error = await rejectionOf(
      runPipeline({
        tickers: ["GOOD", "OTHER"],
        fetchDailyCloses: noDailyData,
        fetchIntradayBars: async (symbol) => intradayFixture.get(symbol) ?? [],
        fetchFiveMinuteBars: async (symbol) => intradayFixture.get(symbol) ?? [],
        fetchIntraday1mBars: noIntradayData,
        store,
        asOf: ASOF,
      }),
    );

    // The run still fails -- this is genuinely worth alerting on (see
    // this file's own header comment) -- naming the override and the
    // forced date, not just a console.error buried in CloudWatch.
    expect(error.message).toContain("Compute failures");
    expect(error.message).toContain(`5-minute override (3M): ${FORCED_DATE}`);
    expect(error.message).toContain("cross-source merge would have violated");

    // Containment held: this wasn't a bare throw that aborted the whole
    // run before anything could write. 3M's own result was still
    // computed and written, with the forced date present (not dropped).
    const threeMonth = JSON.parse(store.objects.get("results/3M.json")!);
    const day = threeMonth.days.find((d: { date: string }) => d.date === FORCED_DATE);
    expect(day).toBeDefined();

    // The fallback used BASE_DAY (the long-only winner) wholesale for
    // *both* bundles -- OVERRIDE_DAY's higher longShort figures (300/60)
    // were discarded entirely rather than partially mixed in, which is
    // exactly what keeps this fallback trivially safe.
    expect(day.endingBalance).toBe(200);
    expect(day.worstCase.endingBalance).toBe(50);
    expect(day.longShort.endingBalance).toBe(220);
    expect(day.longShort.worstCase.endingBalance).toBe(40);
    expect(day.trades[0].ticker).toBe("GOOD");
    expect(day.longShort.trades[0].ticker).toBe("GOOD");

    // The written day still satisfies both of results-schema.ts's own
    // write-time cross-checks (it passed validatePrecomputedResult to
    // even get written at all, but re-asserted here for clarity).
    expect(day.longShort.endingBalance).toBeGreaterThanOrEqual(day.endingBalance);
    expect(day.longShort.worstCase.endingBalance).toBeLessThanOrEqual(day.worstCase.endingBalance);

    // The other intraday-path ranges (sharing the same buildIntradayResults
    // call, but with no override of their own to trip this) still wrote
    // too -- one range's compute failure didn't take down the rest of
    // the intraday path's writes. (5Y/MAX use the separate window path,
    // which this test's fetchDailyCloses deliberately starves of data --
    // irrelevant to what's under test here.)
    expect(store.objects.has("results/1Y.json")).toBe(true);
    expect(store.objects.has("results/1M.json")).toBe(true);
  });
});
