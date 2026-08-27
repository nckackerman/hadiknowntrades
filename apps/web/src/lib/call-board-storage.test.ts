import { afterEach, describe, expect, it, vi } from "vitest";

import type { DailyClose } from "@hadiknowntrades/core";

import type { ResolvedCall } from "./call-board-scoring";
import {
  MAX_STORED_RESOLVED_CALLS,
  getCallBoardPick,
  getResolvedCalls,
  readCallBoardPicks,
  saveCallBoardPick,
  saveResolvedCalls,
  syncCallBoard,
} from "./call-board-storage";

/** An instant at `hhmm` New York time on a summer (EDT) date. */
function summerEt(date: string, hhmm: string): Date {
  return new Date(`${date}T${hhmm}:00-04:00`);
}

// Friday 2026-08-21 is a real trading day; 08-24/25/26 are the Mon/Tue/Wed
// after it, and 08-22/23 the weekend in between.
const BEFORE_OPEN = summerEt("2026-08-21", "09:00");
const AFTER_OPEN = summerEt("2026-08-21", "09:30");

describe("saveCallBoardPick / getCallBoardPick", () => {
  afterEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it("returns null for a day that hasn't been called", () => {
    expect(getCallBoardPick("2026-08-24")).toBeNull();
  });

  it("round-trips a pick for a not-yet-started trading day", () => {
    expect(saveCallBoardPick("2026-08-24", "up-strong", BEFORE_OPEN)).toBe(true);
    expect(getCallBoardPick("2026-08-24")).toBe("up-strong");
  });

  it("keeps each day's pick independent (the key is the date)", () => {
    saveCallBoardPick("2026-08-24", "up", BEFORE_OPEN);
    saveCallBoardPick("2026-08-25", "down-strong", BEFORE_OPEN);

    expect(getCallBoardPick("2026-08-24")).toBe("up");
    expect(getCallBoardPick("2026-08-25")).toBe("down-strong");
    expect(window.localStorage.getItem("hikt:call-board:pick:2026-08-24")).toBe(
      JSON.stringify({ bucket: "up" }),
    );
  });

  it("lets a pick for a not-yet-started day be changed any number of times", () => {
    for (const bucket of ["up", "down", "down-strong", "up-strong"] as const) {
      expect(saveCallBoardPick("2026-08-24", bucket, BEFORE_OPEN)).toBe(true);
      expect(getCallBoardPick("2026-08-24")).toBe(bucket);
    }
  });

  it("locks a day at its own approximate market open: a later edit is a no-op, not a silent overwrite", () => {
    // Both sides of the boundary for the *same* day, changing nothing else.
    expect(saveCallBoardPick("2026-08-21", "up", BEFORE_OPEN)).toBe(true);
    expect(getCallBoardPick("2026-08-21")).toBe("up");

    expect(saveCallBoardPick("2026-08-21", "down-strong", AFTER_OPEN)).toBe(false);
    expect(getCallBoardPick("2026-08-21")).toBe("up");
  });

  it("refuses a first-ever pick for a day whose market has already opened", () => {
    expect(saveCallBoardPick("2026-08-21", "up", AFTER_OPEN)).toBe(false);
    expect(getCallBoardPick("2026-08-21")).toBeNull();
  });

  it("refuses a pick for a non-trading day even before that day's 9:30", () => {
    // Saturday, and the observed Independence Day -- neither has a session.
    expect(saveCallBoardPick("2026-08-22", "up", BEFORE_OPEN)).toBe(false);
    expect(saveCallBoardPick("2026-07-03", "up", summerEt("2026-07-02", "12:00"))).toBe(false);
  });

  it("treats a corrupted/hand-edited stored pick as 'never called' rather than throwing", () => {
    window.localStorage.setItem("hikt:call-board:pick:2026-08-24", "not json{{");
    expect(() => getCallBoardPick("2026-08-24")).not.toThrow();
    expect(getCallBoardPick("2026-08-24")).toBeNull();

    window.localStorage.setItem(
      "hikt:call-board:pick:2026-08-25",
      JSON.stringify({ bucket: "sideways" }),
    );
    expect(getCallBoardPick("2026-08-25")).toBeNull();
  });

  it("reads a batch of dates into a date -> bucket map, omitting uncalled days", () => {
    saveCallBoardPick("2026-08-24", "up", BEFORE_OPEN);
    saveCallBoardPick("2026-08-26", "down", BEFORE_OPEN);

    expect(readCallBoardPicks(["2026-08-24", "2026-08-25", "2026-08-26"])).toEqual({
      "2026-08-24": "up",
      "2026-08-26": "down",
    });
  });
});

