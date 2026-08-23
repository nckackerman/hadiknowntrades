import { describe, expect, it } from "vitest";

import {
  anchorDateToDate,
  CUSTOM_RANGE_ANCHOR_YEARS_BACK,
  customRangeAnchors,
} from "./custom-range-anchors.js";
import { toDateString } from "./date-utils.js";

describe("anchorDateToDate", () => {
  it("parses a well-formed YYYY-MM-DD anchor to that exact UTC day", () => {
    expect(toDateString(anchorDateToDate("2019-03-15")!)).toBe("2019-03-15");
  });

  it("returns null for a malformed string", () => {
    expect(anchorDateToDate("not-a-date")).toBeNull();
    expect(anchorDateToDate("2019-3-15")).toBeNull();
    expect(anchorDateToDate("2019/03/15")).toBeNull();
    expect(anchorDateToDate("2019-03")).toBeNull();
    expect(anchorDateToDate("")).toBeNull();
  });

  it("returns null for a month outside 01-12", () => {
    expect(anchorDateToDate("2019-00-15")).toBeNull();
    expect(anchorDateToDate("2019-13-15")).toBeNull();
  });

  it("returns null for a day outside 01-31", () => {
    expect(anchorDateToDate("2019-03-00")).toBeNull();
    expect(anchorDateToDate("2019-03-32")).toBeNull();
  });

  it("accepts every real month 01-12", () => {
    for (let month = 1; month <= 12; month++) {
      const anchor = `2019-${String(month).padStart(2, "0")}-01`;
      expect(anchorDateToDate(anchor)).not.toBeNull();
    }
  });

  it("accepts every real day 01-31", () => {
    for (let day = 1; day <= 31; day++) {
      const anchor = `2019-01-${String(day).padStart(2, "0")}`;
      expect(anchorDateToDate(anchor)).not.toBeNull();
    }
  });

  it("returns null for a year before MIN_ANCHOR_YEAR (the two-digit-year Date.UTC reinterpretation bug)", () => {
    // A syntactically well-formed 4-digit year like "0099" still hits
    // JS's legacy Date.UTC two-digit-year reinterpretation rule -- see
    // this function's own doc comment. Without the explicit floor this
    // would otherwise silently resolve to 1999-06-01, not year 99.
    expect(anchorDateToDate("0099-06-01")).toBeNull();
  });

  it("returns null for a year far in the future", () => {
    expect(anchorDateToDate("9999-06-01")).toBeNull();
  });
});

/**
 * A dense (every calendar day, no weekend/holiday gaps) synthetic
 * trading-day calendar for testing customRangeAnchors' own date-range
 * filtering logic in isolation from real market-holiday data -- see
 * "only ever returns dates present in the input" below for a test that a
 * genuinely gappy input (the realistic shape a real
 * buildCalendar(history).dates would have) is respected as-is, not
 * forward-filled the way the old month scheme's slicing filter used to.
 */
function denseTradingDates(fromYear: number, toDateStr: string): string[] {
  const dates: string[] = [];
  const cursor = new Date(Date.UTC(fromYear, 0, 1));
  const end = new Date(`${toDateStr}T00:00:00Z`);
  while (cursor.getTime() <= end.getTime()) {
    dates.push(toDateString(cursor));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

describe("customRangeAnchors", () => {
  const asOf = new Date("2024-06-15T00:00:00Z");
  const tradingDates = denseTradingDates(2000, "2024-06-15");

  it(`returns every trading date within CUSTOM_RANGE_ANCHOR_YEARS_BACK (${CUSTOM_RANGE_ANCHOR_YEARS_BACK}) years of asOf, newest first`, () => {
    const anchors = customRangeAnchors(tradingDates, asOf);
    expect(anchors[0]).toBe("2024-06-15");
    expect(anchors[1]).toBe("2024-06-14");
  });

  it("includes the exact cutoff date (an inclusive lower bound)", () => {
    const anchors = customRangeAnchors(tradingDates, asOf);
    expect(anchors[anchors.length - 1]).toBe("2019-06-15");
  });

  it("excludes a trading date one day before the cutoff", () => {
    const anchors = customRangeAnchors(tradingDates, asOf);
    expect(anchors).not.toContain("2019-06-14");
  });

  it("only ever returns dates actually present in the input tradingDates -- no forward-snapping/synthesis of a missing day", () => {
    const gappy = tradingDates.filter((d) => d !== "2024-06-10");
    const anchors = customRangeAnchors(gappy, asOf);
    expect(anchors).not.toContain("2024-06-10");
    // Its neighbors are still independently present -- the gap doesn't
    // widen or shift anything around it.
    expect(anchors).toContain("2024-06-11");
    expect(anchors).toContain("2024-06-09");
  });

  it("excludes a date after asOf even if the input contains one", () => {
    const withFuture = [...tradingDates, "2024-06-16"];
    const anchors = customRangeAnchors(withFuture, asOf);
    expect(anchors).not.toContain("2024-06-16");
  });

  it("has no duplicates", () => {
    const anchors = customRangeAnchors(tradingDates, asOf);
    expect(new Set(anchors).size).toBe(anchors.length);
  });

  it("correctly rolls over a year boundary (asOf in January)", () => {
    const janAsOf = new Date("2024-01-15T00:00:00Z");
    const anchors = customRangeAnchors(denseTradingDates(2000, "2024-01-15"), janAsOf);
    expect(anchors[0]).toBe("2024-01-15");
    expect(anchors[anchors.length - 1]).toBe("2019-01-15");
  });

  it("does not mutate the asOf date passed in", () => {
    const original = new Date(asOf);
    customRangeAnchors(tradingDates, asOf);
    expect(asOf.getTime()).toBe(original.getTime());
  });

  it("does not mutate the tradingDates array passed in", () => {
    const original = [...tradingDates];
    customRangeAnchors(tradingDates, asOf);
    expect(tradingDates).toEqual(original);
  });

  it("returns an empty array when no trading dates fall in the window", () => {
    expect(customRangeAnchors([], asOf)).toEqual([]);
    expect(customRangeAnchors(["1999-01-01"], asOf)).toEqual([]);
  });

  it("every returned anchor round-trips through anchorDateToDate", () => {
    for (const anchor of customRangeAnchors(tradingDates, asOf)) {
      expect(anchorDateToDate(anchor)).not.toBeNull();
    }
  });
});
