import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RESULTS_SCHEMA_VERSION, type TheOrderPuzzle } from "@hadiknowntrades/core";

import { bestToWorstTickers } from "./order-scoring";
import * as orderStorage from "./order-storage";
import { getOrderDayState, saveOrderDayState, type OrderDayState } from "./order-storage";
import { useOrderGame } from "./use-order-game";

const DATE = "2026-08-26";

// Worst-to-best, exactly as the server always emits it.
const PUZZLE: TheOrderPuzzle = {
  schemaVersion: RESULTS_SCHEMA_VERSION,
  generatedAt: "2026-08-27T06:00:00.000Z",
  date: DATE,
  tickers: [
    { ticker: "TSLA", companyName: "Tesla, Inc.", pctReturn: -3.1 },
    { ticker: "AAPL", companyName: "Apple Inc.", pctReturn: -0.42 },
    { ticker: "MSFT", companyName: "Microsoft", pctReturn: 0.55 },
    { ticker: "META", companyName: "Meta Platforms", pctReturn: 1.85 },
    { ticker: "NVDA", companyName: "Nvidia", pctReturn: 3.2 },
  ],
};

// Best-to-worst -- what the game actually shows/grades against.
const ANSWER = bestToWorstTickers(PUZZLE.tickers).map((t) => t.ticker);

function stateWith(overrides: Partial<OrderDayState> = {}): OrderDayState {
  return {
    guess: [...ANSWER],
    feedback: null,
    attempts: 0,
    done: false,
    won: false,
    ...overrides,
  };
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useOrderGame -- stored-state verification against the current puzzle", () => {
  it("discards stored state whose guess is not a permutation of the current puzzle's own tickers", async () => {
    // A stale/backfilled puzzle: the persisted guess is a real permutation
    // of a *different* 5-ticker set entirely, not today's real answer.
    saveOrderDayState(
      DATE,
      stateWith({
        guess: ["GOOGL", "AMZN", "AAPL", "MSFT", "NVDA"],
        done: true,
        won: false,
        feedback: ["incorrect", "incorrect", "incorrect", "incorrect", "incorrect"],
      }),
    );

    const { result } = renderHook(() => useOrderGame(PUZZLE));
    await waitFor(() => expect(result.current.view.hydrated).toBe(true));

    // Falls back to a fresh state -- not done, no feedback -- rather than
    // trusting the stale, mismatched stored guess.
    expect(result.current.view.state!.done).toBe(false);
    expect(result.current.view.state!.feedback).toBeNull();
    expect(result.current.view.state!.attempts).toBe(0);
    expect([...result.current.view.state!.guess].sort()).toEqual([...ANSWER].sort());
  });

  it("still trusts stored state that IS a genuine permutation of the current puzzle's tickers", async () => {
    const reordered = [...ANSWER].reverse();
    saveOrderDayState(DATE, stateWith({ guess: reordered }));

    const { result } = renderHook(() => useOrderGame(PUZZLE));
    await waitFor(() => expect(result.current.view.hydrated).toBe(true));

    expect(result.current.view.state!.guess).toEqual(reordered);
  });

  it("treats a pre-this-redesign stored value (missing `attempts`) as nothing stored, and starts fresh", async () => {
    // The one-shot mechanic's own shape, written before this redesign --
    // a real, well-formed OrderDayState under the old contract, just
    // missing the `attempts` field this redesign requires. Matches
    // order-storage.ts's own documented safe-fallback migration choice.
    window.localStorage.setItem(
      `hikt:the-order:day:${DATE}`,
      JSON.stringify({
        guess: [...ANSWER],
        done: true,
        won: true,
        feedback: ["correct", "correct", "correct", "correct", "correct"],
      }),
    );

    const { result } = renderHook(() => useOrderGame(PUZZLE));
    await waitFor(() => expect(result.current.view.hydrated).toBe(true));

    expect(result.current.view.state!.done).toBe(false);
    expect(result.current.view.state!.attempts).toBe(0);
    expect(result.current.view.state!.feedback).toBeNull();
  });
});

