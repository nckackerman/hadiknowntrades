import { describe, expect, it } from "vitest";

import { celebrationIntensityFor, FULL_CELEBRATION_INTENSITY } from "./celebration-magnitude";

describe("celebrationIntensityFor (issue #125)", () => {
  it("suppresses the burst entirely for a marginal win", () => {
    // A ~5% window -- a real gain, but not a confetti moment.
    expect(celebrationIntensityFor(1.05).pieceCount).toBe(0);
    // Right below the threshold.
    expect(celebrationIntensityFor(1.24).pieceCount).toBe(0);
  });

  it("gives a real, smaller burst once past the suppression threshold", () => {
    const modest = celebrationIntensityFor(1.25);

    expect(modest.pieceCount).toBeGreaterThan(0);
    expect(modest.pieceCount).toBeLessThan(FULL_CELEBRATION_INTENSITY.pieceCount);
    expect(modest.spreadPercent).toBeLessThan(FULL_CELEBRATION_INTENSITY.spreadPercent);
  });

  it("grows monotonically with the multiplier, tier by tier", () => {
    const tiers = [1.05, 2, 25, 5_000].map(celebrationIntensityFor);

    for (let i = 1; i < tiers.length; i += 1) {
      expect(tiers[i]!.pieceCount).toBeGreaterThan(tiers[i - 1]!.pieceCount);
      expect(tiers[i]!.spreadPercent).toBeGreaterThan(tiers[i - 1]!.spreadPercent);
    }
  });

  it("fires the original full-width burst for a Max-range-scale result", () => {
    // ~35.8Mx, the real Max-range multiplier documented in
    // apps/web/CLAUDE.md's multiplier-badge section.
    expect(celebrationIntensityFor(35_800_000)).toEqual(FULL_CELEBRATION_INTENSITY);
  });

  it("never celebrates a loss or a flat result, at any tier", () => {
    for (const multiplier of [0, 0.1, 0.99, 1]) {
      expect(celebrationIntensityFor(multiplier).pieceCount).toBe(0);
    }
  });

  it("degrades a non-finite multiplier to no burst, not the biggest one", () => {
    // A corrupted/zero startingCapital would produce these.
    expect(celebrationIntensityFor(Number.POSITIVE_INFINITY).pieceCount).toBe(0);
    expect(celebrationIntensityFor(Number.NaN).pieceCount).toBe(0);
  });
});
