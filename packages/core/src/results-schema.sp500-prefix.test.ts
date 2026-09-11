// Covers validateSp500PrefixResult (The Cut, issue #232). Kept in its own
// file, mirroring results-schema.the-order.test.ts's own precedent -- a
// separate stored-object family with its own invariants (a triplet-nullable
// bestN/bestPortfolioReturn/bestEndingBalance, a strictly-ascending-by-n
// curve with monotonically non-decreasing cumWeight) that share no fixtures
// with any existing suite.

import { describe, expect, it } from "vitest";

import {
  RESULTS_SCHEMA_VERSION,
  ResultValidationError,
  sp500PrefixResultKey,
  validateSp500PrefixResult,
  type Sp500PrefixResult,
} from "./results-schema";
import type { Sp500PrefixCurvePoint } from "./sp500-prefix-selection";

const CURVE: Sp500PrefixCurvePoint[] = [
  { n: 1, portfolioReturn: 1.5, endingBalance: 30, cumWeight: 8 },
  { n: 2, portfolioReturn: 1.3, endingBalance: 26, cumWeight: 15 },
  { n: 3, portfolioReturn: 1.2, endingBalance: 24, cumWeight: 20 },
];

function result(overrides: Partial<Sp500PrefixResult> = {}): Sp500PrefixResult {
  return {
    schemaVersion: RESULTS_SCHEMA_VERSION,
    range: "1Y",
    generatedAt: "2026-09-10T06:00:00.000Z",
    dataAsOf: "2026-09-09",
    endDate: "2026-09-10",
    startDate: "2025-09-09",
    startingCapital: 20,
    universeSize: 3,
    truncated: false,
    bestN: 1,
    bestPortfolioReturn: 1.5,
    bestEndingBalance: 30,
    curve: CURVE.map((p) => ({ ...p })),
    benchmark: {
      ticker: "SPY",
      startDate: "2025-09-09",
      startPrice: 100,
      endDate: "2026-09-09",
      endPrice: 120,
      endingBalance: 24,
      truncated: false,
    },
    n500VsSpyPctDiff: 25,
    ...overrides,
  };
}

describe("sp500PrefixResultKey", () => {
  it("is a per-range key under its own prefix, distinct from the flat preset-range keys", () => {
    expect(sp500PrefixResultKey("1Y")).toBe("results/sp500-prefix/1Y.json");
    expect(sp500PrefixResultKey("MAX")).toBe("results/sp500-prefix/MAX.json");
  });

  it("accepts the 1D CutRange (issue #238)", () => {
    expect(sp500PrefixResultKey("1D")).toBe("results/sp500-prefix/1D.json");
  });
});

