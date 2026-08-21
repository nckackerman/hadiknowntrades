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
});
