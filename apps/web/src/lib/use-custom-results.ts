"use client";

// Client-side fetch of GET /api/results?anchor=... (issue #11's coarsened
// custom date-range feature -- see ../app/api/results/route.ts). A thin
// wrapper around use-results.ts's shared useFetchResultsState state
// machine, not a second independent copy of it (see that function's own
// doc comment for why): the two are only ever active one at a time on
// ResultsPage (range mode XOR anchor mode -- see ResultsPage.tsx).

import type { AnchorMonth, CustomWindowResult } from "@hadiknowntrades/core";

import { useFetchResultsState, type ResultsState } from "./use-results";

/**
 * Fetches the precomputed CustomWindowResult for `anchor` and tracks it
 * as a loading/error/success state, re-fetching whenever `anchor`
 * changes -- see useFetchResultsState (use-results.ts) for the shared
 * mechanics this instantiates. `anchor === null` means "custom-range
 * mode isn't active right now" (the page is showing a preset range
 * instead), and this returns `null` rather than ever fetching -- avoids
 * an always-on background request for whichever mode isn't currently
 * selected.
 */
export function useCustomResults(
  anchor: AnchorMonth | null,
): ResultsState<CustomWindowResult> | null {
  return useFetchResultsState<CustomWindowResult>(
    anchor === null ? null : `/api/results?anchor=${encodeURIComponent(anchor)}`,
  );
}
