"use client";

// Client-side fetches for Beat the Bench's Mystery Day mode (issue
// #132), both thin `useFetchResultsState` instantiations over the same
// shared fetch/loading/error state machine every other data hook in this
// app builds on (use-results.ts).
//
// **The `null`-URL behaviour of that shared hook is the entire
// enforcement mechanism here, not an incidental detail.**
// `useFetchResultsState(null)` makes no request at all -- it doesn't
// fetch and discard, it doesn't fetch and hide, it never reaches the
// network. So:
//
//   - `useMysterySession(pick)` is `null` until the player actually
//     chooses Mystery Day, so nothing is fetched for a mode nobody is
//     playing.
//   - `useMysteryReveal(sessionId)` is `null` until a session has
//     genuinely settled. Until then there is no request for
//     `/api/beat-the-bench/mystery/reveal`, and therefore no date
//     anywhere in the client: not rendered, not in component state, not
//     in a fetch cache, not in the network log. That is what makes the
//     acceptance criterion checkable against a real browser rather than
//     by reading the render tree and hoping.
//
// Unlike `useTodaysCloseSession` (whose object is fetched on mount
// because the chooser card names its real date), the mystery session is
// fetched only on demand: its chooser card has nothing to say about the
// day it will hand out, so there is nothing to prefetch for.

import type { MysteryRevealResponse, MysterySessionResponse } from "./results-api";
import { useFetchResultsState, type ResultsState } from "./use-results";

/**
 * Fetches one randomly chosen pooled session, or nothing at all when
 * `pick` is `null` (the player is on the chooser, or playing the other
 * mode).
 *
 * `pick` is a monotonically increasing counter the caller bumps to ask
 * for *another* random day. It rides along in the query string purely so
 * the URL changes -- `useFetchResultsState` refetches on URL change and
 * nothing else, so without it "play another mystery day" would re-render
 * against the session already in state. The server ignores the parameter
 * entirely; each request re-picks regardless.
 */
export function useMysterySession(
  pick: number | null,
): ResultsState<MysterySessionResponse> | null {
  return useFetchResultsState<MysterySessionResponse>(
    pick === null ? null : `/api/beat-the-bench/mystery?pick=${pick}`,
  );
}

/**
 * Resolves a settled mystery session's real date -- and **only** once
 * `sessionId` is non-null, which the caller must not do before the
 * session has settled.
 *
 * Passing `null` is not "fetch it but don't show it": no request is made.
 */
export function useMysteryReveal(
  sessionId: string | null,
): ResultsState<MysteryRevealResponse> | null {
  return useFetchResultsState<MysteryRevealResponse>(
    sessionId === null
      ? null
      : `/api/beat-the-bench/mystery/reveal?id=${encodeURIComponent(sessionId)}`,
  );
}
