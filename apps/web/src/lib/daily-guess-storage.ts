// Persists a user's guess for one intraday day's result (issue #34),
// keyed per calendar date -- built on local-storage.ts's defensive
// read/write rather than touching `window.localStorage` directly, so
// this module never has to think about SSR/private-browsing/disabled-
// storage itself.

import { readLocalStorage, writeLocalStorage } from "./local-storage";

// Namespaced (not just the bare date) so this can't collide with a key
// some other feature picks -- see apps/web/CLAUDE.md's localStorage note.
const KEY_PREFIX = "hikt:daily-guess:";

function keyFor(date: string): string {
  return `${KEY_PREFIX}${date}`;
}

interface StoredGuess {
  guess: number;
}

function isStoredGuess(value: unknown): value is StoredGuess {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>).guess === "number" &&
    Number.isFinite((value as Record<string, unknown>).guess)
  );
}

/**
 * The user's previously-submitted guess for `date`, or `null` if they
 * haven't guessed that date yet -- including if storage is unavailable, or
 * holds a value that doesn't parse as a well-formed guess (a corrupt/
 * hand-edited value should read the same as "never guessed", not throw).
 */
export function getDailyGuess(date: string): number | null {
  const raw = readLocalStorage(keyFor(date));
  if (raw === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  return isStoredGuess(parsed) ? parsed.guess : null;
}

/** Records `guess` as the user's guess for `date`, overwriting any previous guess for that same date. */
export function saveDailyGuess(date: string, guess: number): void {
  const stored: StoredGuess = { guess };
  writeLocalStorage(keyFor(date), JSON.stringify(stored));
}
