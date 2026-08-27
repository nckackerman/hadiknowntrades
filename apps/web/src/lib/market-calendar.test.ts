import { describe, expect, it } from "vitest";

import { SPY_DAILY_CLOSES } from "../test-fixtures/spy-daily-closes";
import {
  exchangeClock,
  hasMarketOpened,
  isMarketHoliday,
  isPickEditable,
  isTradingDay,
  isWeekend,
  nextTradingDay,
  tradingDaysFrom,
} from "./market-calendar";

/** 9:30 AM in New York on a summer (EDT, UTC-4) date. */
function summerEt(date: string, hhmm: string): Date {
  return new Date(`${date}T${hhmm}:00-04:00`);
}

/** The same, on a winter (EST, UTC-5) date. */
function winterEt(date: string, hhmm: string): Date {
  return new Date(`${date}T${hhmm}:00-05:00`);
}

describe("isWeekend / isTradingDay", () => {
  it("treats Saturday and Sunday as non-trading days", () => {
    // 2026-08-22 is a Saturday, 2026-08-23 the Sunday after it.
    expect(isWeekend("2026-08-22")).toBe(true);
    expect(isWeekend("2026-08-23")).toBe(true);
    expect(isTradingDay("2026-08-22")).toBe(false);
    expect(isTradingDay("2026-08-23")).toBe(false);

    expect(isWeekend("2026-08-21")).toBe(false); // Friday
    expect(isTradingDay("2026-08-21")).toBe(true);
  });
});

describe("isMarketHoliday", () => {
  it("knows each of the ten scheduled US market holidays in a plain year", () => {
    // 2026: none of these need observed-date shifting except July 4 (below).
    expect(isMarketHoliday("2026-01-01")).toBe(true); // New Year's Day (Thu)
    expect(isMarketHoliday("2026-01-19")).toBe(true); // MLK Jr. Day, 3rd Monday
    expect(isMarketHoliday("2026-02-16")).toBe(true); // Washington's Birthday, 3rd Monday
    expect(isMarketHoliday("2026-04-03")).toBe(true); // Good Friday (Easter is 2026-04-05)
    expect(isMarketHoliday("2026-05-25")).toBe(true); // Memorial Day, last Monday
    expect(isMarketHoliday("2026-06-19")).toBe(true); // Juneteenth (Fri)
    expect(isMarketHoliday("2026-09-07")).toBe(true); // Labor Day, 1st Monday
    expect(isMarketHoliday("2026-11-26")).toBe(true); // Thanksgiving, 4th Thursday
    expect(isMarketHoliday("2026-12-25")).toBe(true); // Christmas Day (Fri)
  });

  it("does not treat an ordinary trading day as a holiday", () => {
    expect(isMarketHoliday("2026-11-25")).toBe(false);
    // The half day after Thanksgiving is still a real (short) session.
    expect(isMarketHoliday("2026-11-27")).toBe(false);
    expect(isTradingDay("2026-11-27")).toBe(true);
  });

  it("shifts a Saturday holiday to the preceding Friday", () => {
    // Independence Day 2026 falls on Saturday July 4; the NYSE observes it
    // on Friday July 3.
    expect(isMarketHoliday("2026-07-03")).toBe(true);
    // Only the *observed* date is modelled as a holiday -- July 4 itself is
    // simply a weekend day here, which is all `isTradingDay` needs.
    expect(isMarketHoliday("2026-07-04")).toBe(false);
    expect(isTradingDay("2026-07-04")).toBe(false);
    expect(isTradingDay("2026-07-03")).toBe(false);
    expect(isTradingDay("2026-07-02")).toBe(true);
  });

  it("shifts a Sunday holiday to the following Monday", () => {
    // Christmas Day 2022 fell on a Sunday; the NYSE was closed Monday the 26th.
    expect(isTradingDay("2022-12-26")).toBe(false);
  });

  it("does NOT observe New Year's Day on the preceding Friday when it falls on a Saturday", () => {
    // The one real exception in the NYSE's own rule: a Saturday holiday is
    // observed the preceding Friday *unless* that Friday is the last trading
    // day of the year. Jan 1 2022 was a Saturday, and Friday 2021-12-31 was a
    // full trading day.
    expect(isTradingDay("2021-12-31")).toBe(true);
    expect(isMarketHoliday("2021-12-31")).toBe(false);

    // Same shape, in the other direction, for 2027/2028: Christmas Day 2027 is
    // a Saturday (observed Friday the 24th), but New Year's Day 2028 is also a
    // Saturday and simply isn't observed.
    expect(isTradingDay("2027-12-24")).toBe(false);
    expect(isTradingDay("2027-12-31")).toBe(true);
  });
});

