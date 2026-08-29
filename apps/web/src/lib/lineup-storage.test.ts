import { afterEach, describe, expect, it } from "vitest";

import {
  MAX_STORED_LINEUP_HISTORY,
  computeLineupStreak,
  getLineupPlayedResult,
  saveLineupPlayedResult,
  type LineupPlayedResult,
} from "./lineup-storage";

function result(overrides: Partial<LineupPlayedResult> = {}): LineupPlayedResult {
  return {
    date: "2026-08-26",
    outcome: "won",
    guessesUsed: 4,
    columnsSolved: 5,
    tilesFilled: 18,
    totalTiles: 18,
    lockedColumns: [true, true, true, true, true],
    ...overrides,
  };
}

describe("saveLineupPlayedResult / getLineupPlayedResult", () => {
  afterEach(() => {
    window.localStorage.clear();
  });

  it("returns null for a day that hasn't been played", () => {
    expect(getLineupPlayedResult("2026-08-26")).toBeNull();
  });

  it("round-trips a played result", () => {
    expect(saveLineupPlayedResult(result())).toBe(true);
    expect(getLineupPlayedResult("2026-08-26")).toEqual(result());
  });

  it("keeps each day's result independent (the key is the date)", () => {
    saveLineupPlayedResult(result({ date: "2026-08-25", outcome: "lost", columnsSolved: 2 }));
    saveLineupPlayedResult(result({ date: "2026-08-26", outcome: "won" }));

    expect(getLineupPlayedResult("2026-08-25")?.outcome).toBe("lost");
    expect(getLineupPlayedResult("2026-08-26")?.outcome).toBe("won");
    expect(window.localStorage.getItem("hikt:the-lineup:2026-08-26")).toBe(
      JSON.stringify(result()),
    );
  });

  it("is idempotent per date: replaying the same day overwrites, not duplicates", () => {
    saveLineupPlayedResult(result({ guessesUsed: 3 }));
    saveLineupPlayedResult(result({ guessesUsed: 7 }));

    expect(getLineupPlayedResult("2026-08-26")?.guessesUsed).toBe(7);
    expect(computeLineupStreak().currentStreak).toBe(1); // history entry replaced, not duplicated
  });

  it("round-trips a lost game's per-column lockedColumns, not just the count", () => {
    const lost = result({
      outcome: "lost",
      columnsSolved: 2,
      tilesFilled: 7,
      totalTiles: 18,
      lockedColumns: [true, false, true, false, false],
    });
    saveLineupPlayedResult(lost);
    expect(getLineupPlayedResult("2026-08-26")?.lockedColumns).toEqual([
      true,
      false,
      true,
      false,
      false,
    ]);
  });

  it("treats a malformed stored value as unplayed", () => {
    window.localStorage.setItem("hikt:the-lineup:2026-08-26", "{not json");
    expect(getLineupPlayedResult("2026-08-26")).toBeNull();

    window.localStorage.setItem(
      "hikt:the-lineup:2026-08-26",
      JSON.stringify({ date: "2026-08-26", outcome: "maybe" }),
    );
    expect(getLineupPlayedResult("2026-08-26")).toBeNull();
  });

  it("treats a stored value with a shorter (stale/hand-edited) lockedColumns array as unplayed, not as a real result with missing columns silently read as false", () => {
    // A real LineupPlayedResult always has exactly LINEUP_COLUMNS (5)
    // entries -- a hand-edited or stale-format value with fewer must not
    // parse as valid: TheLineup.tsx reads lockedColumns[i] for every i up
    // to 4 unconditionally once this parses, so a shorter array would
    // silently read `undefined` (falsy) for the missing indices,
    // rendering an actually-solved column as "revealed/lost" instead of
    // "exact/solved" on a cold reload.
    window.localStorage.setItem(
      "hikt:the-lineup:2026-08-26",
      JSON.stringify(result({ lockedColumns: [true, true, true] })),
    );
    expect(getLineupPlayedResult("2026-08-26")).toBeNull();

    // A too-long array is rejected the same way -- the contract is
    // exactly LINEUP_COLUMNS, not "at least" or "at most."
    window.localStorage.setItem(
      "hikt:the-lineup:2026-08-26",
      JSON.stringify(result({ lockedColumns: [true, true, true, true, true, true] })),
    );
    expect(getLineupPlayedResult("2026-08-26")).toBeNull();
  });
});

describe("computeLineupStreak", () => {
  afterEach(() => {
    window.localStorage.clear();
  });

  it("is 0/0 with no history", () => {
    expect(computeLineupStreak()).toEqual({ currentStreak: 0, bestStreak: 0 });
  });

  it("counts consecutive wins", () => {
    saveLineupPlayedResult(result({ date: "2026-08-24" }));
    saveLineupPlayedResult(result({ date: "2026-08-25" }));
    saveLineupPlayedResult(result({ date: "2026-08-26" }));

    expect(computeLineupStreak()).toEqual({ currentStreak: 3, bestStreak: 3 });
  });

  it("resets currentStreak on a loss, but keeps the historical bestStreak", () => {
    saveLineupPlayedResult(result({ date: "2026-08-20" }));
    saveLineupPlayedResult(result({ date: "2026-08-21" }));
    saveLineupPlayedResult(result({ date: "2026-08-22", outcome: "lost" }));
    saveLineupPlayedResult(result({ date: "2026-08-24" }));

    expect(computeLineupStreak()).toEqual({ currentStreak: 1, bestStreak: 2 });
  });

  it("saved out of date order still resolves correctly (history is sorted by date, not insertion order)", () => {
    saveLineupPlayedResult(result({ date: "2026-08-26" }));
    saveLineupPlayedResult(result({ date: "2026-08-24" }));
    saveLineupPlayedResult(result({ date: "2026-08-25" }));

    expect(computeLineupStreak()).toEqual({ currentStreak: 3, bestStreak: 3 });
  });

  it("trims to MAX_STORED_LINEUP_HISTORY, oldest first", () => {
    const base = new Date("2026-01-01T00:00:00Z");
    for (let i = 0; i < MAX_STORED_LINEUP_HISTORY + 5; i++) {
      const day = new Date(base);
      day.setUTCDate(day.getUTCDate() + i);
      saveLineupPlayedResult(result({ date: day.toISOString().slice(0, 10) }));
    }
    const raw = window.localStorage.getItem("hikt:the-lineup:history");
    const parsed = JSON.parse(raw!) as { resolved: { date: string }[] };
    expect(parsed.resolved).toHaveLength(MAX_STORED_LINEUP_HISTORY);
    // The 5 oldest entries were trimmed away, not the newest.
    expect(parsed.resolved[0]!.date).toBe("2026-01-06");
  });
});
