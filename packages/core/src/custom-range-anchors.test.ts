import { describe, expect, it } from "vitest";

import {
  anchorMonthToDate,
  CUSTOM_RANGE_ANCHOR_YEARS_BACK,
  customRangeAnchors,
  toAnchorMonth,
} from "./custom-range-anchors.js";
import { toDateString } from "./date-utils.js";

describe("anchorMonthToDate", () => {
  it("parses a well-formed YYYY-MM anchor to the 1st of that month, UTC", () => {
    expect(toDateString(anchorMonthToDate("2019-03")!)).toBe("2019-03-01");
  });

  it("returns null for a malformed string", () => {
    expect(anchorMonthToDate("not-a-month")).toBeNull();
    expect(anchorMonthToDate("2019-3")).toBeNull();
    expect(anchorMonthToDate("2019/03")).toBeNull();
    expect(anchorMonthToDate("")).toBeNull();
  });

  it("returns null for a month outside 01-12", () => {
    expect(anchorMonthToDate("2019-00")).toBeNull();
    expect(anchorMonthToDate("2019-13")).toBeNull();
  });

  it("accepts every real month 01-12", () => {
    for (let month = 1; month <= 12; month++) {
      const anchor = `2019-${String(month).padStart(2, "0")}`;
      expect(anchorMonthToDate(anchor)).not.toBeNull();
    }
  });
});

describe("toAnchorMonth", () => {
  it("round-trips with anchorMonthToDate", () => {
    expect(toAnchorMonth(anchorMonthToDate("2019-03")!)).toBe("2019-03");
  });

  it("formats a Date's UTC year/month, zero-padded", () => {
    expect(toAnchorMonth(new Date("2024-01-15T00:00:00Z"))).toBe("2024-01");
  });
});

describe("customRangeAnchors", () => {
  const asOf = new Date("2024-06-15T00:00:00Z");

  it("returns CUSTOM_RANGE_ANCHOR_YEARS_BACK * 12 anchors", () => {
    expect(customRangeAnchors(asOf)).toHaveLength(CUSTOM_RANGE_ANCHOR_YEARS_BACK * 12);
  });

  it("starts with the current (possibly partial) month, newest first", () => {
    expect(customRangeAnchors(asOf)[0]).toBe("2024-06");
    expect(customRangeAnchors(asOf)[1]).toBe("2024-05");
  });

  it("ends CUSTOM_RANGE_ANCHOR_YEARS_BACK years back", () => {
    const anchors = customRangeAnchors(asOf);
    expect(anchors[anchors.length - 1]).toBe("2003-07");
  });

  it("every returned anchor round-trips through anchorMonthToDate", () => {
    for (const anchor of customRangeAnchors(asOf)) {
      expect(anchorMonthToDate(anchor)).not.toBeNull();
    }
  });

  it("has no duplicates", () => {
    const anchors = customRangeAnchors(asOf);
    expect(new Set(anchors).size).toBe(anchors.length);
  });

  it("correctly rolls over a year boundary (asOf in January)", () => {
    const anchors = customRangeAnchors(new Date("2024-01-15T00:00:00Z"));
    expect(anchors[0]).toBe("2024-01");
    expect(anchors[1]).toBe("2023-12");
  });

  it("does not mutate the asOf date passed in", () => {
    const original = new Date(asOf);
    customRangeAnchors(asOf);
    expect(asOf.getTime()).toBe(original.getTime());
  });
});
