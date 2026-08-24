"use client";

// Tracks whether the user has already guessed a given (range, mode) pair's
// whole-range running-balance result (issue #91), backed by
// range-guess-storage.ts so a guess persists across a reload. Replaces
// use-daily-guess.ts (removed by this issue) now that guessing happens
// exactly once per range instead of once per day.

import { useState } from "react";

import type { PresetRange } from "@hadiknowntrades/core";

import type { Mode } from "./mode";
import { getRangeGuess, saveRangeGuess } from "./range-guess-storage";

interface UseRangeGuessResult {
  /** The user's stored guess for `range` under `mode`, or `null` if they haven't guessed it yet. */
  guess: number | null;
  /** The starting capital that was in effect when `guess` was submitted, or `null` alongside `guess` when nothing's been guessed yet. Lets a caller rescale the guess to whatever starting capital is in effect *now* if it's since changed. */
  guessStartingCapital: number | null;
  /** Records `value` (made while the prompt showed `startingCapital`) as the guess for `range` under `mode` and reflects it immediately, without waiting for a re-read from storage. */
  submitGuess: (value: number, startingCapital: number) => void;
}

/**
 * Reading localStorage directly inside the `useState` initializer below is
 * safe for the same reason use-daily-guess.ts's own doc comment gave: this
 * hook is only ever used from ResultsPanel's `success` branch, which never
 * exists during a server render.
 *
 * `range` or `mode` changing (the user switched range tabs, or toggled
 * long-only/long+short via ModeToggle) re-checks that pair's own stored
 * guess during render, the same "adjust state during render when a prop
 * changes" pattern use-daily-guess.ts established.
 *
 * `range === null` means custom-range mode is active (issue #11) -- this
 * hook is still called unconditionally (Rules of Hooks) from
 * ResultsPanel, but its result is never consumed in that mode (the guess
 * UI only renders inside the "intraday-daily" branch, which requires a
 * real preset range). Reads/writes nothing and always reports "never
 * guessed" when `range` is null.
 */
export function useRangeGuess(range: PresetRange | null, mode: Mode): UseRangeGuessResult {
  const [tracked, setTracked] = useState({ range, mode });
  const [stored, setStored] = useState(() => (range === null ? null : getRangeGuess(range, mode)));

  if (range !== tracked.range || mode !== tracked.mode) {
    setTracked({ range, mode });
    setStored(range === null ? null : getRangeGuess(range, mode));
  }

  function submitGuess(value: number, startingCapital: number) {
    if (range === null) return; // no-op: nothing to key a guess under outside a preset range
    saveRangeGuess(range, mode, value, startingCapital);
    setStored({ guess: value, startingCapital });
  }

  return {
    guess: stored?.guess ?? null,
    guessStartingCapital: stored?.startingCapital ?? null,
    submitGuess,
  };
}
