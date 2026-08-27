"use client";

// The React layer over issue #128's Call Board engine (issue #129).
//
// **This file adds no scoring, storage, or calendar logic of its own** --
// every question it answers is delegated: `syncCallBoard` for the board
// itself (including the rolling lookahead), `saveCallBoardPick` for a
// write (which is also where the after-the-open lock lives, see
// call-board-storage.ts), and `exchangeClock`/`isTradingDay` for "what day
// is it in New York, and does the market trade today?". If something here
// looks like it's re-deriving one of those, it's a bug.

import { useCallback, useEffect, useMemo, useState } from "react";

import type { DailyClose, PrecomputedResult } from "@hadiknowntrades/core";

import { computeCallBoardStats, type CallBucket } from "./call-board-scoring";
import { saveCallBoardPick, syncCallBoard, type CallBoardState } from "./call-board-storage";
import { exchangeClock, isTradingDay } from "./market-calendar";
import { useFetchResultsState } from "./use-results";

/**
 * Which preset range's result the SPY close series is read from.
 *
 * Any of the six would do -- `benchmarkSeries` is deliberately
 * range-independent (issue #126: the identical trailing ~90-calendar-day
 * window is stamped onto every preset result, precisely so a rolling daily
 * game doesn't inherit whichever range the viewer happens to be browsing).
 * 1W is picked because it's `ResultsPage`'s own `DEFAULT_RANGE`, so on the
 * overwhelmingly common first load this hook's request is for a URL the
 * page has already fetched and the browser can serve from its own cache
 * (`/api/results` sets a real `Cache-Control`) rather than a second
 * round-trip to S3.
 */
export const CALL_BOARD_SERIES_RANGE = "1W";

/**
 * Stable empty-series identity. Returned by `useCallBoardCloses` for every
 * non-success state so the array reference this hook hands `useCallBoard`
 * doesn't change on every render -- `useCallBoard`'s own sync effect is
 * keyed on it, and a fresh `[]` literal each render would re-sync forever.
 */
const NO_CLOSES: readonly DailyClose[] = [];

/**
 * The real SPY daily closes the board resolves against, or an empty series
 * while the fetch is in flight, if it fails, or if the stored result
 * carries `benchmarkSeries: null` (a real, valid state -- see
 * `BenchmarkSeries`' own doc comment: the nightly SPY fetch can fail).
 *
 * An empty series is a genuinely fine degraded state, not an error worth
 * surfacing: `syncCallBoard` still returns the full board from
 * localStorage plus the clock (the lookahead and the persisted resolved
 * history need no closes at all) -- only *newly* settling a day does. The
 * board stays fully playable with the network down, which is the same
 * silent-graceful-degrade posture `BenchmarkStat`'s own `null` render and
 * the OG card route's 404 already take elsewhere in this app.
 *
 * **This is how #129 obtains the series without taking a
 * `PrecomputedResult` prop**, per issue #122's standing decision that a
 * mechanic section is not a function of the hindsight result.
 */
export function useCallBoardCloses(): readonly DailyClose[] {
  const state = useFetchResultsState<PrecomputedResult>(
    `/api/results?range=${CALL_BOARD_SERIES_RANGE}`,
  );
  return useMemo(() => {
    if (state?.status !== "success") return NO_CLOSES;
    return state.data.benchmarkSeries?.closes ?? NO_CLOSES;
  }, [state]);
}

/** Everything `CallBoard.tsx` renders, in one snapshot taken against one instant. */
export interface CallBoardView {
  /** The engine's own board -- lookahead, resolved history, derived stats. */
  board: CallBoardState;
  /**
   * Whether today is a weekend or a scheduled market holiday. The board's
   * three slots are always real trading sessions either way
   * (`upcomingCallDays` skips non-trading days on its own), so this exists
   * only so the UI can say *why* the first slot isn't today.
   */
  marketClosedToday: boolean;
  /**
   * `false` on the very first render (server *and* the client's own
   * hydration render), `true` from the mount-time correction onwards.
   *
   * Callers must render nothing clock- or storage-derived while this is
   * `false` -- see `UNHYDRATED_VIEW` for why that matters here specifically.
   */
  hydrated: boolean;
}