describe("holiday model vs. real SPY daily closes", () => {
  // The strongest available check that this hand-rolled calendar matches
  // reality: every weekday inside the fixture's real window that Yahoo has no
  // close for must be a day this module also calls non-trading, and vice
  // versa. See test-fixtures/spy-daily-closes.ts for the data's provenance.
  it("agrees with the real fixture on every calendar day in its window", () => {
    const present = new Set(SPY_DAILY_CLOSES.map((entry) => entry.date));
    const first = SPY_DAILY_CLOSES[0]!.date;
    const last = SPY_DAILY_CLOSES[SPY_DAILY_CLOSES.length - 1]!.date;

    const missingTradingDays: string[] = [];
    const unexpectedSessions: string[] = [];
    const cursor = new Date(`${first}T00:00:00Z`);
    let date = first;
    while (date <= last) {
      if (isTradingDay(date) && !present.has(date)) missingTradingDays.push(date);
      if (!isTradingDay(date) && present.has(date)) unexpectedSessions.push(date);
      cursor.setUTCDate(cursor.getUTCDate() + 1);
      date = cursor.toISOString().slice(0, 10);
    }

    expect(missingTradingDays).toEqual([]);
    expect(unexpectedSessions).toEqual([]);
    // Guards against the loop above silently checking nothing.
    expect(present.size).toBe(63);
  });
});

describe("nextTradingDay / tradingDaysFrom", () => {
  it("skips the weekend", () => {
    expect(nextTradingDay("2026-08-21")).toBe("2026-08-24"); // Fri -> Mon
  });

  it("skips a real market holiday as well as the weekend", () => {
    // Thursday 2026-11-26 is Thanksgiving; the Wednesday before it rolls to
    // the (half-day, but real) Friday session.
    expect(nextTradingDay("2026-11-25")).toBe("2026-11-27");
    // Thursday 2026-12-24 -> Christmas Day (Fri) -> weekend -> Monday.
    expect(nextTradingDay("2026-12-24")).toBe("2026-12-28");
  });

  it("includes `from` itself when it is a trading day", () => {
    expect(tradingDaysFrom("2026-08-21", 3)).toEqual(["2026-08-21", "2026-08-24", "2026-08-25"]);
  });

  it("walks forward past a weekend and a holiday together", () => {
    // Wednesday 2026-07-01, then the observed Independence Day (Fri 07-03)
    // and the weekend are all skipped.
    expect(tradingDaysFrom("2026-07-01", 4)).toEqual([
      "2026-07-01",
      "2026-07-02",
      "2026-07-06",
      "2026-07-07",
    ]);
  });
});

describe("exchangeClock", () => {
  it("renders an instant in the exchange's own zone, not the runner's", () => {
    expect(exchangeClock(summerEt("2026-08-21", "09:29"))).toEqual({
      date: "2026-08-21",
      minutesSinceMidnight: 9 * 60 + 29,
    });
  });

  it("rolls the exchange-local date back for a late-evening UTC instant", () => {
    // 2026-08-22T01:00Z is still 9:00 PM on the 21st in New York.
    expect(exchangeClock(new Date("2026-08-22T01:00:00Z")).date).toBe("2026-08-21");
  });
});

describe("hasMarketOpened / isPickEditable", () => {
  it("is false right up to 9:30 AM exchange time and true from 9:30 onward", () => {
    expect(hasMarketOpened("2026-08-21", summerEt("2026-08-21", "09:29"))).toBe(false);
    expect(hasMarketOpened("2026-08-21", summerEt("2026-08-21", "09:30"))).toBe(true);
    expect(hasMarketOpened("2026-08-21", summerEt("2026-08-21", "09:31"))).toBe(true);
  });

  it("uses the exchange's real wall clock across DST, not a fixed UTC offset", () => {
    // 13:30 UTC is 9:30 in New York during EDT but only 8:30 during EST.
    expect(hasMarketOpened("2026-08-21", new Date("2026-08-21T13:30:00Z"))).toBe(true);
    expect(hasMarketOpened("2026-01-21", new Date("2026-01-21T13:30:00Z"))).toBe(false);
    expect(hasMarketOpened("2026-01-21", winterEt("2026-01-21", "09:30"))).toBe(true);
  });

  it("treats any earlier or later calendar day as unambiguous", () => {
    expect(hasMarketOpened("2026-08-24", summerEt("2026-08-21", "23:59"))).toBe(false);
    expect(hasMarketOpened("2026-08-21", summerEt("2026-08-24", "00:01"))).toBe(true);
  });

  it("never reports a non-trading day as editable, even before its 9:30", () => {
    // Saturday 2026-08-22 has no session at all.
    expect(isPickEditable("2026-08-22", summerEt("2026-08-22", "09:00"))).toBe(false);
    expect(isPickEditable("2026-07-03", summerEt("2026-07-02", "12:00"))).toBe(false);
  });

  it("flips a real trading day from editable to locked at its own open", () => {
    expect(isPickEditable("2026-08-21", summerEt("2026-08-21", "09:29"))).toBe(true);
    expect(isPickEditable("2026-08-21", summerEt("2026-08-21", "09:30"))).toBe(false);
  });
});
