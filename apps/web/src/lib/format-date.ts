// Shared date formatting for PortfolioChart and TradeList, so the chart
// and the trade list can't silently drift on how a date is displayed.

/** Formats a plain calendar date ("2025-08-21") as "Aug 21, 2025". */
export function formatDate(isoDate: string): string {
  // Parsed as UTC (not the browser's local zone) since these are plain
  // calendar dates from the pipeline, not timestamps -- parsing
  // "2025-08-21" as local time can roll it back a day in zones west of
  // UTC.
  return new Date(`${isoDate}T00:00:00Z`).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/**
 * Formats a bare local time-of-day ("14:30:00", no date) as "2:30 PM" --
 * for IntradayTrade's buyTime/sellTime (issue #28), which don't carry a
 * date of their own since the day is already known from context (the
 * selected day in the intraday view).
 */
export function formatTime(time: string): string {
  // Parsed against a fixed, arbitrary reference date and treated as UTC
  // so the literal wall-clock time renders unchanged regardless of the
  // viewer's timezone -- consistent with treating these already-local
  // time strings "as if UTC" the same way formatDate does for plain
  // calendar dates (see packages/core's date-utils comments on the same
  // convention).
  return new Date(`2000-01-01T${time}Z`).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
  });
}

/**
 * Formats a PortfolioPoint's `date` field, which is either a plain
 * calendar date ("2025-08-21", the window model) or a full local
 * datetime ("2025-08-21T14:30:00", an intraday day's chart -- issue
 * #28) -- detected by the presence of a "T" separator. A datetime
 * formats as time-only ("2:30 PM"): the chart already shows which
 * single day is selected elsewhere in the intraday view, so repeating
 * the date on every point would be redundant.
 */
export function formatDateTime(date: string): string {
  const separatorIndex = date.indexOf("T");
  if (separatorIndex === -1) return formatDate(date);
  return formatTime(date.slice(separatorIndex + 1));
}
