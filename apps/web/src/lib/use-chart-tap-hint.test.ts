import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { dismissChartTapHint } from "./chart-tap-hint-storage";
import { useChartTapHint } from "./use-chart-tap-hint";

const STORAGE_KEY = "hikt:chart-tap-hint-dismissed";

/**
 * Stubs `window.matchMedia` per-query, unlike use-count-up.test.ts's own
 * helper (a single fixed `matches` regardless of query) -- this hook
 * calls `matchMedia` for two different queries
 * (`prefersReducedMotion()`'s own `(prefers-reduced-motion: reduce)`,
 * plus this hook's own `(pointer: coarse)`), and tests need to control
 * them independently.
 */
function stubMatchMedia(overrides: Record<string, boolean>) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: overrides[query] ?? false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
}

describe("useChartTapHint", () => {
  afterEach(() => {
    window.localStorage.clear();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("shows the hint on a touch-primary device with nothing stored and no reduced-motion preference", () => {
    stubMatchMedia({ "(pointer: coarse)": true, "(prefers-reduced-motion: reduce)": false });

    const { result } = renderHook(() => useChartTapHint());

    expect(result.current[0]).toBe(true);
  });

  it("does not show the hint on a mouse/trackpad device (pointer: coarse doesn't match)", () => {
    stubMatchMedia({ "(pointer: coarse)": false, "(prefers-reduced-motion: reduce)": false });

    const { result } = renderHook(() => useChartTapHint());

    expect(result.current[0]).toBe(false);
  });

  it("does not show the hint when the user prefers reduced motion, even on a touch device", () => {
    stubMatchMedia({ "(pointer: coarse)": true, "(prefers-reduced-motion: reduce)": true });

    const { result } = renderHook(() => useChartTapHint());

    expect(result.current[0]).toBe(false);
  });

  it("does not show the hint when it was already dismissed on a previous visit", () => {
    stubMatchMedia({ "(pointer: coarse)": true, "(prefers-reduced-motion: reduce)": false });
    dismissChartTapHint();

    const { result } = renderHook(() => useChartTapHint());

    expect(result.current[0]).toBe(false);
  });

  it("treats a missing matchMedia (unsupported environment) as no hint, not a throw", () => {
    vi.stubGlobal("matchMedia", undefined);

    // renderHook itself would surface any throw as a failing test -- no
    // separate expect(...).not.toThrow() wrapper needed.
    const { result } = renderHook(() => useChartTapHint());

    expect(result.current[0]).toBe(false);
  });

  it("dismiss() hides the hint and persists the dismissal to localStorage", () => {
    stubMatchMedia({ "(pointer: coarse)": true, "(prefers-reduced-motion: reduce)": false });

    const { result } = renderHook(() => useChartTapHint());
    expect(result.current[0]).toBe(true);

    act(() => {
      result.current[1]();
    });

    expect(result.current[0]).toBe(false);
    expect(window.localStorage.getItem(STORAGE_KEY)).not.toBeNull();
  });

  it("dismiss() is a no-op (doesn't write to storage) when the hint was never shown", () => {
    stubMatchMedia({ "(pointer: coarse)": false, "(prefers-reduced-motion: reduce)": false });

    const { result } = renderHook(() => useChartTapHint());
    expect(result.current[0]).toBe(false);

    act(() => {
      result.current[1]();
    });

    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
  });
});
