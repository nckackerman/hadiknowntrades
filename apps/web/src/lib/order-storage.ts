// Date-keyed browser storage for The Order: today's in-progress/finished
// game state, plus a persisted streak history -- the same two-layer
// localStorage pattern every prior feature in this app builds on (see
// apps/web/CLAUDE.md's "localStorage pattern"): every read/write goes
// through local-storage.ts's defensive helpers, this module owns one
// namespaced key prefix and its own JSON shapes, and anything that
// doesn't parse as well-formed reads as "nothing stored" rather than
// throwing.
//
// **Keyed by the puzzle's own real date** (TheOrderPuzzle.date -- "the
// most recent real trading day," the same concept
// beat-the-bench-storage.ts's own TodaysCloseSession.date keys against),
// not the viewer's local calendar day.
//
// **`OrderDayState`'s own shape changed with the mechanic redesign** (see
// order-scoring.ts's own top-of-file note) -- it used to track an
// `attempt` counter, a full `history` of past submissions, and a
// per-slot `locked` array (a multi-attempt Mastermind loop). The new
// one-shot mechanic needs none of that: `guess` is still the current
// arrangement, but there's only ever one real submission, so `feedback`
// (this attempt's own per-slot grading, or `null` if the day ended via
// a bail-out reveal instead) replaces the whole `history`/`locked` pair.
// A pre-redesign stored value simply fails `isOrderDayState`'s shape
// check below and reads as "nothing stored," the same graceful
// degradation this app's storage convention already gives a puzzle
// rewritten with a different ticker set (see `isPermutationOf`'s own
// doc comment in order-scoring.ts) -- no migration needed, and no
// storage-format version bump either, since a malformed/differently-
// shaped stored value has always meant "start fresh" here.
//
// **Streak tracking follows CallBoard.tsx's own shape exactly**, and is
// completely unaffected by the mechanic redesign above: `currentStreak`/
// `bestStreak` are *derived* from a persisted, bounded history on every
// read, never stored as their own numbers -- the same "a stale or
// hand-edited stored streak could disagree with the very days it claims
// to summarise" reasoning call-board-storage.ts's own `syncCallBoard`
// doc comment already gives for computing stats fresh every time.

import { readLocalStorage, writeLocalStorage } from "./local-storage";
import { parseJson } from "./parse-json";
import type { OrderFeedback } from "./order-scoring";

const KEY_PREFIX = "hikt:the-order:";
const DAY_KEY_PREFIX = `${KEY_PREFIX}day:`;
const STREAK_HISTORY_KEY = `${KEY_PREFIX}streak-history`;

function dayKeyFor(date: string): string {
  return `${DAY_KEY_PREFIX}${date}`;
}

function isStringArray(value: unknown, length: number): value is string[] {
  return (
    Array.isArray(value) &&
    value.length === length &&
    value.every((entry) => typeof entry === "string" && entry.length > 0)
  );
}

function isOrderFeedbackArray(value: unknown, length: number): value is OrderFeedback[] {
  return (
    Array.isArray(value) &&
    value.length === length &&
    value.every((entry) => entry === "correct" || entry === "incorrect")
  );
}

/** Today's in-progress or finished game state for one puzzle. */
export interface OrderDayState {
  /** The current editable arrangement -- ticker codes, one per slot, best mover (slot 0) to worst (last slot). */
  guess: string[];
  /** True once the player has submitted their one guess, or bailed out with a reveal. */
  done: boolean;
  /** Only meaningful once `done` -- true if every slot's guess matched the real ticker. */
  won: boolean;
  /** This puzzle's one real grading, from the actual submitted guess -- `null` if the day ended via a bail-out reveal instead of a real submission (there's nothing to grade in that case). */
  feedback: OrderFeedback[] | null;
}

