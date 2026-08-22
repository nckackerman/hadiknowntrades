// Persists a user's guess for one intraday day's result (issue #34),
// keyed per (range, calendar date) pair -- built on local-storage.ts's
// defensive read/write rather than touching `window.localStorage`
// directly, so this module never has to think about SSR/private-
// browsing/disabled-storage itself.
//
// Keying on range as well as date matters because the same calendar
// date can genuinely carry a different intraday result depending on
// which range you're viewing it under: 1M and 3M each layer their own
// granularity override (1-minute and 5-minute bars respectively) on
// top of the shared 60-minute base, merged independently per date (see
// apps/pipeline's buildIntradayResults/mergeDaysByGranularity), so
// endingBalance/trades/barIntervalMinutes for a given date can differ
// across 1M/3M/1Y. A guess keyed by date alone would silently skip the
// guess-gate on a range switch that lands on the same date -- see
// apps/web/CLAUDE.md's "Daily guessing game" note.

import type { PresetRange } from "@hadiknowntrades/core";

import { readLocalStorage, writeLocalStorage } from "./local-storage";

// Namespaced (not just the bare date) so this can't collide with a key
// some other feature picks -- see apps/web/CLAUDE.md's localStorage note.
const KEY_PREFIX = "hikt:daily-guess:";

function keyFor(range: PresetRange, date: string): string {
  return `${KEY_PREFIX}${range}:${date}`;
}

interface StoredGuess {
  guess: number;
}

function isStoredGuess(value: unknown): value is StoredGuess {
  if (typeof value !== "object" || value === null) return false;
  const guess = (value as Record<string, unknown>).guess;
  return typeof guess === "number" && Number.isFinite(guess) && guess >= 0;
}

/**
 * The user's previously-submitted guess for `date` under `range`, or
 * `null` if they haven't guessed that (range, date) pair yet --
 * including if storage is unavailable, or holds a value that doesn't
 * parse as a well-formed guess (a corrupt/hand-edited value -- e.g. a
 * negative guess no real form submission could produce -- should read
 * the same as "never guessed", not throw or render nonsense).
 */
export function getDailyGuess(range: PresetRange, date: string): number | null {
  const raw = readLocalStorage(keyFor(range, date));
  if (raw === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  return isStoredGuess(parsed) ? parsed.guess : null;
}

/** Records `guess` as the user's guess for `date` under `range`, overwriting any previous guess for that same (range, date) pair. */
export function saveDailyGuess(range: PresetRange, date: string, guess: number): void {
  const stored: StoredGuess = { guess };
  writeLocalStorage(keyFor(range, date), JSON.stringify(stored));
}
