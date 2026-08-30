// Persists a user's guess for a whole preset range's running-balance
// result (issue #91), keyed per (range, mode) pair -- built on
// local-storage.ts's defensive read/write rather than touching
// `window.localStorage` directly, so this module never has to think
// about SSR/private-browsing/disabled-storage itself.
//
// Unlike the per-day guessing this replaces (see git history's
// daily-guess-storage.ts, removed by issue #91), there is no date
// dimension here at all -- one guess covers the entire range's chained
// running balance, not any individual day within it. Keying on mode
// (issue #13) is still required for the identical reason it was for the
// per-day version: the same range can carry a genuinely different final
// chained balance depending on whether long-only or long+short is
// selected (see selectVariant in ResultsPanel.tsx), so a guess made
// under one mode must not silently satisfy the other.

import type { PresetRange } from "@hadiknowntrades/core";

import { isFiniteNumber } from "./is-finite-number";
import type { Mode } from "./mode";
import { readLocalStorage, writeLocalStorage } from "./local-storage";
import { parseJson } from "./parse-json";

// Namespaced (not just the bare range) so this can't collide with a key
// some other feature picks -- see apps/web/CLAUDE.md's localStorage note.
const KEY_PREFIX = "hikt:range-guess:";

function keyFor(range: PresetRange, mode: Mode): string {
  return `${KEY_PREFIX}${range}:${mode}`;
}

/**
 * `startingCapital` is the dollar amount the guess prompt was actually
 * showing at submission time (issue #15's effectiveStartingCapital) --
 * stored alongside the guess itself so a later starting-capital edit can
 * rescale the displayed "You guessed $X" figure the same way every other
 * dollar figure on the page rescales, instead of leaving it stuck at
 * whatever capital was in effect when the guess was made.
 */
export interface StoredRangeGuess {
  guess: number;
  startingCapital: number;
}

function isStoredRangeGuess(value: unknown): value is StoredRangeGuess {
  if (typeof value !== "object" || value === null) return false;
  const { guess, startingCapital } = value as Record<string, unknown>;
  return (
    isFiniteNumber(guess) && guess >= 0 && isFiniteNumber(startingCapital) && startingCapital > 0
  );
}

/**
 * The user's previously-submitted guess for `range` under `mode` (and the
 * starting capital it was made against), or `null` if they haven't
 * guessed that (range, mode) pair yet -- including if storage is
 * unavailable, or holds a value that doesn't parse as a well-formed
 * guess (a corrupt/hand-edited value should read the same as "never
 * guessed", not throw or render nonsense).
 */
export function getRangeGuess(range: PresetRange, mode: Mode): StoredRangeGuess | null {
  const parsed = parseJson(readLocalStorage(keyFor(range, mode)));
  return isStoredRangeGuess(parsed) ? parsed : null;
}

/** Records `guess` (made while the prompt showed `startingCapital`) as the user's guess for `range`/`mode`, overwriting any previous guess for that same pair. */
export function saveRangeGuess(
  range: PresetRange,
  mode: Mode,
  guess: number,
  startingCapital: number,
): void {
  const stored: StoredRangeGuess = { guess, startingCapital };
  writeLocalStorage(keyFor(range, mode), JSON.stringify(stored));
}
