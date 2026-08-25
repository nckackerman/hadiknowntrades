// Shared date formatting for PortfolioChart and TradeList, so the chart
// and the trade list can't silently drift on how a date is displayed.

/**
 * Formats a raw epoch timestamp (ms) as "Aug 21, 2025", UTC -- the same
 * `Intl` options `formatDate` below uses, extracted so a caller that
 * already has a real epoch value (not a `"YYYY-MM-DD"` string) can
 * reuse the identical formatting rather than round-tripping through a
 * string first. Introduced for `use-trade-replay.ts`'s rewind-to-start
 * readout (issue #97), which tweens a raw epoch between "now" and the
 * result's start date and needs to format every intermediate value, not
 * just the two endpoints `formatDate` alone would cover.
 */
export function formatEpochAsDate(epochMs: number): string {
  return new Date(epochMs).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/** Formats a plain calendar date ("2025-08-21") as "Aug 21, 2025". */
export function formatDate(isoDate: string): string {
  // Parsed as UTC (not the browser's local zone) since these are plain
  // calendar dates from the pipeline, not timestamps -- parsing
  // "2025-08-21" as local time can roll it back a day in zones west of
  // UTC.
  return formatEpochAsDate(Date.parse(`${isoDate}T00:00:00Z`));
}

/**
 * Formats a bare local time-of-day ("14:30:00", no date) as "2:30 PM" --
 * for IntradayTrade's openTime/closeTime (issue #28), which don't carry a
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
 * Whether a PortfolioPoint's `date` field is a full local datetime
 * ("2025-08-21T14:30:00", an intraday day's chart -- issue #28) rather
 * than a plain calendar date ("2025-08-21", the window model) --
 * detected by the presence of a "T" separator. The single canonical
 * place this detection happens: this module's own `toPortfolioTimestamp`
 * (below) and `formatDateTime` both delegate to it instead of each
 * keeping their own copy of the same check, so the two can't drift on
 * what counts as "a datetime" the way two independently written
 * string-sniffing checks otherwise could.
 */
export function isPortfolioDatetime(date: string): boolean {
  return date.includes("T");
}

/**
 * A PortfolioPoint's `date` is either a plain calendar date
 * ("2025-08-21", the window model) or a full local datetime
 * ("2025-08-21T14:30:00", an intraday day's chart -- issue #28). Both
 * are parsed "as if UTC" (a "Z" appended, not re-interpreted through any
 * real timezone) purely to get a monotonic numeric timestamp -- e.g. for
 * laying points out along a chart's x-axis, or for a rewind-intro-beat
 * tween target (issue #97/#105). Extracted from PortfolioChart.tsx's own
 * private `toTimestamp` (issue #105's own plan, section 5/6) so
 * use-trade-replay.ts can share it too, rather than re-deriving the same
 * "is this a datetime or a plain date" check a third time via its own
 * inline `Date.parse` -- see isPortfolioDatetime's own doc comment for
 * why that's the one thing this module already guards against
 * duplicating.
 */
export function toPortfolioTimestamp(date: string): number {
  return new Date(isPortfolioDatetime(date) ? `${date}Z` : `${date}T00:00:00Z`).getTime();
}

/**
 * Formats a PortfolioPoint's `date` field (see isPortfolioDatetime).
 *
 * `includeDate` disambiguates two genuinely different chart shapes that
 * both use datetime-labeled points: a single day's own intraday chart
 * (where the day is already shown elsewhere on the page, so repeating
 * it on every point would be redundant -- pass `false`, formats as
 * time-only, "2:30 PM") vs. the whole-range chart chaining many days
 * together (issue #91, see portfolio-series.ts's
 * deriveWholeRangeIntradaySeries), where a bare time is ambiguous about
 * *which* day it falls on -- pass `true`, formats as "Aug 21, 2:30 PM".
 * Ignored for a plain calendar-date point (the window model), which
 * already always shows its own date regardless.
 */
export function formatDateTime(date: string, includeDate: boolean): string {
  if (!isPortfolioDatetime(date)) return formatDate(date);
  const separatorIndex = date.indexOf("T");
  const time = formatTime(date.slice(separatorIndex + 1));
  if (!includeDate) return time;
  const day = new Date(`${date.slice(0, separatorIndex)}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
  return `${day}, ${time}`;
}
