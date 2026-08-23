"use client";

import { useMemo, useRef, useState } from "react";

import type { AnchorDate } from "@hadiknowntrades/core";

import { useCustomAnchors } from "@/lib/use-custom-anchors";

interface CustomRangeSelectorProps {
  /** The currently-selected anchor, or null when custom-range mode isn't active (a preset range is showing instead). */
  selected: AnchorDate | null;
  onSelect: (anchor: AnchorDate) => void;
}

const WEEKDAY_LABELS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

/** Splits a well-formed YYYY-MM-DD AnchorDate into its numeric parts (month 0-indexed, matching Date's own convention). Every anchor this component ever handles comes from either `selected` (already validated upstream, see ResultsPage.tsx's parseAnchorDate) or the manifest (already validated at write time by packages/core's validateCustomAnchorsManifest), so no malformed-input branch is needed here. */
function parseAnchorParts(anchor: AnchorDate): { year: number; month: number; day: number } {
  const [year, month, day] = anchor.split("-").map(Number);
  return { year: year!, month: month! - 1, day: day! };
}

/** Formats an AnchorDate as "March 15, 2019" for the trigger's own label once a date is selected -- the same toLocaleDateString pattern the old month-scheme formatAnchorLabel used, with day: "numeric" added. */
function formatSelectedLabel(anchor: AnchorDate): string {
  const { year, month, day } = parseAnchorParts(anchor);
  return new Date(Date.UTC(year, month, day)).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

/** Formats a (year, 0-indexed month) pair as "March 2019" for the calendar grid's own header. */
function formatMonthLabel(year: number, month: number): string {
  return new Date(Date.UTC(year, month, 1)).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    timeZone: "UTC",
  });
}

/** A sortable/comparable "YYYY-MM" key for a (year, 0-indexed month) pair -- used only to compare two months' relative order (prev/next-month boundary checks below), never displayed. */
function monthKey(year: number, month: number): string {
  return `${year}-${String(month + 1).padStart(2, "0")}`;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

/** 0 (Sunday) - 6 (Saturday), matching WEEKDAY_LABELS' own Sun-first order. */
function firstWeekdayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 1)).getUTCDay();
}

