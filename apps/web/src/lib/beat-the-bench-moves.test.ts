import { describe, expect, it } from "vitest";

import { balanceAtBar, STARTING_CAPITAL } from "./beat-the-bench";
import {
  benchmarkDollarsFor,
  biggestMissedMove,
  biggestSwings,
  heldThroughout,
  missedMoves,
  missedMoveSentence,
  topUpMoves,
} from "./beat-the-bench-moves";
import {
  SPY_DOWN_SESSION_BARS,
  SPY_UP_SESSION_BARS,
} from "@/test-fixtures/spy-trending-session-bars";
import type { SessionBar } from "@hadiknowntrades/core";

/** A tiny hand-built session with one obvious run in the middle, so the picks are checkable by eye. */
const SHAPED: SessionBar[] = [
  { time: "09:30:00", close: 100 },
  { time: "09:35:00", close: 99 },
  { time: "09:40:00", close: 110 }, // the big run: 99 -> 110
  { time: "09:45:00", close: 105 },
  { time: "09:50:00", close: 107 }, // a smaller one: 105 -> 107
  { time: "09:55:00", close: 106 },
];

describe("topUpMoves", () => {
  it("finds the session's biggest run first, then the best one that doesn't overlap it", () => {
    const moves = topUpMoves(SHAPED, [], STARTING_CAPITAL, 2);

    expect(moves[0]).toMatchObject({ fromIndex: 1, toIndex: 2 });
    expect(moves[0]!.returnFraction).toBeCloseTo(110 / 99 - 1, 12);
    expect(moves[1]).toMatchObject({ fromIndex: 3, toIndex: 4 });
    expect(moves[1]!.returnFraction).toBeCloseTo(107 / 105 - 1, 12);
  });

  it("returns nothing at all for a session that only ever fell", () => {
    const falling: SessionBar[] = [
      { time: "09:30:00", close: 100 },
      { time: "09:35:00", close: 99 },
      { time: "09:40:00", close: 98 },
    ];
    expect(topUpMoves(falling, [], STARTING_CAPITAL)).toEqual([]);
  });

  it("returns nothing for a session too short to contain a move", () => {
    expect(topUpMoves([{ time: "09:30:00", close: 100 }], [], STARTING_CAPITAL)).toEqual([]);
  });

  // The span cap exists because the uncapped search degenerates on
  // exactly the days this is most interesting for -- see
  // MAX_MOVE_SPAN_FRACTION's own note. This is that behaviour, against
  // the real +1.24% session it was measured on.
  it("reports runs within the day rather than one run spanning the whole day", () => {
    const moves = topUpMoves(SPY_UP_SESSION_BARS, [], STARTING_CAPITAL);
    const lastIndex = SPY_UP_SESSION_BARS.length - 1;

    expect(moves).toHaveLength(3);
    for (const move of moves) {
      expect(move.toIndex - move.fromIndex).toBeLessThanOrEqual(Math.floor(lastIndex / 3));
      expect(move.returnFraction).toBeGreaterThan(0);
    }
    // Descending by return, and genuinely non-overlapping.
    expect(moves[0]!.returnFraction).toBeGreaterThan(moves[1]!.returnFraction);
    expect(moves[1]!.returnFraction).toBeGreaterThan(moves[2]!.returnFraction);
    const sorted = [...moves].sort((a, b) => a.fromIndex - b.fromIndex);
    for (let i = 1; i < sorted.length; i += 1) {
      expect(sorted[i]!.fromIndex).toBeGreaterThanOrEqual(sorted[i - 1]!.toIndex);
    }
  });

  it("marks a run the player rode as held, and one they sat out as missed", () => {
    // Sell at bar 1 (right before the big run), buy back at bar 3.
    const moves = topUpMoves(SHAPED, [1, 3], STARTING_CAPITAL, 2);
    expect(moves[0]).toMatchObject({ fromIndex: 1, toIndex: 2, playerHeld: false });
    expect(moves[1]).toMatchObject({ fromIndex: 3, toIndex: 4, playerHeld: true });
  });
});

