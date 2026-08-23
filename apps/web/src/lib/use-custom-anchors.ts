"use client";

// Client-side fetch of GET /api/custom-anchors (issue #75) -- the
// published list of valid custom-range start-date anchors, consumed
// exclusively by CustomRangeSelector.tsx's calendar-grid picker. A thin
// `useFetchResultsState<CustomAnchorsManifest>` instantiation, the same
// shared fetch/loading/error state machine useResults/useCustomResults
// already build on (use-results.ts) -- see that function's own doc
// comment for the shared mechanics.
//
// Unlike useResults(range)/useCustomResults(anchor), this hook's URL
// never changes (there's no identifier to parameterize it by -- the
// manifest is one fixed object) -- so it fetches exactly once per mount,
// not once per some changing selector value.

import type { CustomAnchorsManifest } from "@hadiknowntrades/core";

import { useFetchResultsState, type ResultsState } from "./use-results";

const CUSTOM_ANCHORS_URL = "/api/custom-anchors";

/**
 * Fetches the published custom-range anchors manifest and tracks it as a
 * loading/error/success state -- see useFetchResultsState (use-results.ts)
 * for the shared mechanics. Always fetches (this hook's URL is a
 * constant, not a nullable selector the way useResults/useCustomResults'
 * own `range`/`anchor` parameters are), so the return type is never
 * `null` in practice -- kept as `ResultsState<CustomAnchorsManifest> |
 * null` to match useFetchResultsState's own general signature rather
 * than asserting it away with a non-null cast.
 */
export function useCustomAnchors(): ResultsState<CustomAnchorsManifest> | null {
  return useFetchResultsState<CustomAnchorsManifest>(CUSTOM_ANCHORS_URL);
}
