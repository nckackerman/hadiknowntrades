import { describe, expect, it } from "vitest";

import type { DailyClose } from "@hadiknowntrades/core";

import { SPY_DAILY_CLOSES } from "../test-fixtures/spy-daily-closes";
import {
  bucketDirection,
  bucketForMove,
  computeCallBoardStats,
  dailyMoveFraction,
  mergeResolvedCalls,
  resolveCalls,
  scoreCall,
  upcomingCallDays,
  type CallBucket,
  type ResolvedCall,
} from "./call-board-scoring";

/** An instant at `hhmm` New York time on a summer (EDT) date. */
function summerEt(date: string, hhmm: string): Date {
  return new Date(`${date}T${hhmm}:00-04:00`);
}

/** Every date in `closes` picked as the same bucket -- a blind fixed-call strategy. */
function alwaysPick(closes: readonly DailyClose[], bucket: CallBucket): Record<string, CallBucket> {
  return Object.fromEntries(closes.map((entry) => [entry.date, bucket]));
}

describe("bucketForMove", () => {
  it("splits at +/-0.5%", () => {
    expect(bucketForMove(0.02)).toBe("up-strong");
    expect(bucketForMove(0.005)).toBe("up-strong"); // exactly at the threshold
    expect(bucketForMove(0.00499)).toBe("up");
    expect(bucketForMove(0)).toBe("up"); // a dead-flat day counts as "up"
    expect(bucketForMove(-0.0001)).toBe("down");
    expect(bucketForMove(-0.00499)).toBe("down");
    expect(bucketForMove(-0.005)).toBe("down-strong");
    expect(bucketForMove(-0.031)).toBe("down-strong");
  });
});

describe("dailyMoveFraction", () => {
  it("is the close-to-close fractional change", () => {
    expect(dailyMoveFraction(100, 101)).toBeCloseTo(0.01, 10);
    expect(dailyMoveFraction(100, 99)).toBeCloseTo(-0.01, 10);
  });
});

describe("scoreCall", () => {
  it("gives 2 for an exact bucket match", () => {
    expect(scoreCall("up-strong", "up-strong")).toBe(2);
    expect(scoreCall("down", "down")).toBe(2);
  });

  it("gives 1 for the right direction at the wrong confidence", () => {
    expect(scoreCall("up", "up-strong")).toBe(1);
    expect(scoreCall("up-strong", "up")).toBe(1);
    expect(scoreCall("down", "down-strong")).toBe(1);
    expect(scoreCall("down-strong", "down")).toBe(1);
  });

  it("gives 0 for the wrong direction, at either confidence", () => {
    expect(scoreCall("up", "down")).toBe(0);
    expect(scoreCall("up-strong", "down")).toBe(0);
    expect(scoreCall("up", "down-strong")).toBe(0);
    expect(scoreCall("down-strong", "up")).toBe(0);
  });

  it("agrees with bucketDirection about which calls are on which side", () => {
    expect(bucketDirection("up-strong")).toBe("up");
    expect(bucketDirection("up")).toBe("up");
    expect(bucketDirection("down")).toBe("down");
    expect(bucketDirection("down-strong")).toBe("down");
  });
});

