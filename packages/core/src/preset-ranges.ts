// The six preset timeline windows the app supports (see README). Shared
// vocabulary between the nightly pipeline (which precomputes one result
// per range) and, later, the API/frontend (which serve/select by range).

import { daysBeforeUtc } from "./date-utils";

export const PRESET_RANGES = ["1W", "1M", "3M", "1Y", "5Y", "MAX"] as const;

export type PresetRange = (typeof PRESET_RANGES)[number];

/**
 * Subtracts months and/or years from a UTC date, clamping the day of
 * month if it would otherwise overflow into a later month.
 *
 * Naively calling setUTCMonth/setUTCFullYear on a date like the 31st
 * overflows into the *next* month whenever the target month is shorter
 * (e.g. asOf = Mar 31, minus 1 month naively lands on Mar 2/3, not Feb
 * 29/28) — this clamps to the target month's actual last day instead,
 * the same way most calendar libraries define "a month before the 31st."
 */
function subtractCalendar(date: Date, delta: { months?: number; years?: number }): Date {
  const result = new Date(date);
  const originalDay = result.getUTCDate();
  // Set to day 1 first so changing month/year below can't itself
  // overflow while the day-of-month is still (possibly) out of range
  // for the month it's about to leave or land on.
  result.setUTCDate(1);
  if (delta.years) result.setUTCFullYear(result.getUTCFullYear() - delta.years);
  if (delta.months) result.setUTCMonth(result.getUTCMonth() - delta.months);

  const daysInTargetMonth = new Date(
    Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0),
  ).getUTCDate();
  result.setUTCDate(Math.min(originalDay, daysInTargetMonth));
  return result;
}

/**
 * The start date for a preset range, given the "as of" date (the most
 * recent day of data being used). Returns null for "MAX", meaning
 * unbounded — use all available history.
 */
export function presetRangeStartDate(range: PresetRange, asOf: Date): Date | null {
  switch (range) {
    case "1W":
      return daysBeforeUtc(asOf, 7);
    case "1M":
      return subtractCalendar(asOf, { months: 1 });
    case "3M":
      return subtractCalendar(asOf, { months: 3 });
    case "1Y":
      return subtractCalendar(asOf, { years: 1 });
    case "5Y":
      return subtractCalendar(asOf, { years: 5 });
    case "MAX":
      return null;
  }
}
