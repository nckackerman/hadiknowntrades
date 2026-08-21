import { describe, expect, it } from "vitest";

import { toDateString } from "./date-utils.js";

describe("toDateString", () => {
  it("formats a UTC date as YYYY-MM-DD", () => {
    expect(toDateString(new Date("2024-03-05T14:30:00Z"))).toBe("2024-03-05");
  });

  it("pads single-digit months and days", () => {
    expect(toDateString(new Date("2024-01-02T00:00:00Z"))).toBe("2024-01-02");
  });
});
