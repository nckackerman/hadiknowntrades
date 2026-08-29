"use client";

// Client-side fetch of GET /api/lineup (issue #208) -- the day's real 5
// mystery tickers TheLineup.tsx plays against. A thin
// `useFetchResultsState<LineupResult>` instantiation, the same shared
// fetch/loading/error state machine useResults/useCustomResults/
// useTodaysCloseSession already build on (use-results.ts).
//
// Like useTodaysCloseSession, this hook's URL never changes -- there's
// no identifier to parameterize it by, since /api/lineup always serves
// whichever LineupResult was most recently published -- so it fetches
// exactly once per mount.

import type { LineupResult } from "@hadiknowntrades/core";

import { useFetchResultsState, type ResultsState } from "./use-results";

const LINEUP_URL = "/api/lineup";

/**
 * Fetches the published Lineup selection and tracks it as a
 * loading/error/success state -- see useFetchResultsState
 * (use-results.ts) for the shared mechanics. Always fetches (the URL is
 * a constant, not a nullable selector), so the return is never `null` in
 * practice; the type keeps useFetchResultsState's own general signature
 * rather than asserting that away, matching useTodaysCloseSession.
 */
export function useLineupResult(): ResultsState<LineupResult> | null {
  return useFetchResultsState<LineupResult>(LINEUP_URL);
}
