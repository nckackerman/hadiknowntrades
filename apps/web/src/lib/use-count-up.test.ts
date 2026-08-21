import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useCountUp } from "./use-count-up";

/** Stubs `window.matchMedia` the way real browsers implement it (jsdom in this repo's setup doesn't implement it at all -- see use-count-up.ts's own doc comment). */
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

describe("useCountUp", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("starts at `from` before any animation frame has run", () => {
    stubPrefersReducedMotion(false);
    // Never invoke the callback, so the hook is observed mid-flight,
    // before the first tick would move it.
    vi.spyOn(window, "requestAnimationFrame").mockReturnValue(1);

    const { result } = renderHook(() => useCountUp(20, 6876.86, 1200));

    expect(result.current).toBe(20);
  });

  it("settles on exactly `to` once elapsed time reaches the duration", () => {
    stubPrefersReducedMotion(false);
    // Simulate a frame firing well past the animation's duration --
    // real elapsed-time value, not tied to how long the test itself
    // takes to run.
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb: FrameRequestCallback) => {
      cb(performance.now() + 100_000);
      return 1;
    });

    const { result } = renderHook(() => useCountUp(20, 6876.86, 1200));

    // Bit-for-bit `to`, not just numerically close -- the hero stat's
    // final render must be pixel-identical to the old static one.
    expect(result.current).toBe(6876.86);
  });

  it("jumps straight to `to` with no animation when the user prefers reduced motion", () => {
    stubPrefersReducedMotion(true);
    // The very first available frame settles it -- no elapsed-time
    // math, no further frames scheduled.
    const raf = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((cb: FrameRequestCallback) => {
        cb(performance.now());
        return 1;
      });

    const { result } = renderHook(() => useCountUp(20, 6876.86, 1200));

    expect(result.current).toBe(6876.86);
    expect(raf).toHaveBeenCalledTimes(1); // settled on the first frame, no animation loop
  });

  it("settles on `to` immediately for a non-positive duration, without producing NaN", () => {
    stubPrefersReducedMotion(false);
    // Pin performance.now() so the first frame's `elapsed` is exactly 0
    // -- with durationMs = 0 that's 0/0 = NaN unless the hook special-
    // cases a non-positive duration (see the `t >= 1` short-circuit in
    // use-count-up.ts).
    vi.spyOn(performance, "now").mockReturnValue(1000);
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb: FrameRequestCallback) => {
      cb(1000);
      return 1;
    });

    const { result } = renderHook(() => useCountUp(20, 6876.86, 0));

    expect(result.current).toBe(6876.86);
  });

  it("treats a missing matchMedia (unsupported environment) as motion-allowed, not reduced", () => {
    // No stubPrefersReducedMotion call -- matchMedia is left undefined,
    // matching jsdom's default in this repo's test setup.
    vi.spyOn(window, "requestAnimationFrame").mockReturnValue(1);

    const { result } = renderHook(() => useCountUp(20, 6876.86, 1200));

    expect(result.current).toBe(20); // mid-animation, not jumped to `to`
  });
});
