import { describe, expect, it } from "vitest";

import { formatHeroCurrency } from "./format-currency";
import { rescaleFromStartingCapital } from "./rescale-starting-capital";

describe("rescaleFromStartingCapital", () => {
  it("is a no-op when the target capital equals the original (ratio of 1)", () => {
    expect(rescaleFromStartingCapital(6876.86, 20, 20)).toBeCloseTo(6876.86);
  });

  it("scales up proportionally to a larger starting capital", () => {
    // $20 -> $6,876.86 is a ~343.843x multiplier; starting from $1,000
    // instead should land on exactly 343.843x of $1,000.
    expect(rescaleFromStartingCapital(6876.86, 20, 1000)).toBeCloseTo(343843);
  });

  it("scales down proportionally to a smaller starting capital", () => {
    expect(rescaleFromStartingCapital(40, 20, 5)).toBeCloseTo(10);
  });

  it("preserves the multiplier exactly: rescaled endingBalance / rescaled startingCapital equals the original multiplier", () => {
    const startingCapital = 20;
    const endingBalance = 6876.86;
    const multiplier = endingBalance / startingCapital;
    const userCapital = 12345;

    const rescaledEnding = rescaleFromStartingCapital(endingBalance, startingCapital, userCapital);

    expect(rescaledEnding / userCapital).toBeCloseTo(multiplier);
  });

  it("exercises the existing large-number formatting path at a Max-range-scale multiplier (packages/core/CLAUDE.md's ~$716M-from-$20 case)", () => {
    const startingCapital = 20;
    const endingBalance = 716_000_000; // ~35.8Mx, per packages/core/CLAUDE.md
    const userCapital = 1_000_000;

    const rescaled = rescaleFromStartingCapital(endingBalance, startingCapital, userCapital);

    // 1,000,000 * (716,000,000 / 20) = 35,800,000,000,000 -- comfortably
    // representable, and formats via the compact "T" ladder rather than
    // overflowing to Infinity or a wall of digits.
    expect(rescaled).toBeCloseTo(35_800_000_000_000);
    expect(formatHeroCurrency(rescaled)).toBe("$35.8T");
  });
});
