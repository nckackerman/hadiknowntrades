import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RESULTS_SCHEMA_VERSION, type TheOrderPuzzle } from "@hadiknowntrades/core";

import * as orderStorage from "./order-storage";
import { saveOrderDayState, type OrderDayState } from "./order-storage";
import { useOrderGame } from "./use-order-game";

const DATE = "2026-08-26";

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

const ANSWER = PUZZLE.tickers.map((t) => t.ticker);

function stateWith(overrides: Partial<OrderDayState> = {}): OrderDayState {
  return {
    guess: [...ANSWER],
    attempt: 1,
    history: [],
    locked: [false, false, false, false, false],
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

describe("useOrderGame -- stored-state verification against the current puzzle (issue #210)", () => {
  it("discards stored state whose guess is not a permutation of the current puzzle's own tickers", async () => {
    // A stale/backfilled puzzle: the persisted guess is a real permutation
    // of a *different* 5-ticker set entirely, not today's real answer.
    saveOrderDayState(
      DATE,
      stateWith({
        guess: ["GOOGL", "AMZN", "AAPL", "MSFT", "NVDA"],
        attempt: 3,
        history: [
          {
            guess: ["GOOGL", "AMZN", "AAPL", "MSFT", "NVDA"],
            feedback: ["far", "far", "far", "far", "far"],
          },
        ],
      }),
    );

    const { result } = renderHook(() => useOrderGame(PUZZLE));
    await waitFor(() => expect(result.current.view.hydrated).toBe(true));

    // Falls back to a fresh state -- attempt 1, no history -- rather than
    // trusting the stale, mismatched stored guess.
    expect(result.current.view.state!.attempt).toBe(1);
    expect(result.current.view.state!.history).toEqual([]);
    expect([...result.current.view.state!.guess].sort()).toEqual([...ANSWER].sort());
  });

  it("still trusts stored state that IS a genuine permutation of the current puzzle's tickers", async () => {
    const reordered = [...ANSWER].reverse();
    saveOrderDayState(
      DATE,
      stateWith({
        guess: reordered,
        attempt: 2,
        history: [{ guess: reordered, feedback: ["far", "far", "exact", "far", "far"] }],
      }),
    );

    const { result } = renderHook(() => useOrderGame(PUZZLE));
    await waitFor(() => expect(result.current.view.hydrated).toBe(true));

    expect(result.current.view.state!.attempt).toBe(2);
    expect(result.current.view.state!.guess).toEqual(reordered);
  });
});

describe("useOrderGame -- persist() only re-reads streak history on the done transition (issue #210)", () => {
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

  it("does not read the streak history on a submit that doesn't finish the puzzle", async () => {
    // A deterministic, guaranteed-not-a-win guess (a fully reversed
    // answer, per order-scoring.test.ts's own "scores a fully reversed
    // guess" case) -- no reliance on any random shuffle outcome.
    saveOrderDayState(DATE, stateWith({ guess: [...ANSWER].reverse() }));
    const { result } = renderHook(() => useOrderGame(PUZZLE));
    await waitFor(() => expect(result.current.view.hydrated).toBe(true));

    const streakSpy = vi.spyOn(orderStorage, "getOrderStreakHistory");
    act(() => {
      result.current.submit();
    });

    expect(result.current.view.state!.done).toBe(false);
    expect(result.current.view.state!.attempt).toBe(2);
    expect(streakSpy).not.toHaveBeenCalled();
  });

  it("does read the streak history the instant `done` first goes true", async () => {
    // Seed the guess as the exact real answer so the very next submit()
    // call wins outright on the first attempt -- the shortest real path
    // to a `done` transition.
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
