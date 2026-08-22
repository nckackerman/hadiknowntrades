import type { IntradayResult, WindowResult } from "@hadiknowntrades/core";
import { describe, expect, it } from "vitest";

import { buildOgCardContent, rangeLabel } from "./og-card";

function windowResult(overrides: Partial<WindowResult> = {}): WindowResult {
  return {
    schemaVersion: 2,
    model: "window",
    range: "MAX",
    generatedAt: "2026-08-21T00:00:00.000Z",
    dataAsOf: "2026-08-20",
    startDate: null,
    endDate: "2026-08-21",
    maxTrades: 3,
    startingCapital: 20,
    endingBalance: 48_203,
    trades: [],
    universeSize: 500,
    skippedTickers: [],
    ...overrides,
  };
}

function intradayResult(overrides: Partial<IntradayResult> = {}): IntradayResult {
  return {
    schemaVersion: 2,
    model: "intraday-daily",
    range: "1M",
    generatedAt: "2026-08-21T00:00:00.000Z",
    dataAsOf: "2026-08-20",
    endDate: "2026-08-21",
    maxTradesPerDay: 3,
    startingCapital: 20,
    universeSize: 500,
    skippedTickers: [],
    days: [],
    ...overrides,
  };
}

describe("buildOgCardContent", () => {
  it("builds card content from a window-model result", () => {
    const content = buildOgCardContent(windowResult());

    expect(content).toEqual({
      range: "MAX",
      startingCapitalLabel: "$20.00",
      endingBalanceLabel: "$48.2K",
      multiplierLabel: "2.4Kx",
      isMultiplierGain: true,
      dataAsOfLabel: "Aug 20, 2026",
    });
  });

  it("treats an exact 1x (flat) result as a gain, matching TradeRow's own convention", () => {
    const content = buildOgCardContent(windowResult({ endingBalance: 20 }));

    expect(content?.isMultiplierGain).toBe(true);
    expect(content?.multiplierLabel).toBe("1x");
  });

  it("colors a real loss as not-a-gain", () => {
    const content = buildOgCardContent(windowResult({ endingBalance: 15 }));

    expect(content?.isMultiplierGain).toBe(false);
    expect(content?.multiplierLabel).toBe("0.8x");
  });

  it("returns null for an intraday-daily result -- out of scope, see this file's header comment", () => {
    expect(buildOgCardContent(intradayResult())).toBeNull();
  });
});

describe("rangeLabel", () => {
  it("has a human-readable label for every preset range", () => {
    expect(rangeLabel("1M")).toBe("1 month");
    expect(rangeLabel("3M")).toBe("3 months");
    expect(rangeLabel("1Y")).toBe("1 year");
    expect(rangeLabel("5Y")).toBe("5 years");
    expect(rangeLabel("MAX")).toBe("Max");
  });
});
