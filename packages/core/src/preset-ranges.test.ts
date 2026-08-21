import { describe, expect, it } from "vitest";

import { toDateString } from "./date-utils.js";
import { presetRangeStartDate } from "./preset-ranges.js";

describe("presetRangeStartDate", () => {
  const asOf = new Date("2024-06-15T00:00:00Z");

  it("returns null for MAX (unbounded)", () => {
    expect(presetRangeStartDate("MAX", asOf)).toBeNull();
  });

  it("subtracts 1 month for 1M", () => {
    expect(toDateString(presetRangeStartDate("1M", asOf)!)).toBe("2024-05-15");
  });

  it("subtracts 3 months for 3M", () => {
    expect(toDateString(presetRangeStartDate("3M", asOf)!)).toBe("2024-03-15");
  });

  it("subtracts 1 year for 1Y", () => {
    expect(toDateString(presetRangeStartDate("1Y", asOf)!)).toBe("2023-06-15");
  });

  it("subtracts 5 years for 5Y", () => {
    expect(toDateString(presetRangeStartDate("5Y", asOf)!)).toBe("2019-06-15");
  });

  it("does not mutate the asOf date passed in", () => {
    const original = new Date(asOf);
    presetRangeStartDate("1Y", asOf);
    expect(asOf.getTime()).toBe(original.getTime());
  });

  describe("month-end clamping (regression: naive setUTCMonth/setUTCFullYear overflow into the wrong month)", () => {
    it("1M from Mar 31 clamps to Feb 29 in a leap year, not overflowing into March", () => {
      expect(toDateString(presetRangeStartDate("1M", new Date("2024-03-31T00:00:00Z"))!)).toBe(
        "2024-02-29",
      );
    });

    it("1M from Mar 31 clamps to Feb 28 in a non-leap year", () => {
      expect(toDateString(presetRangeStartDate("1M", new Date("2023-03-31T00:00:00Z"))!)).toBe(
        "2023-02-28",
      );
    });

    it("3M from May 31 clamps to Feb 29 in a leap year", () => {
      expect(toDateString(presetRangeStartDate("3M", new Date("2024-05-31T00:00:00Z"))!)).toBe(
        "2024-02-29",
      );
    });

    it("1Y from Feb 29 (leap day) clamps to Feb 28 when the target year isn't a leap year", () => {
      expect(toDateString(presetRangeStartDate("1Y", new Date("2024-02-29T00:00:00Z"))!)).toBe(
        "2023-02-28",
      );
    });

    it("5Y from Feb 29 (leap day) clamps to Feb 28 when the target year isn't a leap year", () => {
      expect(toDateString(presetRangeStartDate("5Y", new Date("2024-02-29T00:00:00Z"))!)).toBe(
        "2019-02-28",
      );
    });
  });
});
