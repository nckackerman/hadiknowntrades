import { describe, expect, it } from "vitest";

import type { Trade } from "@hadiknowntrades/core";

import { derivePortfolioSeries } from "./portfolio-series";
import { narrateTrades } from "./narrate-trades";
import { compoundBalance, computeTradeReturn, InvalidTradePriceError } from "./trade-math";

describe("computeTradeReturn", () => {
  it("returns a positive returnFraction and isGain=true for a gaining leg", () => {
    expect(computeTradeReturn(100, 125)).toEqual({ returnFraction: 0.25, isGain: true });
  });

  it("returns a negative returnFraction and isGain=false for a losing leg", () => {
    expect(computeTradeReturn(200, 150)).toEqual({ returnFraction: -0.25, isGain: false });
  });

  it("treats an exactly flat leg as a gain (returnFraction === 0, isGain=true)", () => {
    expect(computeTradeReturn(100, 100)).toEqual({ returnFraction: 0, isGain: true });
  });

  it("throws InvalidTradePriceError instead of silently computing Infinity/NaN for a non-finite or non-positive price", () => {
    // A zero/non-finite buyPrice would otherwise make returnFraction
    // Infinity/NaN, and Infinity >= 0 is true -- isGain would silently
    // read as a "gain" for corrupted data instead of surfacing the
    // problem (see InvalidTradePriceError's own doc comment).
    expect(() => computeTradeReturn(0, 125)).toThrow(InvalidTradePriceError);
    expect(() => computeTradeReturn(-5, 125)).toThrow(InvalidTradePriceError);
    expect(() => computeTradeReturn(NaN, 125)).toThrow(InvalidTradePriceError);
    expect(() => computeTradeReturn(100, Infinity)).toThrow(InvalidTradePriceError);
  });
});

describe("compoundBalance", () => {
  it("scales the starting balance by the sellPrice/buyPrice ratio", () => {
    expect(compoundBalance(20, 100, 125)).toBeCloseTo(25);
  });

  it("shrinks the balance for a losing leg", () => {
    expect(compoundBalance(20, 200, 150)).toBeCloseTo(15);
  });

  it("throws InvalidTradePriceError for a non-finite or non-positive price, independently of computeTradeReturn's own check", () => {
    expect(() => compoundBalance(20, 0, 125)).toThrow(InvalidTradePriceError);
    expect(() => compoundBalance(20, 100, NaN)).toThrow(InvalidTradePriceError);
  });
});

/**
 * Regression guard against the exact drift issue #32's code review
 * flagged: narrate-trades.ts's running-balance loop and
 * portfolio-series.ts's appendTradeSteps used to be two independent
 * re-implementations of the same multiplicative compounding chain. Now
 * that both call trade-math.ts's compoundBalance, this asserts they
 * still agree on the same trade sequence's balance at every sell point
 * -- if either call site ever drifts back to its own arithmetic, this
 * test catches it.
 */
describe("narrateTrades and derivePortfolioSeries agree on running balance", () => {
  it("produces the same sequence of post-trade balances for the same trades and startingCapital", () => {
    const trades: Trade[] = [
      { ticker: "AAA", buyDate: "2025-01-02", buyPrice: 10, sellDate: "2025-01-10", sellPrice: 20 },
      { ticker: "BBB", buyDate: "2025-01-15", buyPrice: 5, sellDate: "2025-01-20", sellPrice: 4 },
      { ticker: "CCC", buyDate: "2025-01-25", buyPrice: 8, sellDate: "2025-01-30", sellPrice: 24 },
    ];
    const startingCapital = 20;

    const narrations = narrateTrades(
      trades.map((trade) => ({
        ticker: trade.ticker,
        buyLabel: trade.buyDate,
        buyPrice: trade.buyPrice,
        sellLabel: trade.sellDate,
        sellPrice: trade.sellPrice,
      })),
      startingCapital,
    );

    const points = derivePortfolioSeries(startingCapital, "2025-01-01", "2025-02-01", trades);
    const sellBalances = points.filter((p) => p.event?.type === "sell").map((p) => p.value);

    expect(narrations.map((n) => n.endBalance)).toEqual(sellBalances);
  });
});
