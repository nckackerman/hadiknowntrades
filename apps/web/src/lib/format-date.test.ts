import { describe, expect, it } from "vitest";

import { formatDate, formatDateTime, formatTime } from "./format-date";

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

describe("formatTime", () => {
  it("formats a bare local time as a 12-hour clock time", () => {
    expect(formatTime("09:30:00")).toBe("9:30 AM");
    expect(formatTime("14:30:00")).toBe("2:30 PM");
  });

  it("formats midnight and noon correctly (the classic 12-hour edge cases)", () => {
    expect(formatTime("00:00:00")).toBe("12:00 AM");
    expect(formatTime("12:00:00")).toBe("12:00 PM");
  });
});

describe("formatDateTime", () => {
  it("formats a plain calendar date exactly like formatDate", () => {
    expect(formatDateTime("2025-08-21")).toBe(formatDate("2025-08-21"));
  });

  it("formats a full local datetime as time-only, not repeating the date", () => {
    expect(formatDateTime("2026-08-21T14:30:00")).toBe("2:30 PM");
  });
});
