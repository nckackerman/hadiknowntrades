/** Formats a Date as YYYY-MM-DD in UTC, matching the DailyClose.date format. */
export function toDateString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** `date` minus a plain number of calendar days, in UTC. */
export function daysBeforeUtc(date: Date, days: number): Date {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() - days);
  return result;
}
