"use client";

import { customRangeAnchors, type AnchorMonth } from "@hadiknowntrades/core";

/** Formats a YYYY-MM anchor identifier as "March 2019" for the picker's option labels. */
function formatAnchorLabel(anchor: AnchorMonth): string {
  const year = Number(anchor.slice(0, 4));
  const month = Number(anchor.slice(5, 7));
  return new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString("en-US", {
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
 * arbitrary date. A plain `<select>`, same reasoning DaySelector already
 * established (apps/web/CLAUDE.md's "Two result models" section): up to
 * CUSTOM_RANGE_ANCHOR_YEARS_BACK*12 options is far too many for a row of
 * pill buttons like RangeSelector.
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
 * customRangeAnchors(new Date()) is called fresh on every render rather
 * than memoized/passed as a prop -- it's a cheap, pure function of
 * calendar time (a 252-iteration loop), and the tiny risk of an SSR vs.
 * client hydration mismatch (both sides call `new Date()` independently,
 * a few hundred ms apart at most) only matters if a render straddles the
 * exact millisecond a month boundary rolls over -- an accepted,
 * documented edge case for a low-stakes learning project, not engineered
 * around further.
 */
export function CustomRangeSelector({ selected, onSelect }: CustomRangeSelectorProps) {
  const anchors = customRangeAnchors(new Date());

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
