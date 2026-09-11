// Range-keyed browser storage for The Cut -- the same two-layer
// localStorage pattern every prior feature in this app builds on (see
// apps/web/CLAUDE.md's "localStorage pattern"): every read/write goes
// through local-storage.ts's defensive helpers, this module owns one
// namespaced key prefix and its own JSON shapes, and anything that
// doesn't parse as well-formed reads as "nothing stored" rather than
// throwing.
//
// **Keyed by PresetRange, not by any date** -- The Cut is explicitly not
// a daily-rotating puzzle (docs/design/the-cut-2026-09/README.md's own
// "Naming and scope" section: "daily rotation/streak-reset mechanics tied
// to a calendar day" is out of scope for v1). A player can replay any
// range at any time; the in-progress/finished state for each of the 6
// PRESET_RANGES is simply whatever that range's own key currently holds.
//
// **Streak/history follows order-storage.ts's own precedent exactly**:
// currentStreak/bestStreak are *derived* from a persisted, bounded
// history of completed games on every read, never stored as their own
// number -- the same "a stale or hand-edited stored streak could disagree
// with the very games it claims to summarise" reasoning that file's own
// header comment gives. Unlike a daily puzzle's one-entry-per-date
// history, a completed Cut game has no date identity of its own (a
// player can replay the same range many times in one sitting) -- so the
// history is just a plain ascending list, one entry per completed game,
// with no de-dup key at all.

import type { PresetRange } from "@hadiknowntrades/core";

import { readLocalStorage, writeLocalStorage } from "./local-storage";
import { parseJson } from "./parse-json";
import { isFiniteNumber } from "./is-finite-number";

const KEY_PREFIX = "hikt:the-cut:";
const GAME_KEY_PREFIX = `${KEY_PREFIX}game:`;
const HISTORY_KEY = `${KEY_PREFIX}history`;

function gameKeyFor(range: PresetRange): string {
  return `${GAME_KEY_PREFIX}${range}`;
}

function isNumberArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((entry) => isFiniteNumber(entry));
}

/** One range's in-progress or finished game state. */
export interface CutGameState {
  /** Every guess submitted so far this game, oldest first. */
  guesses: number[];
  /** True once the player guessed exactly right, or ran out of attempts. */
  done: boolean;
  /** Only meaningful once `done` -- true iff the final guess was exact. */
  won: boolean;
}

function isCutGameState(value: unknown): value is CutGameState {
  if (typeof value !== "object" || value === null) return false;
  const { guesses, done, won } = value as Record<string, unknown>;
  return isNumberArray(guesses) && typeof done === "boolean" && typeof won === "boolean";
}

/** The stored state for `range`, or `null` if there's nothing stored yet (or storage is unavailable, or holds something malformed). */
export function getCutGameState(range: PresetRange): CutGameState | null {
  const parsed = parseJson(readLocalStorage(gameKeyFor(range)));
  return isCutGameState(parsed) ? parsed : null;
}

/** Persists `state` for `range`, write-through -- overwrites whatever was there before, including a finished game (see clearCutGameState for starting a fresh one deliberately). */
export function saveCutGameState(range: PresetRange, state: CutGameState): boolean {
  return writeLocalStorage(gameKeyFor(range), JSON.stringify(state));
}

/** Resets `range` back to a fresh, unplayed game -- how "play again" is implemented (there's no daily lock to respect, so replaying is always allowed). */
export function clearCutGameState(range: PresetRange): boolean {
  return saveCutGameState(range, { guesses: [], done: false, won: false });
}

/** One completed game's outcome, kept in the persisted streak history. */
export interface CutCompletedGame {
  range: PresetRange;
  won: boolean;
  /** The final guess's own % of the available edge captured -- kept alongside `won` so a future UI could show more than a win/loss streak without a storage-format change. */
  edgeCapturedPct: number;
}

function isCutCompletedGame(value: unknown): value is CutCompletedGame {
  if (typeof value !== "object" || value === null) return false;
  const { range, won, edgeCapturedPct } = value as Record<string, unknown>;
  return typeof range === "string" && typeof won === "boolean" && isFiniteNumber(edgeCapturedPct);
}

/** Same order of magnitude as order-storage.ts's own MAX_STORED_ORDER_DAYS -- a generous, non-restrictive bound; the streak stat only ever reads the tail. */
export const MAX_STORED_CUT_GAMES = 400;

/** The persisted completed-game history, ascending -- any entry that doesn't parse is dropped rather than failing the whole read. */
export function getCutGameHistory(): CutCompletedGame[] {
  const parsed = parseJson(readLocalStorage(HISTORY_KEY));
  if (typeof parsed !== "object" || parsed === null) return [];
  const { games } = parsed as Record<string, unknown>;
  if (!Array.isArray(games)) return [];
  return games.filter(isCutCompletedGame);
}

function saveCutGameHistory(games: readonly CutCompletedGame[]): boolean {
  const trimmed = games.slice(-MAX_STORED_CUT_GAMES);
  return writeLocalStorage(HISTORY_KEY, JSON.stringify({ games: trimmed }));
}

/**
 * Appends one completed game to the persisted history -- unlike
 * order-storage.ts's recordOrderCompletion (idempotent per date, since a
 * daily puzzle can only finish once), this always appends: a completed
 * Cut game has no date identity, and replaying the same range is a
 * genuinely new game each time, not a re-render of the same one. Callers
 * (use-cut-game.ts) are responsible for calling this exactly once per
 * completed game -- the moment `done` first goes true.
 */
export function recordCutCompletion(
  range: PresetRange,
  won: boolean,
  edgeCapturedPctValue: number,
): boolean {
  const existing = getCutGameHistory();
  return saveCutGameHistory([...existing, { range, won, edgeCapturedPct: edgeCapturedPctValue }]);
}

export interface CutStreakStats {
  currentStreak: number;
  bestStreak: number;
}

/** Rolls a completed-game history (ascending) up into streak stats -- mirrors order-storage.ts's own computeOrderStreak exactly (a trailing run of wins from the most recent end, and the longest such run anywhere in the history). */
export function computeCutStreak(history: readonly CutCompletedGame[]): CutStreakStats {
  let currentStreak = 0;
  let bestStreak = 0;
  for (const game of history) {
    if (game.won) {
      currentStreak += 1;
      if (currentStreak > bestStreak) bestStreak = currentStreak;
    } else {
      currentStreak = 0;
    }
  }
  return { currentStreak, bestStreak };
}