describe("resolveCalls", () => {
  const closes: DailyClose[] = [
    { date: "2026-08-17", close: 100 },
    { date: "2026-08-18", close: 101 }, // +1.00% -> up-strong
    { date: "2026-08-19", close: 101.2 }, // +0.198% -> up
    { date: "2026-08-20", close: 100 }, // -1.19% -> down-strong
  ];

  it("scores each picked day against its own close-to-close move", () => {
    const resolved = resolveCalls(closes, {
      "2026-08-18": "up",
      "2026-08-19": "up",
      "2026-08-20": "down-strong",
    });

    expect(resolved.map((call) => [call.date, call.actual, call.score])).toEqual([
      ["2026-08-18", "up-strong", 1],
      ["2026-08-19", "up", 2],
      ["2026-08-20", "down-strong", 2],
    ]);
  });

  it("settles an unpicked day too, as a distinct no-input entry rather than leaving it out", () => {
    const resolved = resolveCalls(closes, { "2026-08-19": "up" });
    // Every resolvable day still resolves -- only 08-19 was actually picked;
    // 08-18 and 08-20 settle with no pick at all.
    expect(resolved).toHaveLength(3);
    expect(resolved.map((call) => [call.date, call.pick, call.score])).toEqual([
      ["2026-08-18", null, 0],
      ["2026-08-19", "up", 2],
      ["2026-08-20", null, 0],
    ]);
  });

  it("settles every day as a no-input entry when nothing was ever called", () => {
    const resolved = resolveCalls(closes, {});
    expect(resolved).toHaveLength(3);
    expect(resolved.every((call) => call.pick === null && call.score === 0)).toBe(true);
  });

  it("cannot resolve the very first close in the window (no prior close to measure against), even with a pick stored for it", () => {
    const resolved = resolveCalls(closes, { "2026-08-17": "up" });
    // 08-17 itself never appears -- there's no prior close to measure it
    // against -- but the pick stored for it has no bearing on 08-18/19/20,
    // which all still settle, each as a no-input entry.
    expect(resolved.map((call) => call.date)).toEqual(["2026-08-18", "2026-08-19", "2026-08-20"]);
    expect(resolved.every((call) => call.pick === null)).toBe(true);
  });

  it("a pick for a date the close series doesn't cover has no effect on the days it does cover", () => {
    const resolved = resolveCalls(closes, { "2026-08-21": "up" });
    // "2026-08-21" isn't in the window at all, so it never appears; every
    // in-window day still settles, all as no-input since none of them were
    // actually picked.
    expect(resolved.map((call) => call.date)).toEqual(["2026-08-18", "2026-08-19", "2026-08-20"]);
    expect(resolved.every((call) => call.pick === null && call.score === 0)).toBe(true);
  });

  it("sorts a mis-ordered series rather than trusting its caller", () => {
    const shuffled = [closes[2]!, closes[0]!, closes[3]!, closes[1]!];
    expect(resolveCalls(shuffled, { "2026-08-19": "up" })).toEqual(
      resolveCalls(closes, { "2026-08-19": "up" }),
    );
  });

  it("ignores a corrupt (non-finite or non-positive) close rather than scoring against it", () => {
    const corrupt: DailyClose[] = [
      { date: "2026-08-17", close: 100 },
      { date: "2026-08-18", close: Number.NaN },
      { date: "2026-08-19", close: 101 },
    ];
    const resolved = resolveCalls(corrupt, {
      "2026-08-18": "up",
      "2026-08-19": "up",
    });
    // The NaN day drops out; the day after it measures against the last real
    // close instead of producing a NaN move.
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.date).toBe("2026-08-19");
    expect(Number.isFinite(resolved[0]!.moveFraction)).toBe(true);
  });
});

describe("computeCallBoardStats", () => {
  function history(scores: readonly (0 | 1 | 2)[]): ResolvedCall[] {
    return scores.map((score, index) => ({
      date: `2026-08-${String(index + 1).padStart(2, "0")}`,
      pick: "up" as const,
      actual: score === 0 ? ("down" as const) : ("up" as const),
      moveFraction: score === 0 ? -0.01 : 0.01,
      score,
    }));
  }

  it("reports an empty board rather than dividing by zero", () => {
    expect(computeCallBoardStats([])).toEqual({
      resolvedCalls: 0,
      wins: 0,
      winRate: null,
      totalPoints: 0,
      currentStreak: 0,
      bestStreak: 0,
    });
  });

  it("counts a win at 1 point or better and totals points separately", () => {
    expect(computeCallBoardStats(history([2, 1, 0, 2]))).toEqual({
      resolvedCalls: 4,
      wins: 3,
      winRate: 0.75,
      totalPoints: 5,
      currentStreak: 1,
      bestStreak: 2,
    });
  });

  it("tracks the current streak from the end and the best from anywhere", () => {
    expect(computeCallBoardStats(history([1, 1, 1, 0, 1, 1]))).toMatchObject({
      currentStreak: 2,
      bestStreak: 3,
    });
    expect(computeCallBoardStats(history([0, 0, 0])).currentStreak).toBe(0);
    expect(computeCallBoardStats(history([1, 1])).currentStreak).toBe(2);
  });

  // A no-input day (pick: null, score: 0) must break the current streak
  // exactly the same way a genuine wrong-direction call does -- an explicit
  // decision made with the user, not re-derived here. It falls out of the
  // exact same `score < WINNING_SCORE` check every other loss already goes
  // through, with no separate branch for "no input" anywhere in
  // computeCallBoardStats itself.
  it("breaks the current streak on a no-input day exactly like a loss", () => {
    const noInput = (date: string): ResolvedCall => ({
      date,
      pick: null,
      actual: "up",
      moveFraction: 0.01,
      score: 0,
    });

    const stats = computeCallBoardStats([
      ...history([1, 1, 1]),
      noInput("2026-08-10"),
      ...history([1]).map((call) => ({ ...call, date: "2026-08-11" })),
    ]);
    expect(stats).toMatchObject({
      resolvedCalls: 5,
      wins: 4,
      currentStreak: 1, // only the single win after the skipped day
      bestStreak: 3, // the run before it
    });
  });

  it("counts a no-input day toward resolvedCalls (and so dilutes winRate), same as any other settled day", () => {
    const stats = computeCallBoardStats([
      ...history([2]),
      { date: "2026-08-02", pick: null, actual: "down", moveFraction: -0.01, score: 0 },
    ]);
    expect(stats.resolvedCalls).toBe(2);
    expect(stats.wins).toBe(1);
    expect(stats.winRate).toBe(0.5);
    expect(stats.totalPoints).toBe(2); // the no-input day contributes 0 points
  });
});

