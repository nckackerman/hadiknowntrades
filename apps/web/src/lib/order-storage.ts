// Date-keyed browser storage for The Order (issue #207): today's
// in-progress/finished game state, plus a persisted streak history --
// the same two-layer localStorage pattern every prior feature in this
// app builds on (see apps/web/CLAUDE.md's "localStorage pattern"): every
// read/write goes through local-storage.ts's defensive helpers, this
// module owns one namespaced key prefix and its own JSON shapes, and
// anything that doesn't parse as well-formed reads as "nothing stored"
// rather than throwing.
//
// **Keyed by the puzzle's own real date** (TheOrderPuzzle.date -- "the
// most recent real trading day," the same concept
// beat-the-bench-storage.ts's own TodaysCloseSession.date keys against),
// not the viewer's local calendar day -- mirroring that established
// precedent rather than inventing a second "what day is it" concept.
//
// **Streak tracking follows CallBoard.tsx's own shape exactly** (per
// spec-the-order.md's own "Retention mechanic recommendation": "The
// Order should follow The Call Board's shape exactly"): `currentStreak`/
// `bestStreak` are *derived* from a persisted, bounded history on every
// read, never stored as their own numbers -- the same "a stale or
// hand-edited stored streak could disagree with the very days it claims
// to summarise" reasoning call-board-storage.ts's own `syncCallBoard`
// doc comment already gives for computing stats fresh every time.

import { readLocalStorage, writeLocalStorage } from "./local-storage";
import type { OrderFeedback } from "./order-scoring";

const KEY_PREFIX = "hikt:the-order:";
const DAY_KEY_PREFIX = `${KEY_PREFIX}day:`;
const STREAK_HISTORY_KEY = `${KEY_PREFIX}streak-history`;

function dayKeyFor(date: string): string {
  return `${DAY_KEY_PREFIX}${date}`;
}

function parseJson(raw: string | null): unknown {
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function isStringArray(value: unknown, length: number): value is string[] {
  return (
    Array.isArray(value) &&
    value.length === length &&
    value.every((entry) => typeof entry === "string" && entry.length > 0)
  );
}

function isBooleanArray(value: unknown, length: number): value is boolean[] {
  return (
    Array.isArray(value) &&
    value.length === length &&
    value.every((entry) => typeof entry === "boolean")
  );
}

function isOrderFeedbackArray(value: unknown, length: number): value is OrderFeedback[] {
  return (
    Array.isArray(value) &&
    value.length === length &&
    value.every((entry) => entry === "exact" || entry === "close" || entry === "far")
  );
}

/** One past submitted attempt, in the day's history strip. */
export interface OrderHistoryEntry {
  guess: string[];
  feedback: OrderFeedback[];
}

/** Today's in-progress or finished game state for one puzzle. */
export interface OrderDayState {
  /** The current editable row -- ticker codes, in guess order. */
  guess: string[];
  /** 1-based, the attempt currently being edited (or, once `done`, the attempt count actually used). */
  attempt: number;
  /** Every submitted attempt so far, oldest first. */
  history: OrderHistoryEntry[];
  /** Per-slot lock state -- true once that slot has scored "exact" on some submitted attempt. */
  locked: boolean[];
  /** True once the puzzle is solved, out of attempts, or the player bailed out with a reveal. */
  done: boolean;
  /** Only meaningful once `done` -- true if the puzzle was solved (not just revealed/exhausted). */
  won: boolean;
}

function isOrderHistoryEntry(value: unknown, slotCount: number): value is OrderHistoryEntry {
  if (typeof value !== "object" || value === null) return false;
  const { guess, feedback } = value as Record<string, unknown>;
  return isStringArray(guess, slotCount) && isOrderFeedbackArray(feedback, slotCount);
}

function isOrderDayState(value: unknown, slotCount: number): value is OrderDayState {
  if (typeof value !== "object" || value === null) return false;
  const { guess, attempt, history, locked, done, won } = value as Record<string, unknown>;
  return (
    isStringArray(guess, slotCount) &&
    typeof attempt === "number" &&
    Number.isInteger(attempt) &&
    attempt >= 1 &&
    Array.isArray(history) &&
    history.every((entry) => isOrderHistoryEntry(entry, slotCount)) &&
    isBooleanArray(locked, slotCount) &&
    typeof done === "boolean" &&
    typeof won === "boolean"
  );
}

/** Today's stored game state for `date`, or `null` if there's nothing stored yet (or storage is unavailable, or holds something malformed). */
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
 * most recent end, and the longest such run anywhere in the history),
 * per spec-the-order.md's own instruction to follow The Call Board's
 * shape, not invent a second one.
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
