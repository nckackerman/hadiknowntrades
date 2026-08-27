"use client";

// The React layer over the daily ritual (issue #133): one snapshot of
// "today, so far", re-read whenever any of the three mechanics it
// summarises changes.
//
// **This hook owns no state of its own and writes nothing.** Every value in
// its snapshot belongs to a feature that already owns it -- Beat the
// Bench's played record, The Call Board's open picks, issue #91's
// whole-range guess -- and this is a pure reader over all three. That is
// what makes the status rail honest: there is no second copy of any of
// those flags to fall out of sync with the mechanic that owns it, and no
// way for the rail to show a step as done that the feature itself doesn't
// consider done.
//
// Staying current is delegated to local-storage.ts's own change
// notification rather than to any per-feature plumbing, since that module
// is already the single choke point every one of those writes passes
// through. See its `subscribeToLocalStorage` doc comment.

import { useEffect, useState } from "react";

import type { PresetRange } from "@hadiknowntrades/core";

import { readAnyPlayedSession } from "./beat-the-bench-storage";
import { getCallBoardPick } from "./call-board-storage";
import { MAX_OPEN_CALLS, upcomingCallDays } from "./call-board-scoring";
import type { DailyRitualSnapshot } from "./daily-ritual";
import type { HeadlineFigure } from "./headline-figure";
import { subscribeToLocalStorage } from "./local-storage";
import type { Mode } from "./mode";
import { getRangeGuess } from "./range-guess-storage";
import { useTodaysCloseSession } from "./use-todays-close-session";

export interface UseDailyRitualOptions {
  /** The active preset range, or `null` in custom start-date anchor mode -- needed to look up issue #91's guess for the right (range, mode) pair. */
  range: PresetRange | null;
  mode: Mode;
  /**
   * The figure the results page is headlining right now (see
   * headline-figure.ts), or `null` if the result hasn't loaded. Passed in
   * rather than fetched here: the page already has it, and re-fetching a
   * result to restate a number that's on screen would be a second source of
   * truth for the same figure.
   */
  headline: HeadlineFigure | null;
}

/**
 * The snapshot before the mount-time correction: nothing played, nothing
 * called, no headline. Identical on the server and on the client's own
 * hydration render, always -- a plain constant that reads neither the clock
 * nor storage, the same discipline `use-call-board.ts`'s `UNHYDRATED_VIEW`
 * keeps and for the same two reasons (the Call Board's own lookahead turns
 * over at 9:30 AM New York, and a stored record read during hydration would
 * make the client's first render disagree with the server's).
 */
const UNHYDRATED_SNAPSHOT: DailyRitualSnapshot = {
  heroSeen: true,
  bench: null,
  calls: { filled: 0, total: MAX_OPEN_CALLS },
  headline: null,
};

export interface UseDailyRitualResult {
  snapshot: DailyRitualSnapshot;
  /** `false` on the first render (server and hydration), `true` from the mount-time correction onwards. Callers must render nothing clock- or storage-derived while this is `false`. */
  hydrated: boolean;
}

/**
 * Reads the current state of today's ritual.
 *
 * `benchDate` comes from the published Today's Close session rather than
 * from the viewer's own clock, because that is what
 * `beat-the-bench-storage.ts` keys on: Today's Close replays the most
 * recently *closed* session, so on a Saturday both the game and this rail
 * mean Friday, and asking the browser what day it is would silently start a
 * second "today" over a weekend.
 */
export function useDailyRitual({
  range,
  mode,
  headline,
}: UseDailyRitualOptions): UseDailyRitualResult {
  const sessionState = useTodaysCloseSession();
  const benchDate = sessionState?.status === "success" ? sessionState.data.date : null;

  const [stored, setStored] = useState<{
    bench: DailyRitualSnapshot["bench"];
    calls: DailyRitualSnapshot["calls"];
    guessed: boolean;
  } | null>(null);

  useEffect(() => {
    function read() {
      const now = new Date();
      const openDays = upcomingCallDays(now);
      const played = benchDate === null ? null : readAnyPlayedSession(benchDate);
      setStored({
        bench:
          played === null || benchDate === null
            ? null
            : { date: benchDate, session: played.session },
        // Read straight from the pick entries rather than through
        // `syncCallBoard`: that function *writes* a freshly-resolved history
        // back, and a write from inside this read would re-enter the very
        // notification this effect subscribes to. The board's own component
        // still does the resolving; the rail only ever counts.
        calls: {
          filled: openDays.filter((date) => getCallBoardPick(date) !== null).length,
          total: openDays.length === 0 ? MAX_OPEN_CALLS : openDays.length,
        },
        guessed: range !== null && getRangeGuess(range, mode) !== null,
      });
    }

    // Deferred into a microtask rather than run as the effect's first
    // statement, the same shape use-hydrated-local-storage-state.ts uses to
    // stay clear of react-hooks/set-state-in-effect.
    queueMicrotask(read);
    return subscribeToLocalStorage(read);
  }, [benchDate, range, mode]);

  if (stored === null) return { snapshot: UNHYDRATED_SNAPSHOT, hydrated: false };

  return {
    snapshot: {
      heroSeen: true,
      bench: stored.bench,
      calls: stored.calls,
      // **The one spoiler gate this app has** (issue #91) applies to the
      // recap exactly as it applies to the share-card link: the
      // intraday-daily model's headline figure is the very number the
      // whole-range guess hides, so quoting it in a recap the player can
      // read before they've guessed would hand them the answer from inside
      // the page. The window model has no such gate -- its figure is
      // already unconditionally on screen above.
      headline:
        headline === null || (headline.model === "intraday-daily" && !stored.guessed)
          ? null
          : headline,
    },
    hydrated: true,
  };
}
