import { describe, expect, it } from "vitest";

import { easeOutCubic, tweenValue } from "./easing";

describe("easeOutCubic", () => {
  it("starts at 0 and ends at 1", () => {
    expect(easeOutCubic(0)).toBe(0);
    expect(easeOutCubic(1)).toBe(1);
  });

  it("is monotonically increasing across the domain", () => {
    const samples = [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1].map(easeOutCubic);
    for (let i = 1; i < samples.length; i++) {
      expect(samples[i]).toBeGreaterThanOrEqual(samples[i - 1]!);
    }
  });
});

describe("tweenValue", () => {
  it("returns `from` at t=0 and `to` at t=1", () => {
    expect(tweenValue(20, 40, 0)).toBe(20);
    expect(tweenValue(20, 40, 1)).toBe(40);
  });

  it("snaps to the exact `to` for any t >= 1, not just t === 1 -- the guard use-count-up.ts's own doc comment calls out (issue #96 follow-up round 3: use-trade-replay.ts's own independent copy of this formula used to lack it)", () => {
    expect(tweenValue(20, 40, 1.5)).toBe(40);
  });

  it("interpolates strictly between `from` and `to` for 0 < t < 1", () => {
    const mid = tweenValue(20, 40, 0.5);
    expect(mid).toBeGreaterThan(20);
    expect(mid).toBeLessThan(40);
  });

  it("works the same way for a decreasing value (a loss leg)", () => {
    expect(tweenValue(40, 20, 0)).toBe(40);
    expect(tweenValue(40, 20, 1)).toBe(20);
    const mid = tweenValue(40, 20, 0.5);
    expect(mid).toBeLessThan(40);
    expect(mid).toBeGreaterThan(20);
  });
});
