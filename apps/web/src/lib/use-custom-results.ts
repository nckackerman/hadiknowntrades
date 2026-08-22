"use client";

// Client-side fetch of GET /api/results?anchor=... (issue #11's coarsened
// custom date-range feature -- see ../app/api/results/route.ts) as the
// same small loading/error/success state machine use-results.ts already
// gives PresetRange callers. A sibling hook rather than a change to
// useResults itself: the two are only ever active one at a time on
// ResultsPage (range mode XOR anchor mode -- see ResultsPage.tsx), and
// keeping useResults's own well-tested range-only behavior untouched is
// safer than growing it into a dual-mode hook.

import { useEffect, useState } from "react";

import type { AnchorMonth, CustomWindowResult } from "@hadiknowntrades/core";

import { isApiErrorBody, type ResultsState } from "./use-results";

/**
 * Fetches the precomputed CustomWindowResult for `anchor` and tracks it
 * as a loading/error/success state, re-fetching whenever `anchor`
 * changes -- mirrors useResults's own state machine (including ignoring
 * a stale in-flight request if `anchor` changes again before it
 * resolves) with one difference: `anchor === null` means "custom-range
 * mode isn't active right now" (the page is showing a preset range
 * instead), and this hook returns `null` rather than ever fetching --
 * avoids an always-on background request for whichever mode isn't
 * currently selected.
 */
export function useCustomResults(
  anchor: AnchorMonth | null,
): ResultsState<CustomWindowResult> | null {
  const [trackedAnchor, setTrackedAnchor] = useState(anchor);
  const [state, setState] = useState<ResultsState<CustomWindowResult> | null>(
    anchor === null ? null : { status: "loading" },
  );

  // Same "adjust state during render when a prop changes" pattern
  // useResults uses for `range` -- see that file's own comment for why
  // this runs during render rather than as the first line of an effect.
  if (anchor !== trackedAnchor) {
    setTrackedAnchor(anchor);
    setState(anchor === null ? null : { status: "loading" });
  }

  useEffect(() => {
    if (anchor === null) return;
    let cancelled = false;

    fetch(`/api/results?anchor=${encodeURIComponent(anchor)}`)
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

        const data = (await response.json()) as CustomWindowResult;
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
  }, [anchor]);

  return state;
}
