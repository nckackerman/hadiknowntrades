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

import { PRESET_RANGES, type PresetRange } from "./preset-ranges";
import type { Trade } from "./optimizer";
import type { IntradayDayResult } from "./intraday-optimizer";
import { isValidPrice } from "./is-valid-price";

/** Bumped whenever the shape of PrecomputedResult changes in a way a reader needs to know about. */
export const RESULTS_SCHEMA_VERSION = 3;

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
 * The worst achievable <=maxTrades outcome over the same window (issue
 * #31) -- same shape as the sibling optimal-case fields
 * (endingBalance/trades), minus startingCapital, which is identical to
 * the already-present sibling value on WindowResult/IntradayDayResult
 * and not worth duplicating (both the optimal- and worst-case search
 * start from the same capital). Always
 * `worstCase.endingBalance <= endingBalance` by construction -- the
 * min-search explores a subset of the same trade-sequence space the
 * max-search does -- checked below in validateWorstCaseResult's caller.
 */
export interface WorstCaseResult {
  endingBalance: number;
  trades: Trade[];
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
  /** The worst achievable <=maxTrades outcome over the same window (issue #31) -- see WorstCaseResult. */
  worstCase: WorstCaseResult;
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

// --- Write-time self-validation (issue #47) ---------------------------
//
// The types above only enforce shape at compile time -- a `NaN`
// `endingBalance` or a bug that drops a required field still satisfies
// TypeScript, since `number` and optional-vs-missing checks are purely
// static. apps/pipeline (src/pipeline.ts) writes whatever
// buildWindowResults/buildIntradayResults produced straight to S3 with
// no runtime check that the *value itself* still matches its declared
// shape, so a malformed result would previously ship silently and only
// surface later as a confusing frontend bug in apps/web. This section
// gives the pipeline a runtime check to call immediately before each
// putObject, in the same spirit as optimizer.ts's own
// OptimizerInputError input validation (see packages/core/CLAUDE.md's
// "defense in depth" note) -- except this validates output, not input,
// and there's nothing upstream left to "trust" once this fails: it's
// the last line of defense before a result becomes what apps/web reads.
//
// Deliberately hand-rolled rather than pulled in from a schema library
// (e.g. zod): this package has no runtime-validation dependency today,
// the shape being checked is small and stable, and a validator that's
// just read top-to-bottom against the interfaces above is easier to
// keep in sync with them by hand than round-tripping through a second,
// schema-library-specific representation of the same shape.

/** Thrown by validatePrecomputedResult when a PrecomputedResult fails to satisfy its own declared shape. */
export class ResultValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResultValidationError";
  }
}

/**
 * Builds on the same `isValidPrice` (`is-valid-price.ts`) that
 * `optimizer.ts`/`yahoo-client.ts` already use to define "legitimate
 * price," rather than re-deriving `Number.isFinite(value) && value > 0`
 * independently here -- keeps that definition from drifting between call
 * sites (see that file's own header comment). Used for every
 * positive-finite-number field this validator checks, not just
 * buyPrice/sellPrice -- the predicate is identical either way, just under
 * a more general name for fields (startingCapital, endingBalance, ...)
 * that aren't literally a price.
 */
function isPositiveFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && isValidPrice(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/**
 * Validates one `Trade` (see optimizer.ts) as it appears embedded in a
 * `WindowResult.trades` entry, appending one message per problem found
 * to `problems` rather than stopping at the first -- a malformed result
 * is worth diagnosing in one pass, not one failed `putObject` retry at a
 * time.
 */
function validateTrade(trade: unknown, path: string, problems: string[]): void {
  if (trade === null || typeof trade !== "object") {
    problems.push(`${path} must be an object, got ${describe(trade)}`);
    return;
  }
  const t = trade as Record<string, unknown>;
  if (!isNonEmptyString(t.ticker))
    problems.push(`${path}.ticker must be a non-empty string, got ${describe(t.ticker)}`);
  if (!isNonEmptyString(t.buyDate))
    problems.push(`${path}.buyDate must be a non-empty string, got ${describe(t.buyDate)}`);
  if (!isPositiveFiniteNumber(t.buyPrice))
    problems.push(`${path}.buyPrice must be a positive finite number, got ${describe(t.buyPrice)}`);
  if (!isNonEmptyString(t.sellDate))
    problems.push(`${path}.sellDate must be a non-empty string, got ${describe(t.sellDate)}`);
  if (!isPositiveFiniteNumber(t.sellPrice))
    problems.push(
      `${path}.sellPrice must be a positive finite number, got ${describe(t.sellPrice)}`,
    );
}

/** Validates one `IntradayTrade` (see intraday-optimizer.ts) embedded in an `IntradayDayResult.trades` entry. */
function validateIntradayTrade(trade: unknown, path: string, problems: string[]): void {
  if (trade === null || typeof trade !== "object") {
    problems.push(`${path} must be an object, got ${describe(trade)}`);
    return;
  }
  const t = trade as Record<string, unknown>;
  if (!isNonEmptyString(t.ticker))
    problems.push(`${path}.ticker must be a non-empty string, got ${describe(t.ticker)}`);
  if (!isNonEmptyString(t.date))
    problems.push(`${path}.date must be a non-empty string, got ${describe(t.date)}`);
  if (!isNonEmptyString(t.buyTime))
    problems.push(`${path}.buyTime must be a non-empty string, got ${describe(t.buyTime)}`);
  if (!isPositiveFiniteNumber(t.buyPrice))
    problems.push(`${path}.buyPrice must be a positive finite number, got ${describe(t.buyPrice)}`);
  if (!isNonEmptyString(t.sellTime))
    problems.push(`${path}.sellTime must be a non-empty string, got ${describe(t.sellTime)}`);
  if (!isPositiveFiniteNumber(t.sellPrice))
    problems.push(
      `${path}.sellPrice must be a positive finite number, got ${describe(t.sellPrice)}`,
    );
}

/**
 * Validates one `WorstCaseResult` (see results-schema.ts's own doc
 * comment on that type) embedded in a `WindowResult.worstCase` field --
 * same shape/style as validateTrade, reusing it for the nested `trades`
 * array.
 */
function validateWorstCaseResult(value: unknown, path: string, problems: string[]): void {
  if (value === null || typeof value !== "object") {
    problems.push(`${path} must be an object, got ${describe(value)}`);
    return;
  }
  const w = value as Record<string, unknown>;
  if (!isPositiveFiniteNumber(w.endingBalance))
    problems.push(
      `${path}.endingBalance must be a positive finite number, got ${describe(w.endingBalance)}`,
    );
  if (!Array.isArray(w.trades)) {
    problems.push(`${path}.trades must be an array, got ${describe(w.trades)}`);
  } else {
    w.trades.forEach((trade, i) => validateTrade(trade, `${path}.trades[${i}]`, problems));
  }
}

/**
 * Validates one `IntradayWorstCaseResult` (see intraday-optimizer.ts)
 * embedded in an `IntradayDayResult.worstCase` field -- same shape/style
 * as validateWorstCaseResult above, but reusing validateIntradayTrade for
 * its nested `trades` array (buyTime/sellTime, not buyDate/sellDate).
 */
function validateIntradayWorstCaseResult(value: unknown, path: string, problems: string[]): void {
  if (value === null || typeof value !== "object") {
    problems.push(`${path} must be an object, got ${describe(value)}`);
    return;
  }
  const w = value as Record<string, unknown>;
  if (!isPositiveFiniteNumber(w.endingBalance))
    problems.push(
      `${path}.endingBalance must be a positive finite number, got ${describe(w.endingBalance)}`,
    );
  if (!Array.isArray(w.trades)) {
    problems.push(`${path}.trades must be an array, got ${describe(w.trades)}`);
  } else {
    w.trades.forEach((trade, i) => validateIntradayTrade(trade, `${path}.trades[${i}]`, problems));
  }
}

/**
 * Cross-checks that a worst-case ending balance never exceeds its
 * sibling optimal-case one (issue #31) -- a real, always-true invariant
 * by construction (the min-search explores a subset of the same
 * trade-sequence space the max-search does, so worst <= optimal always),
 * and specifically valuable here because "worst case ends up higher than
 * optimal case" is exactly the symptom a max/min inversion bug (an
 * accidentally-unflipped comparison in optimizer.ts's computeLevel) would
 * produce. Only checked once both values are already known-valid
 * positive finite numbers -- an already-reported malformed value doesn't
 * need a second, redundant problem appended for failing this comparison
 * too.
 */
function validateWorstNotExceedingOptimal(
  worstEndingBalance: unknown,
  optimalEndingBalance: unknown,
  path: string,
  problems: string[],
): void {
  if (
    isPositiveFiniteNumber(worstEndingBalance) &&
    isPositiveFiniteNumber(optimalEndingBalance) &&
    worstEndingBalance > optimalEndingBalance
  ) {
    problems.push(
      `${path} (${worstEndingBalance}) must not exceed its optimal-case counterpart (${optimalEndingBalance})`,
    );
  }
}

/** Validates one `IntradayDayResult` (see intraday-optimizer.ts) embedded in an `IntradayResult.days` entry. */
function validateIntradayDay(day: unknown, path: string, problems: string[]): void {
  if (day === null || typeof day !== "object") {
    problems.push(`${path} must be an object, got ${describe(day)}`);
    return;
  }
  const d = day as Record<string, unknown>;
  if (!isNonEmptyString(d.date))
    problems.push(`${path}.date must be a non-empty string, got ${describe(d.date)}`);
  if (!isPositiveFiniteNumber(d.startingCapital))
    problems.push(
      `${path}.startingCapital must be a positive finite number, got ${describe(d.startingCapital)}`,
    );
  if (!isPositiveFiniteNumber(d.endingBalance))
    problems.push(
      `${path}.endingBalance must be a positive finite number, got ${describe(d.endingBalance)}`,
    );
  if (!isPositiveFiniteNumber(d.barIntervalMinutes))
    problems.push(
      `${path}.barIntervalMinutes must be a positive finite number, got ${describe(d.barIntervalMinutes)}`,
    );
  if (!Array.isArray(d.trades)) {
    problems.push(`${path}.trades must be an array, got ${describe(d.trades)}`);
  } else {
    d.trades.forEach((trade, i) => validateIntradayTrade(trade, `${path}.trades[${i}]`, problems));
  }
  validateIntradayWorstCaseResult(d.worstCase, `${path}.worstCase`, problems);
  validateWorstNotExceedingOptimal(
    (d.worstCase as Record<string, unknown> | undefined)?.endingBalance,
    d.endingBalance,
    `${path}.worstCase.endingBalance`,
    problems,
  );
}

/** A short, safe-to-embed-in-an-error-message description of an arbitrary value, for validation failure messages. */
function describe(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "number") return String(value); // covers NaN, Infinity legibly
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `an array of length ${value.length}`;
  if (typeof value === "object") return "an object";
  return String(value);
}

