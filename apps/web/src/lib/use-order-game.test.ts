import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RESULTS_SCHEMA_VERSION, type TheOrderPuzzle } from "@hadiknowntrades/core";

import { bestToWorstTickers } from "./order-scoring";
import * as orderStorage from "./order-storage";
import { saveOrderDayState, type OrderDayState } from "./order-storage";
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

// Best-to-worst -- what the redesigned game actually shows/grades against.
const ANSWER = bestToWorstTickers(PUZZLE.tickers).map((t) => t.ticker);

function stateWith(overrides: Partial<OrderDayState> = {}): OrderDayState {
  return {
    guess: [...ANSWER],
    done: false,
    won: false,
    feedback: null,
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
    expect([...result.current.view.state!.guess].sort()).toEqual([...ANSWER].sort());
  });

  it("still trusts stored state that IS a genuine permutation of the current puzzle's tickers", async () => {
    const reordered = [...ANSWER].reverse();
    saveOrderDayState(DATE, stateWith({ guess: reordered }));

    const { result } = renderHook(() => useOrderGame(PUZZLE));
    await waitFor(() => expect(result.current.view.hydrated).toBe(true));

    expect(result.current.view.state!.guess).toEqual(reordered);
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
  it("does not read the streak history on an intermediate move or shuffle", async () => {
    const { result } = renderHook(() => useOrderGame(PUZZLE));
    await waitFor(() => expect(result.current.view.hydrated).toBe(true));

    const streakSpy = vi.spyOn(orderStorage, "getOrderStreakHistory");

    act(() => {
      result.current.move(0, 1);
    });
    act(() => {
      result.current.shuffle();
    });

    // Neither move() nor shuffle() ever changes `done` (they only ever
    // rearrange an in-progress guess), so this is deterministic -- no
    // reliance on a shuffled guess happening not to match the real answer.
    expect(result.current.view.state!.done).toBe(false);
    expect(streakSpy).not.toHaveBeenCalled();
  });

  it("does read the streak history the instant `done` first goes true, on submit", async () => {
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

describe("useOrderGame -- submit()", () => {
  it("wins outright when the guess exactly matches the real (best-to-worst) answer", async () => {
    saveOrderDayState(DATE, stateWith({ guess: [...ANSWER] }));
    const { result } = renderHook(() => useOrderGame(PUZZLE));
    await waitFor(() => expect(result.current.view.hydrated).toBe(true));

    act(() => {
      result.current.submit();
    });

    expect(result.current.view.state!.done).toBe(true);
    expect(result.current.view.state!.won).toBe(true);
    expect(result.current.view.state!.feedback).toEqual([
      "correct",
      "correct",
      "correct",
      "correct",
      "correct",
    ]);
  });

  it("grades a mixed guess per slot and does not win", async () => {
    // Swap the two end slots -- both wrong, the three middle slots correct.
    const guess = [...ANSWER];
    [guess[0], guess[4]] = [guess[4]!, guess[0]!];
    saveOrderDayState(DATE, stateWith({ guess }));
    const { result } = renderHook(() => useOrderGame(PUZZLE));
    await waitFor(() => expect(result.current.view.hydrated).toBe(true));

    act(() => {
      result.current.submit();
    });

    expect(result.current.view.state!.done).toBe(true);
    expect(result.current.view.state!.won).toBe(false);
    expect(result.current.view.state!.feedback).toEqual([
      "incorrect",
      "correct",
      "correct",
      "correct",
      "incorrect",
    ]);
  });

  it("always ends the day -- there is no second attempt", async () => {
    const guess = [...ANSWER].reverse();
    saveOrderDayState(DATE, stateWith({ guess }));
    const { result } = renderHook(() => useOrderGame(PUZZLE));
    await waitFor(() => expect(result.current.view.hydrated).toBe(true));

    act(() => {
      result.current.submit();
    });

    expect(result.current.view.state!.done).toBe(true);
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

  it("reveal() on a genuinely in-progress day marks it done without a win or feedback, per its own contract", async () => {
    const { result } = renderHook(() => useOrderGame(PUZZLE));
    await waitFor(() => expect(result.current.view.hydrated).toBe(true));
    expect(result.current.view.state!.done).toBe(false);

    act(() => {
      result.current.reveal();
    });

    expect(result.current.view.state!.done).toBe(true);
    expect(result.current.view.state!.won).toBe(false);
    expect(result.current.view.state!.feedback).toBeNull();
  });
});
