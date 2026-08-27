import { describe, expect, it } from "vitest";

import { SPY_SESSION_BARS } from "@/test-fixtures/spy-session-bars";

import {
  balanceAtBar,
  BASE_TICK_MS,
  gapPhrase,
  isPlayableSession,
  outcomeDetail,
  outcomeHeadline,
  PLAYBACK_SPEEDS,
  positionAfterBar,
  positionsThroughBar,
  sessionDurationMs,
  settleSession,
  STARTING_CAPITAL,
  TARGET_SESSION_MS_AT_1X,
  tickIntervalMs,
} from "./beat-the-bench";

const BARS = SPY_SESSION_BARS;
const LAST = BARS.length - 1;

/** The real fixture session, wrapped as the stored object shape the API serves. */
function sessionPayload(bars = BARS) {
  return {
    schemaVersion: 8,
    generatedAt: "2026-08-27T00:52:58.157Z",
    ticker: "SPY",
    barIntervalMinutes: 5,
    date: "2026-08-26",
    bars: [...bars],
  };
}

describe("the zero-trade invariant", () => {
  // Issue #131's first acceptance criterion, and the reason the player
  // starts *in the market*: buy-and-hold and "never touch it" are the
  // same thing, so a player who never moves must tie the benchmark
  // exactly -- not within a cent, and not within a floating-point
  // epsilon. Real prices, the real 79-bar 2026-08-26 SPY session.
  it("ties the benchmark exactly, to the last bit, over a real session", () => {
    const settlement = settleSession(BARS, [], STARTING_CAPITAL);

    expect(settlement.playerBalance).toBe(settlement.benchmarkBalance);
    expect(settlement.outcome).toBe("tie");
    expect(settlement.moves).toBe(0);
    // Not a degenerate tie at the starting capital -- this session really
    // did move (a +0.053% day), both sides just moved with it.
    expect(settlement.playerBalance).not.toBe(STARTING_CAPITAL);
  });

  it("ties exactly at every intermediate bar too, not just at the close", () => {
    // The live readouts run off `balanceAtBar` bar by bar, so a player
    // who hasn't moved *yet* has to read level with the bench on every
    // frame -- including at bars before a move they make later, which
    // must not leak backwards into an earlier balance.
    const laterMoves = [40, 60];
    for (let i = 0; i < 40; i += 1) {
      expect(balanceAtBar(BARS, laterMoves, STARTING_CAPITAL, i)).toBe(
        balanceAtBar(BARS, [], STARTING_CAPITAL, i),
      );
    }
  });

  it("still ties exactly when the player sells and buys back at the same bar", () => {
    // Two toggles at one price is a real thing a player can do (a mis-tap,
    // or a change of mind) and it must cost nothing -- the money never
    // actually left that price.
    const settlement = settleSession(BARS, [30, 30], STARTING_CAPITAL);

    expect(settlement.playerBalance).toBe(settlement.benchmarkBalance);
    expect(settlement.outcome).toBe("tie");
    expect(settlement.moves).toBe(2);
  });

  it("computes a benchmark that really is buy-and-hold", () => {
    // The tie above is exact *by construction* (both sides are the same
    // call), so this is the check that the shared construction is the
    // right one and not merely self-consistent.
    const { benchmarkBalance } = settleSession(BARS, [], STARTING_CAPITAL);
    const closedForm = STARTING_CAPITAL * (BARS[LAST]!.close / BARS[0]!.close);

    expect(benchmarkBalance).toBeCloseTo(closedForm, 12);
    expect(benchmarkBalance).toBeCloseTo(20.010579666394552, 10);
  });
});

describe("settlement against real prices", () => {
  // The single best and single worst out-and-back-in pair in this real
  // session, found by exhaustive search over every (out, in) pair of its
  // 79 bars -- not eyeballed, and not tuned to a target number.
  const BEST_MOVES = [5, 38]; // out at 09:55 (765.68), back in at 12:40 (762.81)
  const WORST_MOVES = [38, 66]; // out at 12:40 (762.81), back in at 15:00 (766.06)

  it("beats the bench by stepping out before the session's biggest drop", () => {
    const settlement = settleSession(BARS, BEST_MOVES, STARTING_CAPITAL);

    expect(settlement.outcome).toBe("win");
    expect(settlement.playerBalance).toBeGreaterThan(settlement.benchmarkBalance);
    expect(settlement.playerBalance).toBeCloseTo(20.08595840498944, 10);
    expect(outcomeHeadline(settlement)).toBe("You beat the bench");
  });

  it("falls behind by stepping out before the session's biggest rise", () => {
    const settlement = settleSession(BARS, WORST_MOVES, STARTING_CAPITAL);

    expect(settlement.outcome).toBe("loss");
    expect(settlement.playerBalance).toBeLessThan(settlement.benchmarkBalance);
    expect(settlement.playerBalance).toBeCloseTo(19.92561038705815, 10);
    expect(outcomeHeadline(settlement)).toBe("The bench stayed ahead");
  });

  it("leaves a player who sells and never buys back holding exactly that bar's value", () => {
    const settlement = settleSession(BARS, [10], STARTING_CAPITAL);
    expect(settlement.playerBalance).toBeCloseTo(
      STARTING_CAPITAL * (BARS[10]!.close / BARS[0]!.close),
      12,
    );
  });

  it("selling at the very last bar changes nothing", () => {
    const settlement = settleSession(BARS, [LAST], STARTING_CAPITAL);
    expect(settlement.playerBalance).toBeCloseTo(settlement.benchmarkBalance, 12);
  });
});

