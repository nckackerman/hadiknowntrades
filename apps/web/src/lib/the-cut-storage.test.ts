import { afterEach, describe, expect, it } from "vitest";

import {
  clearCutGameState,
  computeCutStreak,
  getCutGameHistory,
  getCutGameState,
  MAX_STORED_CUT_GAMES,
  recordCutCompletion,
  saveCutGameState,
  type CutCompletedGame,
  type CutGameState,
} from "./the-cut-storage";

afterEach(() => {
  window.localStorage.clear();
});

function freshState(overrides: Partial<CutGameState> = {}): CutGameState {
  return { guesses: [], done: false, won: false, ...overrides };
}

describe("getCutGameState / saveCutGameState", () => {
  it("returns null when nothing is stored for a range", () => {
    expect(getCutGameState("1Y")).toBeNull();
  });

  it("round-trips a real in-progress state", () => {
    const state = freshState({ guesses: [250, 100] });
    expect(saveCutGameState("1Y", state)).toBe(true);
    expect(getCutGameState("1Y")).toEqual(state);
  });

  it("round-trips a real finished (won) state", () => {
    const state = freshState({ guesses: [250, 100, 42], done: true, won: true });
    expect(saveCutGameState("1Y", state)).toBe(true);
    expect(getCutGameState("1Y")).toEqual(state);
  });

  it("keys by range -- two different ranges don't collide", () => {
    saveCutGameState("1Y", freshState({ guesses: [1] }));
    saveCutGameState("5Y", freshState({ guesses: [2, 3] }));
    expect(getCutGameState("1Y")?.guesses).toEqual([1]);
    expect(getCutGameState("5Y")?.guesses).toEqual([2, 3]);
  });

  it("supports the 1D range (CutRange, issue #238), keyed distinctly from every PresetRange", () => {
    saveCutGameState("1D", freshState({ guesses: [7] }));
    saveCutGameState("1Y", freshState({ guesses: [9] }));
    expect(getCutGameState("1D")?.guesses).toEqual([7]);
    expect(getCutGameState("1Y")?.guesses).toEqual([9]);
  });

  it("treats a malformed stored value as nothing stored", () => {
    window.localStorage.setItem("hikt:the-cut:game:1Y", JSON.stringify({ nonsense: true }));
    expect(getCutGameState("1Y")).toBeNull();
  });

  it("treats a non-JSON stored value as nothing stored", () => {
    window.localStorage.setItem("hikt:the-cut:game:1Y", "{not json");
    expect(getCutGameState("1Y")).toBeNull();
  });

  it("treats a stored guesses array with a non-number entry as malformed", () => {
    window.localStorage.setItem(
      "hikt:the-cut:game:1Y",
      JSON.stringify({ guesses: [1, "two"], done: false, won: false }),
    );
    expect(getCutGameState("1Y")).toBeNull();
  });
});

describe("clearCutGameState", () => {
  it("resets a range back to a fresh, unplayed game", () => {
    saveCutGameState("1Y", freshState({ guesses: [1, 2, 3], done: true, won: true }));
    expect(clearCutGameState("1Y")).toBe(true);
    expect(getCutGameState("1Y")).toEqual(freshState());
  });
});

describe("getCutGameHistory / recordCutCompletion", () => {
  it("starts empty", () => {
    expect(getCutGameHistory()).toEqual([]);
  });

  it("always appends -- replaying the same range is a genuinely new game each time", () => {
    recordCutCompletion("1Y", true, 100);
    recordCutCompletion("1Y", false, 40);
    expect(getCutGameHistory()).toEqual([
      { range: "1Y", won: true, edgeCapturedPct: 100 },
      { range: "1Y", won: false, edgeCapturedPct: 40 },
    ]);
  });

  it("records games across different ranges in one shared history", () => {
    recordCutCompletion("1W", true, 90);
    recordCutCompletion("5Y", false, 10);
    expect(getCutGameHistory().map((g) => g.range)).toEqual(["1W", "5Y"]);
  });

  it("trims the history to MAX_STORED_CUT_GAMES, oldest dropped first", () => {
    for (let i = 0; i < MAX_STORED_CUT_GAMES + 5; i++) {
      recordCutCompletion("1Y", i % 2 === 0, i);
    }
    const history = getCutGameHistory();
    expect(history).toHaveLength(MAX_STORED_CUT_GAMES);
    expect(history[0]!.edgeCapturedPct).toBe(5); // the oldest 5 entries were dropped
  });

  it("treats a malformed stored history as empty", () => {
    window.localStorage.setItem("hikt:the-cut:history", JSON.stringify({ nonsense: true }));
    expect(getCutGameHistory()).toEqual([]);
  });

  it("drops only the malformed entries within an otherwise-valid history", () => {
    window.localStorage.setItem(
      "hikt:the-cut:history",
      JSON.stringify({
        games: [
          { range: "1Y", won: true, edgeCapturedPct: 100 },
          { nonsense: true },
          { range: "5Y", won: false, edgeCapturedPct: 20 },
        ],
      }),
    );
    expect(getCutGameHistory()).toEqual([
      { range: "1Y", won: true, edgeCapturedPct: 100 },
      { range: "5Y", won: false, edgeCapturedPct: 20 },
    ]);
  });
});

describe("computeCutStreak", () => {
  function games(wins: readonly boolean[]): CutCompletedGame[] {
    return wins.map((won) => ({ range: "1Y", won, edgeCapturedPct: won ? 100 : 0 }));
  }

  it("is 0/0 for an empty history", () => {
    expect(computeCutStreak([])).toEqual({ currentStreak: 0, bestStreak: 0 });
  });

  it("counts a trailing run of wins as the current streak", () => {
    expect(computeCutStreak(games([false, true, true, true]))).toEqual({
      currentStreak: 3,
      bestStreak: 3,
    });
  });

  it("resets the current streak on a loss, but keeps the best streak from earlier", () => {
    expect(computeCutStreak(games([true, true, true, false, true]))).toEqual({
      currentStreak: 1,
      bestStreak: 3,
    });
  });

  it("is 0 current streak right after a loss", () => {
    expect(computeCutStreak(games([true, true, false]))).toEqual({
      currentStreak: 0,
      bestStreak: 2,
    });
  });
});
