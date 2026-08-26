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
import type { IntradayDayResult, IntradayLongShortResult } from "./intraday-optimizer";
import type { DailyClose } from "./yahoo-client";
import { isValidPrice } from "./is-valid-price";
import { anchorDateToDate, type AnchorDate } from "./custom-range-anchors";

/**
 * Bumped whenever the shape of PrecomputedResult changes in a way a reader needs to know about.
 *
 * **Bumped 7 -> 8 for issue #126** (`benchmarkSeries`): every
 * PrecomputedResult gains a trailing window of raw SPY daily closes
 * alongside the existing whole-window `benchmark` summary. This clears
 * the constant's own stated bar ("a shape change a reader needs to know
 * about") rather than the additive-field exemption `barIntervalMinutes`
 * took (see packages/core/CLAUDE.md's "Mixed-granularity 1M/3M assembly"
 * section): issue #128's Call Board engine reads this field directly,
 * so a reader deployed against the new shape must not silently accept a
 * stale pre-#126 object that simply doesn't have it.
 */
export const RESULTS_SCHEMA_VERSION = 8;

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

/**
 * The S3 key a custom-range anchor's precomputed result (issue #11,
 * day-granularity since issue #75) is stored/read under -- same
 * single-source-of-truth role as resultKey above, just for
 * CustomWindowResult instead of PrecomputedResult. Namespaced under
 * `results/custom/` (not flat alongside the 6 preset keys) so the two
 * families are trivially distinguishable by key prefix alone, and so an
 * S3 listing of one family never accidentally includes the other.
 *
 * **Issue #75 migrated the identifier from `YYYY-MM` to `YYYY-MM-DD`**
 * -- the key *shape* (`results/custom/` prefix + identifier + `.json`)
 * is unchanged, only the identifier's own format grows two extra digit
 * groups. The old `results/custom/{YYYY-MM}.json` keys this function
 * used to produce are left in place, not retired -- see
 * apps/pipeline/CLAUDE.md's "Day-granularity extension" section for why.
 */
export function customResultKey(anchorDate: AnchorDate): string {
  return `results/custom/${anchorDate}.json`;
}

/**
 * The S3 key the custom-anchors manifest (CustomAnchorsManifest, below)
 * is stored/read under (issue #75) -- a single fixed key, not a function
 * of an identifier, since there's exactly one manifest per pipeline run.
 * `index.json` deliberately can't collide with a real per-anchor key
 * (`\d{4}-\d{2}-\d{2}\.json`): a plain prefix listing of `results/custom/`
 * trivially distinguishes "the one manifest object" from "every
 * individual anchor result" by filename shape alone, the same
 * by-prefix-alone distinguishability principle issue #11's own doc
 * comment already established for why `results/custom/` is a separate
 * prefix from the 6 flat preset-range keys in the first place.
 */
export const CUSTOM_ANCHORS_MANIFEST_KEY = "results/custom/index.json";

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
  /**
   * SPY buy-and-hold comparison over the same window (issue #12). Null
   * only when no benchmark data could be fetched at all this run (see
   * BenchmarkResult / apps/pipeline's computeBenchmark) -- a
   * present-but-truncated result is a real, honestly-scoped comparison,
   * not a degraded/missing one; see BenchmarkResult.truncated.
   */
  benchmark: BenchmarkResult | null;
  /**
   * A trailing window of raw SPY daily closes (issue #126) -- the data
   * foundation issue #128's Call Board engine needs to score a rolling
   * daily up/down prediction game, which the whole-window `benchmark`
   * summary above can't provide (it collapses the entire window to a
   * single start/end pair).
   *
   * Null under exactly the same conditions `benchmark` is null: the SPY
   * fetch failed outright this run, or produced no bars inside the
   * trailing window. That fetch is deliberately non-fatal to the
   * pipeline run (see apps/pipeline's fetchBenchmarkHistory), so a
   * reader MUST render sanely with this field absent -- the same
   * contract `benchmark: null` already carries.
   *
   * Deliberately NOT on CustomWindowResult, unlike `benchmark` -- see
   * BenchmarkSeries' own doc comment for why.
   */
  benchmarkSeries: BenchmarkSeries | null;
}

/**
 * A trailing window of raw SPY daily closes (issue #126), carried on
 * every PrecomputedResult alongside the whole-window `benchmark`
 * summary -- see apps/pipeline's computeBenchmarkSeries for how it's
 * sliced, and BENCHMARK_SERIES_TRAILING_DAYS there for the window size.
 *
 * **Range-independent on purpose**: the identical series is stamped onto
 * all 6 preset ranges' results, not sliced to each range's own window.
 * Its consumer (issue #128's Call Board) is a rolling daily game about
 * recent trading days, not about whichever range the viewer happens to
 * have selected -- scoping it per range would make the same game show
 * different history depending on an unrelated control, and would leave
 * the 1W range with too few days to score anything at all.
 *
 * **Deliberately not added to CustomWindowResult**, unlike `benchmark`:
 * a custom anchor's result is one of hundreds written per run (see
 * custom-range-anchors.ts), and stamping the same range-independent
 * series onto every one of them would multiply a few KB into megabytes
 * of byte-identical duplication for a field no custom-anchor reader
 * wants. The 6 preset results are where a reader already goes for it.
 */
export interface BenchmarkSeries {
  /** Hardcoded to "SPY", same as BenchmarkResult.ticker -- a real field rather than an assumption baked into every reader, in case that ever changes. */
  ticker: string;
  /**
   * The trailing window size, in calendar days, this series was sliced
   * to (apps/pipeline's BENCHMARK_SERIES_TRAILING_DAYS). Self-describing
   * so a reader can tell how much history it actually got without
   * hardcoding the pipeline's own constant a second time -- and so a
   * later change to that constant is visible in the stored JSON itself.
   */
  trailingDays: number;
  /**
   * SPY's real daily closes inside that trailing window, ascending by
   * date, one entry per real trading day (weekends/holidays simply
   * aren't present). Never empty -- an empty window yields a null
   * `benchmarkSeries` instead, so a reader never has to distinguish
   * "no data" from "an empty array." Reuses DailyClose (yahoo-client.ts)
   * as-is rather than re-declaring the identical `{date, close}` shape,
   * the same reasoning IntradayResult.days already applies to
   * IntradayDayResult.
   */
  closes: DailyClose[];
}

