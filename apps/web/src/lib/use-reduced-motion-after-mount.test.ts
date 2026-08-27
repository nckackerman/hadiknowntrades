import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { stubPrefersReducedMotion } from "./stub-prefers-reduced-motion.test-util";
import { useReducedMotionAfterMount } from "./use-reduced-motion-after-mount";

describe("useReducedMotionAfterMount", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // The difference from useReducedMotionAtMount, and the entire reason
  // this second hook exists: its caller (BeatTheBench, mounted at the
  // ResultsPage level per issue #122) renders on the server, so the
  // first client render has to match the server's -- which never has a
  // preference to read. Correcting after mount is what keeps those two
  // renders in agreement.
  it("reports no preference on the very first render, then corrects after mount", async () => {
    stubPrefersReducedMotion(true);

    const { result } = renderHook(() => useReducedMotionAfterMount());

    expect(result.current).toBe(false);
    await waitFor(() => {
      expect(result.current).toBe(true);
    });
  });

  it("stays false when the viewer has no preference", async () => {
    stubPrefersReducedMotion(false);

    const { result } = renderHook(() => useReducedMotionAfterMount());

    await waitFor(() => {
      expect(result.current).toBe(false);
    });
  });

  it("degrades to 'no preference' where matchMedia doesn't exist at all", async () => {
    // jsdom implements no matchMedia; prefersReducedMotion() treats that
    // as "no preference", the same way a browser without media-query
    // support would.
    const { result } = renderHook(() => useReducedMotionAfterMount());

    await waitFor(() => {
      expect(result.current).toBe(false);
    });
  });

  // Read once after mount, not subscribed live -- the same posture every
  // other reduced-motion read in this app takes. For Beat the Bench the
  // preference decides how playback *starts*; the viewer can change
  // speed or step by hand from there either way.
  it("doesn't follow a mid-session change of the OS preference", async () => {
    stubPrefersReducedMotion(false);
    const { result, rerender } = renderHook(() => useReducedMotionAfterMount());
    await waitFor(() => {
      expect(result.current).toBe(false);
    });

    stubPrefersReducedMotion(true);
    rerender();

    expect(result.current).toBe(false);
  });
});
