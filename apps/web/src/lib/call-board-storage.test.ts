import { afterEach, describe, expect, it, vi } from "vitest";

import type { DailyClose } from "@hadiknowntrades/core";

import type { ResolvedCall } from "./call-board-scoring";
import {
  MAX_STORED_OFFERED_DATES,
  MAX_STORED_RESOLVED_CALLS,
  getCallBoardPick,
  getOfferedDates,
  getResolvedCalls,
  readCallBoardPicks,
  recordOfferedDates,
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

describe("getOfferedDates / recordOfferedDates", () => {
  afterEach(() => {
    window.localStorage.clear();
  });

  it("returns an empty log when nothing has ever been offered", () => {
    expect(getOfferedDates()).toEqual([]);
  });

  it("round-trips, deduplicated and sorted", () => {
    recordOfferedDates(["2026-08-19", "2026-08-17"]);
    recordOfferedDates(["2026-08-18", "2026-08-19"]); // 08-19 repeats
    expect(getOfferedDates()).toEqual(["2026-08-17", "2026-08-18", "2026-08-19"]);
  });

  it("is a no-op write when every date is already recorded", () => {
    recordOfferedDates(["2026-08-19"]);
    expect(recordOfferedDates(["2026-08-19"])).toBe(true);
    expect(getOfferedDates()).toEqual(["2026-08-19"]);
  });

  it("treats a corrupted stored value as an empty log rather than throwing", () => {
    window.localStorage.setItem("hikt:call-board:offered-dates", "not json{{");
    expect(() => getOfferedDates()).not.toThrow();
    expect(getOfferedDates()).toEqual([]);
  });

  it("keeps only the most recent MAX_STORED_OFFERED_DATES entries", () => {
    const many = Array.from(
      { length: MAX_STORED_OFFERED_DATES + 5 },
      (_, i) => `2020-01-${String(i).padStart(4, "0")}`,
    );
    recordOfferedDates(many);

    const stored = getOfferedDates();
    expect(stored).toHaveLength(MAX_STORED_OFFERED_DATES);
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

  it("does not retroactively resolve anything on a completely fresh sync (matches the 0/0%/0/0 first-visit spec)", () => {
    // A day only ever settles as a no-input entry once this browser's own
    // rolling lookahead has actually shown it as an open call at some
    // point (see syncCallBoard's own doc comment) -- on a genuinely first
    // sync, nothing has ever been offered yet, so none of 08-18/19/20
    // resolve even though the close series covers all three. A fresh
    // board must read exactly as empty as it did before this feature
    // existed, not instantly acquire a backlog of retroactive losses.
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

  it("settles a day as no-input once this browser's own lookahead has actually shown it as open, but not a day it never showed", () => {
    // First sync: 2026-08-17 is "today" (still before its own open), so the
    // real lookahead is 08-17/08-18/08-19 -- recorded into the
    // offered-dates log as a side effect of this very call. 08-20 is
    // deliberately never part of any lookahead in this test.
    syncCallBoard([], summerEt("2026-08-17", "09:00"));

    // Second sync, later: the close series now covers all four days, and
    // no pick was ever made for any of them.
    const state = syncCallBoard(closes, BEFORE_OPEN);

    // 08-17 never resolves regardless (no prior close in the window to
    // measure it against). 08-18/08-19 were genuinely offered, so they
    // settle as real no-input entries; 08-20 was never shown to this
    // browser at all, so it's correctly left out, exactly as it would
    // have been before this feature existed.
    expect(state.resolved.map((call) => [call.date, call.pick, call.score])).toEqual([
      ["2026-08-18", null, 0],
      ["2026-08-19", null, 0],
    ]);
    expect(state.stats.resolvedCalls).toBe(2);
  });

  it("still resolves a real pick for a day the offered-dates log never happened to record", () => {
    // A real pick can only ever exist because this board's own UI offered
    // that date at some point -- but this exercises the filter's own
    // `pick !== null` short-circuit directly, in case the offered-dates
    // log and a stored pick ever disagreed for some other reason (a
    // migration, a hand-edited value). A real call must never be silently
    // dropped just because the log doesn't happen to know about it.
    window.localStorage.setItem(
      "hikt:call-board:pick:2026-08-19",
      JSON.stringify({ bucket: "up" }),
    );
    const state = syncCallBoard(closes, BEFORE_OPEN);

    expect(state.resolved).toHaveLength(1);
    expect(state.resolved[0]).toMatchObject({ date: "2026-08-19", pick: "up", score: 2 });
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

    // Nothing in the current window was ever offered to this browser (a
    // fresh sync, per the offered-dates gate above), so the aged-out real
    // call is the only thing here.
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
