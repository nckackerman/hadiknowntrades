import { describe, expect, it } from "vitest";

import { buildLogScale, buildTimeScale, niceLogTicks } from "./chart-scales";

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
