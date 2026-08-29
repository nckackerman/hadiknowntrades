"use client";

// Client-side fetch of GET /api/the-order (issue #207) -- the daily
// puzzle TheOrder.tsx plays. A thin `useFetchResultsState<TheOrderPuzzle>`
// instantiation, the exact same shape use-todays-close-session.ts already
// establishes for Beat the Bench's own fixed-key fetch: no identifier to
// parameterize the URL by, so this fetches exactly once per mount.

import type { TheOrderPuzzle } from "@hadiknowntrades/core";

import { useFetchResultsState, type ResultsState } from "./use-results";

const THE_ORDER_URL = "/api/the-order";

/**
 * Fetches the published daily Order puzzle and tracks it as a
 * loading/error/success state -- see useFetchResultsState (use-results.ts)
 * for the shared mechanics. Always fetches (the URL is a constant, not a
 * nullable selector), so the return is never `null` in practice; the type
 * keeps useFetchResultsState's own general signature rather than
 * asserting that away, matching useTodaysCloseSession/useCustomAnchors.
 */
export function useTheOrderPuzzle(): ResultsState<TheOrderPuzzle> | null {
  return useFetchResultsState<TheOrderPuzzle>(THE_ORDER_URL);
}
