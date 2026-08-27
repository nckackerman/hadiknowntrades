"use client";

// Client-side fetch of GET /api/beat-the-bench (issue #131) -- the
// Today's Close session BeatTheBench.tsx plays through. A thin
// `useFetchResultsState<TodaysCloseSession>` instantiation, the same
// shared fetch/loading/error state machine useResults/useCustomResults/
// useCustomAnchors already build on (use-results.ts).
//
// Like useCustomAnchors, this hook's URL never changes -- there's no
// identifier to parameterize it by, since Today's Close is one fixed
// object -- so it fetches exactly once per mount.
//
// Fetched on mount rather than deferred until the viewer presses play:
// the chooser card names the real session date ("Today's close, Aug 26"),
// which is in the payload, and the payload is a few KB of bars. If a
// future mode ever makes this heavy (issue #132's pool is many
// sessions), reconsider then -- don't assume this precedent covers it.

import type { TodaysCloseSession } from "@hadiknowntrades/core";

import { useFetchResultsState, type ResultsState } from "./use-results";

const TODAYS_CLOSE_URL = "/api/beat-the-bench";

/**
 * Fetches the published Today's Close session and tracks it as a
 * loading/error/success state -- see useFetchResultsState
 * (use-results.ts) for the shared mechanics. Always fetches (the URL is
 * a constant, not a nullable selector), so the return is never `null` in
 * practice; the type keeps useFetchResultsState's own general signature
 * rather than asserting that away, matching useCustomAnchors.
 */
export function useTodaysCloseSession(): ResultsState<TodaysCloseSession> | null {
  return useFetchResultsState<TodaysCloseSession>(TODAYS_CLOSE_URL);
}
