"use client";

// The shared, type-agnostic presentational core behind both
// RangeSelector.tsx (PRESET_RANGES/PresetRange, the main results page)
// and CutRangeSelector.tsx (CUT_RANGES/CutRange, The Cut -- issue #238).
//
// Extracted after review found the two nearly-verbatim-duplicated: the
// duration-bar width formula, the container/button markup, and every
// className string were hand-copied between the two files with nothing
// catching drift. This component owns all of that once; each caller
// supplies only what's genuinely different between them -- its own
// range list, label map, and `aria-label` (RangeSelector's own "Preset
// date range" and CutRangeSelector's own distinct "The Cut date range"
// -- see that component's own doc comment for why the two must differ).
//
// Generic over `T extends string` rather than fixed to `PresetRange |
// CutRange`: neither caller's own range type is a subtype of the
// other's, so a shared, non-generic prop shape would have to either
// union the two (letting a PresetRange-only caller accidentally render
// a "1D" pill) or fall back to `string` (losing every caller's own
// compile-time exhaustiveness). A generic keeps each caller's own
// range type exact.

interface RangeSelectorBaseProps<T extends string> {
  /** The full, ordered range list this picker renders -- PRESET_RANGES or CUT_RANGES. Duration-bar width is derived from each range's own position in this array, not a second, independently-maintained ordinal. */
  ranges: readonly T[];
  /** Visible label per range, e.g. `{ "1W": "1W", ..., MAX: "Max" }`. */
  labels: Record<T, string>;
  /** The currently-selected range, or null when no preset is active (see RangeSelector's own doc comment on why that's possible there but not for CutRangeSelector). */
  selected: T | null;
  onSelect: (range: T) => void;
  /** This picker's own accessible group name -- must be distinct across every simultaneously-mounted instance (two `role="group"` elements with the identical name in the same accessible tree at once breaks screen-reader disambiguation and any `getByRole("group", {name})` query). */
  ariaLabel: string;
}

/**
 * Duration-coded indicator (issue #123): each pill carries a short bar
 * under its label whose *length* grows with the range's own duration, so
 * the row reads as an ordered scale (a week, a month, ... everything) at
 * a glance rather than several equally-weighted labels.
 *
 * Length, not color. An earlier mockup for this gave each range its own
 * dot color, which collides with the two meanings color already carries
 * on the main results page -- gain/loss (--status-good/--status-critical)
 * and earned-vs-selected (--accent-reward/--accent-selection, see
 * globals.css's own issue #121 decision block). Duration is ordinal, so
 * encode it with the one channel nothing else there is using.
 *
 * Ordinal by each range's own position in `ranges`, deliberately NOT
 * proportional to the real elapsed time: 1W to MAX (or 1D to MAX,
 * CutRange's own widened list) spans several orders of magnitude, so a
 * true-to-scale bar would render the shortest ranges as indistinguishable
 * slivers -- exactly the "visibly distinct bar lengths" this is for.
 *
 * A bar can be wider than the very short label above it, which is why it
 * renders absolutely positioned rather than as a flow sibling -- see the
 * render below. The width is an inline style, not a Tailwind class, on
 * purpose: this repo's jsdom test setup loads no stylesheet (see
 * vitest.config.mts), so a class-based width would compute to nothing
 * and could not be asserted. The bar is aria-hidden -- it is a redundant
 * visual encoding of the label that is already there, and any text/label
 * on it would fold into the button's own accessible name.
 */
const DURATION_BAR_MIN_WIDTH_PX = 8;
const DURATION_BAR_STEP_PX = 3;

/**
 * The shared range-picker render: an aria-pressed pill row, each pill
 * stacking its label over an aria-hidden duration bar. A controlled
 * component -- the caller owns which range is selected.
 *
 * The active pill's fill is `--accent-selection` (issue #121's semantic
 * alias for the selected/active-control job), not `--series-1` directly:
 * same blue today on purpose, but the chart's data series and an active
 * control have separate reasons to change later.
 */
export function RangeSelectorBase<T extends string>({
  ranges,
  labels,
  selected,
  onSelect,
  ariaLabel,
}: RangeSelectorBaseProps<T>) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className="inline-flex gap-1 rounded-full bg-[var(--surface-2)] p-1"
    >
      {ranges.map((range, index) => {
        const isSelected = range === selected;
        const durationBarWidthPx = DURATION_BAR_MIN_WIDTH_PX + index * DURATION_BAR_STEP_PX;
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
            {labels[range]}
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
              style={{ width: `${durationBarWidthPx}px` }}
            />
          </button>
        );
      })}
    </div>
  );
}
