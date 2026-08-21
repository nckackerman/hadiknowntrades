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
