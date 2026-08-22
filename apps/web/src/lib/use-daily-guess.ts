"use client";

// Tracks whether the user has already guessed a given intraday day's
// result (issue #34), backed by daily-guess-storage.ts so a guess
// persists across a reload.

import { useState } from "react";

import { getDailyGuess, saveDailyGuess } from "./daily-guess-storage";

interface UseDailyGuessResult {
  /** The user's stored guess for `date`, or `null` if they haven't guessed it yet. */
  guess: number | null;
  /** Records `value` as the guess for `date` and reflects it immediately, without waiting for a re-read from storage. */
  submitGuess: (value: number) => void;
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
 * `date` changing (the user picked a different day via DaySelector) is
 * handled with the same "adjust state during render when a prop changes"
 * pattern use-results.ts already established for range changes: switching
 * days must re-check *that* day's own stored guess, not keep showing
 * whatever the previously-selected day's guess state was.
 */
export function useDailyGuess(date: string): UseDailyGuessResult {
  const [trackedDate, setTrackedDate] = useState(date);
  const [guess, setGuess] = useState<number | null>(() => getDailyGuess(date));

  if (date !== trackedDate) {
    setTrackedDate(date);
    setGuess(getDailyGuess(date));
  }

  function submitGuess(value: number) {
    saveDailyGuess(date, value);
    setGuess(value);
  }

  return { guess, submitGuess };
}
