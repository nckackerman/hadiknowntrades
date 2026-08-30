import type { IntradayDayResult, IntradayResult } from "@hadiknowntrades/core";
import { RESULTS_SCHEMA_VERSION } from "@hadiknowntrades/core";

/**
 * A minimal intraday-daily `IntradayResult`, defaulting to zero days --
 * override `days` with real `intradayDay(...)` entries for anything that
 * needs to read the chained final balance.
 *
 * Extracted once `whole-range-balance.test.ts` needed the identical
 * fixture `og-card.test.ts` already had (code review finding on the
 * coverage-audit PR, fixed) rather than left as two hand-copied
 * duplicates -- the same drift class `stub-match-media.test-util.ts`/
 * `stub-prefers-reduced-motion.test-util.ts` were both extracted for.
 */
export function intradayResult(overrides: Partial<IntradayResult> = {}): IntradayResult {
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
export function intradayDay(
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
