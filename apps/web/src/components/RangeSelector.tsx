"use client";

import { PRESET_RANGES, type PresetRange } from "@hadiknowntrades/core";

import { RangeSelectorBase } from "./RangeSelectorBase";

const RANGE_LABELS: Record<PresetRange, string> = {
  "1W": "1W",
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

/**
 * The 1W / 1M / 3M / 1Y / 5Y / Max preset range picker, used by the main
 * results page. A thin RangeSelectorBase instantiation over PRESET_RANGES
 * -- see that component's own doc comment for the shared render/duration-
 * bar logic (extracted from here and CutRangeSelector.tsx, issue #238's
 * own code review) and for why "Preset date range" must stay distinct
 * from CutRangeSelector's own aria-label.
 */
export function RangeSelector({ selected, onSelect }: RangeSelectorProps) {
  return (
    <RangeSelectorBase
      ranges={PRESET_RANGES}
      labels={RANGE_LABELS}
      selected={selected}
      onSelect={onSelect}
      ariaLabel="Preset date range"
    />
  );
}