/**
 * A SPY buy-and-hold comparison over the same window a PrecomputedResult
 * covers (issue #12) -- see apps/pipeline's computeBenchmark for how this
 * is derived, and this interface's own field comments for what
 * `truncated` means.
 */
export interface BenchmarkResult {
  /** Hardcoded to "SPY" -- no user-chosen ticker (issue #12's own scope). Present as a real field, not assumed by every reader, in case that ever changes. */
  ticker: string;
  /** Actual first date of benchmark data used -- may be later than this result's own requested start date; see `truncated`. */
  startDate: string;
  startPrice: number;
  /** Actual last date of benchmark data used -- <= this result's endDate, same "fact about the data" framing as dataAsOf. */
  endDate: string;
  endPrice: number;
  endingBalance: number;
  /**
   * True when `startDate` had to be pulled forward from this result's own
   * requested start date because the benchmark's own history doesn't
   * reach back that far (concretely: the MAX range vs. SPY's 1993-01-29
   * inception -- MAX's own requested start is unbounded/null, which is
   * always later than SPY's real, finite inception, so this is
   * unconditionally true for MAX). A reader MUST reflect this in
   * displayed copy when true -- see packages/core/CLAUDE.md's benchmark
   * section for why silently showing the number without this caveat
   * misrepresents what window it covers.
   */
  truncated: boolean;
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
 * max-search does -- checked below in validateWorstCaseResultWith's caller.
 */
export interface WorstCaseResult {
  endingBalance: number;
  trades: Trade[];
}

/**
 * The long+short counterpart to a WindowResult's (or CustomWindowResult's,
 * issue #11) own long-only endingBalance/trades/worstCase (issue #13) --
 * searched over the same window, but with short trades (reciprocal-price
 * payoff, see optimizer.ts's own header comment) also available alongside
 * longs. Deliberately an additive sibling field, not a restructure of the
 * existing flat fields -- mirrors WorstCaseResult's own precedent
 * (issue #31) for "a second, alternative computation over the same
 * window," and keeps every existing long-only consumer untouched. No
 * redundant startingCapital here either, same reasoning as
 * WorstCaseResult: identical to the sibling window's own startingCapital.
 *
 * Always true by construction (checked in validateWindowLikeFields below,
 * shared by validatePrecomputedResult's "window" branch and
 * validateCustomWindowResult -- and by validateIntradayDay for
 * IntradayLongShortResult's identical shape): `endingBalance >= ` the
 * sibling long-only `endingBalance` (the long+short max-search explores a
 * strict superset of the long-only candidate set), and
 * `worstCase.endingBalance <= ` the sibling `worstCase.endingBalance`
 * (same superset argument, inverted for a min search).
 */
export interface LongShortResult {
  endingBalance: number;
  trades: Trade[];
  /** Same "worst achievable" meaning as the sibling top-level worstCase, but searched over the long+short candidate set (issue #13) -- see optimizer.ts's own header comment for why this is safe to include (a short's payoff is bounded below by 0 under the chosen model, never negative, so a min search can't produce an impossible result). */
  worstCase: WorstCaseResult;
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
  /** The long+short counterpart to this window's own long-only fields (issue #13) -- see LongShortResult. */
  longShort: LongShortResult;
}

/**
 * The per-day intraday model (issue #28; 1W/1M/3M/1Y, 1W since issue #60): for every
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

/**
 * A custom-range anchor's precomputed result (issue #11's coarsened
 * design, day-granularity anchors since issue #75 -- see
 * docs/plans/issue-11-plan.md and docs/plans/issue-75-plan.md): the same
 * whole-window, daily-close, up-to-`maxTrades` model as WindowResult
 * (same optimizer, same machinery -- see apps/pipeline/src/pipeline.ts's
 * computeWindowOptimization, shared by both), just keyed by a real
 * trading-day `anchorDate` (packages/core/src/custom-range-anchors.ts)
 * instead of a `PresetRange`.
 *
 * Deliberately a type *separate from* the PrecomputedResult union above,
 * not a third member of it -- PresetRange is a closed, exhaustively-
 * iterated 5-member union throughout this codebase (PRESET_RANGES itself,
 * apps/pipeline's WINDOW_RANGES/INTRADAY_RANGES split, apps/web's
 * isCanonicalRange/parseRange), and folding a multi-hundred-member anchor
 * set into that same `range` field would mean loosening PresetRange
 * everywhere it appears, not just here. A sibling type with its own
 * `anchorDate` identifying field avoids that blast radius entirely while
 * still sharing every other field/shape/validation convention below.
 *
 * **Still gated by the same RESULTS_SCHEMA_VERSION as PrecomputedResult**
 * (see `schemaVersion` below) -- unlike the live-compute design this
 * issue's plan originally sketched (whose own CustomWindowResult
 * judgment call exempted it from this version check, reasoning that a
 * live-compute result has no separate writer to drift from the reader).
 * That reasoning doesn't apply here: this result *is* written by a
 * separate process (apps/pipeline, nightly) from the one that reads it
 * (apps/web's API route), the exact same writer/reader-drift risk every
 * other PrecomputedResult already guards against via this same constant
 * -- so it reuses the identical protection rather than inventing a
 * parallel one.
 *
 * **Gains its own `longShort` sibling field (issue #13/#11 integration)**,
 * the same additive-sibling pattern `WindowResult`/`IntradayDayResult`
 * already carry -- `apps/pipeline`'s `buildCustomWindowResults` computes
 * both variants via the same `computeWindowOptimization` helper
 * `buildWindowResults` uses (itself now backed by `optimizeAllVariants`,
 * not the long-only-only `optimizeBothDirections` #11 originally wired
 * it to), so a custom anchor's result is never missing the long+short
 * counterpart every preset window range already has.
 */
export interface CustomWindowResult {
  schemaVersion: number;
  model: "custom-window";
  /**
   * The anchor identifying this result -- see custom-range-anchors.ts.
   * **Renamed from `anchorMonth` (issue #75)**: now a real
   * `YYYY-MM-DD` trading day, not a `YYYY-MM` calendar month -- the
   * field itself was renamed, not just retyped, since "month" stopped
   * being an accurate name for what it holds.
   */
  anchorDate: AnchorDate;
  generatedAt: string;
  /** Same meaning as PrecomputedResultBase.dataAsOf. */
  dataAsOf: string;
  /**
   * Always exactly equal to `anchorDate` -- every anchor is already a
   * real trading day (see custom-range-anchors.ts's own doc comment on
   * why day-granularity anchors need no forward-snapping the way the
   * month scheme once did), so there's no separate "nominal start" vs.
   * "actual snapped start" to distinguish here, unlike
   * WindowResult.startDate, which can be null for the unbounded MAX
   * range. A custom anchor is never unbounded.
   */
  startDate: string;
  /** The requested "as of" boundary for this run -- always "today," same as every preset range's own endDate. */
  endDate: string;
  maxTrades: number;
  startingCapital: number;
  universeSize: number;
  skippedTickers: string[];
  benchmark: BenchmarkResult | null;
  endingBalance: number;
  trades: Trade[];
  worstCase: WorstCaseResult;
  /** The long+short counterpart to this anchor's own long-only fields (issue #13) -- see LongShortResult, and this interface's own doc comment for why it's here at all. */
  longShort: LongShortResult;
}

/**
 * The published list of valid custom-start-date anchors (issue #75) --
 * stored at `CUSTOM_ANCHORS_MANIFEST_KEY` (`results/custom/index.json`),
 * written once per pipeline run alongside every individual
 * `CustomWindowResult`. Exists because day-granularity anchors are no
 * longer computable from calendar math alone the way the old
 * month-granularity scheme's anchors were (see custom-range-anchors.ts's
 * own doc comment) -- `apps/web`'s calendar-grid picker needs a real
 * network fetch to know which specific days are real, precomputed,
 * selectable anchors, and this manifest is what it fetches
 * (`GET /api/custom-anchors`, `apps/web/src/lib/results-api.ts`'s
 * `getCustomAnchorsResponse`).
 *
 * **Reuses `RESULTS_SCHEMA_VERSION`, the same global constant, rather
 * than inventing a second parallel version number** -- the same
 * writer/reader-drift risk every other `PrecomputedResult`/
 * `CustomWindowResult` already guards against via this constant applies
 * here too: this manifest is written by a separate process (the nightly
 * pipeline) from the one that reads it (`apps/web`'s API route).
 */
export interface CustomAnchorsManifest {
  schemaVersion: number;
  /** Every currently-published anchor, ascending (oldest first) -- deliberately NOT customRangeAnchors' own newest-first order, since a calendar UI wants to walk forward through months. */
  anchors: AnchorDate[];
}

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
 * openPrice/closePrice -- the predicate is identical either way, just under
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

/** Validates a `Trade`/`IntradayTrade` `direction` field (issue #13) -- "long" or "short", nothing else. */
function isValidDirection(value: unknown): value is "long" | "short" {
  return value === "long" || value === "short";
}

/**
 * Validates one `Trade` (see optimizer.ts) as it appears embedded in a
 * `WindowResult.trades`/`longShort.trades`/`worstCase.trades` entry,
 * appending one message per problem found to `problems` rather than
 * stopping at the first -- a malformed result is worth diagnosing in one
 * pass, not one failed `putObject` retry at a time.
 */
function validateTrade(trade: unknown, path: string, problems: string[]): void {
  if (trade === null || typeof trade !== "object") {
    problems.push(`${path} must be an object, got ${describe(trade)}`);
    return;
  }
  const t = trade as Record<string, unknown>;
  if (!isNonEmptyString(t.ticker))
    problems.push(`${path}.ticker must be a non-empty string, got ${describe(t.ticker)}`);
  if (!isValidDirection(t.direction))
    problems.push(`${path}.direction must be "long" or "short", got ${describe(t.direction)}`);
  if (!isNonEmptyString(t.openDate))
    problems.push(`${path}.openDate must be a non-empty string, got ${describe(t.openDate)}`);
  if (!isPositiveFiniteNumber(t.openPrice))
    problems.push(
      `${path}.openPrice must be a positive finite number, got ${describe(t.openPrice)}`,
    );
  if (!isNonEmptyString(t.closeDate))
    problems.push(`${path}.closeDate must be a non-empty string, got ${describe(t.closeDate)}`);
  if (!isPositiveFiniteNumber(t.closePrice))
    problems.push(
      `${path}.closePrice must be a positive finite number, got ${describe(t.closePrice)}`,
    );
}

/** Validates one `IntradayTrade` (see intraday-optimizer.ts) embedded in an `IntradayDayResult.trades`/`longShort.trades`/`worstCase.trades` entry. */
function validateIntradayTrade(trade: unknown, path: string, problems: string[]): void {
  if (trade === null || typeof trade !== "object") {
    problems.push(`${path} must be an object, got ${describe(trade)}`);
    return;
  }
  const t = trade as Record<string, unknown>;
  if (!isNonEmptyString(t.ticker))
    problems.push(`${path}.ticker must be a non-empty string, got ${describe(t.ticker)}`);
  if (!isValidDirection(t.direction))
    problems.push(`${path}.direction must be "long" or "short", got ${describe(t.direction)}`);
  if (!isNonEmptyString(t.date))
    problems.push(`${path}.date must be a non-empty string, got ${describe(t.date)}`);
  if (!isNonEmptyString(t.openTime))
    problems.push(`${path}.openTime must be a non-empty string, got ${describe(t.openTime)}`);
  if (!isPositiveFiniteNumber(t.openPrice))
    problems.push(
      `${path}.openPrice must be a positive finite number, got ${describe(t.openPrice)}`,
    );
  if (!isNonEmptyString(t.closeTime))
    problems.push(`${path}.closeTime must be a non-empty string, got ${describe(t.closeTime)}`);
  if (!isPositiveFiniteNumber(t.closePrice))
    problems.push(
      `${path}.closePrice must be a positive finite number, got ${describe(t.closePrice)}`,
    );
}

/** A per-trade validator matching validateTrade/validateIntradayTrade's own signature -- the one thing validateWorstCaseResultWith's two callers below differ on. */
type TradeValidator = (trade: unknown, path: string, problems: string[]) => void;

/**
 * Validates one worst-case result object -- `WorstCaseResult` embedded in
 * a `WindowResult.worstCase` field, or `IntradayWorstCaseResult` embedded
 * in an `IntradayDayResult.worstCase` field (see results-schema.ts's own
 * doc comment on those types). Both shapes share `endingBalance` +
 * `trades`, checked here, and differ only in which per-trade shape their
 * `trades` array holds, so `validateTrade` for the window case is
 * dependency-injected as `validateIntradayTrade` for the intraday case.
 *
 * **Since issue #84, `IntradayWorstCaseResult`/`IntradayLongShortResult`
 * also carry their own `startingCapital` field that `WorstCaseResult`/
 * `LongShortResult` (the window-model siblings) don't have** -- that
 * field is intentionally NOT checked here, since this function is shared
 * across both shapes; `validateIntradayDay` checks it separately, right
 * alongside its own cross-day chaining check (see that function and
 * `validateChainedStartingCapital` below).
 */
function validateWorstCaseResultWith(
  value: unknown,
  path: string,
  problems: string[],
  validateTradeEntry: TradeValidator,
): void {
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
    w.trades.forEach((trade, i) => validateTradeEntry(trade, `${path}.trades[${i}]`, problems));
  }
}

