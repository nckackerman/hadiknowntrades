"use client";

// Client-side fetch of GET /api/sp500-prefix?range=... (issue #233) --
// the precomputed Sp500PrefixResult TheCut.tsx plays against. A thin
// useFetchResultsState<Sp500PrefixResult> instantiation, the same shape
// use-results.ts's own useResults(range) establishes for /api/results --
// unlike that route's `range: PresetRange | null` (custom-anchor mode can
// mean "no range at all"), The Cut always has a real selected range (its
// own range picker, independent of the outer page's ?range=), so this
// hook's own `range` parameter is non-nullable.

import type { PresetRange, Sp500PrefixResult } from "@hadiknowntrades/core";

import { useFetchResultsState, type ResultsState } from "./use-results";

/** Fetches The Cut's precomputed result for `range` and tracks it as a loading/error/success state -- refetches whenever `range` changes. */
export function useSp500Prefix(range: PresetRange): ResultsState<Sp500PrefixResult> | null {
  return useFetchResultsState<Sp500PrefixResult>(`/api/sp500-prefix?range=${range}`);
}
