"use client";

// Client-side fetch of GET /api/results?range=... (see
// ../app/api/results/route.ts) as a small state machine, so components
// only have to switch on `state.status` instead of juggling
// loading/error/data booleans by hand.

import { useEffect, useState } from "react";

import type { PrecomputedResult, PresetRange } from "@hadiknowntrades/core";

import type { ApiErrorCode } from "./results-api";
import { useResetWhenChanged } from "./use-reset-when-changed";

/**
 * Every error code a consumer of useResults can see -- the server's own
 * ApiErrorCode (see results-api.ts), plus two purely client-side ones
 * for failure modes the server never reports itself (a response body
 * that isn't valid JSON matching the expected shape, or the fetch never
 * reaching the server at all).
 */
export type ClientErrorCode = ApiErrorCode | "unknown_error" | "network_error";

/**
 * The shape of every error response from /api/results -- see route.ts's
 * errorResponse(). Exported (along with isApiErrorBody below) so
 * use-custom-results.ts's own fetch state machine can reuse the exact
 * same error-body parsing instead of a second copy -- both hooks hit the
 * same route, just with a different query param, and share this same
 * response error shape.
 */
export interface ApiErrorBody {
  error: ApiErrorCode;
  message: string;
}

/**
 * Generic over the success payload's type (defaults to PrecomputedResult
 * for every existing caller of useResults, unchanged) so
 * use-custom-results.ts's own hook can reuse this exact same state shape
 * for CustomWindowResult instead of a parallel type.
 */
export type ResultsState<T = PrecomputedResult> =
  | { status: "loading" }
  | { status: "error"; httpStatus: number; error: ClientErrorCode; message: string }
  | { status: "success"; data: T };

export function isApiErrorBody(value: unknown): value is ApiErrorBody {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>).error === "string" &&
    typeof (value as Record<string, unknown>).message === "string"
  );
}

/**
 * The shared fetch/loading/error state machine backing both useResults
 * (?range=) and useCustomResults (?anchor=, issue #11) -- parameterized
 * over the success payload's type `T` and by an already-fully-built
 * `url` rather than by a range or anchor directly, so the two hooks
 * don't each maintain an independent copy of this same machinery (a
 * real, near-line-for-line duplication caught in code review). Ignores
 * results from a stale in-flight request if `url` changes again before
 * it resolves (a fast double-click on a selector must not let an
 * earlier response clobber a later one).
 *
 * `url === null` means "this hook isn't the active view mode right now"
 * (e.g. issue #11's custom-range mode is active instead of a preset
 * range, or vice versa -- see ResultsPage.tsx, which always has exactly
 * one of useResults/useCustomResults actually selecting something at a
 * time): no fetch is ever made, and this returns `null` rather than a
 * `"loading"` state that would never resolve.
 */
export function useFetchResultsState<T>(url: string | null): ResultsState<T> | null {
  const [state, setState] = useState<ResultsState<T> | null>(
    url === null ? null : { status: "loading" },
  );

  // Reset to "loading" (or null) the moment `url` changes, during render
  // rather than in the effect below -- React's own "adjusting state when
  // a prop changes" pattern, via the shared useResetWhenChanged helper
  // (code review, issue #96 follow-up round four -- this hand-rolled
  // `trackedUrl` companion state used to be one of six independent copies
  // of this exact idiom across the app). Calling setState synchronously
  // as the first thing an effect does triggers an avoidable extra render
  // (and trips the react-hooks/set-state-in-effect lint); this way the
  // reset and the render that shows it happen together.
  useResetWhenChanged([url], () => {
    setState(url === null ? null : { status: "loading" });
  });

  useEffect(() => {
    if (url === null) return;
    let cancelled = false;

    fetch(url)
      .then(async (response) => {
        if (cancelled) return;

        if (!response.ok) {
          const body: unknown = await response.json().catch(() => null);
          if (isApiErrorBody(body)) {
            setState({
              status: "error",
              httpStatus: response.status,
              error: body.error,
              message: body.message,
            });
          } else {
            setState({
              status: "error",
              httpStatus: response.status,
              error: "unknown_error",
              message: "The server returned an unexpected response.",
            });
          }
          return;
        }

        const data = (await response.json()) as T;
        if (!cancelled) {
          setState({ status: "success", data });
        }
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setState({
          status: "error",
          httpStatus: 0,
          error: "network_error",
          message: error instanceof Error ? error.message : "The request failed.",
        });
      });

    return () => {
      cancelled = true;
    };
  }, [url]);

  return state;
}

/**
 * Fetches the precomputed result for `range` and tracks it as a
 * loading/error/success state, re-fetching whenever `range` changes --
 * see useFetchResultsState above for the shared mechanics this
 * instantiates, and its own `url === null` doc comment for what
 * `range === null` means here.
 */
export function useResults(range: PresetRange | null): ResultsState | null {
  return useFetchResultsState<PrecomputedResult>(
    range === null ? null : `/api/results?range=${range}`,
  );
}
