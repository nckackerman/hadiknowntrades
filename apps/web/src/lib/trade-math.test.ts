import { describe, expect, it } from "vitest";

import type { Trade } from "@hadiknowntrades/core";

import { derivePortfolioSeries } from "./portfolio-series";
import { narrateTrades } from "./narrate-trades";
import { compoundBalance, computeTradeReturn, InvalidTradePriceError } from "./trade-math";

describe("computeTradeReturn", () => {
  describe("direction: long", () => {
    it("returns a positive returnFraction and isGain=true for a gaining leg", () => {
      expect(computeTradeReturn(100, 125, "long")).toEqual({ returnFraction: 0.25, isGain: true });
    });

    it("returns a negative returnFraction and isGain=false for a losing leg", () => {
      expect(computeTradeReturn(200, 150, "long")).toEqual({
        returnFraction: -0.25,
        isGain: false,
      });
    });

    it("treats an exactly flat leg as a gain (returnFraction === 0, isGain=true)", () => {
      expect(computeTradeReturn(100, 100, "long")).toEqual({ returnFraction: 0, isGain: true });
    });
  });

  describe("direction: short (issue #13)", () => {
    it("returns a positive returnFraction and isGain=true when the price fell (a short's profit)", () => {
      // Opened @100, covered @80 -- price fell, a short profits: 100/80 - 1 = 0.25.
      expect(computeTradeReturn(100, 80, "short")).toEqual({ returnFraction: 0.25, isGain: true });
    });

    it("returns a negative returnFraction and isGain=false when the price rose (a short's loss)", () => {
      // Opened @100, covered @125 -- price rose, a short loses: 100/125 - 1 = -0.2.
      const { returnFraction, isGain } = computeTradeReturn(100, 125, "short");
      expect(returnFraction).toBeCloseTo(-0.2);
      expect(isGain).toBe(false);
    });

    it("treats an exactly flat leg as a gain, same convention as long", () => {
      expect(computeTradeReturn(100, 100, "short")).toEqual({ returnFraction: 0, isGain: true });
    });
  });

  it("throws InvalidTradePriceError instead of silently computing Infinity/NaN for a non-finite or non-positive price, for both directions", () => {
    // A zero/non-finite openPrice would otherwise make returnFraction
    // Infinity/NaN, and Infinity >= 0 is true -- isGain would silently
    // read as a "gain" for corrupted data instead of surfacing the
    // problem (see InvalidTradePriceError's own doc comment).
    expect(() => computeTradeReturn(0, 125, "long")).toThrow(InvalidTradePriceError);
    expect(() => computeTradeReturn(-5, 125, "long")).toThrow(InvalidTradePriceError);
    expect(() => computeTradeReturn(NaN, 125, "long")).toThrow(InvalidTradePriceError);
    expect(() => computeTradeReturn(100, Infinity, "long")).toThrow(InvalidTradePriceError);
    expect(() => computeTradeReturn(0, 125, "short")).toThrow(InvalidTradePriceError);
    expect(() => computeTradeReturn(100, NaN, "short")).toThrow(InvalidTradePriceError);
  });
});

describe("compoundBalance", () => {
  describe("direction: long", () => {
    it("scales the starting balance by the closePrice/openPrice ratio", () => {
      expect(compoundBalance(20, 100, 125, "long")).toBeCloseTo(25);
    });

    it("shrinks the balance for a losing leg", () => {
      expect(compoundBalance(20, 200, 150, "long")).toBeCloseTo(15);
    });
  });

  describe("direction: short (issue #13)", () => {
    it("scales the starting balance by the openPrice/closePrice ratio -- mirrors optimizer.ts's own reciprocal-price payoff", () => {
      expect(compoundBalance(20, 100, 80, "short")).toBeCloseTo(25);
    });

    it("shrinks the balance for a short that loses (price rose)", () => {
      expect(compoundBalance(20, 100, 125, "short")).toBeCloseTo(16);
    });

    it("never goes negative -- a short's payoff under this model is bounded below by 0, unlike a real short's unbounded downside (optimizer.ts's own header comment)", () => {
      expect(compoundBalance(20, 100, 100_000, "short")).toBeGreaterThan(0);
    });
  });

  it("throws InvalidTradePriceError for a non-finite or non-positive price, independently of computeTradeReturn's own check, for both directions", () => {
    expect(() => compoundBalance(20, 0, 125, "long")).toThrow(InvalidTradePriceError);
    expect(() => compoundBalance(20, 100, NaN, "long")).toThrow(InvalidTradePriceError);
    expect(() => compoundBalance(20, 0, 125, "short")).toThrow(InvalidTradePriceError);
    expect(() => compoundBalance(20, 100, NaN, "short")).toThrow(InvalidTradePriceError);
  });
});

/**
 * Regression guard against the exact drift issue #32's code review
 * flagged: narrate-trades.ts's running-balance loop and
 * portfolio-series.ts's appendTradeSteps used to be two independent
 * re-implementations of the same multiplicative compounding chain. Now
 * that both call trade-math.ts's compoundBalance, this asserts they
 * still agree on the same trade sequence's balance at every close point
 * -- if either call site ever drifts back to its own arithmetic, this
 * test catches it. Includes a short leg (issue #13) so the direction
 * threading itself is covered by this cross-check too, not just each
 * function in isolation.
 */
describe("narrateTrades and derivePortfolioSeries agree on running balance", () => {
  it("produces the same sequence of post-trade balances for the same trades and startingCapital", () => {
    const trades: Trade[] = [
      {
        ticker: "AAA",
        direction: "long",
        openDate: "2025-01-02",
        openPrice: 10,
        closeDate: "2025-01-10",
        closePrice: 20,
      },
      {
        ticker: "BBB",
        direction: "short",
        openDate: "2025-01-15",
        openPrice: 5,
        closeDate: "2025-01-20",
        closePrice: 4,
      },
      {
        ticker: "CCC",
        direction: "long",
        openDate: "2025-01-25",
        openPrice: 8,
        closeDate: "2025-01-30",
        closePrice: 24,
      },
    ];
    const startingCapital = 20;

    const narrations = narrateTrades(
      trades.map((trade) => ({
        ticker: trade.ticker,
        direction: trade.direction,
        buyLabel: trade.openDate,
        buyPrice: trade.openPrice,
        sellLabel: trade.closeDate,
        sellPrice: trade.closePrice,
      })),
      startingCapital,
    );

    const points = derivePortfolioSeries(startingCapital, "2025-01-01", "2025-02-01", trades);
    const closeBalances = points.filter((p) => p.event?.type === "close").map((p) => p.value);

    expect(narrations.map((n) => n.endBalance)).toEqual(closeBalances);
  });
});
