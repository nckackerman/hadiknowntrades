// Persists a user's guess for one intraday day's result (issue #34),
// keyed per (range, calendar date, mode) triple -- built on
// local-storage.ts's defensive read/write rather than touching
// `window.localStorage` directly, so this module never has to think
// about SSR/private-browsing/disabled-storage itself.
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
//
// Keying on mode too (issue #13) is the identical argument applied one
// axis further: the same (range, date) can now carry a genuinely
// different endingBalance depending on whether long-only or long+short
// is selected (see selectVariant in ResultsPanel.tsx) -- without this, a
// guess submitted under mode=long would incorrectly satisfy the
// guess-gate for the same (range, date) under mode=long-short too,
// skipping straight to a reveal the user never actually guessed against.

import type { PresetRange } from "@hadiknowntrades/core";

import type { Mode } from "./mode";
import { readLocalStorage, writeLocalStorage } from "./local-storage";

// Namespaced (not just the bare date) so this can't collide with a key
// some other feature picks -- see apps/web/CLAUDE.md's localStorage note.
const KEY_PREFIX = "hikt:daily-guess:";

function keyFor(range: PresetRange, date: string, mode: Mode): string {
  return `${KEY_PREFIX}${range}:${date}:${mode}`;
}

/**
 * The pre-issue-#13 two-part key format (`range:date`, no mode segment)
 * -- every guess submitted before this PR's mode toggle shipped is
 * sitting at this key, not the new three-part one. Only ever consulted
 * as a fallback for `mode === "long"` (see getDailyGuess) -- "long" is
 * the one mode that existed before this issue, so it's the only mode a
 * pre-existing entry could possibly satisfy; "long-short" is entirely
 * new with this issue and never had an old-format entry to fall back to.
 */
function legacyKeyFor(range: PresetRange, date: string): string {
  return `${KEY_PREFIX}${range}:${date}`;
}

/**
 * `startingCapital` is the dollar amount the guess prompt was actually
 * showing at submission time (issue #15's effectiveStartingCapital, not
 * necessarily the raw precomputed one) -- stored alongside the guess
 * itself so a later starting-capital edit can rescale the displayed "You
 * guessed $X" figure the same way every other dollar figure on the page
 * rescales, instead of leaving it stuck at whatever capital was in
 * effect when the guess was made. See ResultsPanel.tsx's own comment at
 * its "You guessed" line for the full story.
 */
export interface StoredGuess {
  guess: number;
  startingCapital: number;
}

function isStoredGuess(value: unknown): value is StoredGuess {
  if (typeof value !== "object" || value === null) return false;
  const { guess, startingCapital } = value as Record<string, unknown>;
  return (
    typeof guess === "number" &&
    Number.isFinite(guess) &&
    guess >= 0 &&
    typeof startingCapital === "number" &&
    Number.isFinite(startingCapital) &&
    startingCapital > 0
  );
}

/** Shared JSON-parse-then-validate step behind both the new-key and legacy-key reads in getDailyGuess -- a parse failure or a wrong-shaped value reads as "nothing stored" either way (see getDailyGuess's own doc comment). */
function parseStoredGuess(raw: string): StoredGuess | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return isStoredGuess(parsed) ? parsed : null;
}

/**
 * The user's previously-submitted guess for `date` under `range` and
 * `mode` (and the starting capital it was made against), or `null` if
 * they haven't guessed that (range, date, mode) triple yet -- including
 * if storage is unavailable, or holds a value that doesn't parse as a
 * well-formed guess (a corrupt/hand-edited value -- e.g. a negative guess
 * or a non-positive startingCapital, neither of which any real form
 * submission could produce -- should read the same as "never guessed",
 * not throw or render nonsense).
 *
 * **Legacy-key fallback (issue #13's mode toggle changed `keyFor` from a
 * two-part `range:date` key to a three-part `range:date:mode` key, with
 * no migration).** A user who guessed before this PR deployed has their
 * entry sitting at the old `hikt:daily-guess:{range}:{date}` key; without
 * this fallback, a lookup at the new `hikt:daily-guess:{range}:{date}:long`
 * key would find nothing and silently re-prompt them for a day they
 * already answered, permanently orphaning the old entry (found in code
 * review, real bug -- not hypothetical: this is exactly what happens to
 * every existing guess on deploy day otherwise). Only applies for `mode
 * === "long"` -- see legacyKeyFor's own doc comment for why that's the
 * one mode an old-format entry could ever satisfy. A hit at the new key
 * always wins outright (this fallback is never consulted once it does).
 */
export function getDailyGuess(range: PresetRange, date: string, mode: Mode): StoredGuess | null {
  const raw = readLocalStorage(keyFor(range, date, mode));
  if (raw !== null) return parseStoredGuess(raw);

  if (mode === "long") {
    const legacyRaw = readLocalStorage(legacyKeyFor(range, date));
    if (legacyRaw !== null) return parseStoredGuess(legacyRaw);
  }

  return null;
}

/** Records `guess` (made while the prompt showed `startingCapital`) as the user's guess for `date` under `range`/`mode`, overwriting any previous guess for that same (range, date, mode) triple. */
export function saveDailyGuess(
  range: PresetRange,
  date: string,
  mode: Mode,
  guess: number,
  startingCapital: number,
): void {
  const stored: StoredGuess = { guess, startingCapital };
  writeLocalStorage(keyFor(range, date, mode), JSON.stringify(stored));
}
