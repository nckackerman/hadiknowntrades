// Regression coverage for a third code-review round on issue #13's PR: an
// earlier version of buildIntradayResults (apps/pipeline/src/pipeline.ts)
// dropped a granularity override's own optimizeIntradayDays skippedDays on
// the floor -- captured only via `const { days: overrideDays } =
// optimizeIntradayDays(...)`, never threading `skippedDays` anywhere. That
// meant a genuine, non-overflow bug during an *override* day's solve
// (as opposed to the documented short-payoff overflow case) was silently
// non-fatal: reported only via optimizeIntradayDays' own console.error,
// never folded into this system's only real alerting mechanism (the
// aggregated `computeFailures` throw -- see apps/pipeline/CLAUDE.md's
// "Code review follow-up: issue #13 short-selling PR" section for the
// full reasoning on why an override *solve* failure needs the same
// fatality as a base-pass one, unlike an override *fetch* failure).
//
// Kept in its own file (mirroring pipeline.write-validation.test.ts's own
// precedent) because it needs to mock @hadiknowntrades/core's
// optimizeIntradayDays to force a specific, non-overflow exception on just
// the override pass -- vi.mock applies module-wide, so doing this in
// pipeline.test.ts would affect every other test there.

import { toDateString, type IntradayBar } from "@hadiknowntrades/core";
import { describe, expect, it, vi } from "vitest";

const ASOF = new Date("2024-06-15T00:00:00Z");

function daysBack(days: number) {
  return (asOf: Date) => {
    const d = new Date(asOf);
    d.setUTCDate(d.getUTCDate() - days);
    return d;
  };
}

const FORCED_FAILURE_DATE_STRING = toDateString(daysBack(5)(ASOF));
const FORCED_FAILURE_MESSAGE = "simulated non-overflow defect (test)";

vi.mock("@hadiknowntrades/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@hadiknowntrades/core")>();
  return {
    ...actual,
    optimizeIntradayDays: (
      barsByTicker: Map<string, IntradayBar[]>,
      options: { startingCapital: number; maxTradesPerDay: number; barIntervalMinutes: number },
    ) => {
      const real = actual.optimizeIntradayDays(barsByTicker, options);
      // Only the override (non-60-minute) pass is forced to fail --
      // deliberately NOT the base 60-minute pass, whose own fatal
      // treatment is already covered by pipeline.test.ts's "per-range/
      // per-day compute-failure containment" describe block, using a
      // real overflow trigger. This file specifically exercises a
      // *non-overflow* exception on the *override* pass -- the exact
      // gap the code review found -- by injecting a synthetic failure
      // into the real result's skippedDays, exactly as
      // optimizeIntradayDays' own try/catch would have if a genuine,
      // non-overflow bug had thrown while solving this date.
      if (options.barIntervalMinutes === 60) return real;
      return {
        days: real.days.filter((day) => day.date !== FORCED_FAILURE_DATE_STRING),
        skippedDays: [
          ...real.skippedDays,
          `${FORCED_FAILURE_DATE_STRING}: ${FORCED_FAILURE_MESSAGE}`,
        ],
      };
    },
  };
});

import { runPipeline, type ResultStore } from "./pipeline.js";

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

const noDailyData = async () => [];
const noIntradayData = async (): Promise<IntradayBar[]> => [];

async function rejectionOf(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected the promise to reject, but it resolved");
}

describe("runPipeline: granularity-override solve failures reach compute-failure alerting (code review follow-up to issue #13)", () => {
  it("fails the run over a non-overflow exception during the 5-minute override's own day solve, even though 3M's own stored output still falls back gracefully to 60-minute data for that day", async () => {
    // GOOD has real, solvable bars on both FORCED_FAILURE_DATE_STRING
    // (5 days back -- comfortably inside the 5-minute override's 59-day
    // lookback and 3M's own window) and a second, unaffected day (3 days
    // back), for both the base 60-minute fetch and the 5-minute override
    // fetch -- so the forced failure is a genuine "the override pass
    // tried to solve this date's real data and blew up," not "there was
    // never any data for it" (which would be the already-covered,
    // non-fatal fetch-failure case).
    const intradayFixture = new Map<string, IntradayBar[]>([
      [
        "GOOD",
        [
          bar(daysBack(5), "09:30:00", 10),
          bar(daysBack(5), "10:30:00", 12),
          bar(daysBack(3), "09:30:00", 10),
          bar(daysBack(3), "10:30:00", 20),
        ],
      ],
    ]);
    const store = memoryStore();

    const error = await rejectionOf(
      runPipeline({
        tickers: ["GOOD"],
        fetchDailyCloses: noDailyData,
        fetchIntradayBars: async (symbol) => intradayFixture.get(symbol) ?? [],
        fetchFiveMinuteBars: async (symbol) => intradayFixture.get(symbol) ?? [],
        fetchIntraday1mBars: noIntradayData,
        store,
        asOf: ASOF,
      }),
    );

    // The run still fails -- this system's only alerting mechanism (see
    // apps/pipeline/CLAUDE.md's top section) -- naming the override's own
    // label/range and the forced failure's exact message, not just a
    // console.error buried in CloudWatch.
    expect(error.message).toContain("Compute failures");
    expect(error.message).toContain(
      `5-minute override (3M): ${FORCED_FAILURE_DATE_STRING}: ${FORCED_FAILURE_MESSAGE}`,
    );

    // Containment still held: 3M's own stored result isn't missing the
    // affected day entirely -- mergeDaysByGranularity already falls back
    // to the base 60-minute day for any date the override doesn't cover,
    // so this date's *output* degrades gracefully even though the *run*
    // still fails for alerting. The unaffected day is present too,
    // proving the whole override pass wasn't taken down either.
    const threeMonth = JSON.parse(store.objects.get("results/3M.json")!);
    const dates = threeMonth.days.map((d: { date: string }) => d.date);
    expect(dates).toContain(FORCED_FAILURE_DATE_STRING);
    expect(dates).toContain(toDateString(daysBack(3)(ASOF)));
  });
});
