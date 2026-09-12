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
// **`OrderDayState`'s own shape has changed twice now, once per
// mechanic redesign (see order-scoring.ts's own top-of-file note for
// the full "why" of both):**
//
// 1. The original issue #207 Mastermind mechanic tracked an `attempt`
//    counter, a full `history` of past submissions, and a per-slot
//    `locked` array.
// 2. The first redesign (one free rearrange-then-submit round, no
//    second chance) dropped all of that down to just `guess`/`done`/
//    `won`/`feedback` -- a single real submission per day.
// 3. **This shape, the second redesign (direct user request -- multi-
//    guess with per-slot locking, no attempt cap)**: `guess` is still
//    the current arrangement, `feedback` is still this puzzle's most
//    recent per-slot grading (`null` until the first submission, or if
//    the day ended via a bail-out reveal instead) -- but `done` no
//    longer becomes `true` on every submit. It's now `true` only once
//    every slot is locked correct (a real win) or the player bails out
//    with a reveal, and a new `attempts` field counts how many real
//    submissions have been made so far (no cap enforced anywhere --
//    see order-scoring.ts's own top-of-file note for why). A slot's own
//    "locked" status is deliberately **not** persisted as its own field
//    -- see order-scoring.ts's exported `lockedSlots`, which derives it
//    fresh from `feedback` every time it's needed (a locked slot's own
//    guess never moves again, so it can only ever keep re-grading
//    "correct").
//
// **Migration/fallback choice for a stored blob written before this
// change: safe fallback, not a migration.** A pre-this-redesign stored
// value (shape 1 or shape 2 above) simply fails `isOrderDayState`'s
// shape check below -- shape 2's own `{guess, done, won, feedback}`
// object has no `attempts` field at all, and `attempts` is required
// here -- so it reads as "nothing stored" and the player gets a fresh
// day, exactly the same graceful degradation this file's own prior
// redesign already established for this exact class of change (see
// this repo's own git history for that version of this comment) and
// the same shape-check-or-fallback pattern call-board-storage.ts uses
// (no schema-version field there either -- confirmed by reading that
// file before making this call, per this change's own instructions).
// No migration was written for the same reason it wasn't needed last
// time: any player who already finished today's puzzle under the old
// mechanic already has their real win/loss recorded in the streak
// history below (a separate key, untouched by this shape change), so
// `recordOrderCompletion`'s own per-date idempotency means a fresh
// replay after this deploy can't double-count a streak entry even if
// it happens to occur -- see that function's own doc comment.
//
// **Streak tracking follows CallBoard.tsx's own shape exactly**, and is
// completely unaffected by either mechanic redesign above: `currentStreak`/
// `bestStreak` are *derived* from a persisted, bounded history on every
// read, never stored as their own numbers -- the same "a stale or
// hand-edited stored streak could disagree with the very days it claims
// to summarise" reasoning call-board-storage.ts's own `syncCallBoard`
// doc comment already gives for computing stats fresh every time. A win
// counts once the day is eventually fully solved, regardless of how many
// submissions it took to get there (this game is not scored on attempt
// efficiency -- see order-scoring.ts's own top-of-file note) -- the
// reasonable default this change's own instructions confirmed rather
// than asked to re-derive.

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
  /** The current editable arrangement -- ticker codes, one per slot, best mover (slot 0) to worst (last slot). A locked slot's own entry (see order-scoring.ts's exported `lockedSlots`) never changes again. */
  guess: string[];
  /** This puzzle's most recent per-slot grading, from the last real submission -- `null` before the first submission, or if the day ended via a bail-out reveal instead of a real submission (there's nothing to grade in that case). A locked slot's own entry here is always "correct" and stays that way forever, since its guess never moves again. */
  feedback: OrderFeedback[] | null;
  /** How many real submissions have been made so far -- 0 before the first one. No cap is enforced anywhere; this is purely informational (shown in the tile/panel status line), not a limit. */
  attempts: number;
  /** True once every slot is locked correct (a full win) or the player bailed out with a reveal. */
  done: boolean;
  /** Only meaningful once `done` -- true iff the day ended via a full solve rather than a reveal. */
  won: boolean;
}

function isOrderDayState(value: unknown, slotCount: number): value is OrderDayState {
  if (typeof value !== "object" || value === null) return false;
  const { guess, feedback, attempts, done, won } = value as Record<string, unknown>;
  return (
    isStringArray(guess, slotCount) &&
    (feedback === null || isOrderFeedbackArray(feedback, slotCount)) &&
    typeof attempts === "number" &&
    Number.isInteger(attempts) &&
    attempts >= 0 &&
    typeof done === "boolean" &&
    typeof won === "boolean"
  );
}

/** Today's stored game state for `date`, or `null` if there's nothing stored yet (or storage is unavailable, or holds something malformed -- including a pre-redesign, differently-shaped value from either mechanic before this one). */
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
