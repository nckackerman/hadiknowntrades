import type { PresetRange } from "@hadiknowntrades/core";
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { useDailyGuess } from "./use-daily-guess";

describe("useDailyGuess", () => {
  afterEach(() => {
    window.localStorage.clear();
  });

  it("starts with no guess for a (range, date) pair that hasn't been guessed", () => {
    const { result } = renderHook(() => useDailyGuess("1M", "2026-08-20"));

    expect(result.current.guess).toBeNull();
  });

  it("reflects a submitted guess immediately", () => {
    const { result } = renderHook(() => useDailyGuess("1M", "2026-08-20"));

    act(() => {
      result.current.submitGuess(42);
    });

    expect(result.current.guess).toBe(42);
  });

  it("persists the guess to localStorage, so a fresh mount for the same (range, date) sees it (simulated reload)", () => {
    const { result, unmount } = renderHook(() => useDailyGuess("1M", "2026-08-20"));
    act(() => {
      result.current.submitGuess(42);
    });
    unmount();

    const { result: reloaded } = renderHook(() => useDailyGuess("1M", "2026-08-20"));

    expect(reloaded.current.guess).toBe(42);
  });

  it("re-checks storage fresh when the date changes, instead of carrying over the previous date's guess", () => {
    const { result, rerender } = renderHook(({ date }) => useDailyGuess("1M", date), {
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

  it("re-checks storage fresh when the range changes for the same date, instead of carrying over the previous range's guess (issue: 1M/3M/1Y can genuinely differ on the same calendar date)", () => {
    const { result, rerender } = renderHook(
      ({ range }: { range: PresetRange }) => useDailyGuess(range, "2026-08-20"),
      { initialProps: { range: "1M" } },
    );

    act(() => {
      result.current.submitGuess(42);
    });
    expect(result.current.guess).toBe(42);

    rerender({ range: "3M" });

    expect(result.current.guess).toBeNull();

    rerender({ range: "1M" });

    expect(result.current.guess).toBe(42);
  });

  it("does not let a guess submitted under one range suppress the guess-gate for the same date under another range", () => {
    const { result: oneMonth } = renderHook(() => useDailyGuess("1M", "2026-08-20"));
    act(() => {
      oneMonth.current.submitGuess(42);
    });

    const { result: threeMonth } = renderHook(() => useDailyGuess("3M", "2026-08-20"));
    expect(threeMonth.current.guess).toBeNull();

    const { result: oneYear } = renderHook(() => useDailyGuess("1Y", "2026-08-20"));
    expect(oneYear.current.guess).toBeNull();
  });
});
