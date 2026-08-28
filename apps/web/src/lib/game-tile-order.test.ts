import { describe, expect, it } from "vitest";

import type { TileOrderDay } from "./game-tile-order-storage";
import { orderGameTiles, preferenceScores, wasPlayedOn } from "./game-tile-order";

function days(...entries: [string, ("beat-the-bench" | "call-board")[]][]): TileOrderDay[] {
  return entries.map(([date, order]) => ({ date, order }));
}

describe("preferenceScores", () => {
  it("gives every tile a neutral 0.5 with no history at all", () => {
    expect(preferenceScores([])).toEqual({ "beat-the-bench": 0.5, "call-board": 0.5 });
  });

  it("gives every tile a neutral 0.5 when neither has ever appeared", () => {
    // Can't happen via recordGameTileOpened in practice (an entry is only
    // ever written once a real tile id is recorded), but the scorer
    // itself should still degrade gracefully rather than divide by zero.
    expect(preferenceScores([{ date: "2026-08-27", order: [] as never[] }])).toEqual({
      "beat-the-bench": 0.5,
      "call-board": 0.5,
    });
  });

  it("scores a strong preference one way", () => {
    const history = days(
      ["2026-08-24", ["beat-the-bench", "call-board"]],
      ["2026-08-25", ["beat-the-bench", "call-board"]],
      ["2026-08-26", ["beat-the-bench"]],
      ["2026-08-27", ["call-board", "beat-the-bench"]],
    );

    expect(preferenceScores(history)).toEqual({
      "beat-the-bench": 0.75, // first on 3 of the 4 days it appeared on
      "call-board": 1 / 3, // first on 1 of the 3 days it appeared on (never touched on 08-26)
    });
  });

  it("scores 0 for a tile that has been played but is never first, not neutral", () => {
    const history = days(["2026-08-27", ["beat-the-bench", "call-board"]]);

    expect(preferenceScores(history)).toEqual({ "beat-the-bench": 1, "call-board": 0 });
  });

  it("only counts days a tile actually appeared on, not every recorded day", () => {
    // Call Board never appears at all -- its score is the "no data yet"
    // neutral 0.5, not 0 (which would misrepresent "never played" as
    // "always played second").
    const history = days(
      ["2026-08-25", ["beat-the-bench"]],
      ["2026-08-26", ["beat-the-bench"]],
      ["2026-08-27", ["beat-the-bench"]],
    );

    expect(preferenceScores(history)).toEqual({ "beat-the-bench": 1, "call-board": 0.5 });
  });
});

describe("wasPlayedOn", () => {
  const history = days(["2026-08-27", ["call-board", "beat-the-bench"]]);

  it("is true for either tile touched that day, first or second", () => {
    expect(wasPlayedOn(history, "2026-08-27", "call-board")).toBe(true);
    expect(wasPlayedOn(history, "2026-08-27", "beat-the-bench")).toBe(true);
  });

  it("is false for a day with no recorded entry", () => {
    expect(wasPlayedOn(history, "2026-08-28", "call-board")).toBe(false);
  });
});

describe("orderGameTiles", () => {
  it("falls back to the fixed default order with no history at all", () => {
    expect(orderGameTiles([], "2026-08-27")).toEqual(["beat-the-bench", "call-board"]);
  });

  it("orders by preference when neither tile was played today", () => {
    const history = days(
      ["2026-08-20", ["call-board", "beat-the-bench"]],
      ["2026-08-21", ["call-board", "beat-the-bench"]],
      ["2026-08-22", ["call-board"]],
    );

    // Call Board is usually opened first -- and today is a fresh day
    // neither has been touched on yet, so preference alone decides.
    expect(orderGameTiles(history, "2026-08-27")).toEqual(["call-board", "beat-the-bench"]);
  });

  it("sinks a tile played today below an unplayed one, regardless of its usual preference", () => {
    const history = days(
      // Beat the Bench is strongly preferred historically...
      ["2026-08-20", ["beat-the-bench", "call-board"]],
      ["2026-08-21", ["beat-the-bench", "call-board"]],
      ["2026-08-22", ["beat-the-bench", "call-board"]],
      // ...but today it's already been played.
      ["2026-08-27", ["beat-the-bench"]],
    );

    expect(orderGameTiles(history, "2026-08-27")).toEqual(["call-board", "beat-the-bench"]);
  });

  it("keeps played-today tiles relatively ordered by preference among themselves", () => {
    const history = days(
      ["2026-08-20", ["beat-the-bench", "call-board"]],
      ["2026-08-21", ["beat-the-bench", "call-board"]],
      // Today, played in the *opposite* order from the usual preference --
      // both are still "played today," but Beat the Bench (the usually-
      // preferred one) should still sort ahead of Call Board among the
      // two played-today tiles, not by the order they happened to be
      // touched today.
      ["2026-08-27", ["call-board", "beat-the-bench"]],
    );

    expect(orderGameTiles(history, "2026-08-27")).toEqual(["beat-the-bench", "call-board"]);
  });

  it("gives a brand-new viewer the fixed default order, not an arbitrary-looking one", () => {
    // No history at all yet -- both tiles are neutral (0.5), so the tie
    // break is what actually decides the order, and it should look like
    // this app's own pre-#196 fixed order, not something that looks
    // broken or random on a first visit.
    expect(orderGameTiles([], "2026-08-27")).toEqual(["beat-the-bench", "call-board"]);
  });

  it("breaks a tied score deterministically by the fixed default order", () => {
    const history = days(["2026-08-20", ["beat-the-bench"]], ["2026-08-21", ["call-board"]]); // both score 1 (each is the only, and therefore first, tile on its own day)

    expect(preferenceScores(history)).toEqual({ "beat-the-bench": 1, "call-board": 1 });
    expect(orderGameTiles(history, "2026-08-27")).toEqual(["beat-the-bench", "call-board"]);
  });

  it("does not retroactively let today's own play change today's preference score", () => {
    // A single strong day of history says Call Board goes first; playing
    // Beat the Bench today (and nothing else, ever, historically) must
    // sink it below Call Board for today's render, not flip the
    // preference ranking the two would otherwise have.
    const history = days(
      ["2026-08-20", ["call-board", "beat-the-bench"]],
      ["2026-08-27", ["beat-the-bench"]],
    );

    expect(orderGameTiles(history, "2026-08-27")).toEqual(["call-board", "beat-the-bench"]);
  });

  it("accepts a custom tileIds list, e.g. for future non-ranked placeholder tiles", () => {
    expect(orderGameTiles([], "2026-08-27", ["call-board"])).toEqual(["call-board"]);
  });
});
