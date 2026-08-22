import { describe, expect, it } from "vitest";

import { optimizeIntradayDays } from "./intraday-optimizer.js";
import type { IntradayBar } from "./yahoo-client.js";

/** Builds one ticker's intraday bars for a single day from [time, close] pairs, e.g. bars("2024-01-02", [["09:30:00", 10], ["10:30:00", 20]]). */
function bars(date: string, ticks: [string, number][]): IntradayBar[] {
  return ticks.map(([time, close]) => ({ date: `${date}T${time}`, close }));
}

function multiplier(startingCapital: number, endingBalance: number): number {
  return endingBalance / startingCapital;
}

describe("optimizeIntradayDays", () => {
  it("solves each day independently, with results in ascending date order", () => {
    // Day 1 (01-02): ticker A, buy 09:30@10 -> sell 10:30@20 = 2x.
    // Day 2 (01-03): ticker A, buy 09:30@5 -> sell 10:30@25 = 5x.
    const barsByTicker = new Map<string, IntradayBar[]>([
      [
        "A",
        [
          ...bars("2024-01-02", [
            ["09:30:00", 10],
            ["10:30:00", 20],
            ["11:30:00", 15],
          ]),
          ...bars("2024-01-03", [
            ["09:30:00", 5],
            ["10:30:00", 25],
            ["11:30:00", 12],
          ]),
        ],
      ],
    ]);

    const days = optimizeIntradayDays(barsByTicker, {
      startingCapital: 20,
      maxTradesPerDay: 1,
      barIntervalMinutes: 60,
    });

    expect(days.map((d) => d.date)).toEqual(["2024-01-02", "2024-01-03"]);
    expect(multiplier(20, days[0]!.endingBalance)).toBeCloseTo(2, 6);
    expect(multiplier(20, days[1]!.endingBalance)).toBeCloseTo(5, 6);
  });

  it("stamps barIntervalMinutes from the options onto every day it produces (issue #30)", () => {
    const barsByTicker = new Map<string, IntradayBar[]>([
      [
        "A",
        bars("2024-01-02", [
          ["09:30:00", 10],
          ["10:30:00", 20],
        ]),
      ],
    ]);

    const sixtyMinute = optimizeIntradayDays(barsByTicker, {
      startingCapital: 20,
      maxTradesPerDay: 1,
      barIntervalMinutes: 60,
    });
    const fiveMinute = optimizeIntradayDays(barsByTicker, {
      startingCapital: 20,
      maxTradesPerDay: 1,
      barIntervalMinutes: 5,
    });

    expect(sixtyMinute[0]!.barIntervalMinutes).toBe(60);
    expect(fiveMinute[0]!.barIntervalMinutes).toBe(5);
  });

  it("does not compound across days -- every day starts from the same startingCapital", () => {
    const barsByTicker = new Map<string, IntradayBar[]>([
      [
        "A",
        [
          ...bars("2024-01-02", [
            ["09:30:00", 10],
            ["10:30:00", 100], // a big day-1 gain
          ]),
          ...bars("2024-01-03", [
            ["09:30:00", 10],
            ["10:30:00", 20],
          ]),
        ],
      ],
    ]);

    const days = optimizeIntradayDays(barsByTicker, {
      startingCapital: 20,
      maxTradesPerDay: 1,
      barIntervalMinutes: 60,
    });

    // Day 2's startingCapital is the same $20 constant, not day 1's
    // (much larger) endingBalance.
    expect(days[0]!.startingCapital).toBe(20);
    expect(days[1]!.startingCapital).toBe(20);
    expect(multiplier(20, days[1]!.endingBalance)).toBeCloseTo(2, 6);
  });

  it("picks the better ticker per day, independently -- the best ticker can differ day to day", () => {
    const barsByTicker = new Map<string, IntradayBar[]>([
      [
        "A",
        [
          ...bars("2024-01-02", [
            ["09:30:00", 10],
            ["10:30:00", 30], // A wins day 1: 3x
          ]),
          ...bars("2024-01-03", [
            ["09:30:00", 10],
            ["10:30:00", 15], // A loses day 2: 1.5x
          ]),
        ],
      ],
      [
        "B",
        [
          ...bars("2024-01-02", [
            ["09:30:00", 10],
            ["10:30:00", 15], // B loses day 1: 1.5x
          ]),
          ...bars("2024-01-03", [
            ["09:30:00", 10],
            ["10:30:00", 40], // B wins day 2: 4x
          ]),
        ],
      ],
    ]);

    const days = optimizeIntradayDays(barsByTicker, {
      startingCapital: 20,
      maxTradesPerDay: 1,
      barIntervalMinutes: 60,
    });

    expect(days[0]!.trades).toEqual([
      {
        ticker: "A",
        direction: "long",
        date: "2024-01-02",
        openTime: "09:30:00",
        openPrice: 10,
        closeTime: "10:30:00",
        closePrice: 30,
      },
    ]);
    expect(days[1]!.trades).toEqual([
      {
        ticker: "B",
        direction: "long",
        date: "2024-01-03",
        openTime: "09:30:00",
        openPrice: 10,
        closeTime: "10:30:00",
        closePrice: 40,
      },
    ]);
  });

  it("respects maxTradesPerDay as a per-day cap, not a whole-window budget", () => {
    // Two clearly separate profitable windows in one day: 09:30->10:30 (2x)
    // and 12:30->13:30 (2x). With maxTradesPerDay: 1 only one is taken;
    // with maxTradesPerDay: 2 both are.
    const barsByTicker = new Map<string, IntradayBar[]>([
      [
        "A",
        bars("2024-01-02", [
          ["09:30:00", 10],
          ["10:30:00", 20],
          ["11:30:00", 20],
          ["12:30:00", 10],
          ["13:30:00", 20],
        ]),
      ],
    ]);

    const oneTrade = optimizeIntradayDays(barsByTicker, {
      startingCapital: 20,
      maxTradesPerDay: 1,
      barIntervalMinutes: 60,
    });
    const twoTrades = optimizeIntradayDays(barsByTicker, {
      startingCapital: 20,
      maxTradesPerDay: 2,
      barIntervalMinutes: 60,
    });

    expect(oneTrade[0]!.trades).toHaveLength(1);
    expect(twoTrades[0]!.trades).toHaveLength(2);
    expect(multiplier(20, twoTrades[0]!.endingBalance)).toBeGreaterThan(
      multiplier(20, oneTrade[0]!.endingBalance),
    );
  });

  it("omits a day entirely when no ticker has any bars for it", () => {
    const barsByTicker = new Map<string, IntradayBar[]>([
      [
        "A",
        bars("2024-01-02", [
          ["09:30:00", 10],
          ["10:30:00", 20],
        ]),
      ],
    ]);

    const days = optimizeIntradayDays(barsByTicker, {
      startingCapital: 20,
      maxTradesPerDay: 3,
      barIntervalMinutes: 60,
    });

    expect(days).toHaveLength(1);
    expect(days[0]!.date).toBe("2024-01-02");
  });

  it("handles a ticker that only has data on some days within the window", () => {
    const barsByTicker = new Map<string, IntradayBar[]>([
      [
        "A",
        bars("2024-01-02", [
          ["09:30:00", 10],
          ["10:30:00", 20],
        ]),
      ],
      [
        "B",
        // Only trades on day 2.
        bars("2024-01-03", [
          ["09:30:00", 5],
          ["10:30:00", 25],
        ]),
      ],
    ]);

    const days = optimizeIntradayDays(barsByTicker, {
      startingCapital: 20,
      maxTradesPerDay: 1,
      barIntervalMinutes: 60,
    });

    expect(days.map((d) => d.date)).toEqual(["2024-01-02", "2024-01-03"]);
    expect(days[0]!.trades[0]!.ticker).toBe("A");
    expect(days[1]!.trades[0]!.ticker).toBe("B");
  });

  it("returns no trades for a day with no profitable move (a flat/declining day)", () => {
    const barsByTicker = new Map<string, IntradayBar[]>([
      [
        "A",
        bars("2024-01-02", [
          ["09:30:00", 20],
          ["10:30:00", 10],
        ]),
      ],
    ]);

    const days = optimizeIntradayDays(barsByTicker, {
      startingCapital: 20,
      maxTradesPerDay: 3,
      barIntervalMinutes: 60,
    });

    expect(days[0]!.trades).toEqual([]);
    expect(days[0]!.endingBalance).toBe(20);
  });

  describe("worstCase (issue #31)", () => {
    it("computes each day's worst achievable outcome alongside its optimal one", () => {
      // Same day, two tickers: A rises (2x, the optimal trade), B falls
      // (0.5x, the worst trade).
      const barsByTicker = new Map<string, IntradayBar[]>([
        [
          "A",
          bars("2024-01-02", [
            ["09:30:00", 10],
            ["10:30:00", 20],
          ]),
        ],
        [
          "B",
          bars("2024-01-02", [
            ["09:30:00", 20],
            ["10:30:00", 10],
          ]),
        ],
      ]);

      const days = optimizeIntradayDays(barsByTicker, {
        startingCapital: 20,
        maxTradesPerDay: 1,
        barIntervalMinutes: 60,
      });

      expect(multiplier(20, days[0]!.endingBalance)).toBeCloseTo(2, 6);
      expect(days[0]!.trades[0]!.ticker).toBe("A");
      expect(multiplier(20, days[0]!.worstCase.endingBalance)).toBeCloseTo(0.5, 6);
      expect(days[0]!.worstCase.trades).toEqual([
        {
          ticker: "B",
          direction: "long",
          date: "2024-01-02",
          openTime: "09:30:00",
          openPrice: 20,
          closeTime: "10:30:00",
          closePrice: 10,
        },
      ]);
    });

    it("never reports a worst-case endingBalance higher than that same day's optimal endingBalance, across every day it produces", () => {
      const barsByTicker = new Map<string, IntradayBar[]>([
        [
          "A",
          [
            ...bars("2024-01-02", [
              ["09:30:00", 10],
              ["10:30:00", 20],
              ["11:30:00", 5],
            ]),
            ...bars("2024-01-03", [
              ["09:30:00", 15],
              ["10:30:00", 10],
              ["11:30:00", 30],
            ]),
          ],
        ],
      ]);

      const days = optimizeIntradayDays(barsByTicker, {
        startingCapital: 20,
        maxTradesPerDay: 2,
        barIntervalMinutes: 60,
      });

      expect(days.length).toBeGreaterThan(0);
      for (const day of days) {
        expect(day.worstCase.endingBalance).toBeLessThanOrEqual(day.endingBalance);
      }
    });

    it("stamps a flat day's worstCase.endingBalance at startingCapital when no losing trade is available (the rare 'still a gain' edge case)", () => {
      const barsByTicker = new Map<string, IntradayBar[]>([
        [
          "A",
          bars("2024-01-02", [
            ["09:30:00", 10],
            ["10:30:00", 20],
            ["11:30:00", 30],
          ]),
        ],
      ]);

      const days = optimizeIntradayDays(barsByTicker, {
        startingCapital: 20,
        maxTradesPerDay: 3,
        barIntervalMinutes: 60,
      });

      // Every possible trade on this day is a gain, so the worst-case
      // search takes zero trades rather than force a gain into the
      // "worst case" slot (see optimizeWorstTrades's own doc comment).
      expect(days[0]!.worstCase.endingBalance).toBe(20);
      expect(days[0]!.worstCase.trades).toEqual([]);
    });
  });

  describe("longShort (issue #13)", () => {
    it("captures a purely declining day's short profit, which the long-only fields miss entirely", () => {
      const barsByTicker = new Map<string, IntradayBar[]>([
        [
          "A",
          bars("2024-01-02", [
            ["09:30:00", 100],
            ["10:30:00", 50],
          ]),
        ],
      ]);

      const days = optimizeIntradayDays(barsByTicker, {
        startingCapital: 20,
        maxTradesPerDay: 1,
        barIntervalMinutes: 60,
      });

      expect(days[0]!.trades).toEqual([]);
      expect(days[0]!.endingBalance).toBe(20);

      expect(days[0]!.longShort.trades).toEqual([
        {
          ticker: "A",
          direction: "short",
          date: "2024-01-02",
          openTime: "09:30:00",
          openPrice: 100,
          closeTime: "10:30:00",
          closePrice: 50,
        },
      ]);
      expect(multiplier(20, days[0]!.longShort.endingBalance)).toBeCloseTo(2, 6);
    });

    it("never reports a longShort.endingBalance below that same day's long-only endingBalance, or a longShort.worstCase.endingBalance above the long-only worstCase, across every day it produces", () => {
      const barsByTicker = new Map<string, IntradayBar[]>([
        [
          "A",
          [
            ...bars("2024-01-02", [
              ["09:30:00", 10],
              ["10:30:00", 20],
              ["11:30:00", 5],
            ]),
            ...bars("2024-01-03", [
              ["09:30:00", 15],
              ["10:30:00", 10],
              ["11:30:00", 30],
            ]),
          ],
        ],
      ]);

      const days = optimizeIntradayDays(barsByTicker, {
        startingCapital: 20,
        maxTradesPerDay: 2,
        barIntervalMinutes: 60,
      });

      expect(days.length).toBeGreaterThan(0);
      for (const day of days) {
        expect(day.longShort.endingBalance).toBeGreaterThanOrEqual(day.endingBalance);
        expect(day.longShort.worstCase.endingBalance).toBeLessThanOrEqual(
          day.worstCase.endingBalance,
        );
        expect(day.longShort.worstCase.endingBalance).toBeLessThanOrEqual(
          day.longShort.endingBalance,
        );
      }
    });

    it("stamps barIntervalMinutes-consistent trades through the longShort field too", () => {
      const barsByTicker = new Map<string, IntradayBar[]>([
        [
          "A",
          bars("2024-01-02", [
            ["09:30:00", 100],
            ["10:30:00", 50],
          ]),
        ],
      ]);

      const days = optimizeIntradayDays(barsByTicker, {
        startingCapital: 20,
        maxTradesPerDay: 1,
        barIntervalMinutes: 5,
      });

      expect(days[0]!.barIntervalMinutes).toBe(5);
      expect(days[0]!.longShort.trades[0]!.direction).toBe("short");
    });
  });
});
