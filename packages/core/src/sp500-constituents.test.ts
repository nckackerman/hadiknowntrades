import { describe, expect, it } from "vitest";

import { SP500_CONSTITUENTS } from "./sp500-constituents.js";

describe("SP500_CONSTITUENTS", () => {
  it("has roughly 500 entries (S&P 500 sometimes has ~503 due to dual share classes)", () => {
    expect(SP500_CONSTITUENTS.length).toBeGreaterThanOrEqual(495);
    expect(SP500_CONSTITUENTS.length).toBeLessThanOrEqual(510);
  });

  it("has no duplicate symbols", () => {
    const symbols = SP500_CONSTITUENTS.map((c) => c.symbol);
    expect(new Set(symbols).size).toBe(symbols.length);
  });

  it("every entry has a non-empty symbol, name, and sector", () => {
    for (const constituent of SP500_CONSTITUENTS) {
      expect(constituent.symbol.length).toBeGreaterThan(0);
      expect(constituent.name.length).toBeGreaterThan(0);
      expect(constituent.sector.length).toBeGreaterThan(0);
    }
  });

  it("includes well-known large-cap tickers", () => {
    const symbols = new Set(SP500_CONSTITUENTS.map((c) => c.symbol));
    for (const ticker of ["AAPL", "MSFT", "GOOGL", "AMZN", "NVDA"]) {
      expect(symbols.has(ticker)).toBe(true);
    }
  });

  // Catches upstream data-quality artifacts (stray formatting characters
  // from the source dataset) that a mere non-empty check misses — this
  // exact class of bug shipped once already (a literal "|" in a name).
  const PLAUSIBLE_TEXT = /^[A-Za-z0-9 .,&'()\-–é!]+$/;

  it("names and sectors contain only plausible characters", () => {
    for (const constituent of SP500_CONSTITUENTS) {
      expect(constituent.name).toMatch(PLAUSIBLE_TEXT);
      expect(constituent.sector).toMatch(PLAUSIBLE_TEXT);
    }
  });

  it("symbols contain only letters and dots (e.g. BRK.B)", () => {
    for (const constituent of SP500_CONSTITUENTS) {
      expect(constituent.symbol).toMatch(/^[A-Z.]+$/);
    }
  });

  // Real S&P 500 index-weight magnitude (issue #230) -- sourced from
  // SSGA's published SPY holdings CSV/XLSX, see the file's own header
  // comment for the source, snapshot date, and join process.
  describe("weight", () => {
    it("every entry has a finite, positive weight", () => {
      for (const constituent of SP500_CONSTITUENTS) {
        expect(Number.isFinite(constituent.weight)).toBe(true);
        expect(constituent.weight).toBeGreaterThan(0);
      }
    });

    // A raw percentage-point value (e.g. 7.04 means ~7.04%), not a 0-1
    // fraction -- no single S&P 500 constituent's real weight has ever
    // approached 100% of the index, so this also catches an accidental
    // fraction-vs-percentage mixup at the source-parsing stage.
    it("no single weight is implausibly large (sanity bound, not a fraction)", () => {
      for (const constituent of SP500_CONSTITUENTS) {
        expect(constituent.weight).toBeLessThan(20);
      }
    });

    // Weights should sum close to 100 (a raw percentage-point scale) --
    // not exactly 100, since this snapshot's source (SSGA's SPY holdings)
    // includes a small amount of cash/other and a couple of non-S&P-500
    // residual lines this app's own constituent universe excludes (see
    // the file's header comment). A generous band, not a precise
    // cross-check -- the real number observed at snapshot time was
    // ~99.78.
    it("weights sum to roughly 100 (raw percentage points, not a fraction)", () => {
      const total = SP500_CONSTITUENTS.reduce((sum, c) => sum + c.weight, 0);
      expect(total).toBeGreaterThan(90);
      expect(total).toBeLessThanOrEqual(100);
    });

    // Mega-cap names should sit far above the smallest constituents --
    // catches a join bug that silently assigned every ticker the same
    // (or a near-uniform) placeholder weight instead of real magnitudes.
    it("large-cap tickers have a materially larger weight than small ones", () => {
      const bySymbol = new Map(SP500_CONSTITUENTS.map((c) => [c.symbol, c.weight]));
      const megaCapWeight = bySymbol.get("AAPL");
      const smallWeights = SP500_CONSTITUENTS.map((c) => c.weight).sort((a, b) => a - b);
      const medianWeight = smallWeights[Math.floor(smallWeights.length / 2)];
      expect(megaCapWeight).toBeGreaterThan(medianWeight! * 10);
    });

    // Rank is deliberately NOT a stored field (see the interface's own
    // doc comment) -- it's always this derived sort over `weight`. This
    // test exists to document/enforce that shape rather than to test any
    // library code.
    it("rank is derivable by sorting on weight, not stored separately", () => {
      const ranked = [...SP500_CONSTITUENTS].sort((a, b) => b.weight - a.weight);
      expect(ranked[0]!.weight).toBeGreaterThanOrEqual(ranked[ranked.length - 1]!.weight);
      expect("rank" in SP500_CONSTITUENTS[0]!).toBe(false);
      expect("marketCapRank" in SP500_CONSTITUENTS[0]!).toBe(false);
    });
  });
});