describe("heldThroughout", () => {
  it("counts a player who stepped out mid-run as not having been in the market for it", () => {
    // In at 0, out at 2, back in at 3 -- both endpoints holding, the
    // middle not. Flattering that as "you were in for it" would be a lie.
    expect(heldThroughout([2, 3], 0, 5)).toBe(false);
    expect(heldThroughout([], 0, 5)).toBe(true);
    expect(heldThroughout([1], 0, 1)).toBe(true); // the toggle lands at the run's end
    expect(heldThroughout([1], 1, 3)).toBe(false);
  });
});

describe("benchmarkDollarsFor", () => {
  // The methodology this function's own doc comment states, asserted
  // rather than described: the bench's balance at the run's opening bar,
  // times the run's own price return. Nothing about the player's path.
  it("is exactly the bench's balance at the run's start times the run's return", () => {
    const fromIndex = 2;
    const returnFraction = 0.01;
    const benchAtStart = balanceAtBar(SHAPED, [], STARTING_CAPITAL, fromIndex);

    expect(benchmarkDollarsFor(SHAPED, STARTING_CAPITAL, fromIndex, returnFraction)).toBeCloseTo(
      benchAtStart * returnFraction,
      12,
    );
  });

  it("is independent of what the player actually did", () => {
    const busy = topUpMoves(SHAPED, [1, 2, 3, 4], STARTING_CAPITAL, 2);
    const idle = topUpMoves(SHAPED, [], STARTING_CAPITAL, 2);
    expect(busy.map((m) => m.benchmarkDollars)).toEqual(idle.map((m) => m.benchmarkDollars));
  });
});

describe("missedMoves / biggestMissedMove", () => {
  it("keeps the biggest-first order and returns null when nothing was missed", () => {
    const rode = topUpMoves(SHAPED, [], STARTING_CAPITAL, 2);
    expect(missedMoves(rode)).toEqual([]);
    expect(biggestMissedMove(rode)).toBeNull();

    const missedBig = topUpMoves(SHAPED, [1, 3], STARTING_CAPITAL, 2);
    expect(biggestMissedMove(missedBig)).toMatchObject({ fromIndex: 1, toIndex: 2 });
  });
});

describe("missedMoveSentence", () => {
  it("hedges the dollar figure exactly as far as the computation warrants", () => {
    const moves = topUpMoves(SHAPED, [1, 3], STARTING_CAPITAL, 1);
    const sentence = missedMoveSentence(biggestMissedMove(moves));

    expect(sentence).toContain("9:35 AM to 9:40 AM");
    expect(sentence).toContain("+11.11%");
    // "About", and "to a buy-and-hold position" -- the two words that
    // keep this sentence true, since the figure is not this player's own
    // counterfactual.
    expect(sentence).toContain("about");
    expect(sentence).toContain("to a buy-and-hold position of this size");
  });

  it("says plainly that a player rode every run, rather than inventing a miss", () => {
    expect(missedMoveSentence(null)).toBe(
      "You were in the market for every one of the session's biggest runs.",
    );
  });

  it("never claims the player sat in cash for the whole run when they only missed part of it", () => {
    // Sold at bar 1, back in at bar 2 -- in the market at both ends of
    // the 1 -> 2 run, but out for the segment between them.
    const moves = topUpMoves(SHAPED, [1, 2], STARTING_CAPITAL, 1);
    expect(moves[0]!.playerHeld).toBe(false);
    expect(missedMoveSentence(moves[0]!)).toContain("weren't in the market for all of");
  });
});

