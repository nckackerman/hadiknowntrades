"use client";

import { formatDate } from "@/lib/format-date";

interface DaySelectorProps {
  /** Ascending YYYY-MM-DD dates -- the intraday result's own `days[].date` order (issue #28). */
  days: readonly string[];
  selected: string;
  onSelect: (day: string) => void;
}

/**
 * Picks which trading day's intraday result to view (issue #28) -- a
 * plain `<select>` rather than RangeSelector's pill toggle, since a
 * window can hold up to ~252 trading days (1Y), too many for a row of
 * buttons. A controlled component, same pattern as RangeSelector: the
 * caller (ResultsPanel, via ResultsPage) owns which day is selected and,
 * in the real page, syncs it to the URL.
 */
export function DaySelector({ days, selected, onSelect }: DaySelectorProps) {
  return (
    <label className="flex items-center gap-2 text-sm text-[var(--text-secondary)]">
      <span>Day</span>
      <select
        value={selected}
        onChange={(changeEvent) => onSelect(changeEvent.target.value)}
        className="rounded-md border border-[var(--gridline)] bg-[var(--surface-1)] px-2 py-1.5 text-sm font-medium text-[var(--text-primary)]"
      >
        {days.map((date) => (
          <option key={date} value={date}>
            {formatDate(date)}
          </option>
        ))}
      </select>
    </label>
  );
}
