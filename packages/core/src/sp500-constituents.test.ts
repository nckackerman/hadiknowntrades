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
  // SSGA's published SPY holdings .xlsx (SSGA does not publish a CSV
  // variant of this file -- a `.csv` extension 404s, see the file's own
  // header comment), see that comment for the source, snapshot date,
  // and join process.
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

    // Two independently-sourced real weights matching to 6 decimal
    // places is a strong signal of a parsing/join bug (e.g. a reused
    // sharedStrings index or a copy-pasted row) -- exactly the class of
    // bug a code review flagged for IP/ZBH's shared 0.027834. Re-checked
    // directly against SSGA's raw source XML for this refresh: separate
    // rows (405/406), separate cell styles, separate "Shares Held"
    // figures (6,460,208 vs 2,365,258), independent numeric <v> cells --
    // not a copy/reuse artifact -- and a fresh re-download of the same
    // URL came back byte-identical, so it isn't a corrupted/partial
    // fetch either. A live cross-check against real market prices/share
    // counts confirmed both are independently plausible at ~0.0278% (see
    // packages/core/CLAUDE.md). With 116 of this file's 503 constituents
    // packed into just the [0.02, 0.04] weight band (~0.0001-0.0002
    // apart), one coincidental 6-decimal tie among 503 real published
    // values is a real, if notable, coincidence -- not a bug. This test
    // allows exactly that one documented tie and fails on any other
    // exact-weight collision, which a future refresh's join bug would
    // very likely produce.
    it("no two constituents share an exact weight, other than the one documented, source-verified coincidence (IP/ZBH)", () => {
      const KNOWN_COINCIDENTAL_TIES: ReadonlySet<string>[] = [new Set(["IP", "ZBH"])];

      const symbolsByWeight = new Map<number, string[]>();
      for (const constituent of SP500_CONSTITUENTS) {
        const symbols = symbolsByWeight.get(constituent.weight) ?? [];
        symbols.push(constituent.symbol);
        symbolsByWeight.set(constituent.weight, symbols);
      }

      const duplicateGroups = [...symbolsByWeight.values()].filter((symbols) => symbols.length > 1);
      const unexpectedDuplicates = duplicateGroups.filter(
        (symbols) =>
          !KNOWN_COINCIDENTAL_TIES.some(
            (known) => known.size === symbols.length && symbols.every((s) => known.has(s)),
          ),
      );

      expect(unexpectedDuplicates).toEqual([]);
      // Also confirm the one known tie is still actually present (not
      // stale) -- if a future refresh's real data resolves it, this
      // should be caught and the allowlist above trimmed, not silently
      // pass either way.
      expect(duplicateGroups).toContainEqual(expect.arrayContaining(["IP", "ZBH"]));
    });
  });
});
