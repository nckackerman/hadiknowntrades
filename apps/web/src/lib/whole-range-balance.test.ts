import { describe, expect, it } from "vitest";

import { intradayDay, intradayResult } from "./intraday-result.test-util";
import { wholeRangeFinalBalance } from "./whole-range-balance";

describe("wholeRangeFinalBalance", () => {
  it("returns 0 for a result with no days at all, matching what the page renders in that state", () => {
    expect(wholeRangeFinalBalance(intradayResult({ days: [] }), "long", 20)).toBe(0);
  });

  it("returns the final day's long-only ending balance when effectiveStartingCapital matches the range's own root", () => {
    const data = intradayResult({
      startingCapital: 20,
      days: [intradayDay("2026-08-18", 20, 24), intradayDay("2026-08-19", 24, 30)],
    });

    expect(wholeRangeFinalBalance(data, "long", 20)).toBe(30);
  });

  it("reads the long+short variant, not the long-only one, under that mode", () => {
    const data = intradayResult({
      startingCapital: 20,
      days: [intradayDay("2026-08-18", 20, 24), intradayDay("2026-08-19", 24, 30)],
    });

    // intradayDay's own longShort.endingBalance is endingBalance * 1.1.
    expect(wholeRangeFinalBalance(data, "long-short", 20)).toBeCloseTo(33, 5);
  });

  it("rescales from the range's own root startingCapital, not the final day's own carried-in one", () => {
    const data = intradayResult({
      startingCapital: 20,
      days: [intradayDay("2026-08-18", 20, 24), intradayDay("2026-08-19", 24, 30)],
    });

    // Doubling the viewer's effective starting capital should double the
    // real final balance -- the *root* $20 rescales to $40, not the final
    // day's own $24 carried-in figure (that's exactly the per-day-rescale
    // trap this function's own doc comment warns against).
    expect(wholeRangeFinalBalance(data, "long", 40)).toBe(60);
  });
});
