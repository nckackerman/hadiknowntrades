"use client";

// Client-side fetch of GET /api/results?range=... (see
// ../app/api/results/route.ts) as a small state machine, so components
// only have to switch on `state.status` instead of juggling
// loading/error/data booleans by hand.

import { useEffect, useState } from "react";

import type { PrecomputedResult, PresetRange } from "@hadiknowntrades/core";

/** The shape of every error response from /api/results -- see route.ts's errorResponse(). */
interface ApiErrorBody {
  error: string;
  message: string;
}

export type ResultsState =
  | { status: "loading" }
  | { status: "error"; httpStatus: number; error: string; message: string }
  | { status: "success"; data: PrecomputedResult };

function isApiErrorBody(value: unknown): value is ApiErrorBody {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>).error === "string" &&
    typeof (value as Record<string, unknown>).message === "string"
  );
}

/**
 * Fetches the precomputed result for `range` and tracks it as a
 * loading/error/success state, re-fetching whenever `range` changes.
 * Ignores results from a stale in-flight request if `range` changes
 * again before it resolves (a fast double-click on the range selector
 * must not let an earlier response clobber a later one).
 */
export function useResults(range: PresetRange): ResultsState {
  const [trackedRange, setTrackedRange] = useState(range);
  const [state, setState] = useState<ResultsState>({ status: "loading" });

  // Reset to "loading" the moment `range` changes, during render rather
  // than in the effect below -- React's own "adjusting state when a
  // prop changes" pattern. Calling setState synchronously as the first
  // thing an effect does triggers an avoidable extra render (and trips
  // the react-hooks/set-state-in-effect lint); this way the reset and
  // the render that shows it happen together.
  if (range !== trackedRange) {
    setTrackedRange(range);
    setState({ status: "loading" });
  }

  useEffect(() => {
    let cancelled = false;

    fetch(`/api/results?range=${range}`)
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

        const data = (await response.json()) as PrecomputedResult;
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
  }, [range]);

  return state;
}