describe("mergeResolvedCalls", () => {
  const call = (date: string, score: 0 | 2): ResolvedCall => ({
    date,
    pick: "up",
    actual: score === 0 ? "down" : "up",
    moveFraction: score === 0 ? -0.01 : 0.01,
    score,
  });

  it("keeps one entry per date, ascending", () => {
    const merged = mergeResolvedCalls(
      [call("2026-08-19", 2)],
      [call("2026-08-17", 0), call("2026-08-20", 2)],
    );
    expect(merged.map((entry) => entry.date)).toEqual(["2026-08-17", "2026-08-19", "2026-08-20"]);
  });

  it("never rewrites an already-settled date", () => {
    const merged = mergeResolvedCalls([call("2026-08-19", 2)], [call("2026-08-19", 0)]);
    expect(merged).toEqual([call("2026-08-19", 2)]);
  });

  // The "last-write-loses, a settled call never quietly changes" contract
  // has to hold for a no-input entry exactly the same way it holds for a
  // real one -- a day already recorded as "nothing was called" must never
  // be silently overwritten by a later re-resolution, in either direction.
  const noInput = (date: string): ResolvedCall => ({
    date,
    pick: null,
    actual: "down",
    moveFraction: -0.01,
    score: 0,
  });

  it("keeps an existing no-input entry rather than replacing it with a newly-resolved real call", () => {
    const merged = mergeResolvedCalls([noInput("2026-08-19")], [call("2026-08-19", 2)]);
    expect(merged).toEqual([noInput("2026-08-19")]);
  });

  it("keeps an existing real call rather than replacing it with a newly-resolved no-input entry", () => {
    const merged = mergeResolvedCalls([call("2026-08-19", 2)], [noInput("2026-08-19")]);
    expect(merged).toEqual([call("2026-08-19", 2)]);
  });

  it("folds a genuinely new no-input entry in just like any other new date", () => {
    const merged = mergeResolvedCalls([call("2026-08-19", 2)], [noInput("2026-08-20")]);
    expect(merged).toEqual([call("2026-08-19", 2), noInput("2026-08-20")]);
  });
});

describe("upcomingCallDays", () => {
  it("offers today plus the next two trading days before today's open", () => {
    // Friday 2026-08-21, 9:00 AM ET -- today is still callable.
    expect(upcomingCallDays(summerEt("2026-08-21", "09:00"))).toEqual([
      "2026-08-21",
      "2026-08-24",
      "2026-08-25",
    ]);
  });

  it("drops today the moment its own market opens, rolling the window forward", () => {
    expect(upcomingCallDays(summerEt("2026-08-21", "09:30"))).toEqual([
      "2026-08-24",
      "2026-08-25",
      "2026-08-26",
    ]);
  });

  it("skips weekends and holidays when filling the window", () => {
    // Wednesday 2026-07-01 after the open: Thursday the 2nd, then the
    // observed Independence Day (Fri the 3rd) and the weekend are skipped.
    expect(upcomingCallDays(summerEt("2026-07-01", "10:00"))).toEqual([
      "2026-07-02",
      "2026-07-06",
      "2026-07-07",
    ]);
  });

  it("offers the next session from inside a weekend", () => {
    expect(upcomingCallDays(summerEt("2026-08-22", "12:00"))).toEqual([
      "2026-08-24",
      "2026-08-25",
      "2026-08-26",
    ]);
  });
});

