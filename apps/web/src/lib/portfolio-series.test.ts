import type { IntradayTrade, Trade } from "@hadiknowntrades/core";
import { describe, expect, it } from "vitest";

import { deriveIntradayPortfolioSeries, derivePortfolioSeries } from "./portfolio-series";

function trade(overrides: Partial<Trade>): Trade {
  return {
    ticker: "AAA",
    buyDate: "2025-01-02",
    buyPrice: 10,
    sellDate: "2025-01-10",
    sellPrice: 20,
    ...overrides,
  };
}

function intradayTrade(overrides: Partial<IntradayTrade>): IntradayTrade {
  return {
    ticker: "AAA",
    date: "2025-01-02",
    buyTime: "09:30:00",
    buyPrice: 10,
    sellTime: "10:30:00",
    sellPrice: 20,
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

  it("derives a single trade as flat, buy annotation, flat through the hold, then a jump at sell", () => {
    const trades = [trade({})];
    const points = derivePortfolioSeries(20, "2025-01-01", "2025-02-01", trades);

    expect(points).toEqual([
      { date: "2025-01-01", value: 20, event: null },
      { date: "2025-01-02", value: 20, event: { type: "buy", ticker: "AAA", price: 10 } },
      { date: "2025-01-10", value: 20, event: null },
      { date: "2025-01-10", value: 40, event: { type: "sell", ticker: "AAA", price: 20 } },
      { date: "2025-02-01", value: 40, event: null },
    ]);
  });

  it("compounds value across multiple sequential trades", () => {
    const trades = [
      trade({
        ticker: "AAA",
        buyDate: "2025-01-02",
        buyPrice: 10,
        sellDate: "2025-01-10",
        sellPrice: 20,
      }),
      trade({
        ticker: "BBB",
        buyDate: "2025-01-15",
        buyPrice: 5,
        sellDate: "2025-01-20",
        sellPrice: 15,
      }),
    ];
    const points = derivePortfolioSeries(20, "2025-01-01", "2025-02-01", trades);

    // First trade doubles 20 -> 40; second trade triples 40 -> 120.
    const sellPoints = points.filter((p) => p.event?.type === "sell");
    expect(sellPoints.map((p) => p.value)).toEqual([40, 120]);
    expect(points[points.length - 1]).toEqual({ date: "2025-02-01", value: 120, event: null });
  });

  it("handles a losing trade (value decreases at the sell)", () => {
    const trades = [trade({ buyPrice: 20, sellPrice: 10 })];
    const points = derivePortfolioSeries(20, "2025-01-01", "2025-02-01", trades);

    const sellPoint = points.find((p) => p.event?.type === "sell");
    expect(sellPoint?.value).toBe(10);
  });

  it("starts at the first trade's buy date when startDate is null (the MAX range)", () => {
    const trades = [trade({ buyDate: "2010-06-01" })];
    const points = derivePortfolioSeries(20, null, "2025-02-01", trades);

    expect(points[0]).toEqual({ date: "2010-06-01", value: 20, event: null });
  });

  it("falls back to endDate as the sole point when startDate is null and there are no trades", () => {
    const points = derivePortfolioSeries(20, null, "2025-02-01", []);

    expect(points).toEqual([{ date: "2025-02-01", value: 20, event: null }]);
  });

  it("doesn't append a redundant flat point after a sell that already lands on endDate", () => {
    const trades = [trade({ sellDate: "2025-02-01" })];
    const points = derivePortfolioSeries(20, "2025-01-01", "2025-02-01", trades);

    // Last point is the sell's own jump -- no extra trailing flat point
    // beyond it, since it already sits on endDate.
    expect(points[points.length - 1]).toEqual({
      date: "2025-02-01",
      value: 40,
      event: { type: "sell", ticker: "AAA", price: 20 },
    });
  });

  it("rescales every point proportionally when given a different startingCapital (issue #15) -- passing the user's chosen capital straight in is the whole rescaling strategy, no separate math needed", () => {
    const trades = [
      trade({ buyDate: "2025-01-02", sellDate: "2025-01-10", buyPrice: 10, sellPrice: 20 }),
      trade({
        ticker: "BBB",
        buyDate: "2025-01-15",
        sellDate: "2025-01-20",
        buyPrice: 5,
        sellPrice: 15,
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

  it("handles back-to-back trades where one sell date equals the next buy date", () => {
    const trades = [
      trade({
        ticker: "AAA",
        buyDate: "2025-01-02",
        sellDate: "2025-01-10",
        buyPrice: 10,
        sellPrice: 20,
      }),
      trade({
        ticker: "BBB",
        buyDate: "2025-01-10",
        sellDate: "2025-01-20",
        buyPrice: 5,
        sellPrice: 10,
      }),
    ];
    const points = derivePortfolioSeries(20, "2025-01-01", "2025-02-01", trades);

    const eventsOnJan10 = points.filter((p) => p.date === "2025-01-10" && p.event !== null);
    expect(eventsOnJan10.map((p) => p.event?.type)).toEqual(["sell", "buy"]);
  });
});

describe("deriveIntradayPortfolioSeries", () => {
  it("is a single flat point at startingCapital when there are no trades that day", () => {
    const points = deriveIntradayPortfolioSeries(20, "2025-01-02", []);

    expect(points).toEqual([{ date: "2025-01-02T12:00:00", value: 20, event: null }]);
  });

  it("derives a single trade as flat, buy annotation, flat through the hold, then a jump at sell -- using full local datetimes, not calendar dates", () => {
    const trades = [intradayTrade({})];
    const points = deriveIntradayPortfolioSeries(20, "2025-01-02", trades);

    expect(points).toEqual([
      { date: "2025-01-02T09:30:00", value: 20, event: null },
      { date: "2025-01-02T09:30:00", value: 20, event: { type: "buy", ticker: "AAA", price: 10 } },
      { date: "2025-01-02T10:30:00", value: 20, event: null },
      { date: "2025-01-02T10:30:00", value: 40, event: { type: "sell", ticker: "AAA", price: 20 } },
    ]);
  });

  it("compounds value across multiple sequential same-day trades", () => {
    const trades = [
      intradayTrade({ buyTime: "09:30:00", buyPrice: 10, sellTime: "10:30:00", sellPrice: 20 }),
      intradayTrade({
        ticker: "BBB",
        buyTime: "11:30:00",
        buyPrice: 5,
        sellTime: "13:30:00",
        sellPrice: 15,
      }),
    ];
    const points = deriveIntradayPortfolioSeries(20, "2025-01-02", trades);

    const sellPoints = points.filter((p) => p.event?.type === "sell");
    expect(sellPoints.map((p) => p.value)).toEqual([40, 120]);
  });

  it("handles a losing trade (value decreases at the sell)", () => {
    const trades = [intradayTrade({ buyPrice: 20, sellPrice: 10 })];
    const points = deriveIntradayPortfolioSeries(20, "2025-01-02", trades);

    const sellPoint = points.find((p) => p.event?.type === "sell");
    expect(sellPoint?.value).toBe(10);
  });

  it("rescales every point proportionally when given a different startingCapital (issue #15), same as derivePortfolioSeries above", () => {
    const trades = [intradayTrade({ buyPrice: 10, sellPrice: 20 })];
    const original = deriveIntradayPortfolioSeries(20, "2025-01-02", trades);
    const rescaled = deriveIntradayPortfolioSeries(5, "2025-01-02", trades);

    expect(rescaled.map((p) => p.date)).toEqual(original.map((p) => p.date));
    expect(rescaled.map((p) => p.value)).toEqual(original.map((p) => p.value * 0.25));
  });
});