function isOrderDayState(value: unknown, slotCount: number): value is OrderDayState {
  if (typeof value !== "object" || value === null) return false;
  const { guess, done, won, feedback } = value as Record<string, unknown>;
  return (
    isStringArray(guess, slotCount) &&
    typeof done === "boolean" &&
    typeof won === "boolean" &&
    (feedback === null || isOrderFeedbackArray(feedback, slotCount))
  );
}

/** Today's stored game state for `date`, or `null` if there's nothing stored yet (or storage is unavailable, or holds something malformed -- including a pre-redesign, differently-shaped value). */
export function getOrderDayState(date: string, slotCount: number): OrderDayState | null {
  const parsed = parseJson(readLocalStorage(dayKeyFor(date)));
  return isOrderDayState(parsed, slotCount) ? parsed : null;
}

/** Persists today's game state for `date`, write-through (the same shape every other feature's storage module uses). */
export function saveOrderDayState(date: string, state: OrderDayState): boolean {
  return writeLocalStorage(dayKeyFor(date), JSON.stringify(state));
}

/** One completed day's outcome, kept in the persisted streak history. */
export interface OrderCompletedDay {
  date: string;
  won: boolean;
}

function isOrderCompletedDay(value: unknown): value is OrderCompletedDay {
  if (typeof value !== "object" || value === null) return false;
  const { date, won } = value as Record<string, unknown>;
  return typeof date === "string" && date.length > 0 && typeof won === "boolean";
}

/**
 * How many completed days are kept, oldest dropped first -- same order of
 * magnitude as call-board-storage.ts's own MAX_STORED_RESOLVED_CALLS (a
 * generous, non-restrictive bound for a mechanic played at most once a
 * day; the streak stat only ever reads the *tail* of this history).
 */
export const MAX_STORED_ORDER_DAYS = 400;

/** The persisted streak history, ascending by date -- any entry that doesn't parse is dropped rather than failing the whole read (a partially-corrupt history should cost the entries it corrupted, not the entire record), the same discipline call-board-storage.ts's own getResolvedCalls already applies. */
export function getOrderStreakHistory(): OrderCompletedDay[] {
  const parsed = parseJson(readLocalStorage(STREAK_HISTORY_KEY));
  if (typeof parsed !== "object" || parsed === null) return [];
  const { days } = parsed as Record<string, unknown>;
  if (!Array.isArray(days)) return [];
  return days.filter(isOrderCompletedDay);
}

function saveOrderStreakHistory(days: readonly OrderCompletedDay[]): boolean {
  const trimmed = days.slice(-MAX_STORED_ORDER_DAYS);
  return writeLocalStorage(STREAK_HISTORY_KEY, JSON.stringify({ days: trimmed }));
}

/**
 * Records today's finished outcome into the persisted streak history --
 * idempotent per date, so calling this more than once for the same day
 * (e.g. a re-render after `done` is already true) never double-counts a
 * streak entry. Call exactly once, the instant a day's `done` first goes
 * true.
 */
export function recordOrderCompletion(date: string, won: boolean): boolean {
  const existing = getOrderStreakHistory();
  if (existing.some((entry) => entry.date === date)) return true; // already recorded -- no-op
  return saveOrderStreakHistory([...existing, { date, won }]);
}

export interface OrderStreakStats {
  currentStreak: number;
  bestStreak: number;
}

/**
 * Rolls a completed-day history (ascending by date) up into streak stats
 * -- pure, mirrors call-board-scoring.ts's own computeCallBoardStats
 * currentStreak/bestStreak logic exactly (a trailing run of wins from the
 * most recent end, and the longest such run anywhere in the history).
 */
export function computeOrderStreak(history: readonly OrderCompletedDay[]): OrderStreakStats {
  let currentStreak = 0;
  let bestStreak = 0;
  for (const day of history) {
    if (day.won) {
      currentStreak += 1;
      if (currentStreak > bestStreak) bestStreak = currentStreak;
    } else {
      currentStreak = 0;
    }
  }
  return { currentStreak, bestStreak };
}
