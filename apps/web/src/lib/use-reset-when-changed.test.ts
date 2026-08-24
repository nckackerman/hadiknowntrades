import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useResetWhenChanged } from "./use-reset-when-changed";

describe("useResetWhenChanged", () => {
  it("does not call onChange on the initial render", () => {
    const onChange = vi.fn();
    renderHook(() => useResetWhenChanged([1, "a"], onChange));

    expect(onChange).not.toHaveBeenCalled();
  });

  it("calls onChange exactly once when a single tracked value changes", () => {
    const onChange = vi.fn();
    const { rerender } = renderHook(({ value }) => useResetWhenChanged([value], onChange), {
      initialProps: { value: 1 },
    });

    rerender({ value: 1 });
    expect(onChange).not.toHaveBeenCalled();

    rerender({ value: 2 });
    expect(onChange).toHaveBeenCalledOnce();

    rerender({ value: 2 });
    expect(onChange).toHaveBeenCalledOnce();
  });

  it("calls onChange when any one of several tracked values changes (PortfolioChart's own two-value case)", () => {
    const onChange = vi.fn();
    const { rerender } = renderHook(
      ({ a, b }: { a: number; b: boolean }) => useResetWhenChanged([a, b], onChange),
      { initialProps: { a: 1, b: true } },
    );

    rerender({ a: 1, b: true });
    expect(onChange).not.toHaveBeenCalled();

    // Only the second value changes -- still counts as a change.
    rerender({ a: 1, b: false });
    expect(onChange).toHaveBeenCalledOnce();

    // Only the first value changes.
    rerender({ a: 2, b: false });
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it("compares by Object.is, not deep equality -- a new array with the same contents still counts as changed", () => {
    const onChange = vi.fn();
    const { rerender } = renderHook(
      ({ points }: { points: readonly number[] }) => useResetWhenChanged([points], onChange),
      { initialProps: { points: [1, 2, 3] } },
    );

    rerender({ points: [1, 2, 3] }); // a different array reference, same contents
    expect(onChange).toHaveBeenCalledOnce();
  });
});
