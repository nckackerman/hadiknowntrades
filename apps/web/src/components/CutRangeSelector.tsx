"use client";

// The Cut's own range picker (issue #238) -- mirrors RangeSelector.tsx's
// visual conventions (duration-coded bar, `--accent-selection` fill,
// `aria-pressed` pills) but is driven by CUT_RANGES/CutRange instead of
// PRESET_RANGES/PresetRange, and adds The Cut's own "1D" pill. Both this
// component and RangeSelector.tsx are now thin RangeSelectorBase
// instantiations (see that component's own doc comment for the shared
// render/duration-bar logic, extracted here after code review found the
// two hand-duplicated).
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
// (2) won: generalizing RangeSelector itself (not just the shared
// rendering it's built from) would have put The Cut's own CutRange type
// on the same component the main results page also depends on, growing
// that unrelated, already-tested component's own props for the sake of
// one new caller -- the exact "a change scoped to one feature touches a
// shared, unrelated, already-tested component" blast radius this repo's
// own CustomWindowResult precedent (results-schema.ts) exists to avoid
// for data types, and the same reasoning applies here for a component.
// RangeSelector.tsx's own public props/behavior stay completely
// untouched by this change; only the render internals both files share
// moved into RangeSelectorBase.
//
// **`aria-label` is deliberately its own distinct string, "The Cut date
// range" -- not RangeSelector's own "Preset date range" (code review
// finding, fixed).** ResultsPage.tsx renders both The Cut's panel
// (containing this component) and the separate "Explore other windows"
// panel (containing RangeSelector) as independent `<details>` elements
// with no shared `name` -- a viewer can expand both at once, which would
// put two `role="group"` elements with the identical accessible name in
// the DOM simultaneously, breaking screen-reader disambiguation and any
// `getByRole("group", {name: ...})` query that isn't itself scoped to one
// panel's own subtree.
//
// Unlike RangeSelector's own `selected: PresetRange | null` (the main
// results page can have no preset selected at all, e.g. a custom anchor
// is active instead), The Cut always has a real selected range -- see
// use-sp500-prefix.ts's own doc comment -- so `selected` here is
// non-nullable.

import { CUT_RANGES, type CutRange } from "@hadiknowntrades/core";

import { RangeSelectorBase } from "./RangeSelectorBase";

const RANGE_LABELS: Record<CutRange, string> = {
  "1D": "1D",
  "1W": "1W",
  "1M": "1M",
  "3M": "3M",
  "1Y": "1Y",
  "5Y": "5Y",
  MAX: "Max",
};

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
    <RangeSelectorBase
      ranges={CUT_RANGES}
      labels={RANGE_LABELS}
      selected={selected}
      onSelect={onSelect}
      ariaLabel="The Cut date range"
    />
  );
}
