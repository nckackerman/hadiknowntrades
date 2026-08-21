/** Formats a Date as YYYY-MM-DD in UTC, matching the DailyClose.date format. */
export function toDateString(date: Date): string {
  return date.toISOString().slice(0, 10);
}
