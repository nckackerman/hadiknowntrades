"use client";

// SSR-safe tile order for the daily-hub game tiles (issue #196): reads
// game-tile-order-storage.ts's cross-day history through
// game-tile-order.ts's pure ranking function and returns which order
// ResultsPage.tsx should render BeatTheBench/CallBoard in.
//
// Built on use-hydrated-local-storage-state.ts's shared deferred-
// correction shape rather than reading storage synchronously in a
// useState initializer (the use-daily-guess.ts shortcut, only safe from a
// component that never renders during SSR) -- ResultsPage.tsx, where this
// hook is called, is the same level use-call-board.ts's own UNHYDRATED_VIEW
// and the deleted use-onboarding-dismissed.ts already gave this exact
// defensive treatment to, so this follows the same established precedent
// rather than assuming this one call site is somehow exempt.
//
// This hook owns no write path of its own -- see game-tile-order-storage.ts's
// own header comment on why ordering is a pure read over state
// BeatTheBench.tsx/use-call-board.ts already own and write.

import { orderGameTiles } from "./game-tile-order";
import {
  GAME_TILE_IDS,
  getTileOrderHistory,
  localDateKey,
  type GameTileId,
} from "./game-tile-order-storage";
import { useHydratedLocalStorageState } from "./use-hydrated-local-storage-state";

/**
 * The two game tile ids, in the order ResultsPage.tsx should render them.
 *
 * `GAME_TILE_IDS`' own fixed order (Beat the Bench, then The Call Board --
 * this app's pre-#196 order, and `orderGameTiles`' own tie-break default)
 * on every render up to and including the very first client render during
 * hydration, then the real, history-derived order once the mount-time
 * correction below runs.
 */
export function useGameTileOrder(): readonly GameTileId[] {
  const [order] = useHydratedLocalStorageState<readonly GameTileId[]>(
    GAME_TILE_IDS,
    () => {
      // No recorded history at all (a brand-new viewer, or one whose
      // storage has been cleared) -- `null` per useHydratedLocalStorageState's
      // own contract, so the hook skips re-applying a value that's
      // already identical to the default GAME_TILE_IDS order
      // orderGameTiles would compute anyway (every score neutral,
      // nothing played today, falls through to the same fixed
      // tie-break). Only a genuine history entry is worth the
      // re-application.
      const history = getTileOrderHistory();
      if (history.length === 0) return null;
      return orderGameTiles(history, localDateKey(new Date()));
    },
    () => {
      // No-op setter: this hook never writes. Recording a tile as played
      // is each tile's own responsibility, via
      // game-tile-order-storage.ts's recordGameTileOpened -- see that
      // module's own header comment.
    },
  );
  return order;
}
