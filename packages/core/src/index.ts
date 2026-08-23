// Shared domain logic for Had I Known Trades: ticker universe, the Yahoo
// Finance data client, and the multi-ticker trade optimizer live here.

export { SP500_CONSTITUENTS } from "./sp500-constituents";
export type { SP500Constituent } from "./sp500-constituents";

export {
  fetchDailyCloses,
  fetchIntradayBars,
  fetchFiveMinuteBars,
  fetchIntraday1mBars,
  toYahooSymbol,
  BlockedError,
  TickerNotFoundError,
  UnexpectedResponseError,
  TransientFetchError,
} from "./yahoo-client";
export type { DailyClose, IntradayBar } from "./yahoo-client";

// fetchDailyClosesCached is deliberately not re-exported here — it's a
// dev-only convenience, not part of the production API. Import it
// directly from another TS module in this workspace:
// `import { fetchDailyClosesCached } from "@hadiknowntrades/core/src/yahoo-client-cache"`.
// That resolves fine through this workspace's TS tooling (vitest, or
// whatever runs the pipeline once issue #5 lands), but NOT from a bare
// `node script.mjs` — there's no compiled .js output and no tsx/ts-node
// in this repo (yet) to make that work outside a TS-aware runtime.

export {
  buildCalendar,
  optimizeTrades,
  optimizeWorstTrades,
  optimizeBothDirections,
  optimizeAllVariants,
  OptimizerInputError,
} from "./optimizer";
export type {
  Calendar,
  OptimizationResult,
  OptimizeOptions,
  Trade,
  TradeDirection,
} from "./optimizer";

export { optimizeIntradayDays } from "./intraday-optimizer";
export type {
  IntradayDayResult,
  IntradayTrade,
  IntradayWorstCaseResult,
  IntradayLongShortResult,
  OptimizeIntradayOptions,
  OptimizeIntradayResult,
} from "./intraday-optimizer";

export { PRESET_RANGES, presetRangeStartDate } from "./preset-ranges";
export type { PresetRange } from "./preset-ranges";

export { toDateString, daysBeforeUtc } from "./date-utils";

export {
  CUSTOM_RANGE_ANCHOR_YEARS_BACK,
  anchorDateToDate,
  customRangeAnchors,
} from "./custom-range-anchors";
export type { AnchorDate } from "./custom-range-anchors";

export {
  resultKey,
  customResultKey,
  CUSTOM_ANCHORS_MANIFEST_KEY,
  RESULTS_SCHEMA_VERSION,
  validatePrecomputedResult,
  validateCustomWindowResult,
  validateCustomAnchorsManifest,
  ResultValidationError,
} from "./results-schema";
export type {
  PrecomputedResult,
  WindowResult,
  IntradayResult,
  CustomWindowResult,
  CustomAnchorsManifest,
  ResultModel,
  WorstCaseResult,
  LongShortResult,
  BenchmarkResult,
} from "./results-schema";
