import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { recordGameTileOpened, GAME_TILE_IDS } from "./game-tile-order-storage";
import { useGameTileOrder } from "./use-game-tile-order";

/** The hook's mount-time "hydrate from storage" correction runs inside a
 * microtask (use-hydrated-local-storage-state.ts's own established
 * shape), not synchronously during render -- tests that need to observe
 * the corrected value must flush the microtask queue first. */
async function flushMicrotasks(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

describe("useGameTileOrder", () => {
  afterEach(() => {
    window.localStorage.clear();
  });

  it("starts at the fixed default order on the very first render, even with a different order already stored -- the hydration-safety tradeoff use-hydrated-local-storage-state.ts's own doc comment describes", () => {
    recordGameTileOpened("call-board", "2020-01-01");
    recordGameTileOpened("call-board", "2020-01-02");

    const { result } = renderHook(() => useGameTileOrder());

    expect(result.current).toEqual(GAME_TILE_IDS);
  });

  it("defaults to the fixed order when nothing is stored", async () => {
    const { result } = renderHook(() => useGameTileOrder());
    await flushMicrotasks();

    expect(result.current).toEqual(["beat-the-bench", "call-board"]);
  });

  it("hydrates to the history-derived order shortly after mount", async () => {
    recordGameTileOpened("call-board", "2020-01-01");
    recordGameTileOpened("call-board", "2020-01-02");
    recordGameTileOpened("call-board", "2020-01-03");

    const { result } = renderHook(() => useGameTileOrder());
    await flushMicrotasks();

    expect(result.current).toEqual(["call-board", "beat-the-bench"]);
  });
});
