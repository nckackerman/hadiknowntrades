"use client";

// The daily hero's own data source (issue #161) -- fetches the exact
// same fixed `/api/results?range=1W` that `use-call-board.ts`'s
// `useCallBoardCloses()` already fetches, and for the identical reason:
// 1W is `ResultsPage`'s own `DEFAULT_RANGE`, so on the overwhelmingly
// common first load this hook's request is for a URL the page has
// already fetched and the browser can serve from its own cache
// (`/api/results` sets a real `Cache-Control`) rather than a second
// round-trip to S3. See `CALL_BOARD_SERIES_RANGE`'s own doc comment for
// the full reasoning -- not repeated here to avoid two copies drifting.
//
// Per issue #122's standing decision, a mechanic section is not a
// function of the hindsight result -- this hook is how the daily hero
// gets its own data without `ResultsPage` having to hand it a fetched
// `PrecomputedResult` directly.

import { useMemo } from "react";

import type { PrecomputedResult } from "@hadiknowntrades/core";

import { dailyChallengeFor, type DailyChallenge } from "./daily-challenge";
import type { Mode } from "./mode";
import { useFetchResultsState } from "./use-results";

/** Same range `use-call-board.ts`'s `CALL_BOARD_SERIES_RANGE` fetches, and for the identical reason -- see that constant's own doc comment. Exported so tests can reference it symbolically instead of a bare `"1W"` literal, mirroring that constant's own export. */
export const DAILY_CHALLENGE_RANGE = "1W";

export interface UseDailyChallengeResult {
  /**
   * The most recently completed trading day's own trades, replayed from
   * a fresh, date-seeded starting capital (issue #174) -- `null` while
   * the fetch is still in flight.
   */
  dailyChallenge: DailyChallenge | null;
  /**
   * `true` only while the underlying fetch is genuinely in flight --
   * distinguishes "still loading" (show a skeleton) from "loaded, but
   * genuinely nothing to show" (a fetch error, or a range with no
   * trading days yet -- both degrade to `dailyChallenge: null` forever,
   * the same silent-graceful-degrade posture `BenchmarkStat`'s own
   * `null` render and the OG card route's 404 already take elsewhere in
   * this app).
   */
  loading: boolean;
}

/**
 * The daily hero's one entry point: the most recently completed trading
 * day in `data.days` (`data.days[data.days.length - 1]`), run through
 * `dailyChallengeFor`.
 */
export function useDailyChallenge(mode: Mode): UseDailyChallengeResult {
  const state = useFetchResultsState<PrecomputedResult>(
    `/api/results?range=${DAILY_CHALLENGE_RANGE}`,
  );
  return useMemo(() => {
    if (state === null || state.status === "loading") {
      return { dailyChallenge: null, loading: true };
    }
    if (state.status !== "success" || state.data.model !== "intraday-daily") {
      return { dailyChallenge: null, loading: false };
    }
    const { days } = state.data;
    if (days.length === 0) {
      return { dailyChallenge: null, loading: false };
    }
    const mostRecentDay = days[days.length - 1]!;
    return { dailyChallenge: dailyChallengeFor(mostRecentDay, mode), loading: false };
  }, [state, mode]);
}
