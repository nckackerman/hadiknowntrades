// A forward US-equity trading-day calendar, plus an explicitly-approximate
// "has this day's market opened yet?" check driven by the client's own
// clock (issue #128, The Call Board's engine).
//
// Nothing in this repo provided either of these before this issue. Every
// existing "which days are real trading days" answer is derived from real
// fetched price data after the fact (see packages/core's
// custom-range-anchors.ts, which deliberately reads real daily-close
// history rather than modelling a holiday calendar) -- that works for
// *past* days, but The Call Board has to name the next 3 trading days
// *before* any data for them exists, which real history can't answer.
//
// **Everything here is a model of the NYSE/Nasdaq calendar, not a feed of
// it.** It knows the ten annual scheduled US market holidays and their
// observed-date shifting rules, and nothing else. It does NOT know about:
// unscheduled closures (weather, a national day of mourning, a market-wide
// outage), a future change to the holiday schedule, or non-US exchanges.
// A stakes-free prediction toy can absorb being wrong on one of those rare
// days; don't reuse this module for anything that can't.
//
// **Live-verified once, against real data**: cross-checked against every real
// SPY session Yahoo reports for the three years ending 2026-08-26 (752
// sessions). The model agreed on every single calendar day but one --
// 2025-01-09, the National Day of Mourning for President Carter, i.e. exactly
// the unscheduled-closure category above, not a bug in the holiday rules.
// market-calendar.test.ts keeps a committed-fixture version of that same
// cross-check (see test-fixtures/spy-daily-closes.ts); the 3-year run was a
// one-off live check, not a networked test.

/** IANA zone the US equity markets trade in. Holiday dates and the open-time boundary are both defined against this zone, not the viewer's. */
export const EXCHANGE_TIME_ZONE = "America/New_York";

/** Regular-session open, as minutes past midnight in EXCHANGE_TIME_ZONE (9:30 AM). Half days (the day after Thanksgiving, Christmas Eve) close early but still *open* at 9:30, so this boundary needs no half-day awareness. */
export const MARKET_OPEN_MINUTES = 9 * 60 + 30;

/** Guards every forward walk in this module against spinning forever if the holiday model ever went pathological (it can't today -- there is no run of 10+ consecutive non-trading days on the US calendar). */
const MAX_CALENDAR_SCAN_DAYS = 30;

/**
 * The exchange-local calendar date and time-of-day for `now`, derived from
 * whatever instant the client's clock reports.
 *
 * Uses Intl with an explicit `timeZone`, so DST is handled by the platform's
 * own tz database rather than a hardcoded UTC offset -- unlike
 * packages/core's `unixToLocalDateString`, which deliberately accepts a
 * fixed-offset approximation for price bars (see packages/core/CLAUDE.md).
 * A fixed offset would be genuinely wrong here: the open boundary is a
 * wall-clock time, so it shifts by a real hour in UTC terms twice a year.
 */
export function exchangeClock(now: Date): {
  date: string;
  minutesSinceMidnight: number;
} {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: EXCHANGE_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? "00";
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    minutesSinceMidnight: Number(get("hour")) * 60 + Number(get("minute")),
  };
}

/** Parses a "YYYY-MM-DD" key into a UTC Date. Calendar keys carry no time zone of their own; UTC is just the arithmetic frame, the same convention packages/core's date-utils.ts uses. */
function parseDateKey(date: string): Date {
  return new Date(`${date}T00:00:00Z`);
}

/** Formats a UTC Date back into a "YYYY-MM-DD" key. */
function toDateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(date: string, days: number): string {
  const parsed = parseDateKey(date);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return toDateKey(parsed);
}

/** Saturday or Sunday. */
export function isWeekend(date: string): boolean {
  const day = parseDateKey(date).getUTCDay();
  return day === 0 || day === 6;
}

/** The `n`th `weekday` (0 = Sunday) of `month` (1-12) in `year`, as a date key. */
function nthWeekdayOfMonth(year: number, month: number, weekday: number, n: number): string {
  const first = new Date(Date.UTC(year, month - 1, 1));
  const offset = (weekday - first.getUTCDay() + 7) % 7;
  return toDateKey(new Date(Date.UTC(year, month - 1, 1 + offset + (n - 1) * 7)));
}

/** The last `weekday` (0 = Sunday) of `month` (1-12) in `year`, as a date key. */
function lastWeekdayOfMonth(year: number, month: number, weekday: number): string {
  const last = new Date(Date.UTC(year, month, 0));
  const back = (last.getUTCDay() - weekday + 7) % 7;
  last.setUTCDate(last.getUTCDate() - back);
  return toDateKey(last);
}

/**
 * Easter Sunday in `year`, by the standard Gregorian (Meeus/Jones/Butcher)
 * algorithm -- needed only because Good Friday (two days earlier) is the one
 * US market holiday with no fixed date and no "nth weekday of month" rule.
 */
function easterSunday(year: number): string {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return toDateKey(new Date(Date.UTC(year, month - 1, day)));
}

/**
 * The observed date for a fixed-date holiday: a Saturday holiday is
 * observed the preceding Friday, a Sunday holiday the following Monday.
 *
 * `allowPrecedingFriday: false` encodes the one real exception in the NYSE
 * rules -- a holiday falling on Saturday is *not* observed on the preceding
 * Friday when that Friday is the last trading day of a calendar year, which
 * only ever applies to New Year's Day. In that case there's no observed
 * closure at all (Dec 31 stays a full trading day).
 */
