import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { dismissChartTapHint } from "./chart-tap-hint-storage";
import { stubMatchMedia } from "./stub-match-media.test-util";
import { useChartTapHint } from "./use-chart-tap-hint";

const STORAGE_KEY = "hikt:chart-tap-hint-dismissed";

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

  it("persists the dismissal to localStorage as soon as the hint is shown, before any interaction", () => {
    stubMatchMedia({ "(pointer: coarse)": true, "(prefers-reduced-motion: reduce)": false });

    const { result } = renderHook(() => useChartTapHint());

    // No dismiss() call yet -- the mount effect alone should have
    // already persisted it.
    expect(result.current[0]).toBe(true);
    expect(window.localStorage.getItem(STORAGE_KEY)).not.toBeNull();
  });

  it("does not write to storage on mount when the hint isn't shown", () => {
    stubMatchMedia({ "(pointer: coarse)": false, "(prefers-reduced-motion: reduce)": false });

    renderHook(() => useChartTapHint());

    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("dismiss() hides the hint locally (storage was already persisted at mount)", () => {
    stubMatchMedia({ "(pointer: coarse)": true, "(prefers-reduced-motion: reduce)": false });

    const { result } = renderHook(() => useChartTapHint());
    expect(result.current[0]).toBe(true);

    act(() => {
      result.current[1]();
    });

    expect(result.current[0]).toBe(false);
    expect(window.localStorage.getItem(STORAGE_KEY)).not.toBeNull();
  });

  /**
   * Regression test for a real bug found in code review: the first
   * version only persisted the dismissal from `dismiss()` itself (or
   * the pulse animation's own `onAnimationEnd`), so a chart that
   * unmounted before either happened -- e.g. switching to a different
   * intraday day mid-pulse -- left the flag unset, and the very next
   * mount showed the hint again. Unmounting here with no `dismiss()`
   * call at all mirrors exactly that "switched away before interacting"
   * scenario.
   */
  it("stays dismissed for a later mount even when a shown hint is unmounted without any interaction", () => {
    stubMatchMedia({ "(pointer: coarse)": true, "(prefers-reduced-motion: reduce)": false });

    const first = renderHook(() => useChartTapHint());
    expect(first.result.current[0]).toBe(true);
    first.unmount();

    const second = renderHook(() => useChartTapHint());

    expect(second.result.current[0]).toBe(false);
  });
});