describe("validateSp500PrefixResult", () => {
  it("accepts a real, well-formed result", () => {
    expect(() => validateSp500PrefixResult(result())).not.toThrow();
  });

  it("accepts a well-formed result with bestN: null (whole universe lacks window data)", () => {
    expect(() =>
      validateSp500PrefixResult(
        result({ bestN: null, bestPortfolioReturn: null, bestEndingBalance: null, curve: [] }),
      ),
    ).not.toThrow();
  });

  it("accepts benchmark: null and n500VsSpyPctDiff: null (no SPY data this run)", () => {
    expect(() =>
      validateSp500PrefixResult(result({ benchmark: null, n500VsSpyPctDiff: null })),
    ).not.toThrow();
  });

  it("accepts a negative n500VsSpyPctDiff (the N=universeSize case trailing SPY is a real, legitimate outcome)", () => {
    expect(() => validateSp500PrefixResult(result({ n500VsSpyPctDiff: -12.5 }))).not.toThrow();
  });

  it("rejects a stale schemaVersion", () => {
    expect(() =>
      validateSp500PrefixResult(result({ schemaVersion: RESULTS_SCHEMA_VERSION - 1 })),
    ).toThrow(/schemaVersion must be exactly/);
  });

  it("accepts the 1D range (issue #238 -- CutRange, not PRESET_RANGES)", () => {
    expect(() => validateSp500PrefixResult(result({ range: "1D" }))).not.toThrow();
  });

  it("rejects a range outside CUT_RANGES", () => {
    expect(() =>
      validateSp500PrefixResult(result({ range: "2D" as Sp500PrefixResult["range"] })),
    ).toThrow(/range must be one of/);
  });

  it("rejects bestPortfolioReturn/bestEndingBalance set while bestN is null", () => {
    expect(() =>
      validateSp500PrefixResult(result({ bestN: null, bestPortfolioReturn: 1.5 })),
    ).toThrow(/bestPortfolioReturn must be null when bestN is null/);
    expect(() => validateSp500PrefixResult(result({ bestN: null, bestEndingBalance: 30 }))).toThrow(
      /bestEndingBalance must be null when bestN is null/,
    );
  });

  it("rejects bestPortfolioReturn/bestEndingBalance missing while bestN is set", () => {
    expect(() =>
      validateSp500PrefixResult(result({ bestPortfolioReturn: null as unknown as number })),
    ).toThrow(/bestPortfolioReturn must be a positive finite number when bestN is set/);
  });

  it("rejects a curve entry whose n is not strictly ascending", () => {
    const curve = [CURVE[0]!, { ...CURVE[1]!, n: 1 }, CURVE[2]!];
    expect(() => validateSp500PrefixResult(result({ curve }))).toThrow(
      /curve\[1\]\.n \(1\) must be strictly ascending/,
    );
  });

  it("rejects a curve entry whose cumWeight decreases from the previous entry", () => {
    const curve = [CURVE[0]!, { ...CURVE[1]!, cumWeight: 5 }, CURVE[2]!];
    expect(() => validateSp500PrefixResult(result({ curve }))).toThrow(
      /cumWeight \(5\) must not be less than the previous entry's cumWeight/,
    );
  });

  it("rejects a curve entry with a non-finite n (NaN), and does NOT let it silently disable the ascending check for later entries (regression)", () => {
    // Before the fix, validateSp500PrefixCurvePoint returned `{ n: NaN }`
    // for this entry (gated only on `typeof c.n === "number"`, which NaN
    // itself satisfies -- `typeof NaN === "number"` is true) rather than
    // `null`. The caller's own ascending-order tracker (`previousN`) then
    // got poisoned to NaN, and `anything <= NaN` is always `false` in
    // JS -- so curve[2]'s own `n` (deliberately set to 1 here, a real
    // regression relative to curve[0]'s own `n` of 1) silently cleared
    // the ascending check, comparing against NaN instead of the *last
    // known-good* n (curve[0]'s 1). Fixed: an invalid `n` now makes
    // validateSp500PrefixCurvePoint return `null`, which the caller
    // skips entirely (never updating `previousN`) -- so curve[2] is
    // correctly compared against curve[0]'s own n (1), not NaN, and
    // `1 <= 1` correctly fails strict ascending.
    const curve = [CURVE[0]!, { ...CURVE[1]!, n: NaN }, { ...CURVE[2]!, n: 1 }];
    let message = "";
    try {
      validateSp500PrefixResult(result({ curve }));
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/curve\[1\]\.n must be a positive integer, got NaN/);
    expect(message).toMatch(
      /curve\[2\]\.n \(1\) must be strictly ascending, but does not exceed the previous entry's n \(1\)/,
    );
  });

  it("rejects a curve entry with n = 0 or a non-integer n", () => {
    expect(() => validateSp500PrefixResult(result({ curve: [{ ...CURVE[0]!, n: 0 }] }))).toThrow(
      /curve\[0\]\.n must be a positive integer/,
    );
    expect(() => validateSp500PrefixResult(result({ curve: [{ ...CURVE[0]!, n: 1.5 }] }))).toThrow(
      /curve\[0\]\.n must be a positive integer/,
    );
  });

  it("rejects a non-positive portfolioReturn/endingBalance/cumWeight in a curve entry", () => {
    expect(() =>
      validateSp500PrefixResult(result({ curve: [{ ...CURVE[0]!, portfolioReturn: -1 }] })),
    ).toThrow(/curve\[0\]\.portfolioReturn must be a positive finite number/);
    expect(() =>
      validateSp500PrefixResult(result({ curve: [{ ...CURVE[0]!, endingBalance: 0 }] })),
    ).toThrow(/curve\[0\]\.endingBalance must be a positive finite number/);
    expect(() =>
      validateSp500PrefixResult(result({ curve: [{ ...CURVE[0]!, cumWeight: 0 }] })),
    ).toThrow(/curve\[0\]\.cumWeight must be a positive finite number/);
  });

  it("rejects a benchmark field that is entirely missing (undefined), distinct from a valid benchmark: null", () => {
    const r = result();
    delete (r as { benchmark?: unknown }).benchmark;
    expect(() => validateSp500PrefixResult(r)).toThrow(/benchmark must be null or an object/);
  });

  it("rejects a non-finite n500VsSpyPctDiff", () => {
    expect(() => validateSp500PrefixResult(result({ n500VsSpyPctDiff: NaN }))).toThrow(
      /n500VsSpyPctDiff must be null or a finite number/,
    );
  });

  it("rejects a non-positive-integer universeSize", () => {
    expect(() => validateSp500PrefixResult(result({ universeSize: 0 }))).toThrow(
      /universeSize must be a positive integer/,
    );
  });

  it("reports every problem at once, not just the first", () => {
    let message = "";
    try {
      validateSp500PrefixResult(
        result({ schemaVersion: -1, universeSize: 0, truncated: "yes" as unknown as boolean }),
      );
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("schemaVersion");
    expect(message).toContain("universeSize");
    expect(message).toContain("truncated");
  });

  it("throws a ResultValidationError, not a generic Error", () => {
    expect(() => validateSp500PrefixResult(result({ schemaVersion: -1 }))).toThrow(
      ResultValidationError,
    );
  });
});
