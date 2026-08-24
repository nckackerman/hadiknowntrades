import type { IntradayTrade, Trade } from "@hadiknowntrades/core";
import { describe, expect, it } from "vitest";

import {
  deriveIntradayPortfolioSeries,
  deriveWholeRangeIntradaySeries,
  derivePortfolioSeries,
  spansMultipleDays,
} from "./portfolio-series";

function trade(overrides: Partial<Trade>): Trade {
  return {
    ticker: "AAA",
    direction: "long",
    openDate: "2025-01-02",
    openPrice: 10,
    closeDate: "2025-01-10",
    closePrice: 20,
    ...overrides,
  };
}

function intradayTrade(overrides: Partial<IntradayTrade>): IntradayTrade {
  return {
    ticker: "AAA",
    direction: "long",
    date: "2025-01-02",
    openTime: "09:30:00",
    openPrice: 10,
    closeTime: "10:30:00",
    closePrice: 20,
    ...overrides,
  };
}

describe("derivePortfolioSeries", () => {
  it("is flat at startingCapital for the whole window when there are no trades", () => {
    const points = derivePortfolioSeries(20, "2025-01-01", "2025-02-01", []);

    expect(points).toEqual([
      { date: "2025-01-01", value: 20, event: null },
      { date: "2025-02-01", value: 20, event: null },
    ]);
  });

  it("derives a single trade as flat, open annotation, flat through the hold, then a jump at close", () => {
    const trades = [trade({})];
    const points = derivePortfolioSeries(20, "2025-01-01", "2025-02-01", trades);

    expect(points).toEqual([
      { date: "2025-01-01", value: 20, event: null },
      {
        date: "2025-01-02",
        value: 20,
        event: { type: "open", direction: "long", ticker: "AAA", price: 10 },
      },
      { date: "2025-01-10", value: 20, event: null },
      {
        date: "2025-01-10",
        value: 40,
        event: { type: "close", direction: "long", ticker: "AAA", price: 20 },
      },
      { date: "2025-02-01", value: 40, event: null },
    ]);
  });

  it("compounds value across multiple sequential trades", () => {
    const trades = [
      trade({
        ticker: "AAA",
        openDate: "2025-01-02",
        openPrice: 10,
        closeDate: "2025-01-10",
        closePrice: 20,
      }),
      trade({
        ticker: "BBB",
        openDate: "2025-01-15",
        openPrice: 5,
        closeDate: "2025-01-20",
        closePrice: 15,
      }),
    ];
    const points = derivePortfolioSeries(20, "2025-01-01", "2025-02-01", trades);

    // First trade doubles 20 -> 40; second trade triples 40 -> 120.
    const closePoints = points.filter((p) => p.event?.type === "close");
    expect(closePoints.map((p) => p.value)).toEqual([40, 120]);
    expect(points[points.length - 1]).toEqual({ date: "2025-02-01", value: 120, event: null });
  });

  it("handles a losing trade (value decreases at the close)", () => {
    const trades = [trade({ openPrice: 20, closePrice: 10 })];
    const points = derivePortfolioSeries(20, "2025-01-01", "2025-02-01", trades);

    const closePoint = points.find((p) => p.event?.type === "close");
    expect(closePoint?.value).toBe(10);
  });

  it("starts at the first trade's open date when startDate is null (the MAX range)", () => {
    const trades = [trade({ openDate: "2010-06-01" })];
    const points = derivePortfolioSeries(20, null, "2025-02-01", trades);

    expect(points[0]).toEqual({ date: "2010-06-01", value: 20, event: null });
  });

  it("falls back to endDate as the sole point when startDate is null and there are no trades", () => {
    const points = derivePortfolioSeries(20, null, "2025-02-01", []);

    expect(points).toEqual([{ date: "2025-02-01", value: 20, event: null }]);
  });

  it("doesn't append a redundant flat point after a close that already lands on endDate", () => {
    const trades = [trade({ closeDate: "2025-02-01" })];
    const points = derivePortfolioSeries(20, "2025-01-01", "2025-02-01", trades);

    // Last point is the close's own jump -- no extra trailing flat point
    // beyond it, since it already sits on endDate.
    expect(points[points.length - 1]).toEqual({
      date: "2025-02-01",
      value: 40,
      event: { type: "close", direction: "long", ticker: "AAA", price: 20 },
    });
  });

  it("rescales every point proportionally when given a different startingCapital (issue #15) -- passing the user's chosen capital straight in is the whole rescaling strategy, no separate math needed", () => {
    const trades = [
      trade({ openDate: "2025-01-02", closeDate: "2025-01-10", openPrice: 10, closePrice: 20 }),
      trade({
        ticker: "BBB",
        openDate: "2025-01-15",
        closeDate: "2025-01-20",
        openPrice: 5,
        closePrice: 15,
      }),
    ];
    const original = derivePortfolioSeries(20, "2025-01-01", "2025-02-01", trades);
    const rescaled = derivePortfolioSeries(2000, "2025-01-01", "2025-02-01", trades);

    // Same dates/events throughout, every value scaled by the same 100x
    // ratio (2000 / 20) -- price ratios (and therefore every event) are
    // entirely unaffected by which starting capital was used.
    expect(rescaled.map((p) => p.date)).toEqual(original.map((p) => p.date));
    expect(rescaled.map((p) => p.event)).toEqual(original.map((p) => p.event));
    expect(rescaled.map((p) => p.value)).toEqual(original.map((p) => p.value * 100));
  });

  it("handles back-to-back trades where one close date equals the next open date", () => {
    const trades = [
      trade({
        ticker: "AAA",
        openDate: "2025-01-02",
        closeDate: "2025-01-10",
        openPrice: 10,
        closePrice: 20,
      }),
      trade({
        ticker: "BBB",
        openDate: "2025-01-10",
        closeDate: "2025-01-20",
        openPrice: 5,
        closePrice: 10,
      }),
    ];
    const points = derivePortfolioSeries(20, "2025-01-01", "2025-02-01", trades);

    const eventsOnJan10 = points.filter((p) => p.date === "2025-01-10" && p.event !== null);
    expect(eventsOnJan10.map((p) => p.event?.type)).toEqual(["close", "open"]);
  });

  describe("short trades (issue #13)", () => {
    it("compounds via the reciprocal-price payoff, and the events carry direction: short", () => {
      const trades = [trade({ direction: "short", openPrice: 20, closePrice: 10 })]; // price fell, short profits: 2x
      const points = derivePortfolioSeries(20, "2025-01-01", "2025-02-01", trades);

      const openPoint = points.find((p) => p.event?.type === "open");
      const closePoint = points.find((p) => p.event?.type === "close");
      expect(openPoint?.event).toEqual({
        type: "open",
        direction: "short",
        ticker: "AAA",
        price: 20,
      });
      expect(closePoint?.event).toEqual({
        type: "close",
        direction: "short",
        ticker: "AAA",
        price: 10,
      });
      expect(closePoint?.value).toBe(40); // 20 * (20/10)
    });

    it("handles a losing short (value decreases when the price rose)", () => {
      const trades = [trade({ direction: "short", openPrice: 10, closePrice: 20 })];
      const points = derivePortfolioSeries(20, "2025-01-01", "2025-02-01", trades);

      const closePoint = points.find((p) => p.event?.type === "close");
      expect(closePoint?.value).toBe(10); // 20 * (10/20)
    });

    it("compounds a mixed long+short sequence correctly", () => {
      const trades = [
        trade({ ticker: "AAA", direction: "long", openPrice: 10, closePrice: 20 }), // x2
        trade({ ticker: "BBB", direction: "short", openPrice: 50, closePrice: 25 }), // x2 (price fell)
      ];
      const points = derivePortfolioSeries(20, "2025-01-01", "2025-02-01", trades);

      const closePoints = points.filter((p) => p.event?.type === "close");
      expect(closePoints.map((p) => p.value)).toEqual([40, 80]);
    });
  });
});

