"use client";

import { PRESET_RANGES, type PresetRange } from "@hadiknowntrades/core";

import { RangeSelectorBase } from "./RangeSelectorBase";

// Keeps every PresetRange key even though "5Y" no longer renders a pill
// below -- RangeSelectorBase's `labels` prop is typed as
// Record<T, string>, and passing VISIBLE_RANGES (a PresetRange[], not a
// narrower literal type -- .filter() doesn't narrow) still requires this
// map to cover every PresetRange, not just the ones actually rendered.
const RANGE_LABELS: Record<PresetRange, string> = {
  "1W": "1W",
  "1M": "1M",
  "3M": "3M",
  "1Y": "1Y",
  "5Y": "5Y",
  MAX: "Max",
};

/**
 * The ranges this picker actually renders: every PresetRange except "5Y".
 *
 * 5Y is a "window model" range (see packages/core/CLAUDE.md's "Optimizer
 * algorithm" section and apps/web/CLAUDE.md's "Two result models since
 * issue #28" section) -- it shows at most 3 trades total across the
 * *entire* 5-year window, by deliberate design, not a bug (confirmed live
 * against a real local pipeline run: a real 5Y result genuinely returns
 * exactly 3 trades, $20 -> $1,145.91, a real sensible outcome). 1Y, 3M,
 * 1M and 1W are all "intraday-daily" ranges instead (per-day optimization
 * chained across many trading days, so they can show hundreds of trades
 * total) -- which is why 5Y looks so sparse next to them and reads as
 * "not working" by contrast even though both models are functioning
 * exactly as designed. Removed from this picker specifically, per direct
 * user request, since it's the one range in this list whose result is
 * inherently unexciting to browse this way.
 *
 * Deliberately scoped to *this* picker alone, not PRESET_RANGES itself:
 * that constant/type is still used throughout the schema, pipeline, and
 * the OG-card route (/api/og/[range]) -- the nightly pipeline still
 * computes and stores a real 5Y result, and a direct `?range=5Y` URL
 * still renders it correctly (see ResultsPage.tsx). Exported so
 * ResultsPage.tsx's own "Explore other windows" summary text can derive
 * from the same filtered list rather than maintaining a second one that
 * could silently drift from it.
 */
export const VISIBLE_RANGES: readonly PresetRange[] = PRESET_RANGES.filter(
  (range) => range !== "5Y",
);

interface RangeSelectorProps {
  /**
   * The currently-selected preset range, or null when no preset is
   * active -- e.g. a custom start-date anchor (issue #11's
   * CustomRangeSelector) is selected instead, a mutually-exclusive
   * alternate view mode (see ResultsPage.tsx). null renders every pill
   * unpressed rather than defaulting to any particular one. Selected
   * being "5Y" (e.g. from a direct ?range=5Y URL) also renders every
   * pill unpressed, since 5Y no longer has a pill of its own here.
   */
  selected: PresetRange | null;
  onSelect: (range: PresetRange) => void;
}

/**
 * The 1W / 1M / 3M / 1Y / Max preset range picker (5Y removed, see
 * VISIBLE_RANGES above), used by the main results page. A thin
 * RangeSelectorBase instantiation over VISIBLE_RANGES -- see that
 * component's own doc comment for the shared render/duration-bar logic
 * (extracted from here and CutRangeSelector.tsx, issue #238's own code
 * review; the duration bar's width is derived from each range's own
 * position in whatever `ranges` array it's actually handed, so filtering
 * one entry out of the list handed to it is enough to keep the remaining
 * bars' relative ordering correct on its own) and for why "Preset date
 * range" must stay distinct from CutRangeSelector's own aria-label.
 */
export function RangeSelector({ selected, onSelect }: RangeSelectorProps) {
  return (
    <RangeSelectorBase
      ranges={VISIBLE_RANGES}
      labels={RANGE_LABELS}
      selected={selected}
      onSelect={onSelect}
      ariaLabel="Preset date range"
    />
  );
}
