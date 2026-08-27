import type { IntradayDayResult, IntradayResult, WindowResult } from "@hadiknowntrades/core";
import { RESULTS_SCHEMA_VERSION } from "@hadiknowntrades/core";
import { describe, expect, it } from "vitest";

import { buildOgCardContent, rangeLabel } from "./og-card";

function windowResult(overrides: Partial<WindowResult> = {}): WindowResult {
  return {
    schemaVersion: RESULTS_SCHEMA_VERSION,
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
    worstCase: { endingBalance: 20, trades: [] },
    longShort: { endingBalance: 48_203, trades: [], worstCase: { endingBalance: 20, trades: [] } },
    universeSize: 500,
    skippedTickers: [],
    benchmark: null,
    benchmarkSeries: null,
    ...overrides,
  };
}

function intradayResult(overrides: Partial<IntradayResult> = {}): IntradayResult {
  return {
    schemaVersion: RESULTS_SCHEMA_VERSION,
    model: "intraday-daily",
    range: "1M",
    generatedAt: "2026-08-21T00:00:00.000Z",
    dataAsOf: "2026-08-20",
    endDate: "2026-08-21",
    maxTradesPerDay: 3,
    startingCapital: 20,
    universeSize: 500,
    skippedTickers: [],
    benchmark: null,
    benchmarkSeries: null,
    days: [],
    ...overrides,
  };
}

/**
 * One chained trading day, in the exact shape apps/pipeline writes since
 * issue #84: every track carries its own `startingCapital`, and day N's
 * is day N-1's own `endingBalance` (see packages/core's
 * validateChainedStartingCapital, which enforces exactly this at write
 * time -- these fixtures satisfy it rather than approximating it).
 */
function intradayDay(
  date: string,
  startingCapital: number,
  endingBalance: number,
): IntradayDayResult {
  return {
    date,
    startingCapital,
    endingBalance,
    barIntervalMinutes: 60,
    trades: [],
    worstCase: { startingCapital, endingBalance: startingCapital / 2, trades: [] },
    longShort: {
      startingCapital,
      endingBalance: endingBalance * 1.1,
      trades: [],
      worstCase: { startingCapital, endingBalance: startingCapital / 4, trades: [] },
    },
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
      subtitleLabel: "Max range · best possible 3-trade outcome",
      dataAsOfLabel: "Aug 20, 2026",
    });
  });

  it("reads the window result's own maxTrades for its subtitle, rather than hardcoding 3", () => {
    const content = buildOgCardContent(windowResult({ maxTrades: 5 }));

    expect(content?.subtitleLabel).toBe("Max range · best possible 5-trade outcome");
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

  it("headlines an intraday-daily result's whole-range chained balance (issue #134)", () => {
    const content = buildOgCardContent(
      intradayResult({
        range: "1W",
        days: [
          intradayDay("2026-08-17", 20, 25),
          intradayDay("2026-08-18", 25, 30),
          intradayDay("2026-08-19", 30, 41),
        ],
      }),
    );

    expect(content).toEqual({
      range: "1W",
      // The range's own root capital paired with the FINAL day's ending
      // balance -- the same $20 -> $41 chained figure WholeRangeBalance
      // headlines on the page, not any single day's own ratio.
      startingCapitalLabel: "$20.00",
      endingBalanceLabel: "$41.00",
      multiplierLabel: "2x",
      isMultiplierGain: true,
      subtitleLabel: "1 week range · best possible 3 trades a day, chained day to day",
      dataAsOfLabel: "Aug 20, 2026",
    });
  });

  it("uses the range's own root capital, not the final day's chained carry-in", () => {
    // The trap this guards against: pairing the final day's own
    // startingCapital ($30) with its endingBalance ($41) would render a
    // "$30 -> $41" card, silently showing that one day's result as if
    // the whole range had started there (see og-card.ts's own doc
    // comment, and apps/web/CLAUDE.md's per-day-rescale-cancellation
    // section).
    const content = buildOgCardContent(
      intradayResult({
        days: [intradayDay("2026-08-18", 20, 30), intradayDay("2026-08-19", 30, 41)],
      }),
    );

    expect(content?.startingCapitalLabel).toBe("$20.00");
    expect(content?.endingBalanceLabel).toBe("$41.00");
  });

  it("reads the long-only track, not longShort, for an intraday-daily result", () => {
    // Every fixture day's longShort.endingBalance is deliberately 1.1x
    // the long-only one, so a card built off the wrong track would show
    // $45.10 instead of $41.00.
    const content = buildOgCardContent(
      intradayResult({ days: [intradayDay("2026-08-19", 20, 41)] }),
    );

    expect(content?.endingBalanceLabel).toBe("$41.00");
  });

  it("colors a losing intraday-daily range as not-a-gain", () => {
    const content = buildOgCardContent(
      intradayResult({ days: [intradayDay("2026-08-19", 20, 12)] }),
    );

    expect(content?.isMultiplierGain).toBe(false);
    expect(content?.multiplierLabel).toBe("0.6x");
  });

  it("returns null for an intraday-daily result with no trading days at all", () => {
    expect(buildOgCardContent(intradayResult({ days: [] }))).toBeNull();
  });
});

describe("rangeLabel", () => {
  it("has a human-readable label for every preset range", () => {
    expect(rangeLabel("1W")).toBe("1 week");
    expect(rangeLabel("1M")).toBe("1 month");
    expect(rangeLabel("3M")).toBe("3 months");
    expect(rangeLabel("1Y")).toBe("1 year");
    expect(rangeLabel("5Y")).toBe("5 years");
    expect(rangeLabel("MAX")).toBe("Max");
  });
});
