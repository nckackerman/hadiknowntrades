import { describe, expect, it } from "vitest";

import type { IntradayDayResult, IntradayTrade } from "@hadiknowntrades/core";

import { dailyChallengeFor, DAILY_CHALLENGE_STARTING_CAPITAL } from "./daily-challenge";

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
    // $20, so a test that accidentally reads this field instead of
    // recompounding from DAILY_CHALLENGE_STARTING_CAPITAL fails loudly.
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

describe("dailyChallengeFor", () => {
  it("always starts from a fresh $20, not the day's own chained startingCapital", () => {
    const challenge = dailyChallengeFor(day(), "long");
    expect(challenge.startingCapital).toBe(DAILY_CHALLENGE_STARTING_CAPITAL);
  });

  it("recompounds the day's own long-only trades from $20", () => {
    const challenge = dailyChallengeFor(day(), "long");
    // 20 * (172.80 / 170.10)
    expect(challenge.endingBalance).toBeCloseTo(20 * (172.8 / 170.1));
    expect(challenge.trades).toEqual([trade()]);
  });

  it("carries the day's own date through unchanged", () => {
    const challenge = dailyChallengeFor(day({ date: "2026-08-24" }), "long");
    expect(challenge.date).toBe("2026-08-24");
  });

  it("selects the long+short variant's own trades under long-short mode (issue #13)", () => {
    const challenge = dailyChallengeFor(day(), "long-short");
    expect(challenge.trades).toEqual([trade({ ticker: "SHORTED", direction: "short" })]);
    // 20 * (170.10 / 172.80) -- a short's payoff is openPrice/closePrice.
    expect(challenge.endingBalance).toBeCloseTo(20 * (170.1 / 172.8));
  });

  it("compounds multiple trades in sequence, not just the last one", () => {
    const challenge = dailyChallengeFor(
      day({
        trades: [
          trade({ ticker: "AVGO", openPrice: 170.1, closePrice: 172.8 }),
          trade({ ticker: "PLTR", openPrice: 84.5, closePrice: 87.1 }),
        ],
      }),
      "long",
    );
    const expected = 20 * (172.8 / 170.1) * (87.1 / 84.5);
    expect(challenge.endingBalance).toBeCloseTo(expected);
  });

  it("returns a $20 flat result (no gain, no throw) for a day with no trades", () => {
    const challenge = dailyChallengeFor(day({ trades: [] }), "long");
    expect(challenge.endingBalance).toBe(DAILY_CHALLENGE_STARTING_CAPITAL);
    expect(challenge.trades).toEqual([]);
  });
});