/**
 * Shared "positive-finite a vs b ordering" predicate (code review
 * follow-up to issue #13) -- validateWorstNotExceedingOptimal,
 * validateLongShortNotBelowLongOnly, and
 * validateLongShortWorstNotAboveLongOnlyWorst below all used to
 * hand-roll this exact same check (both operands must already be
 * known-valid positive finite numbers, then one comparator decides
 * whether to report a problem), differing only in which comparison they
 * ran and how they worded the resulting message -- extracted here so
 * there's one place that owns "only fire once both values are already
 * valid numbers" instead of three copies that could drift apart.
 */
function validateOrdering(
  actual: unknown,
  bound: unknown,
  violates: (actual: number, bound: number) => boolean,
  problems: string[],
  message: (actual: number, bound: number) => string,
): void {
  if (isPositiveFiniteNumber(actual) && isPositiveFiniteNumber(bound) && violates(actual, bound)) {
    problems.push(message(actual, bound));
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
  validateOrdering(
    worstEndingBalance,
    optimalEndingBalance,
    (worst, optimal) => worst > optimal,
    problems,
    (worst, optimal) =>
      `${path} (${worst}) must not exceed its optimal-case counterpart (${optimal})`,
  );
}

/**
 * Validates one `LongShortResult`/`IntradayLongShortResult` (issue #13) --
 * `endingBalance`/`trades` validate identically to a `WorstCaseResult`
 * (reused directly via validateWorstCaseResultWith, since the two shapes
 * only differ in LongShortResult nesting its own `worstCase`), plus that
 * nested `worstCase` validated the same way a second time, plus the same
 * "worst never exceeds optimal" cross-check applied to this nested pair.
 */
function validateLongShortResultWith(
  value: unknown,
  path: string,
  problems: string[],
  validateTradeEntry: TradeValidator,
): void {
  validateWorstCaseResultWith(value, path, problems, validateTradeEntry);
  if (value === null || typeof value !== "object") return; // already reported above
  const ls = value as Record<string, unknown>;
  validateWorstCaseResultWith(ls.worstCase, `${path}.worstCase`, problems, validateTradeEntry);
  validateWorstNotExceedingOptimal(
    (ls.worstCase as Record<string, unknown> | undefined)?.endingBalance,
    ls.endingBalance,
    `${path}.worstCase.endingBalance`,
    problems,
  );
}

/**
 * Cross-checks that the long+short max-search never does worse than its
 * long-only counterpart (issue #13) -- true by construction: the
 * long+short search explores a strict superset of the long-only
 * candidate trade set (every long candidate remains available, plus
 * shorts), so a max search over a superset can never do worse.
 * Specifically valuable because a violation is exactly the signature a
 * short-search implementation bug (e.g. the short block accidentally
 * excluding some long candidates) would produce.
 */
function validateLongShortNotBelowLongOnly(
  longShortEndingBalance: unknown,
  longOnlyEndingBalance: unknown,
  path: string,
  problems: string[],
): void {
  validateOrdering(
    longShortEndingBalance,
    longOnlyEndingBalance,
    (longShort, longOnly) => longShort < longOnly,
    problems,
    (longShort, longOnly) =>
      `${path} (${longShort}) must be >= its long-only counterpart (${longOnly})`,
  );
}

/**
 * Cross-checks that the long+short min-search (worst case) never finds a
 * *higher* (less bad) minimum than its long-only counterpart (issue #13)
 * -- same superset argument as validateLongShortNotBelowLongOnly above,
 * inverted for a min search: it can never find a higher minimum than a
 * min search over a subset could.
 */
function validateLongShortWorstNotAboveLongOnlyWorst(
  longShortWorstEndingBalance: unknown,
  longOnlyWorstEndingBalance: unknown,
  path: string,
  problems: string[],
): void {
  validateOrdering(
    longShortWorstEndingBalance,
    longOnlyWorstEndingBalance,
    (longShortWorst, longOnlyWorst) => longShortWorst > longOnlyWorst,
    problems,
    (longShortWorst, longOnlyWorst) =>
      `${path} (${longShortWorst}) must be <= its long-only counterpart (${longOnlyWorst})`,
  );
}

/**
 * Optional extra guard (issue #13, lower priority than the two cross-
 * checks above): every trade in a long-only trades array must have
 * `direction === "long"` -- a long-only search can never legitimately
 * produce a short trade, so a `"short"` appearing here indicates a bug
 * (e.g. `includeShorts` accidentally wired to `true` for a call site
 * that should be `false`). Cheap, and catches exactly the class of
 * regression this schema's "long-only behavior provably unchanged"
 * argument depends on staying true. Silently skips a malformed entry --
 * validateTrade/validateIntradayTrade already reported that separately.
 */
function validateAllTradesAreLong(trades: unknown, path: string, problems: string[]): void {
  if (!Array.isArray(trades)) return;
  trades.forEach((trade, i) => {
    if (trade === null || typeof trade !== "object") return;
    const direction = (trade as Record<string, unknown>).direction;
    if (direction !== "long") {
      problems.push(
        `${path}[${i}].direction must be "long" in a long-only trades array, got ${describe(direction)}`,
      );
    }
  });
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
    validateAllTradesAreLong(d.trades, `${path}.trades`, problems);
  }
  validateWorstCaseResultWith(d.worstCase, `${path}.worstCase`, problems, validateIntradayTrade);
  validateWorstNotExceedingOptimal(
    (d.worstCase as Record<string, unknown> | undefined)?.endingBalance,
    d.endingBalance,
    `${path}.worstCase.endingBalance`,
    problems,
  );
  const worstCaseTrades = (d.worstCase as Record<string, unknown> | undefined)?.trades;
  if (worstCaseTrades !== undefined) {
    validateAllTradesAreLong(worstCaseTrades, `${path}.worstCase.trades`, problems);
  }
  // This track's own chained starting capital (issue #84) -- see
  // IntradayWorstCaseResult's own doc comment for why this field exists
  // separately from the sibling IntradayDayResult.startingCapital above.
  if (
    !isPositiveFiniteNumber((d.worstCase as Record<string, unknown> | undefined)?.startingCapital)
  ) {
    problems.push(
      `${path}.worstCase.startingCapital must be a positive finite number, got ${describe((d.worstCase as Record<string, unknown> | undefined)?.startingCapital)}`,
    );
  }

  // Long+short counterpart to this day's own long-only fields (issue #13).
  validateLongShortResultWith(d.longShort, `${path}.longShort`, problems, validateIntradayTrade);
  const longShort = d.longShort as Record<string, unknown> | undefined;
  validateLongShortNotBelowLongOnly(
    longShort?.endingBalance,
    d.endingBalance,
    `${path}.longShort.endingBalance`,
    problems,
  );
  validateLongShortWorstNotAboveLongOnlyWorst(
    (longShort?.worstCase as Record<string, unknown> | undefined)?.endingBalance,
    (d.worstCase as Record<string, unknown> | undefined)?.endingBalance,
    `${path}.longShort.worstCase.endingBalance`,
    problems,
  );
  // This track's own chained starting capital (issue #84), and its
  // nested worst-case counterpart's -- same reasoning as d.worstCase.startingCapital above.
  if (!isPositiveFiniteNumber(longShort?.startingCapital)) {
    problems.push(
      `${path}.longShort.startingCapital must be a positive finite number, got ${describe(longShort?.startingCapital)}`,
    );
  }
  if (
    !isPositiveFiniteNumber(
      (longShort?.worstCase as Record<string, unknown> | undefined)?.startingCapital,
    )
  ) {
    problems.push(
      `${path}.longShort.worstCase.startingCapital must be a positive finite number, got ${describe((longShort?.worstCase as Record<string, unknown> | undefined)?.startingCapital)}`,
    );
  }
}

