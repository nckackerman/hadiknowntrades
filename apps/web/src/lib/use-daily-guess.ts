"use client";

// Tracks whether the user has already guessed a given (range, date, mode)
// intraday day's result (issue #34; mode added by issue #13), backed by
// daily-guess-storage.ts so a guess persists across a reload.

import { useState } from "react";

import type { PresetRange } from "@hadiknowntrades/core";

import type { Mode } from "./mode";
import { getDailyGuess, saveDailyGuess } from "./daily-guess-storage";

interface UseDailyGuessResult {
  /** The user's stored guess for `date` under `range`, or `null` if they haven't guessed it yet. */
  guess: number | null;
  /**
   * The starting capital that was in effect when `guess` was submitted
   * (issue #15's effectiveStartingCapital at that moment), or `null`
   * alongside `guess` when nothing's been guessed yet. Lets a caller
   * rescale the guess to whatever starting capital is in effect *now* if
   * it's since changed -- see ResultsPanel.tsx's "You guessed" line.
   */
  guessStartingCapital: number | null;
  /** Records `value` (made while the prompt showed `startingCapital`) as the guess for `date` under `range` and reflects it immediately, without waiting for a re-read from storage. */
  submitGuess: (value: number, startingCapital: number) => void;
}

/**
 * Reading localStorage directly inside the `useState` initializer below
 * (rather than deferring to an effect the way HeroStat/CelebrationBurst
 * defer their own `window.matchMedia` reads -- see apps/web/CLAUDE.md's
 * "Client-side animation" note) is safe here specifically because this
 * hook is only ever used from ResultsPanel's `success` branch, which
 * never exists during a server render: useResults always starts in a
 * "loading" state and only reaches "success" after a client-only fetch
 * effect resolves (see use-results.ts), so by the time a component using
 * this hook mounts at all, hydration has already completed against a
 * loading skeleton that never touched storage. Don't reuse this hook from
 * a tree that can render during SSR without re-checking that assumption.
 *
 * `range`, `date`, or `mode` changing (the user picked a different day
 * via DaySelector, switched range tabs, or toggled long-only/long+short
 * via ModeToggle -- issue #13) is handled with the same "adjust state
 * during render when a prop changes" pattern use-results.ts already
 * established for range changes: switching any of the three must
 * re-check that exact (range, date, mode) triple's own stored guess, not
 * keep showing whatever the previous triple's guess state was -- a range
 * or mode switch that lands on the same calendar date can still carry a
 * genuinely different underlying result (see daily-guess-storage.ts's
 * own note), so it must re-prompt just as much as a date change would.
 */
export function useDailyGuess(range: PresetRange, date: string, mode: Mode): UseDailyGuessResult {
  const [tracked, setTracked] = useState({ range, date, mode });
  const [stored, setStored] = useState(() => getDailyGuess(range, date, mode));

  if (range !== tracked.range || date !== tracked.date || mode !== tracked.mode) {
    setTracked({ range, date, mode });
    setStored(getDailyGuess(range, date, mode));
  }

  function submitGuess(value: number, startingCapital: number) {
    saveDailyGuess(range, date, mode, value, startingCapital);
    setStored({ guess: value, startingCapital });
  }

  return {
    guess: stored?.guess ?? null,
    guessStartingCapital: stored?.startingCapital ?? null,
    submitGuess,
  };
}