function observedDate(date: string, allowPrecedingFriday = true): string | null {
  const day = parseDateKey(date).getUTCDay();
  if (day === 6) return allowPrecedingFriday ? addDays(date, -1) : null;
  if (day === 0) return addDays(date, 1);
  return date;
}

const holidayCache = new Map<number, ReadonlySet<string>>();

/**
 * Every scheduled US market holiday observed in `year`, as date keys.
 *
 * The list is the ten the NYSE and Nasdaq both close for. Juneteenth became
 * a market holiday in 2022; it's included unconditionally rather than gated
 * on the year, since this module is only ever asked about recent/upcoming
 * days (The Call Board looks at most a few days forward and ~90 days back).
 */
function holidaysForYear(year: number): ReadonlySet<string> {
  const cached = holidayCache.get(year);
  if (cached) return cached;

  const holidays = new Set<string>();
  const add = (date: string | null): void => {
    if (date !== null) holidays.add(date);
  };

  add(observedDate(`${year}-01-01`, false)); // New Year's Day
  add(nthWeekdayOfMonth(year, 1, 1, 3)); // MLK Jr. Day (3rd Monday of January)
  add(nthWeekdayOfMonth(year, 2, 1, 3)); // Washington's Birthday (3rd Monday of February)
  add(addDays(easterSunday(year), -2)); // Good Friday
  add(lastWeekdayOfMonth(year, 5, 1)); // Memorial Day (last Monday of May)
  add(observedDate(`${year}-06-19`)); // Juneteenth
  add(observedDate(`${year}-07-04`)); // Independence Day
  add(nthWeekdayOfMonth(year, 9, 1, 1)); // Labor Day (1st Monday of September)
  add(nthWeekdayOfMonth(year, 11, 4, 4)); // Thanksgiving (4th Thursday of November)
  add(observedDate(`${year}-12-25`)); // Christmas Day

  holidayCache.set(year, holidays);
  return holidays;
}

/**
 * Whether `date` is a scheduled US market holiday (already accounting for
 * observed-date shifting).
 *
 * Only the date's own calendar year needs checking: no observed date ever
 * lands outside its holiday's own year. The two candidates that could shift
 * across a boundary both can't -- Christmas shifts at most to Dec 24 or Dec
 * 26, and New Year's Day is the one holiday that is simply *not* observed
 * when it falls on a Saturday (see observedDate), precisely so it never
 * shifts back into December.
 */
export function isMarketHoliday(date: string): boolean {
  return holidaysForYear(Number(date.slice(0, 4))).has(date);
}

/** Whether the US equity markets hold a regular session on `date` -- a weekday that isn't a scheduled holiday. */
export function isTradingDay(date: string): boolean {
  return !isWeekend(date) && !isMarketHoliday(date);
}

/** The first trading day strictly after `date`. */
export function nextTradingDay(date: string): string {
  let candidate = addDays(date, 1);
  for (let i = 0; i < MAX_CALENDAR_SCAN_DAYS; i += 1) {
    if (isTradingDay(candidate)) return candidate;
    candidate = addDays(candidate, 1);
  }
  // Unreachable against the real calendar (see MAX_CALENDAR_SCAN_DAYS).
  return candidate;
}

/**
 * The next `count` trading days at or after `from`, ascending.
 * `from` itself is included when it's a trading day.
 *
 * Walks via `nextTradingDay` rather than re-implementing the skip loop, so
 * there's one place weekends/holidays are stepped over, not two.
 */
export function tradingDaysFrom(from: string, count: number): string[] {
  const days: string[] = [];
  let candidate = isTradingDay(from) ? from : nextTradingDay(from);
  while (days.length < count) {
    days.push(candidate);
    candidate = nextTradingDay(candidate);
  }
  return days;
}

/**
 * Whether `date`'s regular session has already begun, as far as the client's
 * own clock can tell.
 *
 * **Deliberately approximate, and that's the whole design.** It answers
 * "is the client's current exchange-local wall-clock time at or past 9:30 AM
 * on `date`?" -- nothing more. It does not consult live market data, does
 * not know whether the exchange actually opened that morning, and trusts the
 * viewer's own system clock (a device set hours fast can lock a pick early;
 * one set slow can leave a pick editable after the real open). For a
 * stakes-free prediction toy with no server-side scoring, that's the right
 * trade: it costs one Intl call and no network, and the worst case is a
 * viewer cheating themselves.
 *
 * A non-trading `date` (weekend, holiday) never has a session at all -- this
 * still reports "opened" once the clock passes that calendar day's 9:30, so
 * that a stale pick against a non-trading day can never sit editable forever.
 * Callers that mean "may this pick still be edited?" should use
 * `isPickEditable`, which excludes non-trading days outright.
 */
export function hasMarketOpened(date: string, now: Date): boolean {
  const clock = exchangeClock(now);
  if (clock.date > date) return true;
  if (clock.date < date) return false;
  return clock.minutesSinceMidnight >= MARKET_OPEN_MINUTES;
}

/**
 * Whether a pick for `date` may still be created or changed: it has to be a
 * real trading day whose session hasn't started yet, per `hasMarketOpened`'s
 * own approximation. Once this goes false for a day it never goes true again
 * (short of the viewer's clock moving backwards).
 */
export function isPickEditable(date: string, now: Date): boolean {
  return isTradingDay(date) && !hasMarketOpened(date, now);
}
