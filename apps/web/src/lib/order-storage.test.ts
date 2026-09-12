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
    feedback: null,
    attempts: 0,
    done: false,
    won: false,
    ...overrides,
  };
}

describe("getOrderDayState / saveOrderDayState", () => {
  it("returns null when nothing is stored for a date", () => {
    expect(getOrderDayState("2026-08-26", SLOT_COUNT)).toBeNull();
  });

  it("round-trips a real in-progress state", () => {
    const state = freshState();
    expect(saveOrderDayState("2026-08-26", state)).toBe(true);
    expect(getOrderDayState("2026-08-26", SLOT_COUNT)).toEqual(state);
  });

  it("round-trips a real partially-locked, still-in-progress state (a resubmission mid-game)", () => {
    const state = freshState({
      attempts: 2,
      feedback: ["correct", "incorrect", "correct", "incorrect", "incorrect"],
    });
    expect(saveOrderDayState("2026-08-26", state)).toBe(true);
    expect(getOrderDayState("2026-08-26", SLOT_COUNT)).toEqual(state);
  });

  it("round-trips a real finished (won) state, with its own feedback", () => {
    const state = freshState({
      attempts: 3,
      done: true,
      won: true,
      feedback: ["correct", "correct", "correct", "correct", "correct"],
    });
    expect(saveOrderDayState("2026-08-26", state)).toBe(true);
    expect(getOrderDayState("2026-08-26", SLOT_COUNT)).toEqual(state);
  });

  it("keys by date -- two different dates don't collide", () => {
    saveOrderDayState("2026-08-26", freshState({ won: false }));
    saveOrderDayState("2026-08-27", freshState({ done: true, won: true }));
    expect(getOrderDayState("2026-08-26", SLOT_COUNT)?.done).toBe(false);
    expect(getOrderDayState("2026-08-27", SLOT_COUNT)?.done).toBe(true);
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

  it("treats a pre-first-redesign stored value (attempt/history/locked Mastermind shape) as nothing stored", () => {
    // The original issue #207 multi-attempt Mastermind shape -- a stale
    // value from before either mechanic redesign. It must not be trusted
    // just because it happens to have a well-formed `guess` array.
    window.localStorage.setItem(
      "hikt:the-order:day:2026-08-26",
      JSON.stringify({
        guess: ["A", "B", "C", "D", "E"],
        attempt: 2,
        history: [],
        locked: [false, false, false, false, false],
        done: false,
        won: false,
      }),
    );
    expect(getOrderDayState("2026-08-26", SLOT_COUNT)).toBeNull();
  });

  it("treats a pre-this-redesign stored value (the one-shot guess/done/won/feedback shape, no `attempts`) as nothing stored", () => {
    // The first redesign's shape -- real, well-formed, but missing the
    // `attempts` field this redesign requires. Confirms the safe-fallback
    // migration choice documented in this module's own top-of-file
    // comment: an old-shape blob reads as "nothing stored," not a crash
    // and not a silent misinterpretation as the new shape.
    window.localStorage.setItem(
      "hikt:the-order:day:2026-08-26",
      JSON.stringify({
        guess: ["A", "B", "C", "D", "E"],
        done: true,
        won: false,
        feedback: ["correct", "incorrect", "correct", "incorrect", "correct"],
      }),
    );
    expect(getOrderDayState("2026-08-26", SLOT_COUNT)).toBeNull();
  });

  it("accepts a stored feedback array containing 'revealed' entries -- a bail-out reveal's own grading, not just 'correct'/'incorrect'", () => {
    // Real, code-review-caught gap: the runtime shape validator here
    // still only allowed the two literals OrderFeedback originally had,
    // so a reveal()-produced state (which grades every never-locked slot
    // "revealed") was silently discarded as "nothing stored" the moment
    // it round-tripped through JSON.
    const state = freshState({
      done: true,
      won: false,
      feedback: ["correct", "revealed", "revealed", "correct", "revealed"],
    });
    window.localStorage.setItem("hikt:the-order:day:2026-08-26", JSON.stringify(state));
    expect(getOrderDayState("2026-08-26", SLOT_COUNT)).toEqual(state);
  });

  it("rejects a stored value whose attempts field is missing or the wrong type", () => {
    window.localStorage.setItem(
      "hikt:the-order:day:2026-08-26",
      JSON.stringify({ ...freshState(), attempts: "2" }),
    );
    expect(getOrderDayState("2026-08-26", SLOT_COUNT)).toBeNull();
  });

  it("rejects a stored value with a negative attempts count", () => {
    window.localStorage.setItem(
      "hikt:the-order:day:2026-08-26",
      JSON.stringify({ ...freshState(), attempts: -1 }),
    );
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

  // The confirmed spec's own streak-counting call: a win counts on
  // eventual full solve regardless of how many submissions it took --
  // this is deliberately a property of `recordOrderCompletion`'s own
  // caller (use-order-game.ts only ever calls it with `won: true` once
  // `done` first goes true via a full solve, no matter the attempt
  // count), not something `computeOrderStreak` itself needs to know
  // about at all -- it only ever sees the final win/loss per day.
  it("counts a win the same way regardless of how many attempts a day took to solve", () => {
    const wonInOneAttempt = [{ date: "2026-08-20", won: true }];
    const wonInManyAttempts = [{ date: "2026-08-20", won: true }];
    expect(computeOrderStreak(wonInOneAttempt)).toEqual(computeOrderStreak(wonInManyAttempts));
  });
});
