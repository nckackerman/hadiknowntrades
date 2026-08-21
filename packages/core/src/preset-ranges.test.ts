import { describe, expect, it } from "vitest";

import { presetRangeStartDate } from "./preset-ranges.js";

describe("presetRangeStartDate", () => {
  const asOf = new Date("2024-06-15T00:00:00Z");

  it("returns null for MAX (unbounded)", () => {
    expect(presetRangeStartDate("MAX", asOf)).toBeNull();
  });

  it("subtracts 1 month for 1M", () => {
    expect(presetRangeStartDate("1M", asOf)?.toISOString().slice(0, 10)).toBe("2024-05-15");
  });

  it("subtracts 3 months for 3M", () => {
    expect(presetRangeStartDate("3M", asOf)?.toISOString().slice(0, 10)).toBe("2024-03-15");
  });

  it("subtracts 1 year for 1Y", () => {
    expect(presetRangeStartDate("1Y", asOf)?.toISOString().slice(0, 10)).toBe("2023-06-15");
  });

  it("subtracts 5 years for 5Y", () => {
    expect(presetRangeStartDate("5Y", asOf)?.toISOString().slice(0, 10)).toBe("2019-06-15");
  });

  it("does not mutate the asOf date passed in", () => {
    const original = new Date(asOf);
    presetRangeStartDate("1Y", asOf);
    expect(asOf.getTime()).toBe(original.getTime());
  });
});