describe("deriveIntradayPortfolioSeries", () => {
  it("is a single flat point at startingCapital when there are no trades that day", () => {
    const points = deriveIntradayPortfolioSeries(20, "2025-01-02", []);

    expect(points).toEqual([{ date: "2025-01-02T12:00:00", value: 20, event: null }]);
  });

  it("derives a single trade as flat, open annotation, flat through the hold, then a jump at close -- using full local datetimes, not calendar dates", () => {
    const trades = [intradayTrade({})];
    const points = deriveIntradayPortfolioSeries(20, "2025-01-02", trades);

    expect(points).toEqual([
      { date: "2025-01-02T09:30:00", value: 20, event: null },
      {
        date: "2025-01-02T09:30:00",
        value: 20,
        event: { type: "open", direction: "long", ticker: "AAA", price: 10 },
      },
      { date: "2025-01-02T10:30:00", value: 20, event: null },
      {
        date: "2025-01-02T10:30:00",
        value: 40,
        event: { type: "close", direction: "long", ticker: "AAA", price: 20 },
      },
    ]);
  });

  it("compounds value across multiple sequential same-day trades", () => {
    const trades = [
      intradayTrade({ openTime: "09:30:00", openPrice: 10, closeTime: "10:30:00", closePrice: 20 }),
      intradayTrade({
        ticker: "BBB",
        openTime: "11:30:00",
        openPrice: 5,
        closeTime: "13:30:00",
        closePrice: 15,
      }),
    ];
    const points = deriveIntradayPortfolioSeries(20, "2025-01-02", trades);

    const closePoints = points.filter((p) => p.event?.type === "close");
    expect(closePoints.map((p) => p.value)).toEqual([40, 120]);
  });

  it("handles a losing trade (value decreases at the close)", () => {
    const trades = [intradayTrade({ openPrice: 20, closePrice: 10 })];
    const points = deriveIntradayPortfolioSeries(20, "2025-01-02", trades);

    const closePoint = points.find((p) => p.event?.type === "close");
    expect(closePoint?.value).toBe(10);
  });

  it("rescales every point proportionally when given a different startingCapital (issue #15), same as derivePortfolioSeries above", () => {
    const trades = [intradayTrade({ openPrice: 10, closePrice: 20 })];
    const original = deriveIntradayPortfolioSeries(20, "2025-01-02", trades);
    const rescaled = deriveIntradayPortfolioSeries(5, "2025-01-02", trades);

    expect(rescaled.map((p) => p.date)).toEqual(original.map((p) => p.date));
    expect(rescaled.map((p) => p.value)).toEqual(original.map((p) => p.value * 0.25));
  });

  it("handles a short trade via the reciprocal-price payoff (issue #13)", () => {
    const trades = [intradayTrade({ direction: "short", openPrice: 20, closePrice: 10 })];
    const points = deriveIntradayPortfolioSeries(20, "2025-01-02", trades);

    const closePoint = points.find((p) => p.event?.type === "close");
    expect(closePoint?.event).toMatchObject({ direction: "short" });
    expect(closePoint?.value).toBe(40); // 20 * (20/10)
  });
});