/** Validates the fields every PrecomputedResult shares, regardless of `model`. */
function validateBase(result: Record<string, unknown>, problems: string[]): void {
  if (result.schemaVersion !== RESULTS_SCHEMA_VERSION) {
    problems.push(
      `schemaVersion must be exactly ${RESULTS_SCHEMA_VERSION}, got ${describe(result.schemaVersion)}`,
    );
  }
  if (!(PRESET_RANGES as readonly string[]).includes(result.range as string)) {
    problems.push(
      `range must be one of ${PRESET_RANGES.join(", ")}, got ${describe(result.range)}`,
    );
  }
  if (!isNonEmptyString(result.generatedAt)) {
    problems.push(`generatedAt must be a non-empty string, got ${describe(result.generatedAt)}`);
  }
  if (!isNonEmptyString(result.dataAsOf)) {
    problems.push(`dataAsOf must be a non-empty string, got ${describe(result.dataAsOf)}`);
  }
  if (!isPositiveFiniteNumber(result.startingCapital)) {
    problems.push(
      `startingCapital must be a positive finite number, got ${describe(result.startingCapital)}`,
    );
  }
  if (!isNonNegativeInteger(result.universeSize)) {
    problems.push(
      `universeSize must be a non-negative integer, got ${describe(result.universeSize)}`,
    );
  }
  if (!Array.isArray(result.skippedTickers)) {
    problems.push(`skippedTickers must be an array, got ${describe(result.skippedTickers)}`);
  } else {
    result.skippedTickers.forEach((ticker, i) => {
      if (!isNonEmptyString(ticker)) {
        problems.push(`skippedTickers[${i}] must be a non-empty string, got ${describe(ticker)}`);
      }
    });
  }
}