describe("useOrderGame -- persist() only re-reads streak history on the done transition", () => {
  // Spying on order-storage.ts's own exported getOrderStreakHistory
  // directly (mirroring use-starting-capital.test.ts's own established
  // "spy on the shared module, not on window.localStorage directly"
  // pattern) rather than on window.localStorage.getItem itself -- jsdom's
  // window.localStorage accessor in this project's test environment
  // doesn't reliably expose the same Storage instance across separate
  // property reads, so a raw vi.spyOn(window.localStorage, "getItem")
  // silently fails to intercept anything here (confirmed directly: even
  // a bare `window.localStorage.getItem("x")` call right after installing
  // such a spy records zero calls). Spying on the module's own exported
  // function is both more reliable and a more precise assertion of the
  // actual claim being tested anyway.
  it("does not read the streak history on an intermediate move, shuffle, or a still-incorrect submit", async () => {
    const { result } = renderHook(() => useOrderGame(PUZZLE));
    await waitFor(() => expect(result.current.view.hydrated).toBe(true));

    const streakSpy = vi.spyOn(orderStorage, "getOrderStreakHistory");

    act(() => {
      result.current.move(0, 1);
    });
    act(() => {
      result.current.shuffle();
    });
    // The hook's own fresh state is a shuffled guess `initialOrderGuess`
    // guarantees is never exactly the real answer, so this submit is
    // guaranteed not to win outright -- confirming a still-incorrect
    // submit (not just move/shuffle) also never reads the streak
    // history, since `done` never goes true here.
    act(() => {
      result.current.submit();
    });

    expect(result.current.view.state!.done).toBe(false);
    expect(streakSpy).not.toHaveBeenCalled();
  });

  it("does read the streak history the instant `done` first goes true, on a winning submit", async () => {
    saveOrderDayState(DATE, stateWith({ guess: [...ANSWER] }));
    const { result } = renderHook(() => useOrderGame(PUZZLE));
    await waitFor(() => expect(result.current.view.hydrated).toBe(true));
    expect(result.current.view.state!.guess).toEqual(ANSWER);

    const streakSpy = vi.spyOn(orderStorage, "getOrderStreakHistory");
    act(() => {
      result.current.submit();
    });

    expect(result.current.view.state!.done).toBe(true);
    expect(result.current.view.state!.won).toBe(true);
    expect(streakSpy).toHaveBeenCalled();
  });
});

