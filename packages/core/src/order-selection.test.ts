import { describe, expect, it } from "vitest";

import {
  computeOrderSelection,
  magSevenCompanyName,
  MAG_SEVEN_TICKERS,
  MIN_ADJACENT_GAP_PP,
  MIN_TOTAL_SPREAD_PP,
  ORDER_POOL_SIZE,
} from "./order-selection";

describe("magSevenCompanyName", () => {
  it("resolves a real company name for every Magnificent Seven ticker", () => {
    for (const ticker of MAG_SEVEN_TICKERS) {
      const name = magSevenCompanyName(ticker);
      expect(name).not.toBe(ticker); // every real one has a distinct display name
      expect(name.length).toBeGreaterThan(0);
    }
  });

  it("falls back to the ticker itself for an unknown symbol", () => {
    expect(magSevenCompanyName("ZZZZ")).toBe("ZZZZ");
  });
});

describe("computeOrderSelection", () => {
  it("returns null when fewer than ORDER_POOL_SIZE candidates are present", () => {
    const returns = new Map([
      ["AAPL", 1],
      ["MSFT", 2],
      ["AMZN", 3],
      ["NVDA", 4],
    ]);
    expect(computeOrderSelection(returns)).toBeNull();
  });

  it("uses every candidate unchanged when exactly ORDER_POOL_SIZE are present", () => {
    const returns = new Map([
      ["AAPL", -2],
      ["MSFT", -1],
      ["AMZN", 0],
      ["NVDA", 1],
      ["META", 2],
    ]);
    const result = computeOrderSelection(returns);
    expect(result).not.toBeNull();
    expect(result!.excludedTickers).toEqual([]);
    expect(result!.widened).toBe(false);
    expect(result!.picks.map((p) => p.ticker)).toEqual(["AAPL", "MSFT", "AMZN", "NVDA", "META"]);
  });

  it("returns null for exactly ORDER_POOL_SIZE candidates that fail the guardrail (nothing to widen to)", () => {
    const returns = new Map([
      ["AAPL", 0],
      ["MSFT", 0.001],
      ["AMZN", 0.002],
      ["NVDA", 0.003],
      ["META", 0.004],
    ]);
    expect(computeOrderSelection(returns)).toBeNull();
  });

  it("applies the primary rule -- excludes the 2 smallest-abs-return tickers, sorts the rest worst-to-best", () => {
    // AAPL (0.01) and MSFT (-0.02) are the two smallest by absolute value;
    // the remaining 5 have a healthy spread/gap so the primary rule holds.
    const returns = new Map([
      ["AAPL", 0.01],
      ["MSFT", -0.02],
      ["AMZN", -5],
      ["NVDA", -2],
      ["META", 1],
      ["TSLA", 2],
      ["GOOGL", 4],
    ]);
    const result = computeOrderSelection(returns);
    expect(result).not.toBeNull();
    expect(result!.widened).toBe(false);
    expect(new Set(result!.excludedTickers)).toEqual(new Set(["AAPL", "MSFT"]));
    expect(result!.picks.map((p) => p.ticker)).toEqual(["AMZN", "NVDA", "META", "TSLA", "GOOGL"]);
    expect(result!.picks.map((p) => p.pctReturn)).toEqual([-5, -2, 1, 2, 4]);
    expect(result!.spreadPp).toBeCloseTo(9);
    expect(result!.minAdjacentGapPp).toBeCloseTo(1);
  });

  it("widens the exclusion when the primary rule trips the minimum-adjacent-gap guardrail", () => {
    // Primary rule excludes GOOGL/TSLA (smallest abs returns, 0/0.001),
    // leaving AAPL/MSFT/AMZN/NVDA/META -- but AAPL and MSFT are a genuine
    // 0.00pp tie (both 1.00000), tripping MIN_ADJACENT_GAP_PP. The
    // full-spread search should find a different 2-exclusion with a real gap.
    const returns = new Map([
      ["GOOGL", 0],
      ["TSLA", 0.001],
      ["AAPL", 1.0],
      ["MSFT", 1.0],
      ["AMZN", -5],
      ["NVDA", -2],
      ["META", 6],
    ]);
    const result = computeOrderSelection(returns);
    expect(result).not.toBeNull();
    expect(result!.widened).toBe(true);
    expect(result!.spreadPp).toBeGreaterThanOrEqual(MIN_TOTAL_SPREAD_PP);
    expect(result!.minAdjacentGapPp).toBeGreaterThanOrEqual(MIN_ADJACENT_GAP_PP);
    // AAPL/MSFT's own tie must not both survive into the widened result --
    // that would still trip the gap guardrail.
    const keptTickers = result!.picks.map((p) => p.ticker);
    expect(keptTickers.includes("AAPL") && keptTickers.includes("MSFT")).toBe(false);
  });

  it("widens among ALL spread-tied candidates, not just the first by tie-break -- the review's exact counterexample", () => {
    // 7 tickers with returns -10, -6, -3, 0, 5.00, 5.01, 10. The primary
    // rule excludes the two smallest-abs-return tickers (0 and -3),
    // leaving [-10, -6, 5.00, 5.01, 10] -- a 0.01pp adjacent gap between
    // 5.00 and 5.01 that fails MIN_ADJACENT_GAP_PP (0.02).
    //
    // The widen search's max spread (20pp) is achieved by many different
    // 2-ticker exclusions. The lexicographically-first one by excluded-
    // ticker-set ("B,C", i.e. excluding the -6 and -3 tickers) recreates
    // the exact same 5.00/5.01 near-tie pair and *also* fails the
    // adjacent-gap guardrail -- the old code checked only that single
    // candidate and wrongly returned null. A different, equally
    // max-spread exclusion (e.g. excluding the -6 and 5.00 tickers)
    // drops one side of the near-tie pair and clears both guardrails --
    // the fixed widen search must find it instead of giving up.
    const returns = new Map([
      ["A", -10],
      ["B", -6],
      ["C", -3],
      ["D", 0],
      ["E", 5.0],
      ["F", 5.01],
      ["G", 10],
    ]);
    const result = computeOrderSelection(returns);
    expect(result).not.toBeNull();
    expect(result!.widened).toBe(true);
    expect(result!.spreadPp).toBeCloseTo(20);
    expect(result!.spreadPp).toBeGreaterThanOrEqual(MIN_TOTAL_SPREAD_PP);
    expect(result!.minAdjacentGapPp).toBeGreaterThanOrEqual(MIN_ADJACENT_GAP_PP);
    // The near-tie pair (E:5.00, F:5.01) must not both survive into the
    // widened result -- that would recreate the failing 0.01pp gap.
    const keptTickers = result!.picks.map((p) => p.ticker);
    expect(keptTickers.includes("E") && keptTickers.includes("F")).toBe(false);
  });

  it("returns null when no exclusion (primary or widened) clears the guardrails", () => {
    // All 7 returns packed into a span far too narrow to ever clear
    // MIN_TOTAL_SPREAD_PP (1.5pp) for any 5-of-7 subset.
    const returns = new Map([
      ["AAPL", 0.0],
      ["MSFT", 0.01],
      ["AMZN", 0.02],
      ["NVDA", 0.03],
      ["META", 0.04],
      ["TSLA", 0.05],
      ["GOOGL", 0.06],
    ]);
    expect(computeOrderSelection(returns)).toBeNull();
  });

  it("is deterministic: identical input always produces identical output", () => {
    const returns = new Map(MAG_SEVEN_TICKERS.map((ticker, i) => [ticker, (i - 3) * 1.7] as const));
    const a = computeOrderSelection(returns);
    const b = computeOrderSelection(returns);
    expect(a).toEqual(b);
  });

  it("breaks a spread tie deterministically by the lexicographically-smallest excluded set", () => {
    // Two disjoint pairs, symmetric around 0, both giving the exact same
    // spread once excluded -- forces the tie-break path.
    const returns = new Map([
      ["AAPL", -10], // excluding this pairs with...
      ["MSFT", 10], // ...this: spread 100 - (-100) style symmetry below
      ["AMZN", -0.1],
      ["NVDA", 0.1],
      ["META", -1],
      ["TSLA", 1],
      ["GOOGL", 0],
    ]);
    const a = computeOrderSelection(returns);
    const b = computeOrderSelection(new Map(returns));
    expect(a).toEqual(b);
  });

  it("real Magnificent Seven pool size always yields exactly ORDER_POOL_SIZE picks when non-null", () => {
    const returns = new Map(MAG_SEVEN_TICKERS.map((ticker, i) => [ticker, i - 3] as const));
    const result = computeOrderSelection(returns);
    expect(result).not.toBeNull();
    expect(result!.picks).toHaveLength(ORDER_POOL_SIZE);
  });
});