/**
 * Validates that `result` actually satisfies its own declared shape
 * (`WindowResult` or `IntradayResult`, per its `model` discriminant) at
 * runtime -- required fields present, prices/balances finite numbers,
 * `trades`/`days` arrays well-formed -- and throws `ResultValidationError`
 * (listing every problem found, not just the first) if it doesn't.
 *
 * Callers should treat `result` as untrusted despite its `PrecomputedResult`
 * compile-time type: the whole point of this check is to catch a bug that
 * produces a runtime value violating that type despite TypeScript (e.g. a
 * `NaN` slipping through arithmetic) -- trusting the static type here
 * would defeat the purpose.
 */
export function validatePrecomputedResult(result: PrecomputedResult): void {
  const problems: string[] = [];
  if (result === null || typeof result !== "object") {
    throw new ResultValidationError(`result must be an object, got ${describe(result)}`);
  }
  const r = result as unknown as Record<string, unknown>;
  validateBase(r, problems);

  if (r.model === "window") {
    if (r.startDate !== null && !isNonEmptyString(r.startDate)) {
      problems.push(`startDate must be a non-empty string or null, got ${describe(r.startDate)}`);
    }
    if (!isNonEmptyString(r.endDate)) {
      problems.push(`endDate must be a non-empty string, got ${describe(r.endDate)}`);
    }
    if (!isNonNegativeInteger(r.maxTrades)) {
      problems.push(`maxTrades must be a non-negative integer, got ${describe(r.maxTrades)}`);
    }
    if (!isPositiveFiniteNumber(r.endingBalance)) {
      problems.push(
        `endingBalance must be a positive finite number, got ${describe(r.endingBalance)}`,
      );
    }
    if (!Array.isArray(r.trades)) {
      problems.push(`trades must be an array, got ${describe(r.trades)}`);
    } else {
      r.trades.forEach((trade, i) => validateTrade(trade, `trades[${i}]`, problems));
    }
    validateWorstCaseResult(r.worstCase, "worstCase", problems);
    validateWorstNotExceedingOptimal(
      (r.worstCase as Record<string, unknown> | undefined)?.endingBalance,
      r.endingBalance,
      "worstCase.endingBalance",
      problems,
    );
  } else if (r.model === "intraday-daily") {
    if (!isNonEmptyString(r.endDate)) {
      problems.push(`endDate must be a non-empty string, got ${describe(r.endDate)}`);
    }
    if (!isNonNegativeInteger(r.maxTradesPerDay)) {
      problems.push(
        `maxTradesPerDay must be a non-negative integer, got ${describe(r.maxTradesPerDay)}`,
      );
    }
    if (!Array.isArray(r.days)) {
      problems.push(`days must be an array, got ${describe(r.days)}`);
    } else {
      r.days.forEach((day, i) => validateIntradayDay(day, `days[${i}]`, problems));
    }
  } else {
    problems.push(`model must be "window" or "intraday-daily", got ${describe(r.model)}`);
  }

  if (problems.length > 0) {
    throw new ResultValidationError(
      `PrecomputedResult for range ${describe(r.range)} failed schema self-validation (${problems.length} problem${problems.length === 1 ? "" : "s"}):\n` +
        problems.map((p) => `  - ${p}`).join("\n"),
    );
  }
}
