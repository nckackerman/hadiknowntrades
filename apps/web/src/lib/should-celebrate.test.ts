import { afterEach, describe, expect, it, vi } from "vitest";

import { shouldCelebrate } from "./should-celebrate";

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

describe("shouldCelebrate", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is true for a gain that has settled, with no reduced-motion preference", () => {
    stubPrefersReducedMotion(false);

    expect(shouldCelebrate(true, true)).toBe(true);
  });

  it("is false for a gain that hasn't settled yet", () => {
    stubPrefersReducedMotion(false);

    expect(shouldCelebrate(true, false)).toBe(false);
  });

  it("is false when settled but not a gain", () => {
    stubPrefersReducedMotion(false);

    expect(shouldCelebrate(false, true)).toBe(false);
  });

  it("is false for a settled gain when the user prefers reduced motion", () => {
    stubPrefersReducedMotion(true);

    expect(shouldCelebrate(true, true)).toBe(false);
  });

  it("treats a missing matchMedia (unsupported environment) as motion-allowed, not reduced", () => {
    // No stubPrefersReducedMotion call -- matchMedia is left undefined,
    // matching jsdom's default in this repo's test setup.
    expect(shouldCelebrate(true, true)).toBe(true);
  });
});
