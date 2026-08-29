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

// Exported for apps/web's Call Board engine (issue #128), which scores
// against a stored DailyClose series and needs the same "is this a
// legitimate price" bar this package already holds every price to --
// rather than re-deriving `Number.isFinite(v) && v > 0` a fourth time
// (see this module's own doc comment on why it exists at all).
export { isValidPrice } from "./is-valid-price";

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
  collectTradingDates,
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

export { buildIntradaySessions, MIN_CLOSED_SESSION_SPAN_MINUTES } from "./intraday-sessions";
export type { IntradaySession } from "./intraday-sessions";

export {
  computeOrderSelection,
  magSevenCompanyName,
  MAG_SEVEN_TICKERS,
  MIN_ADJACENT_GAP_PP,
  MIN_TOTAL_SPREAD_PP,
  ORDER_POOL_SIZE,
} from "./order-selection";
export type { OrderPick, OrderSelectionResult } from "./order-selection";

export {
  resultKey,
  customResultKey,
  CUSTOM_ANCHORS_MANIFEST_KEY,
  MYSTERY_INDEX_KEY,
  MYSTERY_POOL_MANIFEST_KEY,
  MYSTERY_SESSION_IDS,
  mysterySessionKey,
  RESULTS_SCHEMA_VERSION,
  THE_ORDER_KEY,
  THE_ORDER_TICKER_COUNT,
  TODAYS_CLOSE_SESSION_KEY,
  validatePrecomputedResult,
  validateCustomWindowResult,
  validateCustomAnchorsManifest,
  validateMysteryIndex,
  validateMysteryPoolManifest,
  validateMysterySession,
  validateTheOrderPuzzle,
  validateTodaysCloseSession,
  ResultValidationError,
} from "./results-schema";
export type {
  PrecomputedResult,
  WindowResult,
  IntradayResult,
  CustomWindowResult,
  CustomAnchorsManifest,
  MysteryIndex,
  MysteryIndexEntry,
  MysteryPoolManifest,
  MysterySession,
  ResultModel,
  SessionBar,
  TheOrderPuzzle,
  TheOrderTicker,
  TodaysCloseSession,
  WorstCaseResult,
  LongShortResult,
  BenchmarkResult,
  BenchmarkSeries,
} from "./results-schema";
