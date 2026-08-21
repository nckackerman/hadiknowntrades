// The JSON schema for one preset range's precomputed result -- the
// contract between apps/pipeline (which writes one of these per range to
// S3 as `results/{RANGE}.json`, see apps/pipeline/src/pipeline.ts) and
// apps/web's thin results API (which reads it back and serves it to the
// frontend, see apps/web/src/lib/results-api.ts). Lives here rather than
// in apps/pipeline so both sides import the exact same type instead of
// each maintaining their own copy of the shape.
//
// Issue #28 introduced a second result shape: 1M/3M/1Y now use a
// per-day intraday model (IntradayResult) instead of the original
// whole-window model (WindowResult, what every range used before #28).
// 5Y/MAX keep using WindowResult -- same behavior and values as before
// #28, but *not* byte-identical JSON: both shapes now carry the
// discriminant `model` field and the bumped `schemaVersion`, since the
// version number is global across the union rather than per-range (see
// docs/plans/issue-28-plan.md's addendum for why). A reader switches on
// `model` to know which shape it got.

import type { PresetRange } from "./preset-ranges";
import type { Trade } from "./optimizer";
import type { IntradayDayResult } from "./intraday-optimizer";

/** Bumped whenever the shape of PrecomputedResult changes in a way a reader needs to know about. */
export const RESULTS_SCHEMA_VERSION = 2;

/**
 * The S3 key a precomputed result is stored/read under for a given range.
 * Single source of truth for both sides of the S3 contract -- the writer
 * (apps/pipeline/src/pipeline.ts) and the reader
 * (apps/web/src/lib/results-api.ts) both call this instead of each hand-typing
 * the same template literal, so the two can't drift apart.
 */
export function resultKey(range: PresetRange): string {
  return `results/${range}.json`;
}

/** Which trading model produced a given PrecomputedResult -- see the module header comment. */
export type ResultModel = "window" | "intraday-daily";

interface PrecomputedResultBase {
  schemaVersion: number;
  range: PresetRange;
  generatedAt: string;
  /** The most recent trading date actually found in the fetched data -- a fact about the data, which can lag the requested `endDate` (e.g. if the pipeline runs before the latest close is posted, or before the intraday session has finished for the day). */
  dataAsOf: string;
  startingCapital: number;
  universeSize: number;
  skippedTickers: string[];
}

/**
 * The original whole-window model (every range, before issue #28; 5Y/MAX
 * only, after): at most `maxTrades` sequential, all-in trades across the
 * *entire* window, using daily closing prices.
 */
export interface WindowResult extends PrecomputedResultBase {
  model: "window";
  startDate: string | null;
  /** The requested "as of" boundary for this run -- see dataAsOf for what data was actually available. */
  endDate: string;
  /** Maximum trades allowed for this run (see apps/pipeline's DEFAULT_MAX_TRADES) -- explicit in the schema so readers don't have to hardcode the current default to describe the result accurately. */
  maxTrades: number;
  endingBalance: number;
  trades: Trade[];
}

/**
 * The per-day intraday model (issue #28; 1M/3M/1Y only): for every
 * trading day in the window, the best up-to-`maxTradesPerDay` same-day
 * trades achievable using that day's real 60-minute price bars, solved
 * independently per day (see intraday-optimizer.ts) -- results do not
 * compound across days.
 */
export interface IntradayResult extends PrecomputedResultBase {
  model: "intraday-daily";
  /** The requested "as of" boundary for this run -- see dataAsOf for what data was actually available. */
  endDate: string;
  /** Maximum same-day trades allowed per day for this run (see apps/pipeline's DEFAULT_MAX_TRADES_PER_DAY). */
  maxTradesPerDay: number;
  /** One entry per trading day found in the window, ascending by date. A day with no data for any ticker (a holiday, a data gap) simply isn't present. Reuses IntradayDayResult (intraday-optimizer.ts) as-is -- it's already exactly this on-disk shape, and re-declaring it here would just be a second copy to keep in sync. */
  days: IntradayDayResult[];
}

export type PrecomputedResult = WindowResult | IntradayResult;