describe("useOrderGame -- submit(): partial-correct locking and resubmission", () => {
  it("wins outright when the guess exactly matches the real (best-to-worst) answer", async () => {
    saveOrderDayState(DATE, stateWith({ guess: [...ANSWER] }));
    const { result } = renderHook(() => useOrderGame(PUZZLE));
    await waitFor(() => expect(result.current.view.hydrated).toBe(true));

    act(() => {
      result.current.submit();
    });

    expect(result.current.view.state!.done).toBe(true);
    expect(result.current.view.state!.won).toBe(true);
    expect(result.current.view.state!.attempts).toBe(1);
    expect(result.current.view.state!.feedback).toEqual([
      "correct",
      "correct",
      "correct",
      "correct",
      "correct",
    ]);
  });

  it("grades a mixed guess per slot, locks the correct ones, and does NOT end the day", async () => {
    // Swap the two end slots -- both wrong, the three middle slots correct.
    const guess = [...ANSWER];
    [guess[0], guess[4]] = [guess[4]!, guess[0]!];
    saveOrderDayState(DATE, stateWith({ guess }));
    const { result } = renderHook(() => useOrderGame(PUZZLE));
    await waitFor(() => expect(result.current.view.hydrated).toBe(true));

    act(() => {
      result.current.submit();
    });

    // A partial-correct submit no longer ends the day (the core
    // behavior change of this redesign).
    expect(result.current.view.state!.done).toBe(false);
    expect(result.current.view.state!.won).toBe(false);
    expect(result.current.view.state!.attempts).toBe(1);
    expect(result.current.view.state!.feedback).toEqual([
      "incorrect",
      "correct",
      "correct",
      "correct",
      "incorrect",
    ]);
  });

  it("a locked (correct) slot cannot be moved, and cannot be targeted by another slot's move", async () => {
    const guess = [...ANSWER];
    [guess[0], guess[4]] = [guess[4]!, guess[0]!]; // slots 1-3 (0-indexed) are correct
    saveOrderDayState(DATE, stateWith({ guess }));
    const { result } = renderHook(() => useOrderGame(PUZZLE));
    await waitFor(() => expect(result.current.view.hydrated).toBe(true));

    act(() => {
      result.current.submit();
    });
    expect(result.current.view.state!.feedback![1]).toBe("correct");

    // Trying to move the locked slot at index 1 must be a no-op.
    const beforeGuess = result.current.view.state!.guess;
    act(() => {
      result.current.move(1, 1);
    });
    expect(result.current.view.state!.guess).toEqual(beforeGuess);

    // Moving the open slot at index 0 must hop over the locked slot at
    // index 1 (and 2, 3), landing on the other open slot at index 4 --
    // never swapping into a locked slot.
    act(() => {
      result.current.move(0, 1);
    });
    expect(result.current.view.state!.guess[1]).toBe(beforeGuess[1]); // locked slot untouched
    expect(result.current.view.state!.guess[4]).toBe(beforeGuess[0]); // hopped all the way to slot 4
  });

  it("shuffle only rearranges the still-open slots, leaving locked slots exactly in place", async () => {
    const guess = [...ANSWER];
    [guess[0], guess[4]] = [guess[4]!, guess[0]!]; // slots 1-3 correct once submitted
    saveOrderDayState(DATE, stateWith({ guess }));
    const { result } = renderHook(() => useOrderGame(PUZZLE));
    await waitFor(() => expect(result.current.view.hydrated).toBe(true));

    act(() => {
      result.current.submit();
    });
    const lockedTickers = [
      result.current.view.state!.guess[1],
      result.current.view.state!.guess[2],
      result.current.view.state!.guess[3],
    ];

    act(() => {
      result.current.shuffle();
    });

    expect([
      result.current.view.state!.guess[1],
      result.current.view.state!.guess[2],
      result.current.view.state!.guess[3],
    ]).toEqual(lockedTickers);
    // The two open slots still hold exactly the same two tickers, just
    // possibly reordered.
    expect(
      [result.current.view.state!.guess[0], result.current.view.state!.guess[4]].sort(),
    ).toEqual([guess[0], guess[4]].sort());
  });

  it("shuffle() is a no-op (no persist, no re-render) with fewer than 2 open slots -- shuffleUnlockedGuess always allocates a fresh array, so a reference check can't catch this the way move()'s does", async () => {
    // Exactly 1 open slot can't actually arise from a real submit() --
    // scoreOrderMatch grades a whole permutation, and leaving precisely
    // one slot wrong is a mathematical impossibility (if every other
    // slot is already correct, the one remaining ticker has nowhere
    // else to go). Seeded directly to exercise the guard itself,
    // regardless of whether real play can reach this exact shape.
    saveOrderDayState(
      DATE,
      stateWith({
        attempts: 1,
        feedback: ["correct", "correct", "correct", "correct", "incorrect"],
      }),
    );
    const { result } = renderHook(() => useOrderGame(PUZZLE));
    await waitFor(() => expect(result.current.view.hydrated).toBe(true));
    const beforeState = result.current.view.state;
    const persistSpy = vi.spyOn(orderStorage, "saveOrderDayState");

    act(() => {
      result.current.shuffle();
    });

    expect(result.current.view.state).toBe(beforeState); // same reference -- no new state object at all
    expect(persistSpy).not.toHaveBeenCalled();
  });

  it("a second, fully-correct resubmission of the still-open slots wins the day -- eventual full solve, no attempt cap", async () => {
    const guess = [...ANSWER];
    [guess[0], guess[4]] = [guess[4]!, guess[0]!]; // one wrong swap, rest correct
    saveOrderDayState(DATE, stateWith({ guess }));
    const { result } = renderHook(() => useOrderGame(PUZZLE));
    await waitFor(() => expect(result.current.view.hydrated).toBe(true));

    act(() => {
      result.current.submit();
    });
    expect(result.current.view.state!.done).toBe(false);
    expect(result.current.view.state!.attempts).toBe(1);

    // Fix the one wrong swap by moving slot 0 over to slot 4 (hopping the
    // three locked slots in between), then resubmit.
    act(() => {
      result.current.move(0, 1);
    });
    act(() => {
      result.current.submit();
    });

    expect(result.current.view.state!.done).toBe(true);
    expect(result.current.view.state!.won).toBe(true);
    expect(result.current.view.state!.attempts).toBe(2);
    expect(result.current.view.state!.feedback).toEqual([
      "correct",
      "correct",
      "correct",
      "correct",
      "correct",
    ]);
  });

  it("records exactly one streak entry for an eventual win that took several attempts", async () => {
    const guess = [...ANSWER];
    [guess[0], guess[4]] = [guess[4]!, guess[0]!];
    saveOrderDayState(DATE, stateWith({ guess }));
    const { result } = renderHook(() => useOrderGame(PUZZLE));
    await waitFor(() => expect(result.current.view.hydrated).toBe(true));

    act(() => {
      result.current.submit(); // attempt 1: still incorrect on 2 slots
    });
    act(() => {
      result.current.submit(); // attempt 2: a no-op re-submit changes nothing
    });
    act(() => {
      result.current.move(0, 1);
    });
    act(() => {
      result.current.submit(); // attempt 3: the winning one
    });

    expect(result.current.view.state!.done).toBe(true);
    expect(result.current.view.state!.won).toBe(true);
    expect(result.current.view.state!.attempts).toBe(3);
    expect(result.current.view.streak.currentStreak).toBe(1);
    expect(getOrderDayState(DATE, 5)!.attempts).toBe(3);
  });
});

