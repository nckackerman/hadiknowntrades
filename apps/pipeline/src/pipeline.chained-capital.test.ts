// Focused coverage for issue #84's chaining post-processing pass
// (chainStartingCapital, apps/pipeline/src/pipeline.ts), kept in its own
// file per this codebase's own "small, dedicated file for a risky new
// mechanism" precedent (see pipeline.merge-fallback.test.ts,
// pipeline.override-solve-failure.test.ts). pipeline.test.ts's own
// "chains startingCapital across days" test covers the basic two-day
// case inline; this file goes deeper: day-0 root equality across all
// four tracks, cross-day chaining equality for all four tracks, that the
// four tracks genuinely drift independently (not accidentally sharing
// one running balance), that each range chains fresh from its *own*
// first day rather than a shared global first day, and that 5Y/MAX
// (the window model) are completely unaffected.

import {
  optimizeIntradayDays,
  toDateString,
  type DailyClose,
  type IntradayBar,
} from "@hadiknowntrades/core";
import { describe, expect, it } from "vitest";

import { runPipeline, type ResultStore } from "./pipeline.js";

const ASOF = new Date("2024-06-15T00:00:00Z");

function daysBack(days: number) {
  return (asOf: Date) => {
    const d = new Date(asOf);
    d.setUTCDate(d.getUTCDate() - days);
    return d;
  };
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

// Three trading days, deliberately spread so 1M and 1Y cover different
// subsets of them (1M's own ~29-31 day window doesn't reach the oldest
// one) -- this is what lets this file prove each range chains fresh from
// its *own* first day, not from wherever a shared underlying day array's
// global first day happens to be. Two tickers per day, with genuinely
// different gains/losses, so the four tracks (long-only best/worst,
// long+short best/worst) have real room to diverge from each other
// instead of being forced to pick the same single candidate trade.
const INTRADAY_FIXTURE = new Map<string, IntradayBar[]>([
  [
    "AAPL",
    [
      bar(daysBack(60), "09:30:00", 10),
      bar(daysBack(60), "10:30:00", 15), // 1.5x
      bar(daysBack(10), "09:30:00", 10),
      bar(daysBack(10), "10:30:00", 18), // 1.8x
      bar(daysBack(5), "09:30:00", 10),
      bar(daysBack(5), "10:30:00", 6), // 0.6x (a loss)
    ],
  ],
  [
    "MSFT",
    [
      bar(daysBack(60), "09:30:00", 20),
      bar(daysBack(60), "10:30:00", 16), // 0.8x (a loss)
      bar(daysBack(10), "09:30:00", 20),
      bar(daysBack(10), "10:30:00", 12), // 0.6x (a loss)
      bar(daysBack(5), "09:30:00", 20),
      bar(daysBack(5), "10:30:00", 30), // 1.5x
    ],
  ],
]);

function daily(dateFromAsOf: (asOf: Date) => Date, close: number): DailyClose {
  return { date: toDateString(dateFromAsOf(ASOF)), close };
}

// A minimal, real window-path fixture -- this file's "5Y/MAX unaffected"
// test needs the window path to actually produce results (an entirely
// empty window fetch makes runPipeline skip writing 5Y/MAX at all, the
// same "zero usable data" behavior pipeline.test.ts's own "still fails
// the run" tests already document), even though nothing about this
// file's actual subject (chaining) touches this data at all.
const DAILY_FIXTURE = new Map<string, DailyClose[]>([
  ["AAPL", [daily(daysBack(2000), 5), daily(daysBack(10), 50)]],
  ["MSFT", [daily(daysBack(2000), 100), daily(daysBack(10), 120)]],
]);

async function runFixturePipeline() {
  const store = memoryStore();
  await runPipeline({
    tickers: ["AAPL", "MSFT"],
    fetchDailyCloses: async (symbol) => DAILY_FIXTURE.get(symbol) ?? [],
    fetchIntradayBars: async (symbol) => INTRADAY_FIXTURE.get(symbol) ?? [],
    fetchFiveMinuteBars: noIntradayData,
    fetchIntraday1mBars: noIntradayData,
    store,
    asOf: ASOF,
  });
  return store;
}

/** One track's own (startingCapital, endingBalance) pair, read generically from a parsed day object via a field-path prefix ("" for long-only, "worstCase", "longShort", "longShort.worstCase"). */
function trackAt(
  day: Record<string, unknown>,
  path: string,
): { startingCapital: number; endingBalance: number } {
  let node: Record<string, unknown> = day;
  if (path !== "") {
    for (const segment of path.split(".")) {
      node = node[segment] as Record<string, unknown>;
    }
  }
  return {
    startingCapital: node.startingCapital as number,
    endingBalance: node.endingBalance as number,
  };
}

const TRACKS = ["", "worstCase", "longShort", "longShort.worstCase"] as const;

describe("issue #84: chained per-day starting capital", () => {
  it("day 0 of every range starts every one of the four tracks at the range's own root startingCapital", async () => {
    const store = await runFixturePipeline();
    for (const range of ["1M", "1Y"]) {
      const parsed = JSON.parse(store.objects.get(`results/${range}.json`)!);
      const day0 = parsed.days[0];
      for (const track of TRACKS) {
        expect(trackAt(day0, track).startingCapital).toBe(parsed.startingCapital);
      }
    }
  });

  it("day N (N > 0) starts every one of the four tracks at day N-1's own ending balance for that same track, never a fresh reset and never another track's value", async () => {
    const store = await runFixturePipeline();
    const oneYear = JSON.parse(store.objects.get("results/1Y.json")!);
    expect(oneYear.days).toHaveLength(3);

    for (let i = 1; i < oneYear.days.length; i++) {
      const day = oneYear.days[i];
      const prevDay = oneYear.days[i - 1];
      for (const track of TRACKS) {
        const { startingCapital } = trackAt(day, track);
        const { endingBalance: prevEndingBalance } = trackAt(prevDay, track);
        expect(startingCapital).toBeCloseTo(prevEndingBalance, 9);
      }
    }
  });

  it("each track's own chained ratio for a given day matches what an independent, freshly-run optimizeIntradayDays computes for that day alone -- chaining only threads capital across days, it never changes which trades win", async () => {
    const store = await runFixturePipeline();
    const oneYear = JSON.parse(store.objects.get("results/1Y.json")!);

    // startingCapital: 1 makes endingBalance numerically equal to the
    // ratio itself (endingBalance / startingCapital), for every track.
    const { days: unchainedDays } = optimizeIntradayDays(INTRADAY_FIXTURE, {
      startingCapital: 1,
      maxTradesPerDay: 3,
      barIntervalMinutes: 60,
    });
    const unchainedByDate = new Map(unchainedDays.map((d) => [d.date, d]));

    for (const day of oneYear.days) {
      const unchained = unchainedByDate.get(day.date)!;
      for (const track of TRACKS) {
        const chainedRatio =
          trackAt(day, track).endingBalance / trackAt(day, track).startingCapital;
        const expectedRatio = trackAt(
          unchained as unknown as Record<string, unknown>,
          track,
        ).endingBalance;
        expect(chainedRatio).toBeCloseTo(expectedRatio, 9);
      }
    }
  });

  it("the four tracks genuinely drift independently -- not all four end at the same chained balance", async () => {
    const store = await runFixturePipeline();
    const oneYear = JSON.parse(store.objects.get("results/1Y.json")!);
    const finalDay = oneYear.days.at(-1);

    const finalBalances = TRACKS.map((track) => trackAt(finalDay, track).endingBalance);
    const distinctBalances = new Set(finalBalances.map((b) => b.toFixed(6)));
    // With genuinely different per-track ratios across 3 days (this
    // fixture's own design -- see its header comment), the four tracks'
    // cumulative products essentially never coincide by chance; a single
    // shared value across all four would indicate the chaining pass
    // accidentally threaded one track's balance into another's.
    expect(distinctBalances.size).toBeGreaterThan(1);
  });

  it("each range chains fresh from its own first day, not from a shared global first day -- 1M's day 0 starts at the root capital even though 1Y's day 0 (an older day outside 1M's window) does not equal it after chaining", async () => {
    const store = await runFixturePipeline();
    const oneMonth = JSON.parse(store.objects.get("results/1M.json")!);
    const oneYear = JSON.parse(store.objects.get("results/1Y.json")!);

    // 1M's window (~29-31 days) doesn't reach the oldest fixture day
    // (60 days back), so 1M's own day array is a strict, different-
    // first-day subset of 1Y's.
    expect(oneMonth.days).toHaveLength(2);
    expect(oneYear.days).toHaveLength(3);
    expect(oneMonth.days[0].date).not.toBe(oneYear.days[0].date);

    // 1M's own day 0 (the middle of 1Y's three days) still starts fresh
    // at the root capital -- it did NOT inherit 1Y's chained balance
    // for that same calendar date, which is higher (chained through the
    // oldest day first).
    expect(oneMonth.days[0].startingCapital).toBe(oneMonth.startingCapital);
    const sameDateInOneYear = oneYear.days.find(
      (d: { date: string }) => d.date === oneMonth.days[0].date,
    );
    expect(sameDateInOneYear).toBeDefined();
    expect(sameDateInOneYear.startingCapital).not.toBe(oneMonth.days[0].startingCapital);
  });

  it("5Y/MAX (the window model) are completely unaffected by chaining -- no days[] field, and their own startingCapital is the flat configured root, never chained", async () => {
    const store = await runFixturePipeline();
    for (const range of ["5Y", "MAX"]) {
      const parsed = JSON.parse(store.objects.get(`results/${range}.json`)!);
      expect(parsed.model).toBe("window");
      expect(parsed.days).toBeUndefined();
      expect(parsed.startingCapital).toBe(20);
    }
  });
});
