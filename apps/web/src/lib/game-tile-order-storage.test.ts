import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MAX_STORED_TILE_ORDER_DAYS,
  getTileOrderHistory,
  localDateKey,
  recordGameTileOpened,
  type TileOrderDay,
} from "./game-tile-order-storage";

describe("localDateKey", () => {
  it("formats the local calendar date as YYYY-MM-DD", () => {
    expect(localDateKey(new Date(2026, 7, 5))).toBe("2026-08-05"); // month is 0-indexed
    expect(localDateKey(new Date(2026, 0, 31))).toBe("2026-01-31");
  });
});

describe("recordGameTileOpened / getTileOrderHistory", () => {
  afterEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it("reads an empty history when nothing has been recorded", () => {
    expect(getTileOrderHistory()).toEqual([]);
  });

  it("records the first tile touched on a new day", () => {
    expect(recordGameTileOpened("beat-the-bench", "2026-08-27")).toBe(true);
    expect(getTileOrderHistory()).toEqual([
      { date: "2026-08-27", order: ["beat-the-bench"] },
    ] satisfies TileOrderDay[]);
  });

  it("appends a second, different tile touched later the same day", () => {
    recordGameTileOpened("beat-the-bench", "2026-08-27");
    expect(recordGameTileOpened("call-board", "2026-08-27")).toBe(true);

    expect(getTileOrderHistory()).toEqual([
      { date: "2026-08-27", order: ["beat-the-bench", "call-board"] },
    ] satisfies TileOrderDay[]);
  });

  it("is a no-op for a same-day replay of a tile already recorded", () => {
    recordGameTileOpened("beat-the-bench", "2026-08-27");
    expect(recordGameTileOpened("beat-the-bench", "2026-08-27")).toBe(false);

    expect(getTileOrderHistory()).toEqual([
      { date: "2026-08-27", order: ["beat-the-bench"] },
    ] satisfies TileOrderDay[]);
  });

  it("keeps separate days as separate entries, ascending by date", () => {
    recordGameTileOpened("call-board", "2026-08-28");
    recordGameTileOpened("beat-the-bench", "2026-08-26");

    expect(getTileOrderHistory()).toEqual([
      { date: "2026-08-26", order: ["beat-the-bench"] },
      { date: "2026-08-28", order: ["call-board"] },
    ] satisfies TileOrderDay[]);
  });

  it("trims to the most recent MAX_STORED_TILE_ORDER_DAYS days, oldest dropped first", () => {
    for (let i = 0; i < MAX_STORED_TILE_ORDER_DAYS + 5; i++) {
      recordGameTileOpened("beat-the-bench", `2026-01-${String(i + 1).padStart(2, "0")}`);
    }

    const history = getTileOrderHistory();
    expect(history).toHaveLength(MAX_STORED_TILE_ORDER_DAYS);
    expect(history[0]!.date).toBe("2026-01-06"); // the first 5 days were dropped
    expect(history.at(-1)!.date).toBe(`2026-01-${MAX_STORED_TILE_ORDER_DAYS + 5}`);
  });

  it("treats a malformed or stale-format value as nothing stored", () => {
    const malformed = [
      "not json at all",
      "null",
      "[]",
      JSON.stringify({ days: "not an array" }),
      JSON.stringify({ days: [{ date: "2026-08-27" }] }), // no order
      JSON.stringify({ days: [{ date: "2026-08-27", order: [] }] }), // empty order
      JSON.stringify({ days: [{ date: "2026-08-27", order: ["not-a-real-tile"] }] }),
      JSON.stringify({
        days: [{ date: "2026-08-27", order: ["beat-the-bench", "beat-the-bench"] }],
      }), // duplicate tile within one day
      JSON.stringify({ days: [{ date: 20260827, order: ["beat-the-bench"] }] }), // date not a string
    ];

    for (const value of malformed) {
      window.localStorage.setItem("hikt:game-tile-order:history", value);
      expect(getTileOrderHistory()).toEqual([]);
    }
  });

  it("drops only the malformed entries in an otherwise-valid history, not the whole record", () => {
    window.localStorage.setItem(
      "hikt:game-tile-order:history",
      JSON.stringify({
        days: [
          { date: "2026-08-26", order: ["beat-the-bench"] },
          { date: "2026-08-27", order: [] }, // malformed
          "not even an object",
          { date: "2026-08-28", order: ["call-board"] },
        ],
      }),
    );

    expect(getTileOrderHistory()).toEqual([
      { date: "2026-08-26", order: ["beat-the-bench"] },
      { date: "2026-08-28", order: ["call-board"] },
    ] satisfies TileOrderDay[]);
  });

  // The degradation path this app's whole two-layer localStorage pattern
  // exists for (see local-storage.ts): storage disabled by policy or by
  // private browsing throws on *reads* as well as writes, and this
  // display-only ranking feature must never be able to crash the page
  // over it.
  it("degrades to 'no history' when storage itself throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });

    expect(() => recordGameTileOpened("beat-the-bench", "2026-08-27")).not.toThrow();
    expect(recordGameTileOpened("beat-the-bench", "2026-08-27")).toBe(false);
    expect(() => getTileOrderHistory()).not.toThrow();
    expect(getTileOrderHistory()).toEqual([]);
  });
});