/**
 * The four per-track "chained starting capital" checks (issue #84) --
 * the first cross-*day* validation this codebase has ever needed (every
 * check above this function is purely per-day/per-field). Once
 * apps/pipeline chains balances across a range's `days[]` (see that
 * package's own CLAUDE.md), each day's own `startingCapital` (and its
 * worst/longShort/longShort.worstCase siblings) is no longer an
 * independent value to range-check in isolation -- it must equal exactly
 * the *previous* day's own `endingBalance` for that same track, and day
 * 0 of the range must start from the range's own root `startingCapital`.
 *
 * **Exact equality is safe and intentional here, not a tolerance-based
 * check**: apps/pipeline's chaining pass literally copies the previous
 * day's already-computed `endingBalance` forward as the next day's
 * `startingCapital` -- no new arithmetic runs in between that could
 * introduce float drift (see docs/plans/issue-84-plan.md section 6.4).
 *
 * Only compares two values once both are already known-valid positive
 * finite numbers (same "don't pile a second, redundant problem onto an
 * already-reported malformed value" posture `validateOrdering` above
 * uses) -- a day that failed its own per-day `startingCapital`/
 * `endingBalance` check already has a problem recorded for it; this
 * function doesn't also report a confusing chaining mismatch built on
 * top of a value already known to be garbage.
 */