describe("deriveWholeRangeIntradaySeries", () => {
  it("returns an empty series for an empty range", () => {
    expect(deriveWholeRangeIntradaySeries(20, [])).toEqual([]);
  });

  it("chains a day's ending value into the next day's starting value, instead of resetting to startingCapital each day", () => {
    const points = deriveWholeRangeIntradaySeries(20, [
      { date: "2025-01-02", trades: [intradayTrade({ openPrice: 10, closePrice: 20 })] }, // 20 -> 40
      { date: "2025-01-03", trades: [intradayTrade({ openPrice: 10, closePrice: 20 })] }, // 40 -> 80
    ]);

    const closePoints = points.filter((p) => p.event?.type === "close");
    expect(closePoints.map((p) => p.value)).toEqual([40, 80]);
    // The second day's own opening point sits at the first day's real
    // ending value (40), not a fresh reset back to startingCapital (20).
    const secondDayOpen = points.find((p) => p.date === "2025-01-03T09:30:00" && p.event === null);
    expect(secondDayOpen?.value).toBe(40);
  });

  it("renders a zero-trade day as a single flat point at the running value, then keeps chaining from it", () => {
    const points = deriveWholeRangeIntradaySeries(20, [
      { date: "2025-01-02", trades: [intradayTrade({ openPrice: 10, closePrice: 30 })] }, // 20 -> 60
      { date: "2025-01-03", trades: [] },
      { date: "2025-01-04", trades: [intradayTrade({ openPrice: 10, closePrice: 20 })] }, // 60 -> 120
    ]);

    expect(points).toContainEqual({ date: "2025-01-03T12:00:00", value: 60, event: null });
    const closePoints = points.filter((p) => p.event?.type === "close");
    expect(closePoints.map((p) => p.value)).toEqual([60, 120]);
  });

  it("spans the whole range with real intraday spacing preserved within each day", () => {
    const points = deriveWholeRangeIntradaySeries(20, [
      {
        date: "2025-01-02",
        trades: [
          intradayTrade({ openTime: "09:30:00", closeTime: "10:30:00" }),
          intradayTrade({ ticker: "BBB", openTime: "11:00:00", closeTime: "12:00:00" }),
        ],
      },
    ]);

    expect(points.map((p) => p.date)).toEqual([
      "2025-01-02T09:30:00",
      "2025-01-02T09:30:00",
      "2025-01-02T10:30:00",
      "2025-01-02T10:30:00",
      "2025-01-02T11:00:00",
      "2025-01-02T12:00:00",
      "2025-01-02T12:00:00",
    ]);
  });

  it("rescales every point proportionally when given a different startingCapital (issue #15)", () => {
    const days = [
      { date: "2025-01-02", trades: [intradayTrade({ openPrice: 10, closePrice: 20 })] },
      { date: "2025-01-03", trades: [intradayTrade({ openPrice: 10, closePrice: 30 })] },
    ];
    const original = deriveWholeRangeIntradaySeries(20, days);
    const rescaled = deriveWholeRangeIntradaySeries(5, days);

    expect(rescaled.map((p) => p.date)).toEqual(original.map((p) => p.date));
    expect(rescaled.map((p) => p.value)).toEqual(original.map((p) => p.value * 0.25));
  });
});

