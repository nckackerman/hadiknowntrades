import { describe, expect, it } from "vitest";

import { daysBeforeUtc, toDateString } from "./date-utils.js";

describe("toDateString", () => {
  it("formats a UTC date as YYYY-MM-DD", () => {
    expect(toDateString(new Date("2024-03-05T14:30:00Z"))).toBe("2024-03-05");
  });

  it("pads single-digit months and days", () => {
    expect(toDateString(new Date("2024-01-02T00:00:00Z"))).toBe("2024-01-02");
  });
});

describe("daysBeforeUtc", () => {
  it("subtracts a plain number of calendar days in UTC", () => {
    expect(toDateString(daysBeforeUtc(new Date("2024-06-15T00:00:00Z"), 7))).toBe("2024-06-08");
  });

  it("crosses a month boundary with no calendar-clamping logic", () => {
    expect(toDateString(daysBeforeUtc(new Date("2024-03-05T00:00:00Z"), 7))).toBe("2024-02-27");
  });

  it("does not mutate the date passed in", () => {
    const original = new Date("2024-06-15T00:00:00Z");
    const copy = new Date(original);
    daysBeforeUtc(original, 7);
    expect(original.getTime()).toBe(copy.getTime());
  });
});