// ---------------------------------------------------------------------------
// The real-data backtest issue #128's acceptance criteria ask for.
//
// Strategy: call every single day "up" (the ordinary, non-strong bullish
// bucket) and score it against real SPY closes -- test-fixtures/
// spy-daily-closes.ts, fetched live from Yahoo on 2026-08-26, the same
// trailing-90-day shape a real `benchmarkSeries` carries.
//
// Working, by the rules above, for the 22-trading-day span 2026-07-27 ..
// 2026-08-25 (the last 23 closes in the fixture yield 22 close-to-close
// moves). Each row is that day's real move, the bucket it lands in, and what
// a flat "up" call scores against it (2 = exact, 1 = right side, 0 = wrong
// side):
//
//   07-27  +0.022%  up           2      08-11  -0.320%  down          0
//   07-28  +0.239%  up           2      08-12  +0.250%  up            2
//   07-29  -1.539%  down-strong  0      08-13  +0.698%  up-strong     1
//   07-30  +1.677%  up-strong    1      08-14  -0.198%  down          0
//   07-31  +0.720%  up-strong    1      08-17  -0.473%  down          0
//   08-03  +1.424%  up-strong    1      08-18  -0.676%  down-strong   0
//   08-04  +1.803%  up-strong    1      08-19  +0.210%  up            2
//   08-05  -0.200%  down         0      08-20  -0.840%  down-strong   0
//   08-06  -0.160%  down         0      08-21  +0.409%  up            2
//   08-07  +0.612%  up-strong    1      08-24  -0.294%  down          0
//   08-10  -0.030%  down         0      08-25  +0.320%  up            2
//
// Wins (score >= 1) = the 12 rows scoring 1 or 2 -> 12/22 = 54.5%.
// Points = 6 exact matches x 2 + 6 right-side-only x 1 = 18.
// Streaks: the longest unbroken win run is 07-30..08-04 (4 in a row); the
// run at the end of the span is just 08-25 itself (1), since 08-24 lost.
//
// That lands within a call of the figure issue #128 cites from the original
// design process (12 of 22, ~55%, best streak 4) -- recomputed here against
// the window this repo actually ships, not copied from the issue.
// ---------------------------------------------------------------------------
describe("blind 'always call up' strategy against real SPY closes", () => {
  it("scores exactly as hand-worked above over the real 22-trading-day span", () => {
    const span = SPY_DAILY_CLOSES.slice(-23);
    expect(span[0]!.date).toBe("2026-07-24");
    expect(span[span.length - 1]!.date).toBe("2026-08-25");

    const resolved = resolveCalls(span, alwaysPick(span, "up"));
    expect(resolved).toHaveLength(22);
    expect(resolved[0]!.date).toBe("2026-07-27");

    const stats = computeCallBoardStats(resolved);
    expect(stats).toEqual({
      resolvedCalls: 22,
      wins: 12,
      winRate: 12 / 22,
      totalPoints: 18,
      currentStreak: 1,
      bestStreak: 4,
    });
    expect(Math.round(stats.winRate! * 1000) / 10).toBe(54.5);

    // Spot-check the individual rows the table above spells out, so a change
    // to bucketing/scoring can't quietly keep the totals while moving the days.
    expect(resolved.filter((call) => call.score === 2).map((call) => call.date)).toEqual([
      "2026-07-27",
      "2026-07-28",
      "2026-08-12",
      "2026-08-19",
      "2026-08-21",
      "2026-08-25",
    ]);
    expect(resolved.filter((call) => call.score === 1).map((call) => call.date)).toEqual([
      "2026-07-30",
      "2026-07-31",
      "2026-08-03",
      "2026-08-04",
      "2026-08-07",
      "2026-08-13",
    ]);
  });

  it("scores the same strategy over the fixture's full 62-call window", () => {
    const resolved = resolveCalls(SPY_DAILY_CLOSES, alwaysPick(SPY_DAILY_CLOSES, "up"));

    // 63 real closes -> 62 resolvable days.
    expect(resolved).toHaveLength(62);
    expect(computeCallBoardStats(resolved)).toEqual({
      resolvedCalls: 62,
      wins: 32,
      winRate: 32 / 62,
      totalPoints: 48,
      currentStreak: 1,
      bestStreak: 4,
    });
  });

  it("is internally consistent: wins are exactly the days whose real direction matched", () => {
    const resolved = resolveCalls(SPY_DAILY_CLOSES, alwaysPick(SPY_DAILY_CLOSES, "up"));
    const upDays = resolved.filter((call) => bucketDirection(call.actual) === "up");
    const stats = computeCallBoardStats(resolved);

    expect(stats.wins).toBe(upDays.length);
    expect(upDays.every((call) => call.moveFraction >= 0)).toBe(true);
    // Points can never exceed 2 per call, nor be less than the win count.
    expect(stats.totalPoints).toBeLessThanOrEqual(2 * stats.resolvedCalls);
    expect(stats.totalPoints).toBeGreaterThanOrEqual(stats.wins);
  });

  it("mirrors exactly for the opposite blind strategy -- every 'down' day is a win, and no day is a win for both", () => {
    const up = resolveCalls(SPY_DAILY_CLOSES, alwaysPick(SPY_DAILY_CLOSES, "down"));
    const stats = computeCallBoardStats(up);
    expect(stats.resolvedCalls).toBe(62);
    // 32 up days above, so the other 30 are down days.
    expect(stats.wins).toBe(30);
  });
});
