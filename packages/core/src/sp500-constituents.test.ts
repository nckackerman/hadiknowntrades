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
});