// The direction-agnostic sibling `topUpMoves` doesn't provide (issue
// #224) -- same shared window search (`findBestRuns`), scored by
// magnitude instead of signed return, so the biggest move in *either*
// direction always wins the first pick. Bullet Time's own trigger
// scheduler (`bullet-time.ts`) builds directly on this.
describe("biggestSwings", () => {
  const UP_ONLY: SessionBar[] = [
    { time: "09:30:00", close: 100 },
    { time: "09:35:00", close: 101 },
    { time: "09:40:00", close: 102.5 },
    { time: "09:45:00", close: 104 },
    { time: "09:50:00", close: 106 },
  ];

  const DOWN_ONLY: SessionBar[] = [
    { time: "09:30:00", close: 106 },
    { time: "09:35:00", close: 104 },
    { time: "09:40:00", close: 102.5 },
    { time: "09:45:00", close: 101 },
    { time: "09:50:00", close: 100 },
  ];

  const FLAT: SessionBar[] = [
    { time: "09:30:00", close: 100 },
    { time: "09:35:00", close: 100 },
    { time: "09:40:00", close: 100 },
    { time: "09:45:00", close: 100 },
  ];

  it("finds only up-swings, never a down-swing, on a session that only ever rose", () => {
    const swings = biggestSwings(UP_ONLY, 3);
    expect(swings.length).toBeGreaterThan(0);
    for (const swing of swings) {
      expect(swing.returnFraction).toBeGreaterThan(0);
    }
    // The single biggest is the one adjacent-bar step with the largest
    // gain (MAX_MOVE_SPAN_FRACTION caps a run's own span the same way it
    // does for topUpMoves -- a 5-bar session's own cap is a single bar,
    // so "the whole session as one run" is never a candidate here).
    expect(swings[0]!.returnFraction).toBeCloseTo(106 / 104 - 1, 12);
  });

  it("finds only down-swings, never an up-swing, on a session that only ever fell -- signed negative", () => {
    const swings = biggestSwings(DOWN_ONLY, 3);
    expect(swings.length).toBeGreaterThan(0);
    for (const swing of swings) {
      expect(swing.returnFraction).toBeLessThan(0);
    }
    expect(swings[0]!.returnFraction).toBeCloseTo(104 / 106 - 1, 12);
  });

  it("picks the biggest swing in either direction first, regardless of sign -- a session with both", () => {
    // SHAPED's own biggest single-bar move (by magnitude) is the
    // +11.11% run from 99 -> 110; its second-biggest is the -4.55% run
    // right after it, 110 -> 105. topUpMoves would never surface that
    // second one at all (it's a loss, not a gain) -- this is exactly
    // what biggestSwings adds.
    const swings = biggestSwings(SHAPED, 2);
    expect(swings).toHaveLength(2);
    expect(swings[0]).toMatchObject({ fromIndex: 1, toIndex: 2 });
    expect(swings[0]!.returnFraction).toBeCloseTo(110 / 99 - 1, 12);
    expect(swings[1]).toMatchObject({ fromIndex: 2, toIndex: 3 });
    expect(swings[1]!.returnFraction).toBeCloseTo(105 / 110 - 1, 12);
    expect(swings[1]!.returnFraction).toBeLessThan(0);
  });

  it("returns nothing at all for a session with nothing large enough to qualify -- a flat session", () => {
    expect(biggestSwings(FLAT, 3)).toEqual([]);
  });

  it("returns nothing for a session too short to contain a swing", () => {
    expect(biggestSwings([{ time: "09:30:00", close: 100 }], 3)).toEqual([]);
  });

  it("never returns two swings sharing a bar interval, even across a real, noisy real session", () => {
    const swings = biggestSwings(SPY_UP_SESSION_BARS, 5);
    for (let i = 0; i < swings.length; i += 1) {
      for (let j = i + 1; j < swings.length; j += 1) {
        const a = swings[i]!;
        const b = swings[j]!;
        const overlaps = a.fromIndex < b.toIndex && b.fromIndex < a.toIndex;
        expect(overlaps).toBe(false);
      }
    }
  });

  it("finds a real down-swing on a real down-trending session, which topUpMoves cannot represent at all", () => {
    const swings = biggestSwings(SPY_DOWN_SESSION_BARS, 3);
    expect(swings.length).toBeGreaterThan(0);
    // The real session's own overall drift is negative (-1.418%, see the
    // fixture's own doc comment) -- its single biggest swing should be
    // a down-swing, not an up-swing, and topUpMoves (up-only by design)
    // has no way to represent that same swing at all.
    expect(swings[0]!.returnFraction).toBeLessThan(0);
    expect(topUpMoves(SPY_DOWN_SESSION_BARS, [], STARTING_CAPITAL, 3)).not.toContainEqual(
      expect.objectContaining({ fromIndex: swings[0]!.fromIndex, toIndex: swings[0]!.toIndex }),
    );
  });

  it("respects the same span cap as topUpMoves, for the same reason", () => {
    const swings = biggestSwings(SPY_UP_SESSION_BARS, 5);
    const lastIndex = SPY_UP_SESSION_BARS.length - 1;
    for (const swing of swings) {
      expect(swing.toIndex - swing.fromIndex).toBeLessThanOrEqual(Math.floor(lastIndex / 3));
    }
  });
});
