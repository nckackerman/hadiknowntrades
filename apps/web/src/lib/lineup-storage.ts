// Date-keyed browser storage for The Lineup (issue #208): a completed
// day's result, plus a rolling win/loss history used to derive a streak.
//
// Follows this app's established two-layer localStorage pattern (see
// apps/web/CLAUDE.md's "localStorage pattern"): every read/write goes
// through local-storage.ts's defensive helpers, this module owns one
// namespaced key prefix and its own JSON shapes, and anything that
// doesn't parse as a well-formed value reads as "nothing stored" rather
// than throwing. The `"use client"` hook layer over this lives in
// TheLineup.tsx itself, not this file.
//
// **`hikt:the-lineup:{date}`, per issue #208's own Scope wording** -- one
// entry per completed day, matching call-board-storage.ts's own per-day
// pick keying (`hikt:call-board:pick:{date}`) for the identical reason:
// this is a genuinely date-keyed mechanic (one puzzle per real trading
// day), not a single "the current state" record the way
// range-guess-storage.ts's whole-range guess is. `hikt:the-lineup:history`
// (below) can never collide with a real per-day key -- every per-day key
// is a `YYYY-MM-DD` date string, and "history" is not one.

import { readLocalStorage, writeLocalStorage } from "./local-storage";

const KEY_PREFIX = "hikt:the-lineup:";
const HISTORY_KEY = `${KEY_PREFIX}history`;

/**
 * How many days of win/loss outcomes are kept for the streak computation
 * below. Mirrors call-board-storage.ts's own MAX_STORED_RESOLVED_CALLS
 * magnitude (roughly a season's worth of daily play), scaled down since
 * this mechanic produces at most one entry per day (not up to
 * MAX_OPEN_CALLS per day the way Call Board's own history can).
 */
export const MAX_STORED_LINEUP_HISTORY = 90;

export type LineupOutcome = "won" | "lost";

function resultKeyFor(date: string): string {
  return `${KEY_PREFIX}${date}`;
}

