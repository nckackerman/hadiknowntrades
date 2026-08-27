"use client";

import { PRESET_RANGES, type PresetRange } from "@hadiknowntrades/core";

const RANGE_LABELS: Record<PresetRange, string> = {
  "1W": "1W",
  "1M": "1M",
  "3M": "3M",
  "1Y": "1Y",
  "5Y": "5Y",
  MAX: "Max",
};

/**
 * Duration-coded indicator (issue #123): each pill carries a short bar
 * under its label whose *length* grows with the range's own duration, so
 * the row reads as an ordered scale (a week, a month, ... everything) at
 * a glance rather than six equally-weighted labels.
 *
 * Length, not color. An earlier mockup for this gave each range its own
 * dot color, which collides with the two meanings color already carries
 * on this page -- gain/loss (--status-good/--status-critical) and
 * earned-vs-selected (--accent-reward/--accent-selection, see globals.css's
 * own issue #121 decision block). Duration is ordinal, so encode it with
 * the one channel nothing else here is using.
 *
 * Ordinal by PRESET_RANGES position, deliberately NOT proportional to the
 * real elapsed time: 1W to MAX spans three-plus orders of magnitude, so a
 * true-to-scale bar would render 1W/1M/3M as indistinguishable slivers --
 * exactly the "visibly distinct bar lengths" this is for.
 *
 * A bar can be wider than the very short label above it ("1Y" is the
 * narrowest), which is why it renders absolutely positioned rather than as
 * a flow sibling -- see the render below. Measured live at 375px: the
 * whole row is 343px wide, the same as before this indicator existed.
 *
 * The width is an inline style, not a Tailwind class, on purpose: this
 * repo's jsdom test setup loads no stylesheet (see vitest.config.mts), so
 * a class-based width would compute to nothing and could not be asserted.
 * The bar is aria-hidden -- it is a redundant visual encoding of the label
 * that is already there, and any text/label on it would fold into the
 * button's own accessible name (the exact class of breakage DayOverview's
 * "carried over from {date}" note hit in issue #84).
 */
const DURATION_BAR_MIN_WIDTH_PX = 8;
const DURATION_BAR_STEP_PX = 3;

function durationBarWidthPx(range: PresetRange): number {
  return DURATION_BAR_MIN_WIDTH_PX + PRESET_RANGES.indexOf(range) * DURATION_BAR_STEP_PX;
}

interface RangeSelectorProps {
  /**
   * The currently-selected preset range, or null when no preset is
   * active -- e.g. a custom start-date anchor (issue #11's
   * CustomRangeSelector) is selected instead, a mutually-exclusive
   * alternate view mode (see ResultsPage.tsx). null renders every pill
   * unpressed rather than defaulting to any particular one.
   */
  selected: PresetRange | null;
  onSelect: (range: PresetRange) => void;
}

/**
 * The 1W / 1M / 3M / 1Y / 5Y / Max preset range picker. A controlled
 * component -- the caller owns which range is selected (and, in the real
 * page, syncs it to the URL) so this stays trivial to test in isolation.
 *
 * Each pill stacks its label over an aria-hidden duration bar (issue
 * #123) -- see `durationBarWidthPx`'s own doc comment above for why that
 * encoding is length rather than color, ordinal rather than
 * proportional, and inline-styled rather than class-based.
 *
 * The active pill's fill is `--accent-selection` (issue #121's semantic
 * alias for the selected/active-control job), not `--series-1` directly:
 * same blue today on purpose, but the chart's data series and an active
 * control have separate reasons to change later. It stays blue rather
 * than adopting `--accent-reward`'s gold -- gold means "earned," and
 * white-on-gold measures 2.16:1 besides; see globals.css's own decision
 * block.
 */
export function RangeSelector({ selected, onSelect }: RangeSelectorProps) {
  return (
    <div
      role="group"
      aria-label="Preset date range"
      className="inline-flex gap-1 rounded-full bg-[var(--surface-2)] p-1"
    >
      {PRESET_RANGES.map((range) => {
        const isSelected = range === selected;
        return (
          <button
            key={range}
            type="button"
            aria-pressed={isSelected}
            onClick={() => onSelect(range)}
            className={`relative rounded-full px-4 pt-1.5 pb-3 text-sm font-medium transition-colors ${
              isSelected
                ? "bg-[var(--accent-selection)] text-white"
                : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
            }`}
          >
            {RANGE_LABELS[range]}
            {/* Absolutely positioned, not a flow sibling of the label:
                a bar wider than its own (very short) label would
                otherwise widen that pill, and this row already runs
                close to the full viewport width at 375px (issue #63).
                Taking it out of flow keeps every pill's width exactly
                label-driven, so the row measures the same as it did
                before this indicator existed. */}
            <span
              aria-hidden="true"
              data-testid="range-duration-bar"
              data-range={range}
              className={`absolute bottom-1.5 left-1/2 h-0.5 -translate-x-1/2 rounded-full ${
                isSelected ? "bg-white/80" : "bg-[var(--text-muted)]"
              }`}
              style={{ width: `${durationBarWidthPx(range)}px` }}
            />
          </button>
        );
      })}
    </div>
  );
}
