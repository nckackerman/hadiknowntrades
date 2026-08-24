import type { PresetRange } from "@hadiknowntrades/core";
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { useRangeGuess } from "./use-range-guess";

describe("useRangeGuess", () => {
  afterEach(() => {
    window.localStorage.clear();
  });

  it("starts with no guess for a (range, mode) pair that hasn't been guessed", () => {
    const { result } = renderHook(() => useRangeGuess("1M", "long"));

    expect(result.current.guess).toBeNull();
    expect(result.current.guessStartingCapital).toBeNull();
  });

  it("reflects a submitted guess (and the starting capital it was made against) immediately", () => {
    const { result } = renderHook(() => useRangeGuess("1M", "long"));

    act(() => {
      result.current.submitGuess(42, 20);
    });

    expect(result.current.guess).toBe(42);
    expect(result.current.guessStartingCapital).toBe(20);
  });

  it("persists the guess to localStorage, so a fresh mount for the same (range, mode) sees it (simulated reload)", () => {
    const { result, unmount } = renderHook(() => useRangeGuess("1M", "long"));
    act(() => {
      result.current.submitGuess(42, 20);
    });
    unmount();

    const { result: reloaded } = renderHook(() => useRangeGuess("1M", "long"));

    expect(reloaded.current.guess).toBe(42);
    expect(reloaded.current.guessStartingCapital).toBe(20);
  });

  it("re-checks storage fresh when the range changes, instead of carrying over the previous range's guess", () => {
    const { result, rerender } = renderHook(
      ({ range }: { range: PresetRange }) => useRangeGuess(range, "long"),
      { initialProps: { range: "1M" } },
    );

    act(() => {
      result.current.submitGuess(42, 20);
    });
    expect(result.current.guess).toBe(42);

    rerender({ range: "3M" });

    expect(result.current.guess).toBeNull();

    rerender({ range: "1M" });

    expect(result.current.guess).toBe(42);
  });

  it("does not let a guess submitted under one range suppress the guess-gate for another range", () => {
    const { result: oneMonth } = renderHook(() => useRangeGuess("1M", "long"));
    act(() => {
      oneMonth.current.submitGuess(42, 20);
    });

    const { result: threeMonth } = renderHook(() => useRangeGuess("3M", "long"));
    expect(threeMonth.current.guess).toBeNull();
  });

  describe("mode (issue #13)", () => {
    it("re-checks storage fresh when mode changes for the same range, instead of carrying over the previous mode's guess", () => {
      const { result, rerender } = renderHook(
        ({ mode }: { mode: "long" | "long-short" }) => useRangeGuess("1M", mode),
        { initialProps: { mode: "long" } },
      );

      act(() => {
        result.current.submitGuess(42, 20);
      });
      expect(result.current.guess).toBe(42);

      rerender({ mode: "long-short" });

      expect(result.current.guess).toBeNull();

      rerender({ mode: "long" });

      expect(result.current.guess).toBe(42);
    });

    it("does not let a guess submitted under one mode suppress the guess-gate for the same range under another mode", () => {
      const { result: longOnly } = renderHook(() => useRangeGuess("1M", "long"));
      act(() => {
        longOnly.current.submitGuess(42, 20);
      });

      const { result: longShort } = renderHook(() => useRangeGuess("1M", "long-short"));
      expect(longShort.current.guess).toBeNull();
    });
  });
});