function dayAnchor(year: number, month: number, day: number): AnchorDate {
  return `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

interface ViewedMonth {
  year: number;
  /** 0-indexed, matching Date's own convention. */
  month: number;
}

/**
 * The month the calendar grid opens to, absent any explicit prev/next
 * navigation (see `viewedOverride` below): the selected anchor's own
 * month if one is selected, else the newest published anchor's month
 * (anchors is ascending -- see CustomAnchorsManifest's own doc comment
 * -- so the newest is the last element), else (no anchors published
 * yet, or still loading) the real current month.
 */
function defaultViewedMonth(
  anchors: readonly AnchorDate[],
  selected: AnchorDate | null,
): ViewedMonth {
  const source = selected ?? anchors[anchors.length - 1];
  if (!source) {
    const now = new Date();
    return { year: now.getUTCFullYear(), month: now.getUTCMonth() };
  }
  const { year, month } = parseAnchorParts(source);
  return { year, month };
}

/**
 * Lets the user pick a custom start-date anchor (issue #11's coarsened
 * design, day-granularity anchors since issue #75) -- but deliberately
 * only from the fixed set of real trading-day anchor points the nightly
 * pipeline actually computes+writes a result for (the published
 * manifest, fetched via useCustomAnchors), never a truly arbitrary date.
 *
 * **Issue #75 replaced the old month-scheme's plain `<select>` with a
 * hand-rolled calendar-grid picker** -- a day-granularity anchor set
 * (a few thousand entries) is far too many for either a `<select>`'s
 * flat option list or a row of pill buttons, and the day-precision ask
 * itself calls for a genuine calendar UI, not a longer flat list. See
 * docs/plans/issue-75-plan.md section 7 for the full design writeup this
 * implements.
 *
 * **Trigger + popover: a native `<details>`/`<summary>`, not a
 * controlled `useState` open/close** -- matches this app's own
 * established disclosure pattern (ResultsPage.tsx's "More options",
 * PortfolioChart.tsx's "View chart data as a table"), giving free
 * keyboard toggle (Enter/Space on the `<summary>`) with zero extra open/
 * closed state to manage. Used the ordinary way (native `open`/`closed`
 * toggling, no CSS force-open) -- NOT the one real `<details>` bug this
 * codebase has already documented (apps/web/CLAUDE.md's "Mobile layout
 * pass" section: a *closed* `<details>` forced visible via a CSS
 * override doesn't paint/hit-test correctly in this Chromium build),
 * which was specifically about overriding native closed-state behavior
 * with CSS, not about using `<details>` at all.
 *
 * **Selectable vs. disabled**: the published manifest's `anchors`
 * becomes a `Set<AnchorDate>` (`useMemo`) for O(1) per-cell lookups. A
 * day cell in the set renders as an enabled `<button>` (click ->
 * `onSelect` + close the popover); a day cell not in the set (a
 * weekend, a holiday, a day outside the lookback window, a future date,
 * or simply a date the pipeline hasn't published yet) renders
 * `disabled` -- native `disabled` semantics mean it's automatically
 * skipped in tab order and can't be activated, satisfying "only real
 * anchor days are selectable" with no custom ARIA-grid machinery.
 *
 * **Keyboard navigation: tab-order only, no hand-rolled arrow-key grid
 * roving** (a deliberate, documented scoping call, not an oversight --
 * see docs/plans/issue-75-plan.md section 7's own last bullet for the
 * full tradeoff this was weighed against). Every enabled day cell and
 * every nav button is a real, individually focusable, tabbable
 * `<button>`; disabled cells are correctly skipped. This satisfies
 * "everything is reachable and operable without a mouse," just not the
 * richer arrow-key affordance a dedicated date-picker library would add.
 *
 * **Loading/error states (a new failure mode this feature introduces --
 * the old month scheme's anchor list was a pure, always-synchronously-
 * available local computation, so it never needed either)**: while
 * loading, the trigger renders as a disabled button reading "Loading
 * start dates…", not clickable into an empty/broken calendar. On a
 * fetch error, this renders a small inline "Start-date picker
 * unavailable" message instead of any trigger at all -- matching this
 * app's established graceful-degradation posture (e.g. the OG card
 * route's silent 404, BenchmarkStat's silent null render) rather than
 * inventing a new error-surfacing pattern for just this one control.
 */
export function CustomRangeSelector({ selected, onSelect }: CustomRangeSelectorProps) {
  const anchorsState = useCustomAnchors();
  const detailsRef = useRef<HTMLDetailsElement>(null);
  // Only ever set by explicit prev/next navigation below -- null means
  // "still showing the natural default" (see defaultViewedMonth), so a
  // freshly re-opened popover (or a newly-arrived `selected` prop) keeps
  // tracking that default instead of getting stuck wherever a previous
  // session's navigation left off.
  const [viewedOverride, setViewedOverride] = useState<ViewedMonth | null>(null);

  const anchors = anchorsState?.status === "success" ? anchorsState.data.anchors : [];
  // Depends on `anchorsState` itself (not the derived `anchors` above,
  // which is a fresh `[]` literal on every render until the fetch
  // succeeds) -- ESLint's exhaustive-deps otherwise can't prove `anchors`
  // is referentially stable across renders.
  const anchorSet = useMemo(
    () => new Set(anchorsState?.status === "success" ? anchorsState.data.anchors : []),
    [anchorsState],
  );

  if (!anchorsState || anchorsState.status === "loading") {
    return (
      <div className="flex items-center gap-2 text-sm text-[var(--text-secondary)]">
        <span>Starting from</span>
        <button
          type="button"
          disabled
          className="rounded-md border border-[var(--gridline)] bg-[var(--surface-1)] px-2 py-1.5 text-sm font-medium text-[var(--text-muted)]"
        >
          Loading start dates…
        </button>
      </div>
    );
  }

  if (anchorsState.status === "error") {
    return <span className="text-sm text-[var(--text-muted)]">Start-date picker unavailable</span>;
  }

  const viewed = viewedOverride ?? defaultViewedMonth(anchors, selected);
  const oldest = anchors.length > 0 ? parseAnchorParts(anchors[0]!) : null;
  const newest = anchors.length > 0 ? parseAnchorParts(anchors[anchors.length - 1]!) : null;
  const viewedKey = monthKey(viewed.year, viewed.month);
  const atOldestMonth = oldest !== null && viewedKey <= monthKey(oldest.year, oldest.month);
  const atNewestMonth = newest !== null && viewedKey >= monthKey(newest.year, newest.month);

  function goToMonth(delta: number) {
    const totalMonths = viewed.year * 12 + viewed.month + delta;
    setViewedOverride({
      year: Math.floor(totalMonths / 12),
      month: ((totalMonths % 12) + 12) % 12,
    });
  }

  function handleSelect(anchor: AnchorDate) {
    onSelect(anchor);
    setViewedOverride(null);
    if (detailsRef.current) detailsRef.current.open = false;
  }

  const leadingBlanks = firstWeekdayOfMonth(viewed.year, viewed.month);
  const totalDays = daysInMonth(viewed.year, viewed.month);

  return (
    <div className="flex items-center gap-2 text-sm text-[var(--text-secondary)]">
      <span>Starting from</span>
      <details ref={detailsRef} className="relative">
        <summary
          data-testid="custom-range-trigger"
          className="cursor-pointer list-none rounded-md border border-[var(--gridline)] bg-[var(--surface-1)] px-2 py-1.5 text-sm font-medium text-[var(--text-primary)]"
        >
          {selected ? formatSelectedLabel(selected) : "Choose a start date…"}
        </summary>
        <div className="absolute right-0 z-10 mt-2 w-64 max-w-[calc(100vw-2rem)] rounded-md border border-[var(--gridline)] bg-[var(--surface-1)] p-3 shadow-lg">
          <div className="mb-2 flex items-center justify-between gap-2">
            <button
              type="button"
              onClick={() => goToMonth(-1)}
              disabled={atOldestMonth}
              aria-label="Previous month"
              className="rounded-md px-2 py-1 text-[var(--text-secondary)] hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)] disabled:pointer-events-none disabled:opacity-30"
            >
              ‹
            </button>
            <span className="text-sm font-medium text-[var(--text-primary)]">
              {formatMonthLabel(viewed.year, viewed.month)}
            </span>
            <button
              type="button"
              onClick={() => goToMonth(1)}
              disabled={atNewestMonth}
              aria-label="Next month"
              className="rounded-md px-2 py-1 text-[var(--text-secondary)] hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)] disabled:pointer-events-none disabled:opacity-30"
            >
              ›
            </button>
          </div>
          <div className="grid grid-cols-7 gap-y-1 text-center text-xs">
            {WEEKDAY_LABELS.map((label, i) => (
              // Indexed key is safe here -- WEEKDAY_LABELS is a fixed,
              // never-reordered constant, not data that can change shape.
              <span key={i} className="text-[var(--text-muted)]">
                {label}
              </span>
            ))}
            {Array.from({ length: leadingBlanks }, (_, i) => (
              <span key={`blank-${i}`} />
            ))}
            {Array.from({ length: totalDays }, (_, i) => {
              const day = i + 1;
              const anchor = dayAnchor(viewed.year, viewed.month, day);
              const isSelectable = anchorSet.has(anchor);
              const isSelected = anchor === selected;
              return (
                <button
                  key={anchor}
                  type="button"
                  disabled={!isSelectable}
                  onClick={() => handleSelect(anchor)}
                  aria-current={isSelected ? "date" : undefined}
                  className={`rounded-md py-1 text-sm transition-colors ${
                    isSelected
                      ? "bg-[var(--series-1)] text-white"
                      : isSelectable
                        ? "text-[var(--text-primary)] hover:bg-[var(--surface-2)]"
                        : "text-[var(--text-muted)] opacity-40"
                  }`}
                >
                  {day}
                </button>
              );
            })}
          </div>
        </div>
      </details>
    </div>
  );
}
