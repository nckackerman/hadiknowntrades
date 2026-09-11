"use client";

// The Cut's own range picker (issue #238) -- mirrors RangeSelector.tsx's
// visual conventions (duration-coded bar, `--accent-selection` fill,
// `aria-pressed` pills) but is driven by CUT_RANGES/CutRange instead of
// PRESET_RANGES/PresetRange, and adds The Cut's own "1D" pill.
//
// **A dedicated sibling component, not a generalized RangeSelector
// (issue #238's own design decision -- see the PR for the full writeup)**:
// RangeSelector.tsx is also used, as-is, by the main results page
// (ResultsPage.tsx), which has nothing to do with The Cut and no reason
// to know CutRange exists. Two ways to add The Cut's "1D" pill were on
// the table:
//   1. Generalize RangeSelector to take an arbitrary ordered range list +
//      labels via props.
//   2. A small Cut-specific component mirroring the same conventions.
// (2) won: RangeSelector is genuinely tiny (its whole render is ~30
// lines), so duplicating its conventions here costs little, while
// generalizing it would grow every existing call site's own API (an
// explicit range list + label map to pass, every time) for the sake of
// one new caller -- and would put The Cut's own CutRange import into a
// component the main results page also depends on, the exact "a change
// scoped to one feature touches a shared, unrelated, already-tested
// component" blast radius this repo's own CustomWindowResult precedent
// (results-schema.ts) exists to avoid for data types, and the same
// reasoning applies here for a component. RangeSelector.tsx and its own
// tests stay completely untouched by this change.
//
// Unlike RangeSelector's own `selected: PresetRange | null` (the main
// results page can have no preset selected at all, e.g. a custom anchor
// is active instead), The Cut always has a real selected range -- see
// use-sp500-prefix.ts's own doc comment -- so `selected` here is
// non-nullable.

import { CUT_RANGES, type CutRange } from "@hadiknowntrades/core";

const RANGE_LABELS: Record<CutRange, string> = {
  "1D": "1D",
  "1W": "1W",
  "1M": "1M",
  "3M": "3M",
  "1Y": "1Y",
  "5Y": "5Y",
  MAX: "Max",
};

// Same duration-bar constants/derivation as RangeSelector.tsx's own
// durationBarWidthPx -- see that function's doc comment for the full
// "length, not color; ordinal, not proportional" reasoning, which
// applies identically here over CUT_RANGES instead of PRESET_RANGES.
const DURATION_BAR_MIN_WIDTH_PX = 8;
const DURATION_BAR_STEP_PX = 3;

function durationBarWidthPx(range: CutRange): number {
  return DURATION_BAR_MIN_WIDTH_PX + CUT_RANGES.indexOf(range) * DURATION_BAR_STEP_PX;
}

interface CutRangeSelectorProps {
  selected: CutRange;
  onSelect: (range: CutRange) => void;
}

/**
 * The Cut's own 1D / 1W / 1M / 3M / 1Y / 5Y / Max range picker. A
 * controlled component, same as RangeSelector -- TheCut.tsx owns which
 * range is selected.
 */
export function CutRangeSelector({ selected, onSelect }: CutRangeSelectorProps) {
  return (
    <div
      role="group"
      aria-label="Preset date range"
      className="inline-flex gap-1 rounded-full bg-[var(--surface-2)] p-1"
    >
      {CUT_RANGES.map((range) => {
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
            {/* Absolutely positioned, not a flow sibling of the label --
                see RangeSelector.tsx's own identical comment for why. */}
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
