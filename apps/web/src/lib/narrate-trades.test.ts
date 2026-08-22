import { describe, expect, it } from "vitest";

import { narrateTrades, type NarratableTrade } from "./narrate-trades";

function trade(overrides: Partial<NarratableTrade> = {}): NarratableTrade {
  return {
    ticker: "AAPL",
    direction: "long",
    buyLabel: "Mar 12, 2025",
    buyPrice: 100,
    sellLabel: "Mar 19, 2025",
    sellPrice: 125,
    ...overrides,
  };
}

describe("narrateTrades", () => {
  it("returns an empty array for a 0-trade sequence, without throwing", () => {
    expect(narrateTrades([], 20)).toEqual([]);
  });

  it("narrates a single trade with the 'Had you known' lead-in and startingCapital as its start balance", () => {
    const [narration] = narrateTrades([trade()], 20);

    expect(narration).toBeDefined();
    expect(narration!.leadIn).toBe("Had you known, you'd have");
    expect(narration!.ticker).toBe("AAPL");
    expect(narration!.startBalance).toBe(20);
    expect(narration!.endBalance).toBeCloseTo(25); // 20 * 125/100
    expect(narration!.returnFraction).toBeCloseTo(0.25);
    expect(narration!.isGain).toBe(true);
  });

  it("narrates a 2-trade sequence: first trade gets 'Had you known', the (also last) second trade gets 'Finally'", () => {
    const narrations = narrateTrades(
      [trade({ ticker: "AAPL" }), trade({ ticker: "MSFT", buyPrice: 200, sellPrice: 250 })],
      20,
    );

    expect(narrations.map((n) => n.leadIn)).toEqual([
      "Had you known, you'd have",
      "Finally, you'd have",
    ]);
    // Compounds: 20 -> 25 (AAPL, +25%) -> 31.25 (MSFT, +25%).
    expect(narrations[0]!.endBalance).toBeCloseTo(25);
    expect(narrations[1]!.startBalance).toBeCloseTo(25);
    expect(narrations[1]!.endBalance).toBeCloseTo(31.25);
  });

  it("narrates a 3-trade sequence with 'Had you known' / 'Then' / 'Finally' lead-ins, compounding balance across all three", () => {
    const narrations = narrateTrades(
      [
        trade({ ticker: "AAPL", buyPrice: 100, sellPrice: 150 }), // x1.5
        trade({ ticker: "MSFT", buyPrice: 200, sellPrice: 200 }), // flat
        trade({ ticker: "TSLA", buyPrice: 50, sellPrice: 25 }), // x0.5 (loss)
      ],
      20,
    );

    expect(narrations.map((n) => n.leadIn)).toEqual([
      "Had you known, you'd have",
      "Then you'd have",
      "Finally, you'd have",
    ]);
    expect(narrations[0]!.endBalance).toBeCloseTo(30); // 20 * 1.5
    expect(narrations[1]!.endBalance).toBeCloseTo(30); // flat leg
    expect(narrations[1]!.isGain).toBe(true); // flat counts as a gain, matching TradeRow's convention
    expect(narrations[2]!.endBalance).toBeCloseTo(15); // 30 * 0.5
    expect(narrations[2]!.returnFraction).toBeCloseTo(-0.5);
    expect(narrations[2]!.isGain).toBe(false);
  });

  it("handles a loss leg (sellPrice < buyPrice) generically -- not assuming every trade is a gain (issue #31 territory)", () => {
    const [narration] = narrateTrades([trade({ buyPrice: 200, sellPrice: 150 })], 20);

    expect(narration!.returnFraction).toBeCloseTo(-0.25);
    expect(narration!.isGain).toBe(false);
    expect(narration!.endBalance).toBeCloseTo(15); // 20 * 150/200
    expect(narration!.endBalance).toBeLessThan(narration!.startBalance);
  });

  it("compounds to an astronomically large ending balance for a Max-range-scale sequence, still just a finite number for the caller to format", () => {
    // Modeled on packages/core/CLAUDE.md's real ~$716M-from-$20 note: a
    // few huge-multiple legs compounding from a small starting capital.
    const narrations = narrateTrades(
      [
        trade({ ticker: "A", buyPrice: 1, sellPrice: 300 }),
        trade({ ticker: "B", buyPrice: 1, sellPrice: 400 }),
        trade({ ticker: "C", buyPrice: 1, sellPrice: 300 }),
      ],
      20,
    );

    const finalBalance = narrations[2]!.endBalance;
    expect(finalBalance).toBeCloseTo(20 * 300 * 400 * 300); // 720,000,000
    expect(Number.isFinite(finalBalance)).toBe(true);
  });

  describe("short trades (issue #13)", () => {
    it("uses 'shorted'/'covered' verbs and the reciprocal-price payoff for a short leg", () => {
      // Opened @100, covered @80 (price fell): payoff 100/80 = 1.25.
      const [narration] = narrateTrades(
        [trade({ direction: "short", buyPrice: 100, sellPrice: 80 })],
        20,
      );

      expect(narration!.direction).toBe("short");
      expect(narration!.openVerb).toBe("shorted");
      expect(narration!.closeVerb).toBe("covered");
      expect(narration!.endBalance).toBeCloseTo(25); // 20 * 100/80
      expect(narration!.returnFraction).toBeCloseTo(0.25);
      expect(narration!.isGain).toBe(true);
    });

    it("uses 'bought'/'sold' verbs for a long leg, unchanged", () => {
      const [narration] = narrateTrades([trade({ direction: "long" })], 20);
      expect(narration!.openVerb).toBe("bought");
      expect(narration!.closeVerb).toBe("sold");
    });

    it("a short loses money (isGain=false) when the price rose instead of fell", () => {
      const [narration] = narrateTrades(
        [trade({ direction: "short", buyPrice: 100, sellPrice: 125 })],
        20,
      );

      expect(narration!.returnFraction).toBeCloseTo(-0.2); // 100/125 - 1
      expect(narration!.isGain).toBe(false);
      expect(narration!.endBalance).toBeLessThan(narration!.startBalance);
    });

    it("compounds a mixed long+short sequence correctly", () => {
      const narrations = narrateTrades(
        [
          trade({ ticker: "A", direction: "long", buyPrice: 10, sellPrice: 20 }), // x2
          trade({ ticker: "B", direction: "short", buyPrice: 50, sellPrice: 25 }), // x2 (price fell)
        ],
        20,
      );

      expect(narrations[0]!.endBalance).toBeCloseTo(40); // 20 * 2
      expect(narrations[1]!.startBalance).toBeCloseTo(40);
      expect(narrations[1]!.endBalance).toBeCloseTo(80); // 40 * 2
    });
  });
});