describe("position tracking", () => {
  it("flips on each move and ignores moves that haven't happened yet", () => {
    expect(positionAfterBar([5, 9], 4)).toBe("holding");
    expect(positionAfterBar([5, 9], 5)).toBe("cash");
    expect(positionAfterBar([5, 9], 8)).toBe("cash");
    expect(positionAfterBar([5, 9], 9)).toBe("holding");
  });

  it("reports one position per revealed bar", () => {
    expect(positionsThroughBar([2], 3)).toEqual(["holding", "holding", "cash", "cash"]);
    expect(positionsThroughBar([], 0)).toEqual(["holding"]);
  });
});

describe("playback speeds", () => {
  it("offers five genuinely different intervals, at real millisecond values", () => {
    const intervals = PLAYBACK_SPEEDS.map(tickIntervalMs);

    expect(intervals).toEqual([3000, 600, 300, 150, 75]);
    expect(new Set(intervals).size).toBe(PLAYBACK_SPEEDS.length);
    // Strictly decreasing: a "faster" setting must never hold a bar on
    // screen longer than a slower one.
    for (let i = 1; i < intervals.length; i += 1) {
      expect(intervals[i]!).toBeLessThan(intervals[i - 1]!);
    }
  });

  it("plays a full real session in under 30 seconds at 1x -- the stated target", () => {
    // 79 real bars, 78 ticks (the opening bar is already on screen), at
    // BASE_TICK_MS each.
    const atOneX = sessionDurationMs(BARS.length, 1);

    expect(BARS.length).toBe(79);
    expect(atOneX).toBe(78 * BASE_TICK_MS);
    expect(atOneX).toBe(23_400);
    expect(atOneX).toBeLessThan(TARGET_SESSION_MS_AT_1X);
  });

  it("scales the whole session's length by exactly the speed multiplier", () => {
    expect(sessionDurationMs(BARS.length, 0.1)).toBe(234_000);
    expect(sessionDurationMs(BARS.length, 0.5)).toBe(46_800);
    expect(sessionDurationMs(BARS.length, 2)).toBe(11_700);
    expect(sessionDurationMs(BARS.length, 4)).toBe(5_850);
  });

  it("has no ticks to run for a session of one bar", () => {
    expect(sessionDurationMs(1, 1)).toBe(0);
    expect(sessionDurationMs(0, 1)).toBe(0);
  });
});

describe("settlement copy", () => {
  // Issue #131 corrects the source mechanic's register explicitly: Beat
  // the Couch calls a zero-trade player "twitchy" and labels the outcome
  // "even odds". Neither is this app's voice, and "even odds" isn't even
  // accurate -- zero trades is buy-and-hold, not a coin flip.
  it("names the zero-move outcome for what it is, without mocking the player", () => {
    const settlement = settleSession(BARS, [], STARTING_CAPITAL);

    expect(outcomeHeadline(settlement)).toBe("Along for the ride");
    expect(outcomeDetail(settlement)).toContain("You never moved");
    expect(outcomeDetail(settlement)).toContain("exactly where the bench did");
  });

  it("distinguishes a zero-move tie from a tie a player traded into", () => {
    const traded = settleSession(BARS, [30, 30], STARTING_CAPITAL);
    expect(outcomeHeadline(traded)).toBe("Dead even with the bench");
    expect(outcomeDetail(traded)).toContain("You moved 2 times");
  });

  it("describes the gap in words, since both balances can round the same", () => {
    const tie = settleSession(BARS, [], STARTING_CAPITAL);
    expect(gapPhrase(tie)).toBe("Level with the bench, exactly.");

    const win = settleSession(BARS, [5, 38], STARTING_CAPITAL);
    expect(win.outcome).toBe("win");
    expect(gapPhrase(win)).toBe("0.38% ahead of the bench.");

    // A sub-basis-point win says so rather than printing "0.00% ahead".
    const hairline = {
      startingCapital: 20,
      playerBalance: 20.000001,
      benchmarkBalance: 20,
      playerReturnFraction: 0,
      benchmarkReturnFraction: 0,
      moves: 2,
      outcome: "win" as const,
    };
    expect(gapPhrase(hairline)).toBe("Less than 0.01% ahead of the bench.");
  });
});

describe("isPlayableSession", () => {
  it("accepts a real published session", () => {
    expect(isPlayableSession(sessionPayload())).toBe(true);
  });

  it("rejects a session with nothing to play", () => {
    expect(isPlayableSession(sessionPayload([]))).toBe(false);
    expect(isPlayableSession(sessionPayload([BARS[0]!]))).toBe(false);
  });

  it("rejects a session carrying a price the game would divide by", () => {
    expect(isPlayableSession(sessionPayload([{ time: "09:30:00", close: 0 }, BARS[1]!]))).toBe(
      false,
    );
    expect(
      isPlayableSession(sessionPayload([{ time: "09:30:00", close: Number.NaN }, BARS[1]!])),
    ).toBe(false);
  });
});