describe("spansMultipleDays", () => {
  it("is false for an empty series", () => {
    expect(spansMultipleDays([])).toBe(false);
  });

  it("is false for a single day's own intraday series (deriveIntradayPortfolioSeries)", () => {
    const points = deriveIntradayPortfolioSeries(20, "2025-01-02", [intradayTrade({})]);

    expect(spansMultipleDays(points)).toBe(false);
  });

  it("is true for a whole-range series spanning more than one day (deriveWholeRangeIntradaySeries)", () => {
    const points = deriveWholeRangeIntradaySeries(20, [
      { date: "2025-01-02", trades: [intradayTrade({})] },
      { date: "2025-01-03", trades: [intradayTrade({})] },
    ]);

    expect(spansMultipleDays(points)).toBe(true);
  });

  it("is false for a whole-range series with only one day", () => {
    const points = deriveWholeRangeIntradaySeries(20, [
      { date: "2025-01-02", trades: [intradayTrade({})] },
    ]);

    expect(spansMultipleDays(points)).toBe(false);
  });

  it("is true for the window model's plain calendar-date series (harmless -- formatDateTime already always shows the date for a non-datetime point regardless)", () => {
    const points = derivePortfolioSeries(20, "2025-01-02", "2025-01-10", [trade({})]);

    expect(spansMultipleDays(points)).toBe(true);
  });
});
