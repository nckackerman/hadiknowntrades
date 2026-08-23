import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useReducedMotionAtMount } from "./use-reduced-motion-at-mount";

/** See use-count-up.test.ts's identical helper -- jsdom doesn't implement matchMedia at all, so tests stub it the way real browsers implement it. */
function stubPrefersReducedMotion(matches: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockReturnValue({
      matches,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
  );
}

describe("useReducedMotionAtMount", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reflects the OS preference present at mount when motion is allowed", () => {
    stubPrefersReducedMotion(false);

    const { result } = renderHook(() => useReducedMotionAtMount());

    expect(result.current).toBe(false);
  });

  it("reflects the OS preference present at mount when reduced motion is requested", () => {
    stubPrefersReducedMotion(true);

    const { result } = renderHook(() => useReducedMotionAtMount());

    expect(result.current).toBe(true);
  });

  // The whole reason this hook exists (issue #77, extracted from a bug
  // found independently in both HeroStat.tsx and ResultsPanel.tsx's
  // FadeInWrapper): the value must stay fixed for the lifetime of one
  // mount, even if the OS-level preference changes value on a later
  // re-render of the same still-mounted instance -- a live
  // `prefersReducedMotion()` read recomputed every render would let an
  // animation class flip on already-visible, already-settled content.
  it("stays fixed across a re-render of an already-mounted instance, even if the OS preference changes mid-session", () => {
    stubPrefersReducedMotion(false);

    const { result, rerender } = renderHook(() => useReducedMotionAtMount());
    expect(result.current).toBe(false);

    stubPrefersReducedMotion(true);
    rerender();

    expect(result.current).toBe(false);
  });

  it("reads the newly-mounted preference fresh for a genuinely new instance", () => {
    stubPrefersReducedMotion(false);
    const first = renderHook(() => useReducedMotionAtMount());
    expect(first.result.current).toBe(false);
    first.unmount();

    stubPrefersReducedMotion(true);
    const second = renderHook(() => useReducedMotionAtMount());

    expect(second.result.current).toBe(true);
  });
});
