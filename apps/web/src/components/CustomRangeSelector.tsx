"use client";

import { useMemo } from "react";

import { anchorMonthToDate, customRangeAnchors, type AnchorMonth } from "@hadiknowntrades/core";

/**
 * Formats a YYYY-MM anchor identifier as "March 2019" for the picker's
 * option labels -- calls anchorMonthToDate (packages/core) for the
 * actual parse rather than re-deriving the same slice+Date.UTC logic a
 * second time (a real duplication, caught in code review: this file's
 * own copy predated anchorMonthToDate's year-range sanity check, so it
 * was silently exposed to the same "0099" two-digit-year bug that fix
 * closed -- see that function's own doc comment). Every anchor passed in
 * here always comes from customRangeAnchors() below, which never
 * produces a malformed one, so the `null` fallback is defensive only.
 */
function formatAnchorLabel(anchor: AnchorMonth): string {
  const date = anchorMonthToDate(anchor);
  if (!date) return anchor;
  return date.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    timeZone: "UTC",
  });
}

interface CustomRangeSelectorProps {
  /** The currently-selected anchor, or null when custom-range mode isn't active (a preset range is showing instead). */
  selected: AnchorMonth | null;
  onSelect: (anchor: AnchorMonth) => void;
}

/**
 * Lets the user pick a custom start-date anchor (issue #11's coarsened
 * design) -- but deliberately only from the fixed, month-granularity set
 * of anchor points the nightly pipeline actually computes+writes a
 * result for (packages/core's customRangeAnchors), never a truly
 * arbitrary date. A plain `<select>` -- up to
 * CUSTOM_RANGE_ANCHOR_YEARS_BACK*12 options is far too many for a row of
 * pill buttons like RangeSelector. (DaySelector used to make this same
 * "too many for pills" argument for the intraday model's own day picker;
 * issue #80 replaced it with DayOverview, a scrollable row list rather
 * than a `<select>`, since that picker also needs to show each day's
 * trade count/result inline -- CustomRangeSelector has no equivalent
 * per-option content to show, so a plain `<select>` still fits best here.)
 *
 * The leading, disabled placeholder option ("Choose a start month...")
 * is deliberate, not decorative -- it's what makes "you can only pick
 * from this list, not any date" discoverable by just opening the
 * dropdown, rather than a silent constraint a user only discovers after
 * typing/picking something that 404s. A native `<input type="date">`
 * would invite exactly that failure mode (a day the pipeline never
 * actually computed a result for), which is why this is a `<select>` of
 * real options instead.
 *
 * customRangeAnchors(new Date()) is a cheap, pure function of calendar
 * time (a 252-iteration loop) -- memoized per mount (`useMemo(..., [])`)
 * rather than recomputed every render, purely to avoid redundant work
 * across re-renders of the *same* mounted instance (issue #63's code
 * review: ResultsPage.tsx now mounts two instances of this component at
 * once, a desktop copy and a mobile "More options" copy, so an
 * unmemoized per-render call effectively doubled this cost on every
 * ResultsPage render). Still computed fresh on every new *mount* (an
 * empty dependency array, not a module-level constant), so the tiny risk
 * of an SSR vs. client hydration mismatch (both sides call `new Date()`
 * independently, a few hundred ms apart at most) is unchanged from
 * before this memoization -- it only matters if a render straddles the
 * exact millisecond a month boundary rolls over, an accepted, documented
 * edge case for a low-stakes learning project, not engineered around
 * further.
 */
export function CustomRangeSelector({ selected, onSelect }: CustomRangeSelectorProps) {
  const anchors = useMemo(() => customRangeAnchors(new Date()), []);

  return (
    <label className="flex items-center gap-2 text-sm text-[var(--text-secondary)]">
      <span>Starting from</span>
      <select
        value={selected ?? ""}
        onChange={(changeEvent) => {
          const next = changeEvent.target.value;
          if (next) onSelect(next);
        }}
        className="rounded-md border border-[var(--gridline)] bg-[var(--surface-1)] px-2 py-1.5 text-sm font-medium text-[var(--text-primary)]"
      >
        <option value="" disabled>
          Choose a start month…
        </option>
        {anchors.map((anchor) => (
          <option key={anchor} value={anchor}>
            {formatAnchorLabel(anchor)}
          </option>
        ))}
      </select>
    </label>
  );
}
