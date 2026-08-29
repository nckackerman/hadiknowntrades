import { afterEach, describe, expect, it } from "vitest";

import {
  computeOrderStreak,
  getOrderDayState,
  getOrderStreakHistory,
  recordOrderCompletion,
  saveOrderDayState,
  type OrderDayState,
} from "./order-storage";

afterEach(() => {
  window.localStorage.clear();
});

const SLOT_COUNT = 5;

function freshState(overrides: Partial<OrderDayState> = {}): OrderDayState {
  return {
    guess: ["A", "B", "C", "D", "E"],
    attempt: 1,
    history: [],
    locked: [false, false, false, false, false],
    done: false,
    won: false,
    ...overrides,
  };
}

describe("getOrderDayState / saveOrderDayState", () => {
  it("returns null when nothing is stored for a date", () => {
    expect(getOrderDayState("2026-08-26", SLOT_COUNT)).toBeNull();
  });

  it("round-trips a real state", () => {
    const state = freshState({
      attempt: 2,
      history: [
        { guess: ["A", "B", "C", "D", "E"], feedback: ["far", "close", "exact", "far", "close"] },
      ],
      locked: [false, false, true, false, false],
    });
    expect(saveOrderDayState("2026-08-26", state)).toBe(true);
    expect(getOrderDayState("2026-08-26", SLOT_COUNT)).toEqual(state);
  });

  it("keys by date -- two different dates don't collide", () => {
    saveOrderDayState("2026-08-26", freshState({ attempt: 1 }));
    saveOrderDayState("2026-08-27", freshState({ attempt: 3 }));
    expect(getOrderDayState("2026-08-26", SLOT_COUNT)?.attempt).toBe(1);
    expect(getOrderDayState("2026-08-27", SLOT_COUNT)?.attempt).toBe(3);
  });

  it("treats a malformed stored value as nothing stored", () => {
    window.localStorage.setItem(
      "hikt:the-order:day:2026-08-26",
      JSON.stringify({ nonsense: true }),
    );
    expect(getOrderDayState("2026-08-26", SLOT_COUNT)).toBeNull();
  });

  it("rejects a guess array with the wrong slot count", () => {
    const wrongLength = { ...freshState(), guess: ["A", "B", "C"] };
    window.localStorage.setItem("hikt:the-order:day:2026-08-26", JSON.stringify(wrongLength));
    expect(getOrderDayState("2026-08-26", SLOT_COUNT)).toBeNull();
  });
});

describe("recordOrderCompletion / getOrderStreakHistory", () => {
  it("appends a new completed day", () => {
    recordOrderCompletion("2026-08-25", true);
    recordOrderCompletion("2026-08-26", false);
    expect(getOrderStreakHistory()).toEqual([
      { date: "2026-08-25", won: true },
      { date: "2026-08-26", won: false },
    ]);
  });

  it("is idempotent per date -- a second call for the same date doesn't duplicate", () => {
    recordOrderCompletion("2026-08-26", true);
    recordOrderCompletion("2026-08-26", true);
    expect(getOrderStreakHistory()).toHaveLength(1);
  });

  it("drops malformed entries rather than failing the whole read", () => {
    window.localStorage.setItem(
      "hikt:the-order:streak-history",
      JSON.stringify({ days: [{ date: "2026-08-25", won: true }, { garbage: 1 }] }),
    );
    expect(getOrderStreakHistory()).toEqual([{ date: "2026-08-25", won: true }]);
  });
});

describe("computeOrderStreak", () => {
  it("is all zeros for an empty history", () => {
    expect(computeOrderStreak([])).toEqual({ currentStreak: 0, bestStreak: 0 });
  });

  it("counts a trailing run of wins as the current streak", () => {
    const history = [
      { date: "2026-08-20", won: false },
      { date: "2026-08-21", won: true },
      { date: "2026-08-22", won: true },
      { date: "2026-08-23", won: true },
    ];
    expect(computeOrderStreak(history)).toEqual({ currentStreak: 3, bestStreak: 3 });
  });

  it("resets the current streak on a loss but keeps the best streak from an earlier run", () => {
    const history = [
      { date: "2026-08-18", won: true },
      { date: "2026-08-19", won: true },
      { date: "2026-08-20", won: true },
      { date: "2026-08-21", won: true },
      { date: "2026-08-22", won: false },
      { date: "2026-08-23", won: true },
    ];
    expect(computeOrderStreak(history)).toEqual({ currentStreak: 1, bestStreak: 4 });
  });
});
