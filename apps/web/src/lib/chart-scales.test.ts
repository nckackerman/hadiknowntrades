import { describe, expect, it } from "vitest";

import {
  buildChainedIntradayXPositions,
  buildLogScale,
  buildTimeScale,
  buildWindowModelXPositions,
  niceLogTicks,
} from "./chart-scales";

describe("buildChainedIntradayXPositions", () => {
  it("gives every day an equal-width slot regardless of how many points that day has", () => {
    // Day "a": 2 points. Day "b": 5 points (e.g. a day at
    // DEFAULT_MAX_TRADES_PER_DAY). Day "c": 1 point. An earlier,
    // per-point ordinal version of this fix would give "b" roughly 5/8 of
    // the width; day-bucketing gives it the same 1/3 share as "a" and "c".
    const dayKeys = ["a", "a", "b", "b", "b", "b", "b", "c"];
    const timestamps = [100, 200, 300, 310, 320, 330, 340, 500];

    const positions = buildChainedIntradayXPositions(dayKeys, timestamps, [0, 90]);

    // Day "a" (slot [0, 30]): its own min/max points land exactly on the
    // slot's edges.
    expect(positions[0]).toBe(0);
    expect(positions[1]).toBe(30);
    // Day "b" (slot [30, 60]): 5 points, evenly interpolated by real
    // timestamp within that same 30-wide slot -- not a wider one.
    expect(positions[2]).toBe(30);
    expect(positions[3]).toBeCloseTo(37.5, 5);
    expect(positions[4]).toBeCloseTo(45, 5);
    expect(positions[5]).toBeCloseTo(52.5, 5);
    expect(positions[6]).toBe(60);
    // Day "c" (slot [60, 90]): a single point, but it's also the series'
    // very last point -- pinned to the range end (see below), not
    // centered in its slot.
    expect(positions[7]).toBe(90);
  });

  it("centers an interior single-point (no-trade) day in its own slot", () => {
    const dayKeys = ["a", "a", "b", "c", "c"];
    const timestamps = [0, 10, 15, 20, 30]; // "b" chronologically between "a" and "c"

    const positions = buildChainedIntradayXPositions(dayKeys, timestamps, [0, 90]);

    expect(positions).toEqual([0, 30, 45, 60, 90]);
  });

  it("pins the first and last point to the range edges even when the first or last day has only one point", () => {
    const dayKeys = ["a", "b"];
    const timestamps = [0, 1];

    const positions = buildChainedIntradayXPositions(dayKeys, timestamps, [0, 90]);

    expect(positions).toEqual([0, 90]);
  });

  it("returns the range midpoint for a single point overall", () => {
    expect(buildChainedIntradayXPositions(["a"], [0], [0, 90])).toEqual([45]);
  });

  it("returns an empty array for no points", () => {
    expect(buildChainedIntradayXPositions([], [], [0, 90])).toEqual([]);
  });

  it("orders day slots chronologically by each day's own timestamps, not by first appearance in dayKeys (code review regression)", () => {
    // "x" and "y" are boundary days (array-first/last, so their own
    // positions are always pinned to the range edges regardless of day
    // order -- see the pinning test above -- and shouldn't be read as
    // asserting anything about day-sort order). The two interior days,
    // "b" and "a", appear in that order in dayKeys, but "a"'s own
    // timestamp (50) is chronologically *before* "b"'s (100) -- their
    // slots must reflect timestamp order (a's slot left of b's), not
    // input order, or the line would render non-monotonically.
    const dayKeys = ["x", "b", "a", "y"];
    const timestamps = [0, 100, 50, 200];

    const positions = buildChainedIntradayXPositions(dayKeys, timestamps, [0, 90]);

    expect(positions).toEqual([0, 56.25, 33.75, 90]);
    // The decisive check: "a" (earlier) sits left of "b" (later) despite
    // appearing after it in dayKeys -- under the pre-fix first-appearance
    // ordering, this would be reversed.
    expect(positions[2]).toBeLessThan(positions[1]!);
  });
});

