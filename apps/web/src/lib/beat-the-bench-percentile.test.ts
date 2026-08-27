import { describe, expect, it } from "vitest";

import { balanceAtBar, STARTING_CAPITAL } from "./beat-the-bench";
import {
  comparePercentile,
  mulberry32,
  percentilePhrase,
  percentileRank,
  randomTogglerMoves,
  seedFromBars,
  simulateRandomTogglers,
  SIMULATION_TRIALS,
} from "./beat-the-bench-percentile";
import { SPY_SESSION_BARS } from "@/test-fixtures/spy-session-bars";
import {
  SPY_DOWN_SESSION_BARS,
  SPY_UP_SESSION_BARS,
} from "@/test-fixtures/spy-trending-session-bars";

/** The "do nothing" player -- which, per beat-the-bench.ts's own invariant, *is* buy-and-hold. */
const NO_MOVES: number[] = [];

function doNothingPercentile(bars: typeof SPY_UP_SESSION_BARS, seed: number): number {
  return comparePercentile(bars, NO_MOVES, STARTING_CAPITAL, { random: mulberry32(seed) })
    .percentile;
}

describe("mulberry32", () => {
  it("produces the same sequence for the same seed, and a different one for a different seed", () => {
    const first = Array.from({ length: 8 }, mulberry32(12345));
    const second = Array.from({ length: 8 }, mulberry32(12345));
    const other = Array.from({ length: 8 }, mulberry32(12346));

    expect(first).toEqual(second);
    expect(first).not.toEqual(other);
    for (const value of first) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });
});

describe("seedFromBars", () => {
  it("is a function of the price path alone -- stable for the same bars, different for different ones", () => {
    expect(seedFromBars(SPY_UP_SESSION_BARS)).toBe(seedFromBars(SPY_UP_SESSION_BARS));
    expect(seedFromBars(SPY_UP_SESSION_BARS)).not.toBe(seedFromBars(SPY_DOWN_SESSION_BARS));
  });

  it("separates bars that differ only past the second decimal", () => {
    const base = [
      { time: "09:30:00", close: 100.0001 },
      { time: "09:35:00", close: 100.5 },
    ];
    const nudged = [
      { time: "09:30:00", close: 100.0002 },
      { time: "09:35:00", close: 100.5 },
    ];
    expect(seedFromBars(base)).not.toBe(seedFromBars(nudged));
  });
});

describe("randomTogglerMoves", () => {
  it("never toggles at the opening bar -- every trader starts in the market, like the player and the bench", () => {
    const always = randomTogglerMoves(20, 1, () => 0);
    expect(always).not.toContain(0);
    expect(always[0]).toBe(1);
    expect(always).toHaveLength(19);
  });

  it("toggles nowhere when the roll never clears the probability", () => {
    expect(randomTogglerMoves(20, 0.05, () => 0.999)).toEqual([]);
  });
});

describe("percentileRank", () => {
  it("counts ties as half, so a do-nothing player isn't credited with beating the traders they matched", () => {
    expect(percentileRank([1, 2, 3, 4], 2.5)).toBe(0.5);
    expect(percentileRank([1, 2, 2, 3], 2)).toBe(0.5);
    expect(percentileRank([1, 2, 3], 0)).toBe(0);
    expect(percentileRank([1, 2, 3], 9)).toBe(1);
    expect(percentileRank([], 1)).toBe(0);
  });
});

describe("simulateRandomTogglers", () => {
  it("returns one balance per trial, ascending", () => {
    const balances = simulateRandomTogglers(SPY_SESSION_BARS, STARTING_CAPITAL, {
      trials: 40,
      random: mulberry32(7),
    });

    expect(balances).toHaveLength(40);
    expect([...balances].sort((a, b) => a - b)).toEqual(balances);
  });

  it("settles every simulated trader through the same balanceAtBar the player and the bench use", () => {
    // A field whose traders never toggle is, by construction, the
    // benchmark repeated -- the same exactness settleSession's own
    // zero-move tie relies on.
    const balances = simulateRandomTogglers(SPY_SESSION_BARS, STARTING_CAPITAL, {
      trials: 5,
      toggleProbability: 0,
      random: mulberry32(1),
    });
    const bench = balanceAtBar(SPY_SESSION_BARS, [], STARTING_CAPITAL, SPY_SESSION_BARS.length - 1);
    expect(balances).toEqual([bench, bench, bench, bench, bench]);
  });
});

describe("comparePercentile", () => {
  // The acceptance criterion this file exists for: with a fixed seed the
  // simulation must produce the same number every single time, so any
  // assertion built on it is a real assertion rather than a coin flip.
  it("is fully deterministic for a fixed seed, across repeated runs", () => {
    const runs = Array.from({ length: 10 }, () =>
      comparePercentile(SPY_UP_SESSION_BARS, [12, 40], STARTING_CAPITAL, {
        random: mulberry32(20260804),
      }),
    );

    for (const run of runs) {
      expect(run).toEqual(runs[0]);
      expect(run.trials).toBe(SIMULATION_TRIALS);
    }
  });

  it("moves when the seed moves -- the determinism above is the seed's doing, not a constant", () => {
    const a = doNothingPercentile(SPY_UP_SESSION_BARS, 1);
    const b = doNothingPercentile(SPY_UP_SESSION_BARS, 2);
    // Same field size, same session, different draw -- close, but not
    // literally the same number, or the seed wouldn't be doing anything.
    expect(a).not.toBe(b);
  });

  // The directional claim, against two real sessions rather than
  // synthetic ones. A random toggler spends part of the day in cash, so
  // sitting out costs them on an up day and saves them on a down day --
  // which means buy-and-hold (the do-nothing player) should rank high on
  // one and low on the other. Deliberately asserted as a real, large,
  // demonstrated gap rather than against a hardcoded threshold.
  it("ranks a do-nothing player very differently on a real up day than on a real down day", () => {
    const seeds = [1, 2, 3, 4, 5];
    const up = seeds.map((seed) => doNothingPercentile(SPY_UP_SESSION_BARS, seed));
    const down = seeds.map((seed) => doNothingPercentile(SPY_DOWN_SESSION_BARS, seed));

    // Every up-day draw outranks every down-day draw, by a wide margin --
    // the two distributions don't merely differ on average, they don't
    // overlap at all.
    expect(Math.min(...up)).toBeGreaterThan(Math.max(...down));
    expect(Math.min(...up) - Math.max(...down)).toBeGreaterThan(0.5);

    // And the direction is the one the mechanic predicts, not just "some
    // difference": holding beats the random field on the way up and
    // loses to it on the way down.
    expect(Math.min(...up)).toBeGreaterThan(0.5);
    expect(Math.max(...down)).toBeLessThan(0.5);
  });
});

describe("percentilePhrase", () => {
  it("names the field for what it is, in this app's own register", () => {
    expect(percentilePhrase({ trials: 500, percentile: 0.874, medianBalance: 20 })).toBe(
      "You finished ahead of 87% of 500 traders who moved at random through the same session.",
    );
  });

  it("doesn't claim a fraction of a trader at either extreme", () => {
    expect(percentilePhrase({ trials: 500, percentile: 1, medianBalance: 20 })).toContain(
      "ahead of all",
    );
    expect(percentilePhrase({ trials: 500, percentile: 0, medianBalance: 20 })).toContain(
      "behind all",
    );
  });
});
