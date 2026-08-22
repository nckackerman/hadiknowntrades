"use client";

import { PRESET_RANGES, type PresetRange } from "@hadiknowntrades/core";

const RANGE_LABELS: Record<PresetRange, string> = {
  "1M": "1M",
  "3M": "3M",
  "1Y": "1Y",
  "5Y": "5Y",
  MAX: "Max",
};

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

/** The 1M / 3M / 1Y / 5Y / Max preset range picker. A controlled component -- the caller owns which range is selected (and, in the real page, syncs it to the URL) so this stays trivial to test in isolation. */
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
            className={`rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${
              isSelected
                ? "bg-[var(--series-1)] text-white"
                : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
            }`}
          >
            {RANGE_LABELS[range]}
          </button>
        );
      })}
    </div>
  );
}