describe("useOrderGame -- move/shuffle/submit/reveal are no-ops once the day is already done", () => {
  // Real, reachable defensive guards, not dead code: a double-click or a
  // stray keyboard-repeat firing an action after `done` already went
  // true (e.g. between the winning submit() and the settlement UI
  // actually re-rendering to hide the controls) must not silently
  // re-open, re-attempt, or re-record a finished puzzle.
  it("move() does not change a finished day's stored guess", async () => {
    const finished = stateWith({
      attempts: 1,
      done: true,
      won: true,
      feedback: ["correct", "correct", "correct", "correct", "correct"],
    });
    saveOrderDayState(DATE, finished);
    const { result } = renderHook(() => useOrderGame(PUZZLE));
    await waitFor(() => expect(result.current.view.hydrated).toBe(true));

    act(() => {
      result.current.move(0, 1);
    });

    expect(result.current.view.state).toEqual(finished);
  });

  it("shuffle() does not change a finished day's stored guess", async () => {
    const finished = stateWith({
      attempts: 4,
      done: true,
      won: false,
      feedback: ["incorrect", "incorrect", "incorrect", "incorrect", "incorrect"],
    });
    saveOrderDayState(DATE, finished);
    const { result } = renderHook(() => useOrderGame(PUZZLE));
    await waitFor(() => expect(result.current.view.hydrated).toBe(true));

    act(() => {
      result.current.shuffle();
    });

    expect(result.current.view.state).toEqual(finished);
  });

  it("submit() does not re-grade an already-finished day", async () => {
    const finished = stateWith({
      attempts: 2,
      done: true,
      won: true,
      feedback: ["correct", "correct", "correct", "correct", "correct"],
    });
    saveOrderDayState(DATE, finished);
    const { result } = renderHook(() => useOrderGame(PUZZLE));
    await waitFor(() => expect(result.current.view.hydrated).toBe(true));

    const streakSpy = vi.spyOn(orderStorage, "getOrderStreakHistory");
    act(() => {
      result.current.submit();
    });

    expect(result.current.view.state).toEqual(finished);
    expect(streakSpy).not.toHaveBeenCalled();
  });

  it("reveal() does not overwrite an already-finished day's real won/feedback", async () => {
    const finished = stateWith({
      attempts: 1,
      done: true,
      won: true,
      feedback: ["correct", "correct", "correct", "correct", "correct"],
    });
    saveOrderDayState(DATE, finished);
    const { result } = renderHook(() => useOrderGame(PUZZLE));
    await waitFor(() => expect(result.current.view.hydrated).toBe(true));

    act(() => {
      result.current.reveal();
    });

    // A real win must never be silently flipped to won: false by a
    // stray post-finish reveal() call.
    expect(result.current.view.state).toEqual(finished);
  });

  it("reveal() on a genuinely in-progress day marks it done, not won, and grades every never-locked slot 'revealed' (not null, and not 'incorrect')", async () => {
    const { result } = renderHook(() => useOrderGame(PUZZLE));
    await waitFor(() => expect(result.current.view.hydrated).toBe(true));
    expect(result.current.view.state!.done).toBe(false);

    act(() => {
      result.current.reveal();
    });

    expect(result.current.view.state!.done).toBe(true);
    expect(result.current.view.state!.won).toBe(false);
    // Nothing was ever locked on this day, so every slot grades
    // "revealed" -- never "correct" (nothing was earned) and never
    // "incorrect" (the guess array now holds the real answer at every
    // index, so "incorrect" would be a flatly wrong label).
    expect(result.current.view.state!.feedback).toEqual([
      "revealed",
      "revealed",
      "revealed",
      "revealed",
      "revealed",
    ]);
  });

  it("reveal() preserves a slot's real 'correct' grading if it was already locked before the reveal", async () => {
    // Seed a prior submission that already locked slots 0 and 3 correct
    // -- a real bug (found in code review) wiped every slot's badge back
    // to nothing on reveal, including ones the player had genuinely
    // already earned.
    saveOrderDayState(
      DATE,
      stateWith({
        attempts: 1,
        feedback: ["correct", "incorrect", "incorrect", "correct", "incorrect"],
      }),
    );
    const { result } = renderHook(() => useOrderGame(PUZZLE));
    await waitFor(() => expect(result.current.view.hydrated).toBe(true));

    act(() => {
      result.current.reveal();
    });

    expect(result.current.view.state!.feedback).toEqual([
      "correct",
      "revealed",
      "revealed",
      "correct",
      "revealed",
    ]);
  });

  it("reveal() replaces the guess with the real answer, so every slot actually shows the ticker that belongs there", async () => {
    // Deliberately start from a wrong arrangement -- if reveal() merely
    // left the guess as-is (the bug this test guards against), the
    // player's own wrong guess would still be showing after "revealing."
    const wrong = [...ANSWER].reverse();
    saveOrderDayState(DATE, stateWith({ guess: wrong }));
    const { result } = renderHook(() => useOrderGame(PUZZLE));
    await waitFor(() => expect(result.current.view.hydrated).toBe(true));
    expect(result.current.view.state!.guess).toEqual(wrong);

    act(() => {
      result.current.reveal();
    });

    expect(result.current.view.state!.guess).toEqual(ANSWER);
  });

  it("reveal() preserves the attempts count made so far -- a give-up isn't itself an attempt", async () => {
    const guess = [...ANSWER];
    [guess[0], guess[4]] = [guess[4]!, guess[0]!];
    saveOrderDayState(DATE, stateWith({ guess }));
    const { result } = renderHook(() => useOrderGame(PUZZLE));
    await waitFor(() => expect(result.current.view.hydrated).toBe(true));

    act(() => {
      result.current.submit();
    });
    expect(result.current.view.state!.attempts).toBe(1);

    act(() => {
      result.current.reveal();
    });
    expect(result.current.view.state!.attempts).toBe(1);
  });
});
