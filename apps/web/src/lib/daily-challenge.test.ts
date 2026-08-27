import { describe, expect, it } from "vitest";

import type { IntradayDayResult, IntradayTrade } from "@hadiknowntrades/core";

import { dailyChallengeFor, dailyChallengeStartingCapitalFor } from "./daily-challenge";

function trade(overrides: Partial<IntradayTrade> = {}): IntradayTrade {
  return {
    ticker: "AVGO",
    direction: "long",
    date: "2026-08-25",
    openTime: "09:35:00",
    openPrice: 170.1,
    closeTime: "10:40:00",
    closePrice: 172.8,
    ...overrides,
  };
}

function day(overrides: Partial<IntradayDayResult> = {}): IntradayDayResult {
  return {
    date: "2026-08-25",
    // A real, chained (issue #84) startingCapital -- deliberately NOT
    // what dailyChallengeStartingCapitalFor(date) returns, so a test
    // that accidentally reads this field instead of the seeded one
    // fails loudly.
    startingCapital: 28.12,
    endingBalance: 34.5,
    barIntervalMinutes: 60,
    trades: [trade()],
    worstCase: { startingCapital: 28.12, endingBalance: 27, trades: [] },
    longShort: {
      startingCapital: 30,
      endingBalance: 40,
      trades: [trade({ ticker: "SHORTED", direction: "short" })],
      worstCase: { startingCapital: 30, endingBalance: 29, trades: [] },
    },
    ...overrides,
  };
}

describe("dailyChallengeStartingCapitalFor", () => {
  it("is a pure function: the same date always returns the exact same value", () => {
    const first = dailyChallengeStartingCapitalFor("2026-08-25");
    const second = dailyChallengeStartingCapitalFor("2026-08-25");
    expect(first).toBe(second);
  });

  it("returns different values for different dates (sanity check over a handful of real consecutive dates)", () => {
    const dates = ["2026-08-24", "2026-08-25", "2026-08-26", "2026-08-27", "2026-08-28"];
    const values = dates.map(dailyChallengeStartingCapitalFor);
    expect(new Set(values).size).toBe(values.length);
  });

  it("always returns a value in [1, 10000) across a wide sample of dates", () => {
    for (let i = 0; i < 1000; i += 1) {
      const date = `synthetic-date-${String(i).padStart(4, "0")}`;
      const value = dailyChallengeStartingCapitalFor(date);
      expect(value).toBeGreaterThanOrEqual(1);
      expect(value).toBeLessThan(10000);
    }
  });
});

describe("dailyChallengeFor", () => {
  it("always starts from the date-seeded starting capital, not the day's own chained startingCapital", () => {
    const challenge = dailyChallengeFor(day(), "long");
    expect(challenge.startingCapital).toBe(dailyChallengeStartingCapitalFor(day().date));
    expect(challenge.startingCapital).not.toBe(day().startingCapital);
  });

  it("recompounds the day's own long-only trades from its seeded starting capital", () => {
    const challenge = dailyChallengeFor(day(), "long");
    const expectedStart = dailyChallengeStartingCapitalFor(day().date);
    expect(challenge.endingBalance).toBeCloseTo(expectedStart * (172.8 / 170.1));
    expect(challenge.trades).toEqual([trade()]);
  });

  it("carries the day's own date through unchanged", () => {
    const challenge = dailyChallengeFor(day({ date: "2026-08-24" }), "long");
    expect(challenge.date).toBe("2026-08-24");
  });

  it("selects the long+short variant's own trades under long-short mode (issue #13)", () => {
    const challenge = dailyChallengeFor(day(), "long-short");
    const expectedStart = dailyChallengeStartingCapitalFor(day().date);
    expect(challenge.trades).toEqual([trade({ ticker: "SHORTED", direction: "short" })]);
    // A short's payoff is openPrice/closePrice.
    expect(challenge.endingBalance).toBeCloseTo(expectedStart * (170.1 / 172.8));
  });

  it("compounds multiple trades in sequence, not just the last one", () => {
    const multiTradeDay = day({
      trades: [
        trade({ ticker: "AVGO", openPrice: 170.1, closePrice: 172.8 }),
        trade({ ticker: "PLTR", openPrice: 84.5, closePrice: 87.1 }),
      ],
    });
    const challenge = dailyChallengeFor(multiTradeDay, "long");
    const expectedStart = dailyChallengeStartingCapitalFor(multiTradeDay.date);
    const expected = expectedStart * (172.8 / 170.1) * (87.1 / 84.5);
    expect(challenge.endingBalance).toBeCloseTo(expected);
  });

  it("returns a flat result (no gain, no throw) for a day with no trades", () => {
    const challenge = dailyChallengeFor(day({ trades: [] }), "long");
    expect(challenge.endingBalance).toBe(challenge.startingCapital);
    expect(challenge.trades).toEqual([]);
  });

  it("changes only startingCapital/endingBalance across different dates -- trades stay byte-identical for the same underlying trade content (acceptance criteria: trades/tickers/percentage-returns unaffected by the seed)", () => {
    const sharedTrades = [trade({ ticker: "AVGO", openPrice: 170.1, closePrice: 172.8 })];
    const dayA = day({ date: "2026-08-24", trades: sharedTrades });
    const dayB = day({ date: "2026-08-25", trades: sharedTrades });

    const challengeA = dailyChallengeFor(dayA, "long");
    const challengeB = dailyChallengeFor(dayB, "long");

    expect(challengeA.trades).toEqual(challengeB.trades);
    expect(challengeA.startingCapital).not.toBe(challengeB.startingCapital);
  });
});
