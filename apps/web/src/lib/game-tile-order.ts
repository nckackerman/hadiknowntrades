// The pure ranking/sort function behind issue #196: turns a viewer's own
// game-tile play history (game-tile-order-storage.ts) into the order
// ResultsPage.tsx should render its two playable tiles in.
//
// Deliberately pure and storage-free -- no React, no clock reads, no
// localStorage -- so the three ordering rules below are independently
// unit-testable against synthetic history, per this issue's own
// acceptance criteria. The one and only caller (ResultsPage.tsx) is
// responsible for supplying real history (via `getTileOrderHistory`) and
// a real "today" (via `localDateKey(new Date())`), both from
// game-tile-order-storage.ts.
//
// **This must be a pure, derived sort computed from stored history, not
// something that jumps mid-session.** Today's play changes only *today's*
// row in the stored history (see game-tile-order-storage.ts's own
// `recordGameTileOpened`) -- it does not retroactively change the
// preference score itself, which is always computed fresh from whatever
// history happens to be on disk at render time. A tile a viewer just
// finished playing sinks to the bottom on this same render (the
// played-today rule), but the *next* visit's preference ranking is
// unaffected by anything that happens after today's own record is
// written -- there's no separate "pending" state to reconcile.

import { GAME_TILE_IDS, type GameTileId, type TileOrderDay } from "./game-tile-order-storage";

/**
 * The fraction of recorded days each tile was the first one touched --
 * `order[0]` of that day's own `TileOrderDay` entry (see
 * game-tile-order-storage.ts's own doc comment for why a single-tile day
 * still counts as "first touched" for that one tile).
 *
 * A tile with **no recorded history at all** (an empty `history`, or a
 * history where the tile never appears in any day's `order`) gets a
 * neutral 0.5 rather than 0 -- a brand-new viewer, or one who has only
 * ever played the *other* tile, shouldn't see an order that looks
 * confidently "wrong" the first few times either tile is actually played.
 * Contrast: a tile that *has* appeared in `order` but was never first
 * legitimately scores 0 -- that's a real, earned signal ("always played
 * second"), not an absence of data.
 */
export function preferenceScores(history: readonly TileOrderDay[]): Record<GameTileId, number> {
  const scores = {} as Record<GameTileId, number>;
  for (const gameId of GAME_TILE_IDS) {
    const recordedDays = history.filter((day) => day.order.includes(gameId));
    scores[gameId] =
      recordedDays.length === 0
        ? 0.5
        : recordedDays.filter((day) => day.order[0] === gameId).length / recordedDays.length;
  }
  return scores;
}

/** Whether `gameId` was touched at all on `date`'s own recorded entry, if any -- true for either the first- or second-touched tile that day. */
export function wasPlayedOn(
  history: readonly TileOrderDay[],
  date: string,
  gameId: GameTileId,
): boolean {
  return history.some((day) => day.date === date && day.order.includes(gameId));
}

/**
 * Orders `tileIds` (defaulting to both real game tiles) for rendering:
 *
 * 1. Not yet played today, ranked by preference score descending.
 * 2. Already played today, ranked by preference score descending among
 *    themselves -- still relatively ordered by preference, just sunk
 *    below every unplayed tile.
 *
 * Tied scores (including the neutral 0.5/0.5 a brand-new viewer sees)
 * break deterministically by `GAME_TILE_IDS`' own fixed order -- this
 * app's pre-#196 order (Beat the Bench, then The Call Board) -- rather
 * than by inspection of `tileIds`' own input order or `Array.prototype
 * .sort`'s incidental stability, so the same history always produces the
 * same order regardless of how a caller happens to hand tiles in.
 */
export function orderGameTiles(
  history: readonly TileOrderDay[],
  today: string,
  tileIds: readonly GameTileId[] = GAME_TILE_IDS,
): GameTileId[] {
  const scores = preferenceScores(history);
  const playedToday = new Set(
    history.find((day) => day.date === today)?.order.filter((id) => tileIds.includes(id)) ?? [],
  );

  return [...tileIds].sort((a, b) => {
    const aPlayed = playedToday.has(a);
    const bPlayed = playedToday.has(b);
    if (aPlayed !== bPlayed) return aPlayed ? 1 : -1;

    const scoreDiff = scores[b] - scores[a];
    if (scoreDiff !== 0) return scoreDiff;

    return GAME_TILE_IDS.indexOf(a) - GAME_TILE_IDS.indexOf(b);
  });
}