describe("getResolvedCalls / saveResolvedCalls", () => {
  const call = (date: string): ResolvedCall => ({
    date,
    pick: "up",
    actual: "up",
    moveFraction: 0.01,
    score: 2,
  });

  afterEach(() => {
    window.localStorage.clear();
  });

  it("round-trips a history", () => {
    saveResolvedCalls([call("2026-08-19"), call("2026-08-20")]);
    expect(getResolvedCalls().map((entry) => entry.date)).toEqual(["2026-08-19", "2026-08-20"]);
  });

  it("returns an empty history when nothing is stored", () => {
    expect(getResolvedCalls()).toEqual([]);
  });

  it("drops only the malformed entries from a partially-corrupt history", () => {
    window.localStorage.setItem(
      "hikt:call-board:history",
      JSON.stringify({
        resolved: [
          call("2026-08-19"),
          { date: "2026-08-20", pick: "up" },
          { ...call("2026-08-21"), score: 7 },
          call("2026-08-24"),
        ],
      }),
    );

    expect(getResolvedCalls().map((entry) => entry.date)).toEqual(["2026-08-19", "2026-08-24"]);
  });

  it("keeps only the most recent MAX_STORED_RESOLVED_CALLS entries", () => {
    const many = Array.from({ length: MAX_STORED_RESOLVED_CALLS + 5 }, (_, i) =>
      call(`day-${String(i).padStart(4, "0")}`),
    );
    saveResolvedCalls(many);

    const stored = getResolvedCalls();
    expect(stored).toHaveLength(MAX_STORED_RESOLVED_CALLS);
    expect(stored[0]!.date).toBe("day-0005");
  });
});

describe("syncCallBoard", () => {
  const closes: DailyClose[] = [
    { date: "2026-08-17", close: 100 },
    { date: "2026-08-18", close: 101 }, // +1.00% -> up-strong
    { date: "2026-08-19", close: 101.2 }, // +0.198% -> up
    { date: "2026-08-20", close: 100 }, // -1.19% -> down-strong
  ];

  afterEach(() => {
    window.localStorage.clear();
  });

  it("reports an empty board when nothing has been called", () => {
    const state = syncCallBoard(closes, BEFORE_OPEN);

    expect(state.resolved).toEqual([]);
    expect(state.stats.resolvedCalls).toBe(0);
    expect(state.stats.winRate).toBeNull();
    expect(state.openCalls).toEqual([
      { date: "2026-08-21", pick: null },
      { date: "2026-08-24", pick: null },
      { date: "2026-08-25", pick: null },
    ]);
  });

  it("settles picks the close series now covers, and persists them", () => {
    // Pretend these were made before each day opened, by writing the stored
    // shape directly -- saveCallBoardPick would (correctly) refuse them now.
    for (const [date, bucket] of [
      ["2026-08-18", "up"],
      ["2026-08-19", "up"],
      ["2026-08-20", "up"],
    ] as const) {
      window.localStorage.setItem(`hikt:call-board:pick:${date}`, JSON.stringify({ bucket }));
    }

    const state = syncCallBoard(closes, BEFORE_OPEN);

    expect(state.resolved.map((call) => [call.date, call.score])).toEqual([
      ["2026-08-18", 1],
      ["2026-08-19", 2],
      ["2026-08-20", 0],
    ]);
    expect(state.stats).toMatchObject({
      resolvedCalls: 3,
      wins: 2,
      totalPoints: 3,
      currentStreak: 0,
      bestStreak: 2,
    });
    // Persisted, so it survives the close window rolling past these days.
    expect(getResolvedCalls().map((call) => call.date)).toEqual([
      "2026-08-18",
      "2026-08-19",
      "2026-08-20",
    ]);
  });

  it("keeps history that has aged out of the close window", () => {
    saveResolvedCalls([
      {
        date: "2026-01-05",
        pick: "up",
        actual: "up",
        moveFraction: 0.002,
        score: 2,
      },
    ]);

    const state = syncCallBoard(closes, BEFORE_OPEN);

    expect(state.resolved.map((call) => call.date)).toEqual(["2026-01-05"]);
    expect(state.stats.resolvedCalls).toBe(1);
  });

  it("never rescores or duplicates an already-settled day", () => {
    window.localStorage.setItem(
      "hikt:call-board:pick:2026-08-19",
      JSON.stringify({ bucket: "up" }),
    );
    const first = syncCallBoard(closes, BEFORE_OPEN);
    const second = syncCallBoard(closes, BEFORE_OPEN);

    expect(second.resolved).toEqual(first.resolved);
    expect(second.resolved).toHaveLength(1);
  });

  it("surfaces the picks already made for the open lookahead days", () => {
    saveCallBoardPick("2026-08-24", "down", BEFORE_OPEN);

    expect(syncCallBoard(closes, BEFORE_OPEN).openCalls).toEqual([
      { date: "2026-08-21", pick: null },
      { date: "2026-08-24", pick: "down" },
      { date: "2026-08-25", pick: null },
    ]);
  });

  it("rolls the lookahead forward once today's market opens", () => {
    expect(syncCallBoard(closes, AFTER_OPEN).openCalls.map((call) => call.date)).toEqual([
      "2026-08-24",
      "2026-08-25",
      "2026-08-26",
    ]);
  });
});