describe("buildWindowModelXPositions", () => {
  it("maps timestamps linearly across the range, proportional to real elapsed time", () => {
    const positions = buildWindowModelXPositions([0, 250, 1000], [0, 100]);
    expect(positions).toEqual([0, 25, 100]);
  });

  it("pads a single-point series by a day instead of collapsing to a zero-span domain", () => {
    const dayMs = 24 * 60 * 60 * 1000;
    const positions = buildWindowModelXPositions([dayMs * 10], [0, 100]);
    expect(positions[0]).toBeCloseTo(50, 5);
  });
});

describe("buildTimeScale", () => {
  it("maps the domain endpoints to the range endpoints", () => {
    const scale = buildTimeScale([0, 1000], [0, 100]);
    expect(scale(0)).toBe(0);
    expect(scale(1000)).toBe(100);
    expect(scale(500)).toBe(50);
  });

  it("returns the range midpoint for a zero-span domain instead of dividing by zero", () => {
    const scale = buildTimeScale([500, 500], [0, 100]);
    expect(scale(500)).toBe(50);
    expect(Number.isFinite(scale(500))).toBe(true);
  });
});

describe("buildLogScale", () => {
  it("maps the domain endpoints to the range endpoints in log space", () => {
    const scale = buildLogScale([1, 1000], [100, 0]); // SVG y grows downward
    expect(scale(1)).toBeCloseTo(100);
    expect(scale(1000)).toBeCloseTo(0);
    // 10 is 1/3 of the way from 1 to 1000 in log space (log10 1 = 0, log10 1000 = 3).
    expect(scale(10)).toBeCloseTo(100 - 100 / 3, 5);
  });

  it("returns the range midpoint for a zero-span domain instead of dividing by zero", () => {
    const scale = buildLogScale([20, 20], [100, 0]);
    expect(scale(20)).toBe(50);
  });
});

describe("niceLogTicks", () => {
  it("returns every in-domain power of ten when the domain is small", () => {
    expect(niceLogTicks(20, 6876.86)).toEqual([100, 1000]);
  });

  it("thins ticks when the domain spans many orders of magnitude", () => {
    const ticks = niceLogTicks(20, 5e33, 5);
    expect(ticks.length).toBeLessThanOrEqual(5);
    // Every tick is still a whole power of ten.
    for (const tick of ticks) {
      expect(Math.log10(tick)).toBeCloseTo(Math.round(Math.log10(tick)), 10);
    }
  });

  it("returns an empty array for an invalid or non-positive domain", () => {
    expect(niceLogTicks(0, 100)).toEqual([]);
    expect(niceLogTicks(-5, 100)).toEqual([]);
    expect(niceLogTicks(100, 20)).toEqual([]);
  });

  it("every returned tick falls within [min, max], never off the visible axis", () => {
    // A domain narrower than one decade -- e.g. a flat/modest-gain
    // result padded by PortfolioChart's own 1.15x factor -- has no
    // whole power of ten inside it at all, which is exactly the case
    // that used to render every gridline/label off-canvas.
    const cases: Array<[number, number]> = [
      [17.4, 25.3],
      [20, 20.001],
      [1, 9],
      [999, 1001],
    ];
    for (const [min, max] of cases) {
      const ticks = niceLogTicks(min, max);
      expect(ticks.length).toBeGreaterThan(0);
      for (const tick of ticks) {
        expect(tick).toBeGreaterThanOrEqual(min);
        expect(tick).toBeLessThanOrEqual(max);
      }
    }
  });

  it("falls back to evenly log-spaced ticks when no power of ten lands in a sub-decade domain", () => {
    const ticks = niceLogTicks(17.4, 25.3);
    expect(ticks[0]).toBeCloseTo(17.4, 5);
    expect(ticks[ticks.length - 1]).toBeCloseTo(25.3, 5);
  });
});
