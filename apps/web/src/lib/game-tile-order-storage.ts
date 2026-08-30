// Cross-day play-order history for the daily-hub game tiles (issue #196):
// "which game does this viewer tend to open first each day?"
//
// Follows this app's established two-layer localStorage pattern (see
// apps/web/CLAUDE.md's "localStorage pattern"): every read/write goes
// through local-storage.ts's defensive helpers, this module owns one
// namespaced key prefix and its own small JSON shape, and anything that
// doesn't parse as a well-formed value reads as "nothing stored" rather
// than throwing.
//
// **This is new state, not a reshuffle of something that already
// exists.** `beat-the-bench-storage.ts`/`call-board-storage.ts` each
// already know "did the viewer play *this* game today," but neither knows
// anything about the *other* tile, or about which one a viewer tends to
// touch first -- that's the whole question this module exists to answer.
// The ranking function that turns this history into a tile order lives in
// game-tile-order.ts, kept separate and pure so it's independently
// unit-testable against synthetic history with no storage involved.
//
// **Keyed by the viewer's own local calendar date, not a trading day.**
// This is a genuine, deliberate difference from beat-the-bench-storage.ts
// (keyed by the session's own trading date, e.g. Friday on a weekend) and
// call-board-storage.ts (keyed by the *called* day, which is always in
// the future). This module asks a different question -- "in what order did
// *this browser* touch the two tiles today" -- and that's a fact about the
// viewer's own day, not about any trading calendar.

import { readLocalStorage, writeLocalStorage } from "./local-storage";
import { parseJson } from "./parse-json";

/** The two playable game tiles this ranking covers. The Order/The Lineup placeholder tiles (a sibling issue) have no play state to rank by and aren't part of this type yet. */
export type GameTileId = "beat-the-bench" | "call-board";

/** Both tile ids, in this app's pre-#196 fixed order -- also the deterministic tie-break order game-tile-order.ts falls back to. */
export const GAME_TILE_IDS: readonly GameTileId[] = ["beat-the-bench", "call-board"];

function isGameTileId(value: unknown): value is GameTileId {
  return value === "beat-the-bench" || value === "call-board";
}

const KEY = "hikt:game-tile-order:history";

/**
 * How many distinct days of history are kept, oldest dropped first.
 *
 * 30 -- roughly a month of typical daily use. This mechanic only ever
 * needs a *stable* preference signal (a fraction of days), not a long
 * memory: 30 recent days is already enough to smooth out a handful of
 * atypical mornings while staying small (a couple hundred bytes) and
 * cheap to re-derive a score from on every render. Matches the order of
 * magnitude call-board-storage.ts's own MAX_STORED_RESOLVED_CALLS reasons
 * from (bounded, not unbounded, and sized to the signal actually needed
 * rather than to the origin's real storage budget).
 */
export const MAX_STORED_TILE_ORDER_DAYS = 30;

/**
 * One day's recorded tile activity: which of the two tiles the viewer
 * touched, in the order they first touched each one. `order[0]` is
 * "opened first that day"; a tile absent from `order` simply wasn't
 * touched that day at all (not "touched last").
 *
 * An array of ids per day (not just a single `firstGameId`) is what lets
 * a caller answer both questions this feature needs from the same
 * record: which game usually goes first (`order[0]`, aggregated across
 * days) *and* whether a specific game was played today at all
 * (`order.includes(gameId)`) -- the "played-today sinks" rule needs the
 * second question answered for the tile that came second today too, not
 * just the first.
 */
export interface TileOrderDay {
  /** The viewer's own local calendar date ("2026-08-27"), not a trading day -- see this module's own header comment. */
  date: string;
  /** Which tiles were touched this day, in first-touched order. Never empty (a day only gets an entry once at least one tile is recorded) and never repeats a tile. */
  order: GameTileId[];
}

function isTileOrderDay(value: unknown): value is TileOrderDay {
  if (typeof value !== "object" || value === null) return false;
  const { date, order } = value as Record<string, unknown>;
  if (typeof date !== "string" || date.length === 0) return false;
  if (!Array.isArray(order) || order.length === 0) return false;
  if (!order.every(isGameTileId)) return false;
  // No duplicate tile within one day's order -- a hand-edited/corrupt
  // entry could claim a tile was "first touched" twice.
  return new Set(order).size === order.length;
}

/**
 * The viewer's own local calendar date, as "YYYY-MM-DD" -- deliberately
 * the browser's local wall-clock day (`getFullYear`/`getMonth`/`getDate`),
 * not a UTC or exchange-timezone one, since this module tracks a fact
 * about the viewer's own day, not a trading day (see this module's own
 * header comment). Exported so callers record and rank against the exact
 * same notion of "today."
 */
export function localDateKey(now: Date): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * The persisted rolling history, ascending by date. Any entry that
 * doesn't parse as a well-formed `TileOrderDay` is dropped individually
 * rather than failing the whole read -- a partially-corrupt history
 * should cost only the entries it corrupted, matching
 * call-board-storage.ts's own `getResolvedCalls` posture.
 */
export function getTileOrderHistory(): TileOrderDay[] {
  const parsed = parseJson(readLocalStorage(KEY));
  if (typeof parsed !== "object" || parsed === null) return [];
  const { days } = parsed as Record<string, unknown>;
  if (!Array.isArray(days)) return [];
  return days.filter(isTileOrderDay);
}

function saveTileOrderHistory(days: readonly TileOrderDay[]): boolean {
  const trimmed = [...days].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return writeLocalStorage(
    KEY,
    JSON.stringify({ days: trimmed.slice(-MAX_STORED_TILE_ORDER_DAYS) }),
  );
}

/**
 * Records that `gameId` was opened/played on `date` (see `localDateKey`).
 *
 * The *first* tile touched on a day claims that day's first-touched slot;
 * a later, same-day play of the other tile is appended after it, and a
 * same-day replay of a tile already recorded that day is a no-op --
 * today's order is decided the moment each tile is first touched, not
 * re-decided on every subsequent play.
 *
 * Returns whether the write actually changed anything (a new day, or a
 * new tile appended to an existing day) -- `false` for a same-day repeat
 * of a tile already recorded, or for a genuine storage failure.
 */
export function recordGameTileOpened(gameId: GameTileId, date: string): boolean {
  const existing = getTileOrderHistory();
  const todayIndex = existing.findIndex((day) => day.date === date);

  if (todayIndex === -1) {
    return saveTileOrderHistory([...existing, { date, order: [gameId] }]);
  }

  const today = existing[todayIndex]!;
  if (today.order.includes(gameId)) return false;

  const updated = [...existing];
  updated[todayIndex] = { date, order: [...today.order, gameId] };
  return saveTileOrderHistory(updated);
}
