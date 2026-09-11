import { describe, expect, it } from "vitest";

import type { Sp500PrefixCurvePoint } from "@hadiknowntrades/core";

import {
  closenessBand,
  curvePointAtOrBelow,
  edgeCapturedPct,
  isValidSp500PrefixResult,
  n500CurvePoint,
  scoreCutGuess,
} from "./the-cut-scoring";

function point(n: number, endingBalance: number, cumWeight = 1): Sp500PrefixCurvePoint {
  return { n, portfolioReturn: endingBalance / 20, endingBalance, cumWeight };
}

describe("closenessBand", () => {
  it("bands rank-distance as a fraction of universeSize", () => {
    // universeSize = 100: hot <= 2, warm <= 8, cold <= 20, else ice-cold.
    expect(closenessBand(0, 100)).toBe("hot");
    expect(closenessBand(2, 100)).toBe("hot");
    expect(closenessBand(3, 100)).toBe("warm");
    expect(closenessBand(8, 100)).toBe("warm");
    expect(closenessBand(9, 100)).toBe("cold");
    expect(closenessBand(20, 100)).toBe("cold");
    expect(closenessBand(21, 100)).toBe("ice-cold");
  });

  it("scales with universeSize -- the same absolute distance can land in a different band", () => {
    // The same absolute rank-distance (3) lands in a materially different
    // band depending on how large the universe is: 3/50 = 0.06 (warm),
    // but 3/10 = 0.3 (ice-cold).
    expect(closenessBand(3, 50)).toBe("warm");
    expect(closenessBand(3, 10)).toBe("ice-cold");
  });

  it("degrades to ice-cold for a zero universeSize rather than dividing by zero", () => {
    expect(closenessBand(0, 0)).toBe("ice-cold");
  });
});

describe("edgeCapturedPct", () => {
  it("computes the real % of the available edge captured", () => {
    expect(edgeCapturedPct(30, 20, 40)).toBe(50);
  });

  it("clamps below 0 -- a guess that underperforms the baseline captured none of the edge", () => {
    expect(edgeCapturedPct(10, 20, 40)).toBe(0);
  });

  it("clamps above 100 -- a guess can't capture more than the whole available edge", () => {
    expect(edgeCapturedPct(50, 20, 40)).toBe(100);
  });

  it("is exactly 100 at the best guess itself", () => {
    expect(edgeCapturedPct(40, 20, 40)).toBe(100);
  });

  it("is exactly 0 at the baseline itself", () => {
    expect(edgeCapturedPct(20, 20, 40)).toBe(0);
  });

  it("returns 100 unconditionally when there's no real edge to capture (bestN already equals universeSize)", () => {
    expect(edgeCapturedPct(20, 40, 40)).toBe(100);
    expect(edgeCapturedPct(999, 40, 40)).toBe(100);
  });
});

describe("curvePointAtOrBelow", () => {
  const curve = [point(5, 100), point(10, 200), point(20, 50)];

  it("finds the exact entry when it exists", () => {
    expect(curvePointAtOrBelow(curve, 10)).toEqual(point(10, 200));
  });

  it("finds the last entry with n <= guess when there's no exact match", () => {
    expect(curvePointAtOrBelow(curve, 7)).toEqual(point(5, 100));
    expect(curvePointAtOrBelow(curve, 19)).toEqual(point(10, 200));
  });

  it("returns null when the guess is below the curve's own smallest n", () => {
    expect(curvePointAtOrBelow(curve, 3)).toBeNull();
  });

  it("returns null for an empty curve", () => {
    expect(curvePointAtOrBelow([], 1)).toBeNull();
  });
});

describe("n500CurvePoint", () => {
  it("finds the exact n === universeSize entry", () => {
    const curve = [point(1, 20), point(3, 40), point(5, 60)];
    expect(n500CurvePoint(curve, 5)).toEqual(point(5, 60));
  });

  it("falls back to the curve's own last entry when there's no exact match", () => {
    const curve = [point(1, 20), point(3, 40)];
    expect(n500CurvePoint(curve, 5)).toEqual(point(3, 40));
  });

  it("returns null for an empty curve", () => {
    expect(n500CurvePoint([], 5)).toBeNull();
  });
});

describe("scoreCutGuess", () => {
  // universeSize=5, bestN=3 -- a hand-computed curve, n500 (n=5) at $22.
  const curve = [point(1, 24), point(2, 26), point(3, 30), point(4, 28), point(5, 22)];
  const base = {
    bestN: 3,
    curve,
    n500EndingBalance: 22,
    bestEndingBalance: 30,
    universeSize: 5,
    startingCapital: 20,
  };

  it("grades an exact match as correct, with no direction or closeness", () => {
    const feedback = scoreCutGuess({ ...base, guess: 3 });
    expect(feedback).toEqual({
      guess: 3,
      correct: true,
      direction: null,
      closeness: null,
      rankDistance: 0,
      edgeCapturedPct: 100,
      guessEndingBalance: 30,
    });
  });

  it("grades a too-high guess with the right direction and closeness", () => {
    const feedback = scoreCutGuess({ ...base, guess: 5 });
    expect(feedback.correct).toBe(false);
    expect(feedback.direction).toBe("too-high");
    expect(feedback.rankDistance).toBe(2);
    expect(feedback.closeness).toBe("ice-cold"); // 2/5 = 0.4
    expect(feedback.guessEndingBalance).toBe(22);
    expect(feedback.edgeCapturedPct).toBe(0); // guessEndingBalance === n500EndingBalance
  });

  it("grades a too-low guess with the right direction and closeness", () => {
    const feedback = scoreCutGuess({ ...base, guess: 2 });
    expect(feedback.correct).toBe(false);
    expect(feedback.direction).toBe("too-low");
    expect(feedback.rankDistance).toBe(1);
    expect(feedback.closeness).toBe("cold"); // 1/5 = 0.2
    expect(feedback.guessEndingBalance).toBe(26);
    expect(feedback.edgeCapturedPct).toBe(50); // (26-22)/(30-22) = 0.5
  });

  it("falls back to startingCapital when the guess is below the curve's own smallest n", () => {
    const sparseCurve = [point(3, 30), point(5, 22)];
    const feedback = scoreCutGuess({
      ...base,
      curve: sparseCurve,
      guess: 1,
    });
    expect(feedback.guessEndingBalance).toBe(20); // startingCapital fallback
  });
});

describe("isValidSp500PrefixResult", () => {
  const valid = {
    universeSize: 5,
    curve: [],
    bestN: null,
  };

  it("accepts a well-formed shape", () => {
    expect(isValidSp500PrefixResult(valid)).toBe(true);
    expect(isValidSp500PrefixResult({ ...valid, bestN: 3 })).toBe(true);
  });

  it("rejects null/non-object values", () => {
    expect(isValidSp500PrefixResult(null)).toBe(false);
    expect(isValidSp500PrefixResult("nope")).toBe(false);
    expect(isValidSp500PrefixResult(42)).toBe(false);
  });

  it("rejects a non-positive or missing universeSize", () => {
    expect(isValidSp500PrefixResult({ ...valid, universeSize: 0 })).toBe(false);
    expect(isValidSp500PrefixResult({ ...valid, universeSize: "5" })).toBe(false);
    expect(isValidSp500PrefixResult({ curve: [], bestN: null })).toBe(false);
  });

  it("rejects a non-array curve", () => {
    expect(isValidSp500PrefixResult({ ...valid, curve: "nope" })).toBe(false);
  });

  it("rejects a bestN that's neither null nor a number", () => {
    expect(isValidSp500PrefixResult({ ...valid, bestN: "3" })).toBe(false);
  });
});
