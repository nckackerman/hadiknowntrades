import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { useDailyGuess } from "./use-daily-guess";

describe("useDailyGuess", () => {
  afterEach(() => {
    window.localStorage.clear();
  });

  it("starts with no guess for a date that hasn't been guessed", () => {
    const { result } = renderHook(() => useDailyGuess("2026-08-20"));

    expect(result.current.guess).toBeNull();
  });

  it("reflects a submitted guess immediately", () => {
    const { result } = renderHook(() => useDailyGuess("2026-08-20"));

    act(() => {
      result.current.submitGuess(42);
    });

    expect(result.current.guess).toBe(42);
  });

  it("persists the guess to localStorage, so a fresh mount for the same date sees it (simulated reload)", () => {
    const { result, unmount } = renderHook(() => useDailyGuess("2026-08-20"));
    act(() => {
      result.current.submitGuess(42);
    });
    unmount();

    const { result: reloaded } = renderHook(() => useDailyGuess("2026-08-20"));

    expect(reloaded.current.guess).toBe(42);
  });

  it("re-checks storage fresh when the date changes, instead of carrying over the previous date's guess", () => {
    const { result, rerender } = renderHook(({ date }) => useDailyGuess(date), {
      initialProps: { date: "2026-08-20" },
    });

    act(() => {
      result.current.submitGuess(42);
    });
    expect(result.current.guess).toBe(42);

    rerender({ date: "2026-08-21" });

    expect(result.current.guess).toBeNull();

    rerender({ date: "2026-08-20" });

    expect(result.current.guess).toBe(42);
  });
});