export interface UseCallBoardResult {
  view: CallBoardView;
  /**
   * Saves a call for `date` immediately -- there is no separate "lock in"
   * step -- and re-reads the board so the new pick is reflected.
   *
   * Returns whatever `saveCallBoardPick` returned: `false` means the write
   * was refused (that session has already opened, per the engine's own
   * clock approximation) or storage itself is unavailable. Either way the
   * returned board is re-read from storage afterwards, so the UI never
   * shows a pick that didn't actually persist.
   */
  makeCall: (date: string, bucket: CallBucket) => boolean;
}

function viewFor(board: CallBoardState, now: Date): CallBoardView {
  return {
    board,
    marketClosedToday: !isTradingDay(exchangeClock(now).date),
    hydrated: true,
  };
}

/**
 * The board before the mount-time correction: no sessions, no history, no
 * stats, and explicitly `hydrated: false` so `CallBoard.tsx` renders
 * placeholder slots rather than anything derived.
 *
 * **Nothing here reads the clock, and nothing reads storage** -- a plain
 * module constant, identical on the server and on the client's own
 * hydration render, always. That's stricter than
 * `use-hydrated-local-storage-state.ts`'s pattern (which only defers the
 * *storage* read), and stricter than `CustomRangeSelector`'s precedent of
 * calling `new Date()` during render, on purpose:
 *
 * - This board's clock-derived output changes at **two boundaries a day**
 *   -- midnight and 9:30 AM in New York -- not once a month the way
 *   `customRangeAnchors`' does. A first render that read the clock would
 *   therefore genuinely mismatch whenever the server render and the
 *   client's hydration render straddle one of those instants, and 9:30 AM
 *   Eastern is a *high-traffic* moment for a stock-market page rather than
 *   an obscure one.
 * - It costs nothing visible. The correction runs in a microtask
 *   immediately after mount, before the browser paints, and the slots'
 *   placeholders are the same size as the real ones, so there's no flash
 *   and no layout shift to trade away.
 *
 * (Live-verified both halves of this: with a real clock, a
 * `next dev` page loaded under headless Chromium logged zero console
 * errors; deliberately faking *only* the client's clock -- so the server
 * really did render a different day -- reproduced React's hydration
 * mismatch on the pre-fix version of this file and produces none now.)
 */
const UNHYDRATED_VIEW: CallBoardView = {
  board: { openCalls: [], resolved: [], stats: computeCallBoardStats([]) },
  marketClosedToday: false,
  hydrated: false,
};

/**
 * Reads (and writes) The Call Board.
 *
 * `closes` must be a **stable reference** across renders that don't
 * actually change the series -- this hook's sync effect is keyed on it.
 * `useCallBoardCloses` above already guarantees that; a caller passing a
 * fresh literal would re-sync on every render.
 *
 * No `userSetRef`-style race guard is needed here, unlike
 * `use-hydrated-local-storage-state.ts`: `makeCall` writes *through* to
 * localStorage before re-reading, and the deferred hydration read goes to
 * that same synchronous store -- so a call landing in the window between
 * mount and the microtask is already visible to the microtask's own read
 * rather than being clobbered by it.
 */
export function useCallBoard(closes: readonly DailyClose[]): UseCallBoardResult {
  const [view, setView] = useState<CallBoardView>(UNHYDRATED_VIEW);

  useEffect(() => {
    // Deferred into a microtask rather than called as the effect's own
    // first statement, the same shape use-hydrated-local-storage-state.ts
    // uses to stay clear of react-hooks/set-state-in-effect.
    queueMicrotask(() => {
      const now = new Date();
      setView(viewFor(syncCallBoard(closes, now), now));
    });
  }, [closes]);

  const makeCall = useCallback(
    (date: string, bucket: CallBucket): boolean => {
      const now = new Date();
      const saved = saveCallBoardPick(date, bucket, now);
      // Re-read rather than patching `view` in place: a refused write must
      // not leave a pick on screen, and a re-read also picks up the
      // lookahead having rolled forward since the last sync.
      setView(viewFor(syncCallBoard(closes, now), now));
      return saved;
    },
    [closes],
  );

  return { view, makeCall };
}