function parseJson(raw: string | null): unknown {
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function isLineupOutcome(value: unknown): value is LineupOutcome {
  return value === "won" || value === "lost";
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * One completed day's Lineup result -- everything TheLineup.tsx's own
 * post-game state needs to render without replaying the board, and
 * everything the recap line (lib/daily-ritual.ts) needs to describe the
 * outcome without leaking which tickers were involved.
 *
 * `totalTiles` (the sum of the day's 5 real ticker lengths, 15-20) is
 * stored here rather than recomputed from a fresh LineupResult fetch --
 * it's derived from data that's already public the moment a round is
 * submitted (see TheLineup.tsx), so storing it costs nothing and lets a
 * caller (the recap) describe "T of {totalTiles} tiles filled" without
 * needing network access at all.
 */
export interface LineupPlayedResult {
  date: string;
  outcome: LineupOutcome;
  /** How many rounds were actually submitted before the game ended -- at most LINEUP_MAX_ATTEMPTS. */
  guessesUsed: number;
  /** How many of the 5 columns were correctly solved (locked). */
  columnsSolved: number;
  /** How many of the real answer tiles (across all 5 columns) were correctly filled in when the game ended. */
  tilesFilled: number;
  /** The sum of the day's 5 real ticker lengths -- what `tilesFilled` is out of. */
  totalTiles: number;
  /**
   * Per-column, whether that column was actually solved by the player --
   * needed to correctly reconstruct the final grid's own exact-vs-revealed
   * styling on a return visit (a lost game with 2 of 5 solved needs to
   * show *which* 2, not just the count) without persisting the full
   * letter-by-letter guess history.
   */
  lockedColumns: boolean[];
}

function isLineupPlayedResult(value: unknown): value is LineupPlayedResult {
  if (typeof value !== "object" || value === null) return false;
  const { date, outcome, guessesUsed, columnsSolved, tilesFilled, totalTiles, lockedColumns } =
    value as Record<string, unknown>;
  return (
    typeof date === "string" &&
    date.length > 0 &&
    isLineupOutcome(outcome) &&
    isFiniteNumber(guessesUsed) &&
    isFiniteNumber(columnsSolved) &&
    isFiniteNumber(tilesFilled) &&
    isFiniteNumber(totalTiles) &&
    Array.isArray(lockedColumns) &&
    lockedColumns.every((v) => typeof v === "boolean")
  );
}

/**
 * `date`'s played result, or `null` if it hasn't been played yet (or
 * storage is unavailable, or holds something malformed -- a hand-edited
 * or stale-format value is exactly as untrusted as one that was never
 * written, per this app's established localStorage convention).
 */
export function getLineupPlayedResult(date: string): LineupPlayedResult | null {
  const parsed = parseJson(readLocalStorage(resultKeyFor(date)));
  return isLineupPlayedResult(parsed) ? parsed : null;
}

interface HistoryEntry {
  date: string;
  outcome: LineupOutcome;
}

function isHistoryEntry(value: unknown): value is HistoryEntry {
  if (typeof value !== "object" || value === null) return false;
  const { date, outcome } = value as Record<string, unknown>;
  return typeof date === "string" && date.length > 0 && isLineupOutcome(outcome);
}

/**
 * The persisted win/loss history, ascending by date -- kept as its own
 * small object (not re-derived by scanning every `hikt:the-lineup:{date}`
 * key) so computing a streak never needs to enumerate localStorage's own
 * keyspace, which no other feature in this app does today. Mirrors
 * call-board-storage.ts's own `getResolvedCalls`/`HISTORY_KEY` shape.
 */
function getHistory(): HistoryEntry[] {
  const parsed = parseJson(readLocalStorage(HISTORY_KEY));
  if (typeof parsed !== "object" || parsed === null) return [];
  const { resolved } = parsed as Record<string, unknown>;
  if (!Array.isArray(resolved)) return [];
  return resolved.filter(isHistoryEntry);
}

function saveHistory(entries: readonly HistoryEntry[]): void {
  const trimmed = entries.slice(-MAX_STORED_LINEUP_HISTORY);
  writeLocalStorage(HISTORY_KEY, JSON.stringify({ resolved: trimmed }));
}

/**
 * Saves a completed day's result -- idempotent per date: replaying the
 * same day (e.g. a page reload right after finishing) overwrites both
 * the per-day record and its history entry, never duplicates either.
 * Returns whether the per-day write succeeded (the history write is
 * best-effort on top of that, same as call-board-storage.ts's own
 * `saveCallBoardPick`/history split).
 */
export function saveLineupPlayedResult(result: LineupPlayedResult): boolean {
  const wrote = writeLocalStorage(resultKeyFor(result.date), JSON.stringify(result));
  if (!wrote) return false;

  const withoutToday = getHistory().filter((entry) => entry.date !== result.date);
  const merged = [...withoutToday, { date: result.date, outcome: result.outcome }].sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : 0,
  );
  saveHistory(merged);
  return true;
}

export interface LineupStreak {
  currentStreak: number;
  bestStreak: number;
}

const EMPTY_STREAK: LineupStreak = { currentStreak: 0, bestStreak: 0 };

/**
 * Consecutive-days-solved streak (spec-the-lineup.md's own definition:
 * "consecutive days the player fully solved all 5 columns within
 * budget"), derived from the persisted history on every read rather than
 * stored -- the same "a stale stored figure could disagree with the
 * history it claims to summarise" reasoning call-board-storage.ts's own
 * `syncCallBoard` doc comment gives for computing CallBoardStats fresh
 * every time.
 *
 * **Reset on any loss, with no gap/trading-day-continuity check** -- the
 * identical, simpler convention `call-board-scoring.ts`'s own
 * `computeCallBoardStats` already establishes for this app's other daily
 * streak (walk the history in date order, reset `currentStreak` to 0 on
 * anything short of a win), not a stricter definition invented fresh
 * here. A day the player never played at all leaves no history entry, so
 * it neither breaks nor extends a streak by omission -- only an actual
 * loss resets it.
 */
export function computeLineupStreak(): LineupStreak {
  const history = getHistory();
  if (history.length === 0) return EMPTY_STREAK;

  let currentStreak = 0;
  let bestStreak = 0;
  for (const entry of history) {
    if (entry.outcome === "won") {
      currentStreak += 1;
      if (currentStreak > bestStreak) bestStreak = currentStreak;
    } else {
      currentStreak = 0;
    }
  }
  return { currentStreak, bestStreak };
}