function validateChainedStartingCapital(days: unknown[], problems: string[]): void {
  const dayAt = (i: number): Record<string, unknown> | undefined => {
    const day = days[i];
    return day !== null && typeof day === "object" ? (day as Record<string, unknown>) : undefined;
  };
  const worstCaseOf = (
    day: Record<string, unknown> | undefined,
  ): Record<string, unknown> | undefined => {
    const w = day?.worstCase;
    return w !== null && typeof w === "object" ? (w as Record<string, unknown>) : undefined;
  };
  const longShortOf = (
    day: Record<string, unknown> | undefined,
  ): Record<string, unknown> | undefined => {
    const ls = day?.longShort;
    return ls !== null && typeof ls === "object" ? (ls as Record<string, unknown>) : undefined;
  };

  const checkChain = (actualStart: unknown, expectedStart: unknown, path: string): void => {
    if (
      isPositiveFiniteNumber(actualStart) &&
      isPositiveFiniteNumber(expectedStart) &&
      actualStart !== expectedStart
    ) {
      problems.push(
        `${path} (${actualStart}) must equal the previous day's own ending balance (${expectedStart}) once chained (issue #84)`,
      );
    }
  };

  for (let i = 0; i < days.length; i++) {
    const day = dayAt(i);
    const worst = worstCaseOf(day);
    const longShort = longShortOf(day);
    const longShortWorst = worstCaseOf(longShort);
    const path = `days[${i}]`;

    if (i === 0) continue; // day 0's root-capital check is done by the caller, against result.startingCapital.

    const prevDay = dayAt(i - 1);
    const prevWorst = worstCaseOf(prevDay);
    const prevLongShort = longShortOf(prevDay);
    const prevLongShortWorst = worstCaseOf(prevLongShort);

    checkChain(day?.startingCapital, prevDay?.endingBalance, `${path}.startingCapital`);
    checkChain(
      worst?.startingCapital,
      prevWorst?.endingBalance,
      `${path}.worstCase.startingCapital`,
    );
    checkChain(
      longShort?.startingCapital,
      prevLongShort?.endingBalance,
      `${path}.longShort.startingCapital`,
    );
    checkChain(
      longShortWorst?.startingCapital,
      prevLongShortWorst?.endingBalance,
      `${path}.longShort.worstCase.startingCapital`,
    );
  }
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

/**
 * Validates one `benchmark` field (issue #12) -- `null` is a valid,
 * distinct state ("no benchmark data was available this run", see
 * BenchmarkResult's own doc comment), deliberately checked *before* the
 * `typeof value !== "object"` branch below so it doesn't fall into it.
 *
 * **Deliberately distinguishes `undefined` from `null`**: since the
 * first check here is `value === null` (passes) and
 * `typeof undefined !== "object"` (fails the second check, correctly
 * flagged), an entirely-missing `benchmark` field -- e.g. a stale pre-#12
 * stored object, or a future refactor bug that forgets to set it -- is
 * caught as a real validation failure, not silently treated the same as
 * the valid "no benchmark data this run" empty state. Same care issue
 * #47's own `schemaVersion` check already takes for an analogous
 * "any non-negative integer" vs. "exactly this value" distinction -- see
 * packages/core/CLAUDE.md.
 */
function validateBenchmark(value: unknown, problems: string[]): void {
  if (value === null) return; // valid: no benchmark data was available this run
  if (typeof value !== "object") {
    problems.push(`benchmark must be null or an object, got ${describe(value)}`);
    return;
  }
  const b = value as Record<string, unknown>;
  if (!isNonEmptyString(b.ticker))
    problems.push(`benchmark.ticker must be a non-empty string, got ${describe(b.ticker)}`);
  if (!isNonEmptyString(b.startDate))
    problems.push(`benchmark.startDate must be a non-empty string, got ${describe(b.startDate)}`);
  if (!isPositiveFiniteNumber(b.startPrice))
    problems.push(
      `benchmark.startPrice must be a positive finite number, got ${describe(b.startPrice)}`,
    );
  if (!isNonEmptyString(b.endDate))
    problems.push(`benchmark.endDate must be a non-empty string, got ${describe(b.endDate)}`);
  if (!isPositiveFiniteNumber(b.endPrice))
    problems.push(
      `benchmark.endPrice must be a positive finite number, got ${describe(b.endPrice)}`,
    );
  if (!isPositiveFiniteNumber(b.endingBalance))
    problems.push(
      `benchmark.endingBalance must be a positive finite number, got ${describe(b.endingBalance)}`,
    );
  if (typeof b.truncated !== "boolean")
    problems.push(`benchmark.truncated must be a boolean, got ${describe(b.truncated)}`);
}

/**
 * Validates one `benchmarkSeries` field (issue #126) -- the exact same
 * null-vs-undefined discipline validateBenchmark above documents at
 * length: `null` is the valid "the SPY fetch failed (or covered no days
 * in the trailing window) this run" state, while an entirely-missing
 * field (a stale pre-#126 stored object, or a future refactor bug that
 * forgets to set it) falls into the `typeof value !== "object"` branch
 * and is correctly flagged.
 *
 * `closes` is required to be non-empty, matching BenchmarkSeries' own
 * documented contract: computeBenchmarkSeries returns null rather than
 * an empty series, so a reader never has to distinguish the two, and an
 * empty array reaching here means something upstream is broken.
 *
 * Deliberately called from validateBase (which only covers
 * PrecomputedResult) rather than validateSharedResultFields (shared with
 * validateCustomWindowResult) -- CustomWindowResult intentionally has no
 * such field; see BenchmarkSeries' own doc comment.
 */
function validateBenchmarkSeries(value: unknown, problems: string[]): void {
  if (value === null) return; // valid: no benchmark series data was available this run
  if (typeof value !== "object") {
    problems.push(`benchmarkSeries must be null or an object, got ${describe(value)}`);
    return;
  }
  const s = value as Record<string, unknown>;
  if (!isNonEmptyString(s.ticker)) {
    problems.push(`benchmarkSeries.ticker must be a non-empty string, got ${describe(s.ticker)}`);
  }
  if (!isNonNegativeInteger(s.trailingDays) || s.trailingDays === 0) {
    problems.push(
      `benchmarkSeries.trailingDays must be a positive integer, got ${describe(s.trailingDays)}`,
    );
  }
  if (!Array.isArray(s.closes)) {
    problems.push(`benchmarkSeries.closes must be an array, got ${describe(s.closes)}`);
    return;
  }
  if (s.closes.length === 0) {
    problems.push(
      "benchmarkSeries.closes must be non-empty (an empty window is represented as benchmarkSeries: null)",
    );
  }
  let previousDate: string | null = null;
  s.closes.forEach((close, i) => {
    const path = `benchmarkSeries.closes[${i}]`;
    if (close === null || typeof close !== "object") {
      problems.push(`${path} must be an object, got ${describe(close)}`);
      return;
    }
    const c = close as Record<string, unknown>;
    if (!isNonEmptyString(c.date)) {
      problems.push(`${path}.date must be a non-empty string, got ${describe(c.date)}`);
    } else {
      // Ascending, strictly -- BenchmarkSeries documents this ordering
      // as part of its contract, and a duplicate date would silently
      // double-count one trading day for a consumer scoring day-over-day
      // moves (issue #128).
      if (previousDate !== null && c.date <= previousDate) {
        problems.push(
          `${path}.date must be strictly after the previous entry's date (${previousDate}), got ${describe(c.date)}`,
        );
      }
      previousDate = c.date;
    }
    if (!isPositiveFiniteNumber(c.close)) {
      problems.push(`${path}.close must be a positive finite number, got ${describe(c.close)}`);
    }
  });
}

/**
 * Validates the fields shared by *every* whole-result shape this file
 * validates, regardless of whether it's identified by `range`
 * (PrecomputedResult) or `anchorDate` (CustomWindowResult, issue #11) --
 * schemaVersion, generatedAt, dataAsOf, startingCapital, universeSize,
 * skippedTickers, benchmark. Called by both validateBase (below, which
 * additionally validates `range`) and validateCustomWindowResult (which
 * additionally validates `anchorDate`) so the two can't independently
 * drift on what these shared fields require.
 *
 * **Extracted from what used to be two ~50-line-overlapping copies of
 * these same checks (code review finding, issue #11)**: validateBase
 * originally did all of this plus the `range` check inline, and
 * validateCustomWindowResult had re-typed an equivalent block by hand --
 * a future rule change to one of these checks made only in validateBase
 * (e.g. a stricter dataAsOf format) would have silently left
 * validateCustomWindowResult's copy unprotected, defeating the whole
 * point of a write-time validation safety net (issue #47) that's
 * supposed to cover every result family.
 */
function validateSharedResultFields(result: Record<string, unknown>, problems: string[]): void {
  if (result.schemaVersion !== RESULTS_SCHEMA_VERSION) {
    problems.push(
      `schemaVersion must be exactly ${RESULTS_SCHEMA_VERSION}, got ${describe(result.schemaVersion)}`,
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
  validateBenchmark(result.benchmark, problems);
}

/**
 * Validates the fields every whole-window *trades-and-worst-case*-shaped
 * result shares -- WindowResult's own fields beyond PrecomputedResultBase
 * (endDate, maxTrades, endingBalance, trades, worstCase, longShort) and
 * CustomWindowResult's identical sibling set (issue #11). Shared for the
 * exact same "can't independently drift" reason validateSharedResultFields
 * above is -- see that function's own doc comment.
 *
 * **Also covers the long+short cross-checks (issue #13), not just the
 * long-only fields** -- merged here (rather than left duplicated between
 * validatePrecomputedResult's own "window" branch and
 * validateCustomWindowResult) so CustomWindowResult gets the exact same
 * `longShort.endingBalance >= endingBalance` /
 * `longShort.worstCase.endingBalance <= worstCase.endingBalance`
 * guarantees WindowResult already has, for free, the moment it grows its
 * own `longShort` sibling field -- see CustomWindowResult's own doc
 * comment for why that field exists at all (issue #13/#11 integration).
 */
function validateWindowLikeFields(r: Record<string, unknown>, problems: string[]): void {
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
    validateAllTradesAreLong(r.trades, "trades", problems);
  }
  validateWorstCaseResultWith(r.worstCase, "worstCase", problems, validateTrade);
  validateWorstNotExceedingOptimal(
    (r.worstCase as Record<string, unknown> | undefined)?.endingBalance,
    r.endingBalance,
    "worstCase.endingBalance",
    problems,
  );
  const worstCaseTrades = (r.worstCase as Record<string, unknown> | undefined)?.trades;
  if (worstCaseTrades !== undefined) {
    validateAllTradesAreLong(worstCaseTrades, "worstCase.trades", problems);
  }

  // Long+short counterpart to this window's own long-only fields (issue
  // #13).
  validateLongShortResultWith(r.longShort, "longShort", problems, validateTrade);
  const longShort = r.longShort as Record<string, unknown> | undefined;
  validateLongShortNotBelowLongOnly(
    longShort?.endingBalance,
    r.endingBalance,
    "longShort.endingBalance",
    problems,
  );
  validateLongShortWorstNotAboveLongOnlyWorst(
    (longShort?.worstCase as Record<string, unknown> | undefined)?.endingBalance,
    (r.worstCase as Record<string, unknown> | undefined)?.endingBalance,
    "longShort.worstCase.endingBalance",
    problems,
  );
}

/** Validates the fields every PrecomputedResult shares, regardless of `model`: everything validateSharedResultFields covers, plus `range` and `benchmarkSeries` (the two fields CustomWindowResult doesn't have -- it has `anchorDate` instead of `range`, validated separately by validateCustomWindowResult, and deliberately no benchmarkSeries at all, see that interface's own doc comment). */
function validateBase(result: Record<string, unknown>, problems: string[]): void {
  validateSharedResultFields(result, problems);
  validateBenchmarkSeries(result.benchmarkSeries, problems);
  if (!(PRESET_RANGES as readonly string[]).includes(result.range as string)) {
    problems.push(
      `range must be one of ${PRESET_RANGES.join(", ")}, got ${describe(result.range)}`,
    );
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
    validateWindowLikeFields(r, problems);
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
      // Cross-day chaining (issue #84) -- see validateChainedStartingCapital's
      // own doc comment for why this is a new category of check.
      validateChainedStartingCapital(r.days, problems);
      // Day 0 of the range starts every track from the range's own root
      // startingCapital (all four tracks identically, by this chaining
      // design's own construction -- see docs/plans/issue-84-plan.md
      // section 6.2).
      const day0 = r.days[0];
      if (day0 !== null && typeof day0 === "object") {
        const d0 = day0 as Record<string, unknown>;
        const d0Worst = d0.worstCase as Record<string, unknown> | undefined;
        const d0LongShort = d0.longShort as Record<string, unknown> | undefined;
        const d0LongShortWorst = d0LongShort?.worstCase as Record<string, unknown> | undefined;
        const rootCapital = r.startingCapital;
        const checkRoot = (actual: unknown, path: string): void => {
          if (
            isPositiveFiniteNumber(actual) &&
            isPositiveFiniteNumber(rootCapital) &&
            actual !== rootCapital
          ) {
            problems.push(
              `${path} (${actual}) must equal the range's own root startingCapital (${rootCapital}) on day 0 once chained (issue #84)`,
            );
          }
        };
        checkRoot(d0.startingCapital, "days[0].startingCapital");
        checkRoot(d0Worst?.startingCapital, "days[0].worstCase.startingCapital");
        checkRoot(d0LongShort?.startingCapital, "days[0].longShort.startingCapital");
        checkRoot(d0LongShortWorst?.startingCapital, "days[0].longShort.worstCase.startingCapital");
      }
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

/**
 * Validates that `result` actually satisfies CustomWindowResult's own
 * declared shape (issue #11) -- the same runtime-self-check discipline
 * validatePrecomputedResult already gives every PrecomputedResult, kept
 * as a separate function (rather than folded into
 * validatePrecomputedResult itself) since CustomWindowResult is a
 * deliberately separate type, not a third PrecomputedResult union member
 * (see that type's own doc comment for why). Shares
 * validateSharedResultFields and validateWindowLikeFields with
 * validatePrecomputedResult's own "window" branch (a code-review-driven
 * refactor -- see each of those functions' own doc comments for why this
 * used to be ~50 lines of independently hand-typed, drift-prone
 * duplication), and reuses every one of the same private field-level
 * validators (isPositiveFiniteNumber, validateTrade,
 * validateWorstCaseResultWith, validateBenchmark, ...) underneath those,
 * so the two validators can't quietly drift on what counts as e.g. "a
 * valid Trade."
 */
export function validateCustomWindowResult(result: CustomWindowResult): void {
  const problems: string[] = [];
  if (result === null || typeof result !== "object") {
    throw new ResultValidationError(`result must be an object, got ${describe(result)}`);
  }
  const r = result as unknown as Record<string, unknown>;

  validateSharedResultFields(r, problems);
  if (r.model !== "custom-window") {
    problems.push(`model must be "custom-window", got ${describe(r.model)}`);
  }
  if (!isNonEmptyString(r.anchorDate) || anchorDateToDate(r.anchorDate) === null) {
    problems.push(
      `anchorDate must be a well-formed YYYY-MM-DD string, got ${describe(r.anchorDate)}`,
    );
  }
  if (!isNonEmptyString(r.startDate)) {
    problems.push(`startDate must be a non-empty string, got ${describe(r.startDate)}`);
  }
  validateWindowLikeFields(r, problems);

  if (problems.length > 0) {
    throw new ResultValidationError(
      `CustomWindowResult for anchor ${describe(r.anchorDate)} failed schema self-validation (${problems.length} problem${problems.length === 1 ? "" : "s"}):\n` +
        problems.map((p) => `  - ${p}`).join("\n"),
    );
  }
}

/**
 * Validates that `result` actually satisfies CustomAnchorsManifest's own
 * declared shape (issue #75) -- the same runtime-self-check discipline
 * every other stored result gets (issue #47), called immediately before
 * the manifest's own `putObject` by apps/pipeline, the same "last line
 * of defense before this becomes what a reader trusts" discipline issue
 * #47 established for every other write.
 *
 * Checks `schemaVersion` exact-equality (same reasoning as every other
 * validator in this file -- see validateSharedResultFields' own
 * schemaVersion check), that `anchors` is a non-empty array of
 * well-formed AnchorDate strings (via anchorDateToDate, reusing the same
 * parse this file already trusts for CustomWindowResult.anchorDate), and
 * that it's strictly ascending with no duplicates -- the manifest's own
 * documented "ascending, oldest first" contract
 * (CustomAnchorsManifest.anchors' own doc comment) that apps/web's
 * calendar picker relies on.
 */
export function validateCustomAnchorsManifest(result: CustomAnchorsManifest): void {
  const problems: string[] = [];
  if (result === null || typeof result !== "object") {
    throw new ResultValidationError(`result must be an object, got ${describe(result)}`);
  }
  const r = result as unknown as Record<string, unknown>;

  if (r.schemaVersion !== RESULTS_SCHEMA_VERSION) {
    problems.push(
      `schemaVersion must be exactly ${RESULTS_SCHEMA_VERSION}, got ${describe(r.schemaVersion)}`,
    );
  }

  if (!Array.isArray(r.anchors) || r.anchors.length === 0) {
    problems.push(`anchors must be a non-empty array, got ${describe(r.anchors)}`);
  } else {
    // Tracks the most recent *well-formed* anchor and its own real index
    // -- not just "the previous array index" -- so the
    // duplicate/out-of-order messages below always cite the actual
    // preceding well-formed anchor, even when one or more malformed
    // entries sit between it and the current one (a real, if
    // diagnostic-only, bug found in code review: `previous` used to stay
    // unset across a malformed entry's early `return`, but the message
    // still hardcoded `anchors[i - 1]` as if it always held that
    // skipped entry's own value).
    let previous: string | null = null;
    let previousIndex: number | null = null;
    r.anchors.forEach((anchor, i) => {
      if (!isNonEmptyString(anchor) || anchorDateToDate(anchor) === null) {
        problems.push(
          `anchors[${i}] must be a well-formed YYYY-MM-DD string, got ${describe(anchor)}`,
        );
        return;
      }
      if (previous !== null && previousIndex !== null) {
        if (anchor === previous) {
          problems.push(`anchors[${i}] ("${anchor}") duplicates anchors[${previousIndex}]`);
        } else if (anchor < previous) {
          problems.push(
            `anchors[${i}] ("${anchor}") is out of order -- must be strictly ascending, but comes before anchors[${previousIndex}] ("${previous}")`,
          );
        }
      }
      previous = anchor;
      previousIndex = i;
    });
  }

  if (problems.length > 0) {
    throw new ResultValidationError(
      `CustomAnchorsManifest failed schema self-validation (${problems.length} problem${problems.length === 1 ? "" : "s"}):\n` +
        problems.map((p) => `  - ${p}`).join("\n"),
    );
  }
}
