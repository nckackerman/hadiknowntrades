"use client";

// Tracks whether the user has already guessed a given (range, date)
// intraday day's result (issue #34), backed by daily-guess-storage.ts
// so a guess persists across a reload.

import { useState } from "react";

import type { PresetRange } from "@hadiknowntrades/core";

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
 * `range` or `date` changing (the user picked a different day via
 * DaySelector, or switched range tabs) is handled with the same "adjust
 * state during render when a prop changes" pattern use-results.ts
 * already established for range changes: switching either must re-check
 * that exact (range, date) pair's own stored guess, not keep showing
 * whatever the previous pair's guess state was -- a range switch that
 * lands on the same calendar date can still carry a genuinely different
 * underlying result (see daily-guess-storage.ts's own note), so it must
 * re-prompt just as much as a date change would.
 *
 * `range === null` means "custom-range mode is active, not a preset
 * range" (issue #11 -- see ResultsPanel.tsx's own `range` prop, now
 * `PresetRange | null`): this hook is still called unconditionally
 * (Rules of Hooks) from ResultsPanel, but its result is never actually
 * consumed in that mode (the guess UI only ever renders inside the
 * "intraday-daily" branch, which requires a real preset range). Rather
 * than invent a placeholder PresetRange to satisfy daily-guess-storage's
 * own signature, this reads/writes nothing and always reports "never
 * guessed" when `range` is null -- there is no (range, date) pair to key
 * a guess under in that mode anyway.
 */
export function useDailyGuess(range: PresetRange | null, date: string): UseDailyGuessResult {
  const [tracked, setTracked] = useState({ range, date });
  const [stored, setStored] = useState(() => (range === null ? null : getDailyGuess(range, date)));

  if (range !== tracked.range || date !== tracked.date) {
    setTracked({ range, date });
    setStored(range === null ? null : getDailyGuess(range, date));
  }

  function submitGuess(value: number, startingCapital: number) {
    if (range === null) return; // no-op: nothing to key a guess under outside a preset range
    saveDailyGuess(range, date, value, startingCapital);
    setStored({ guess: value, startingCapital });
  }

  return {
    guess: stored?.guess ?? null,
    guessStartingCapital: stored?.startingCapital ?? null,
    submitGuess,
  };
}
