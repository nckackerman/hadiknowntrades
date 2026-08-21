import { describe, expect, it } from "vitest";

import { formatDate } from "./format-date";

describe("formatDate", () => {
  it("formats a plain calendar date without a timezone shift", () => {
    expect(formatDate("2025-08-21")).toBe("Aug 21, 2025");
  });

  it("doesn't roll the date back a day for zones west of UTC", () => {
    // A date near a month boundary is the case most likely to expose a
    // naive local-time parse rolling it back a day.
    expect(formatDate("2026-01-01")).toBe("Jan 1, 2026");
  });
});
