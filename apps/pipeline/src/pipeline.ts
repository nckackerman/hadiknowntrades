// The nightly precompute job: fetches full daily-close history for the
// whole ticker universe once, then for each preset range (1M/3M/1Y/5Y/
// MAX) slices that history to the range's window and runs the optimizer,
// writing one result JSON per range.
//
// Idempotency: each run writes to a fixed key per range (results/{range}
// .json), overwriting the previous run's file rather than accumulating
// dated copies -- re-running for the same day (or any day) just replaces
// the same objects with freshly computed content, no duplicate or
// conflicting state.
//
// Issue #28 split this into two independent paths sharing the same
// fetch/abort machinery (fetchUniverseHistory, generalized below):
//   - the "window" path (5Y/MAX): unchanged from before #28 -- one daily-
//     close fetch (from earliestDate), sliced per range, run through
//     optimizeTrades.
//   - the "intraday" path (1M/3M/1Y): one 60-minute-bar fetch (from the
//     1Y start date -- comfortably covers all three, same "fetch once,
//     slice many" pattern), then optimizeIntradayDays run ONCE over the
//     full fetched history and sliced per range afterward (a given day's
//     own result never depends on which range window it falls inside --
//     range slicing only ever drops whole out-of-range days, never bars
//     within an in-range one -- so running the DP once and filtering its
//     output is equivalent to, and much cheaper than, re-running it per
//     range given 1M/3M/1Y are nested subsets of each other).
// The two paths' fetches run concurrently and fail independently: a
// systemic failure (BlockedError/UnexpectedResponseError, or literally
// zero usable data) on one path refuses to overwrite *that path's*
// range keys, but doesn't prevent the other path's ranges from writing
// if its own fetch succeeded. Whatever succeeded still gets written --
// but if *either* path failed, the run still throws after writing (see
// runPipeline's final check), so a single-path failure still fails the
// Lambda invocation, this system's only alerting mechanism (see
// "no custom retry/alerting" below) -- a silently-good window path
// must not mask a persistently broken intraday path (or vice versa)
// indefinitely. Only when *both* paths produce nothing does the run
// throw *without* writing anything, generalizing the original "refuse
// to overwrite good results with an empty run" guarantee. See
// docs/plans/issue-28-plan.md for the design rationale.
//
// Issue #30 added a third fetch (5-minute bars, retention-bounded to
// the last ~59 days) that upgrades ONLY the 3M range's most recent days
// to finer granularity -- older 3M days, and all of 1M/1Y, stay on
// 60-minute bars. Unlike the window/intraday split above, this third
// path is deliberately NOT held to the same "must still fail the run"
// standard: see buildIntradayResults and packages/core/CLAUDE.md's
// "Mixed-granularity 3M assembly" section for why a 5-minute-path
// failure gracefully degrades 3M back to its pre-#30 behavior instead.

import {
  BlockedError,
  optimizeIntradayDays,
  optimizeTrades,
  PRESET_RANGES,
  presetRangeStartDate,
  resultKey,
  RESULTS_SCHEMA_VERSION,
  toDateString,
  UnexpectedResponseError,
  type DailyClose,
  type IntradayBar,
  type IntradayDayResult,
  type IntradayResult,
  type PrecomputedResult,
  type PresetRange,
  type WindowResult,
} from "@hadiknowntrades/core";

const DEFAULT_STARTING_CAPITAL = 20;
const DEFAULT_MAX_TRADES = 3;
// Distinct from DEFAULT_MAX_TRADES on purpose, even though both are
// currently 3 -- "trades across the whole window" and "trades within one
// day" are conceptually different knobs (see issue #28) that could
// reasonably diverge later; collapsing them into one shared constant
// would be a coincidence today, not an invariant worth encoding.
const DEFAULT_MAX_TRADES_PER_DAY = 3;
// Deliberately early enough to predate any current S&P 500 constituent's
// IPO -- the Yahoo client naturally returns only what actually exists in
// range, so this just means "give me everything you have."
const DEFAULT_EARLIEST_DATE = new Date("1970-01-01T00:00:00Z");
const DEFAULT_FETCH_CONCURRENCY = 10;
// How far back to fetch 5-minute bars for (issue #30, upgrading 3M's
// most recent days -- see packages/core/CLAUDE.md's "5-minute intraday
// bars" section). Yahoo's real retention wall for interval=5m is
// exactly 60 days back (verified live: 59 days back succeeds, 60 fails
// with a 422); requesting 59 keeps every request a full day inside that
// wall rather than right at the boundary. Deliberately NOT reusing
// presetRangeStartDate here -- that function only subtracts whole
// months/years, and this needs a plain days-back offset instead (see
// daysBeforeUtc below).
const FIVE_MINUTE_LOOKBACK_DAYS = 59;

// The "window" (whole-window, daily-close) ranges vs. the "intraday"
// (per-day, 60m-bar) ranges introduced by issue #28. Together these must
// cover every PresetRange exactly once -- see pipeline.test.ts's
// "covers every PresetRange between the two paths" test, which checks
// this against the real PRESET_RANGES export rather than leaving it an
// unenforced comment.
const WINDOW_RANGES: readonly PresetRange[] = ["5Y", "MAX"];
const INTRADAY_RANGES: readonly PresetRange[] = ["1M", "3M", "1Y"];

export interface ResultStore {
  putObject(key: string, body: string): Promise<void>;
}

export interface PipelineRunSummary {
  results: PrecomputedResult[];
  /** Union of tickers skipped by any of the three fetch paths (window, 60-minute intraday, or 5-minute -- issue #30 added the third) -- a ticker can be skipped from one path's fetch but not another's, but this summary doesn't distinguish which. */
  skippedTickers: string[];
}

export interface RunPipelineOptions {
  tickers: readonly string[];
  fetchDailyCloses: (symbol: string, from: Date, to: Date) => Promise<DailyClose[]>;
  fetchIntradayBars: (symbol: string, from: Date, to: Date) => Promise<IntradayBar[]>;
  /** 5-minute bars (issue #30) -- upgrades the 3M range's most recent days; see buildIntradayResults/"Mixed-granularity 3M assembly" in packages/core/CLAUDE.md. */
  fetchFiveMinuteBars: (symbol: string, from: Date, to: Date) => Promise<IntradayBar[]>;
  store: ResultStore;
  /** Defaults to now. */
  asOf?: Date;
  startingCapital?: number;
  /** Max whole-window trades for the window (5Y/MAX) path. */
  maxTrades?: number;
  /** Max same-day trades per day for the intraday (1M/3M/1Y) path. */
  maxTradesPerDay?: number;
  earliestDate?: Date;
  fetchConcurrency?: number;
}

interface UniverseFetchResult<TBar> {
  history: Map<string, TBar[]>;
  /** Every ticker that failed individually (TickerNotFoundError/TransientFetchError) before -- or independently of -- any abort, so this information isn't lost even when `abortError` is also set. */
  skipped: string[];
  /** Set once any worker hits a systemic failure; `history` still holds whatever was fetched before the abort was noticed, but callers that don't trust partial data on abort should ignore it (see fetchPathHistory). */
  abortError: BlockedError | UnexpectedResponseError | null;
}

/**
 * Fetches full history (from..to) for every ticker, with bounded
 * concurrency. A ticker that fails with TickerNotFoundError or
 * TransientFetchError is skipped (logged, doesn't fail the run) -- those
 * are per-ticker problems. Generic over the bar shape so the same
 * concurrency/abort/skip logic backs both the daily-close fetch and the
 * intraday-bar fetch (issue #28) instead of a second copy-pasted worker
 * pool.
 *
 * BlockedError or UnexpectedResponseError set `abortError` rather than
 * throwing: a block means we shouldn't keep firing off hundreds more
 * requests, and an unexpected-response is documented (see
 * yahoo-client.ts) as "likely permanent regardless of symbol" -- i.e. a
 * systemic problem, not a per-ticker one, so treating it as an ordinary
 * skip would risk masking a total data-fetch failure as a handful of
 * unlucky tickers. Once any worker hits one of these, a shared flag
 * stops every worker from starting a *new* fetch (an in-flight request
 * already underway still completes/rejects on its own -- there's no
 * cheap way to cancel it without threading an AbortSignal through the
 * fetch client -- but no further tickers get queued once the flag is
 * set). Returning `abortError` instead of throwing preserves whatever
 * `skipped` had already been accumulated from tickers that failed
 * individually *before* the abort -- a caller that discards `history` on
 * abort (see fetchPathHistory) can still keep that real per-ticker
 * bookkeeping instead of losing it along with the untrusted partial data.
 */
async function fetchUniverseHistory<TBar>(
  tickers: readonly string[],
  from: Date,
  to: Date,
  fetchFn: (symbol: string, from: Date, to: Date) => Promise<TBar[]>,
  concurrency: number,
): Promise<UniverseFetchResult<TBar>> {
  const history = new Map<string, TBar[]>();
  const skipped: string[] = [];
  let nextIndex = 0;
  let abortError: BlockedError | UnexpectedResponseError | null = null;

  async function worker(): Promise<void> {
    for (;;) {
      if (abortError) return;
      const i = nextIndex++;
      if (i >= tickers.length) return;
      const ticker = tickers[i]!;
      try {
        const series = await fetchFn(ticker, from, to);
        history.set(ticker, series);
      } catch (error) {
        if (error instanceof BlockedError || error instanceof UnexpectedResponseError) {
          abortError = error;
          return;
        }
        skipped.push(ticker);
        console.warn(
          `[pipeline] skipping ${ticker}: ${error instanceof Error ? error.message : error}`,
        );
      }
    }
  }

  const workerCount = Math.min(concurrency, tickers.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  return { history, skipped, abortError };
}

/**
 * The most recent date (per `dateOf`) actually present across the whole
 * fetched universe, not exceeding upperBound, or null if there's no such
 * data. Excluding anything past upperBound keeps this consistent with
 * the per-range window filter below -- a fetch client returning data past
 * what was requested (in violation of its own contract) shouldn't make
 * dataAsOf claim freshness beyond what was actually asked for.
 *
 * Generic over `dateOf` (rather than assuming `.date` is already a
 * comparable calendar-date string) so this also backs the intraday path,
 * whose bars' `.date` is a full local datetime string -- comparing that
 * directly against a calendar-date upperBound would be wrong (e.g.
 * "2024-06-15T15:30:00" > "2024-06-15" lexicographically, incorrectly
 * excluding same-day intraday bars); callers pass a `dateOf` that
 * extracts just the calendar-date part for that case.
 */
function findMaxDate<T>(
  history: Map<string, T[]>,
  upperBound: string,
  dateOf: (item: T) => string,
): string | null {
  let max: string | null = null;
  for (const series of history.values()) {
    for (const point of series) {
      const date = dateOf(point);
      if (date > upperBound) continue;
      if (max === null || date > max) max = date;
    }
  }
  return max;
}

/** The calendar-date (YYYY-MM-DD) prefix of an intraday bar's full local-datetime `date` field ("YYYY-MM-DDTHH:MM:SS"). */
function localDatePart(datetime: string): string {
  return datetime.slice(0, 10);
}

/** `date` minus a plain number of calendar days, in UTC (issue #30) -- used only for the 5-minute fetch's lookback window; presetRangeStartDate's month/year subtraction doesn't cover a plain days-back offset. */
function daysBeforeUtc(date: Date, days: number): Date {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() - days);
  return result;
}

/**
 * Drops any bar past `endDateString` (same "don't trust data past what
 * was requested" reasoning as findMaxDate above) and any ticker left
 * with zero bars afterward. Shared between the 60-minute and 5-minute
 * histories in buildIntradayResults (issue #30 -- factored out of what
 * was originally two copy-pasted copies of this loop, one per
 * granularity, caught in code review).
 */
function capHistoryToEndDate(
  history: Map<string, IntradayBar[]>,
  endDateString: string,
): Map<string, IntradayBar[]> {
  const capped = new Map<string, IntradayBar[]>();
  for (const [ticker, series] of history) {
    const sliced = series.filter((bar) => localDatePart(bar.date) <= endDateString);
    if (sliced.length > 0) capped.set(ticker, sliced);
  }
  return capped;
}

/**
 * The later (or equal) of two YYYY-MM-DD date strings, treating `null`
 * as "no value" -- used to fold a granularity override's own data
 * freshness into a range's `dataAsOf` (issue #30). Plain string
 * comparison is safe here since both operands are already
 * zero-padded ISO date strings.
 */
function maxDateString(a: string, b: string | null): string {
  return b !== null && b > a ? b : a;
}

/**
 * Merges two IntradayDayResult arrays produced by separate
 * optimizeIntradayDays calls over different bar granularities (issue
 * #30, used only for the 3M range -- see "Mixed-granularity 3M
 * assembly" in packages/core/CLAUDE.md). For a date only one array
 * covers, that array's day wins by default. For a date **both** cover,
 * this does NOT unconditionally prefer the finer (5-minute) granularity
 * -- a real bug caught in code review: the two granularities can see
 * different ticker universes for the same day (e.g. a ticker's
 * 5-minute fetch failed while its 60-minute fetch succeeded), so the
 * 5-minute day can legitimately have *worse* coverage, and therefore a
 * worse achievable outcome, than the 60-minute day for that same date
 * -- silently taking the 5-minute version regardless would make 3M's
 * result strictly worse than what pre-#30 (60-minute-only) would have
 * shown for that day, undermining this app's whole "best possible
 * outcome" premise. Instead: when both cover a date, keep whichever
 * day's `endingBalance` is actually higher (both were run with the
 * same `startingCapital`, so ending balance is directly comparable as
 * "the better outcome").
 */
function mergeDaysByGranularity(
  primaryDays: IntradayDayResult[],
  overrideDays: IntradayDayResult[],
): IntradayDayResult[] {
  const byDate = new Map<string, IntradayDayResult>();
  for (const day of primaryDays) byDate.set(day.date, day);
  for (const day of overrideDays) {
    const existing = byDate.get(day.date);
    if (!existing || day.endingBalance > existing.endingBalance) {
      byDate.set(day.date, day);
    }
  }
  return [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

interface PathFetchOutcome<TBar> {
  history: Map<string, TBar[]>;
  skipped: string[];
  /** The most recent date with usable data, or null if this path has none (see failureReason for why). */
  dataAsOf: string | null;
  /** Non-null (and dataAsOf/history effectively empty) if this path should refuse to write any results this run -- either the fetch aborted (BlockedError/UnexpectedResponseError) or produced zero usable data across every ticker. Null on success. */
  failureReason: string | null;
}

/**
 * Runs fetchUniverseHistory for one path (window or intraday) and
 * classifies the outcome: a systemic abort or "zero usable data" both
 * become a non-null `failureReason` (rather than throwing) so one path's
 * failure doesn't prevent the other path's results from being computed
 * and written (see the module header comment) -- `runPipeline` decides
 * separately whether an overall failure should still fail the run.
 */
async function fetchPathHistory<TBar>(
  label: string,
  tickers: readonly string[],
  from: Date,
  to: Date,
  fetchFn: (symbol: string, from: Date, to: Date) => Promise<TBar[]>,
  concurrency: number,
  upperBoundDateString: string,
  dateOf: (bar: TBar) => string,
): Promise<PathFetchOutcome<TBar>> {
  const { history, skipped, abortError } = await fetchUniverseHistory(
    tickers,
    from,
    to,
    fetchFn,
    concurrency,
  );

  if (abortError) {
    console.warn(
      `[pipeline] ${label} fetch aborted, that path will write no results this run: ${abortError.message}`,
    );
    // Discard the partial `history` (an abort means we don't trust
    // what was fetched so far -- see fetchUniverseHistory's own doc
    // comment), but keep `skipped`: those tickers had already failed
    // individually, for an unrelated per-ticker reason, before the
    // abort was noticed, and that's real bookkeeping worth preserving
    // now that a path's failure doesn't necessarily fail the whole run.
    return { history: new Map(), skipped, dataAsOf: null, failureReason: abortError.message };
  }

  const dataAsOf = findMaxDate(history, upperBoundDateString, dateOf);
  if (dataAsOf === null) {
    const reason = `no ${label} data was successfully fetched (${skipped.length} of ${tickers.length} tickers skipped)`;
    console.warn(`[pipeline] ${reason} -- that path will write no results this run`);
    return { history, skipped, dataAsOf: null, failureReason: reason };
  }

  return { history, skipped, dataAsOf, failureReason: null };
}

interface BuildWindowResultsOptions {
  history: Map<string, DailyClose[]>;
  dataAsOf: string;
  asOf: Date;
  endDateString: string;
  generatedAt: string;
  startingCapital: number;
  maxTrades: number;
  skipped: readonly string[];
}

function buildWindowResults({
  history,
  dataAsOf,
  asOf,
  endDateString,
  generatedAt,
  startingCapital,
  maxTrades,
  skipped,
}: BuildWindowResultsOptions): WindowResult[] {
  return WINDOW_RANGES.map((range) => {
    const startDate = presetRangeStartDate(range, asOf);
    const startDateString = startDate ? toDateString(startDate) : null;

    const windowed = new Map<string, DailyClose[]>();
    for (const [ticker, series] of history) {
      const sliced = series.filter(
        (p) => (!startDateString || p.date >= startDateString) && p.date <= endDateString,
      );
      if (sliced.length > 0) windowed.set(ticker, sliced);
    }

    const optimized = optimizeTrades(windowed, { startingCapital, maxTrades });

    return {
      schemaVersion: RESULTS_SCHEMA_VERSION,
      model: "window",
      range,
      generatedAt,
      dataAsOf,
      startDate: startDateString,
      endDate: endDateString,
      maxTrades,
      startingCapital,
      endingBalance: optimized.endingBalance,
      trades: optimized.trades,
      universeSize: windowed.size,
      skippedTickers: [...skipped],
    };
  });
}

/**
 * A per-range override of the pure 60-minute day results, keyed by
 * PresetRange (issue #30 -- 3M is the first entry; see the comment on
 * `granularityOverrides` in buildIntradayResults for why this is a
 * lookup rather than a hardcoded `range === "3M"` check). Everything a
 * range needs beyond the base 60-minute data lives together here so
 * adding another range's override later (e.g. issue #29's 1-minute
 * bars for 1M, landing concurrently with this PR -- check for a
 * conflict in this exact area if both exist) means adding one map
 * entry, not a third bespoke branch alongside this one.
 */
interface GranularityOverride {
  /** This range's actual per-day results, replacing the pure 60-minute array wholesale (not merged per-range further -- mergeDaysByGranularity already resolved day-by-day which granularity's result is better). */
  days: IntradayDayResult[];
  /** Additional history map(s), alongside the base 60-minute one, whose tickers should count toward this range's universeSize. */
  extraHistories: Map<string, IntradayBar[]>[];
  /** Additional per-ticker skips, alongside the base intraday fetch's, that should count toward this range's skippedTickers. */
  extraSkipped: readonly string[];
  /** The most recent date found in the extra data source(s), if any -- folded into this range's dataAsOf via maxDateString so a day sourced only from the override data can't make dataAsOf understate this range's actual freshness. */
  extraDataAsOf: string | null;
}

interface BuildIntradayResultsOptions {
  history: Map<string, IntradayBar[]>;
  /**
   * 5-minute bars (issue #30), used only to upgrade 3M's most recent
   * days -- see "Mixed-granularity 3M assembly" in
   * packages/core/CLAUDE.md. Can legitimately be empty (that fetch
   * aborted, or found no usable data): 3M then falls back to 60-minute
   * bars for every day, identical to its pre-#30 behavior, rather than
   * failing anything -- see fiveMinuteSkipped below and runPipeline's
   * own comment on why a 5-minute-path failure doesn't fail the run.
   */
  fiveMinuteHistory: Map<string, IntradayBar[]>;
  dataAsOf: string;
  /** The most recent date found in the 5-minute history specifically, or null -- see GranularityOverride.extraDataAsOf. */
  fiveMinuteDataAsOf: string | null;
  asOf: Date;
  endDateString: string;
  generatedAt: string;
  startingCapital: number;
  maxTradesPerDay: number;
  skipped: readonly string[];
  /** Tickers skipped by the 5-minute fetch specifically -- merged into 3M's own skippedTickers (not 1M/1Y's, which never touch 5-minute data). */
  fiveMinuteSkipped: readonly string[];
}

function buildIntradayResults({
  history,
  fiveMinuteHistory,
  dataAsOf,
  fiveMinuteDataAsOf,
  asOf,
  endDateString,
  generatedAt,
  startingCapital,
  maxTradesPerDay,
  skipped,
  fiveMinuteSkipped,
}: BuildIntradayResultsOptions): IntradayResult[] {
  // Solve every trading day once, over the full fetched history (capped
  // only at endDateString, same "don't trust data past what was
  // requested" reasoning as findMaxDate above) -- a given day's own
  // optimizeIntradayDays result never depends on which range window it
  // happens to fall inside, since 1M/3M/1Y range-slicing only ever drops
  // whole out-of-range days, never bars within an in-range one. Re-
  // running the DP separately per range (as an earlier version of this
  // function did) redundantly re-solved the same day up to 3 times,
  // since each range is a strict subset of the next.
  const cappedHistory = capHistoryToEndDate(history, endDateString);
  const sixtyMinuteDays = optimizeIntradayDays(cappedHistory, {
    startingCapital,
    maxTradesPerDay,
    barIntervalMinutes: 60,
  });

  // 5-minute bars (issue #30) only ever inform the 3M range -- 1M/1Y
  // always read sixtyMinuteDays directly, via the default (no override)
  // case below. Capped the same way as the 60-minute history.
  const cappedFiveMinuteHistory = capHistoryToEndDate(fiveMinuteHistory, endDateString);
  const fiveMinuteDays = optimizeIntradayDays(cappedFiveMinuteHistory, {
    startingCapital,
    maxTradesPerDay,
    barIntervalMinutes: 5,
  });
  // 3M's actual per-day results: whichever of the two granularities
  // produced the better outcome for each day (see mergeDaysByGranularity
  // -- NOT an unconditional "5-minute always wins"). If fiveMinuteDays is
  // empty (fetch failure or no data), this is just sixtyMinuteDays
  // unchanged -- the graceful-degradation path.
  const threeMonthDays = mergeDaysByGranularity(sixtyMinuteDays, fiveMinuteDays);

  // Centralizes every range's deviation from the base 60-minute data in
  // one lookup instead of repeated `range === "3M"` branches (code
  // review feedback on issue #30) -- a future granularity override
  // (e.g. 1-minute bars for 1M, issue #29) adds one entry here rather
  // than a third bespoke branch.
  const granularityOverrides = new Map<PresetRange, GranularityOverride>([
    [
      "3M",
      {
        days: threeMonthDays,
        extraHistories: [cappedFiveMinuteHistory],
        extraSkipped: fiveMinuteSkipped,
        extraDataAsOf: fiveMinuteDataAsOf,
      },
    ],
  ]);

  return INTRADAY_RANGES.map((range) => {
    // Never null: presetRangeStartDate only returns null for "MAX",
    // which isn't one of INTRADAY_RANGES.
    const startDate = presetRangeStartDate(range, asOf)!;
    const startDateString = toDateString(startDate);

    const override = granularityOverrides.get(range);
    const sourceDays = override?.days ?? sixtyMinuteDays;
    const days = sourceDays.filter(
      (day) => day.date >= startDateString && day.date <= endDateString,
    );

    // universeSize for this specific range: tickers with at least one
    // bar inside this range's window -- recomputed per range (cheap, no
    // DP) since it does legitimately vary by range even though `days`
    // itself is now shared/sliced rather than recomputed. A range with
    // an override unions across its extra history source(s) too: a
    // ticker present in only one of the datasets (e.g. it failed the
    // 5-minute fetch but succeeded the 60-minute one) still legitimately
    // contributed to some of that range's days.
    const historiesForRange = [cappedHistory, ...(override?.extraHistories ?? [])];
    const tickersInRange = new Set<string>();
    for (const source of historiesForRange) {
      for (const [ticker, series] of source) {
        const hasBarInRange = series.some((bar) => {
          const date = localDatePart(bar.date);
          return date >= startDateString && date <= endDateString;
        });
        if (hasBarInRange) tickersInRange.add(ticker);
      }
    }

    // An override's own skips only count toward that range's
    // skippedTickers -- a ticker missing only from the 5-minute fetch
    // doesn't affect 1M/1Y (which never read 5-minute data), but it is
    // genuinely absent from 3M's recent (5-minute-sourced) days (see
    // mergeDaysByGranularity's doc comment on why a day's whole
    // tickers-considered set can shift, not a per-ticker splice), so
    // it's worth surfacing there.
    const rangeSkipped = [...new Set([...skipped, ...(override?.extraSkipped ?? [])])];

    // dataAsOf for this range: the later of the base intraday fetch's
    // freshness and this range's own override data source, if any --
    // a real bug caught in code review: 3M's days can include one
    // sourced only from the 5-minute fetch, so dataAsOf must reflect
    // that fetch's freshness too, not just the 60-minute one's, or it
    // can understate how fresh this range's own data actually is.
    const rangeDataAsOf = maxDateString(dataAsOf, override?.extraDataAsOf ?? null);

    return {
      schemaVersion: RESULTS_SCHEMA_VERSION,
      model: "intraday-daily",
      range,
      generatedAt,
      dataAsOf: rangeDataAsOf,
      endDate: endDateString,
      maxTradesPerDay,
      startingCapital,
      days,
      universeSize: tickersInRange.size,
      skippedTickers: rangeSkipped,
    };
  });
}

export async function runPipeline(options: RunPipelineOptions): Promise<PipelineRunSummary> {
  const asOf = options.asOf ?? new Date();
  const startingCapital = options.startingCapital ?? DEFAULT_STARTING_CAPITAL;
  const maxTrades = options.maxTrades ?? DEFAULT_MAX_TRADES;
  const maxTradesPerDay = options.maxTradesPerDay ?? DEFAULT_MAX_TRADES_PER_DAY;
  const earliestDate = options.earliestDate ?? DEFAULT_EARLIEST_DATE;
  const fetchConcurrency = options.fetchConcurrency ?? DEFAULT_FETCH_CONCURRENCY;
  const endDateString = toDateString(asOf);
  // The intraday fetch covers exactly the widest intraday range (1Y),
  // then gets sliced locally for 3M/1M below -- same "fetch once, slice
  // many" pattern as the window path's daily-close fetch, and reuses
  // presetRangeStartDate rather than a second hand-maintained lookback
  // constant. Comfortably within Yahoo's 730-day retention for
  // interval=60m (verified -- see packages/core/CLAUDE.md).
  const intradayFrom = presetRangeStartDate("1Y", asOf)!;
  // The 5-minute fetch (issue #30) covers only its own retention-bounded
  // lookback window, comfortably inside Yahoo's verified 60-day wall for
  // interval=5m (see FIVE_MINUTE_LOOKBACK_DAYS above and
  // packages/core/CLAUDE.md).
  const fiveMinuteFrom = daysBeforeUtc(asOf, FIVE_MINUTE_LOOKBACK_DAYS);

  // The three fetches are independent (see module header comment, and
  // "5-minute path" below for how the third one specifically differs):
  // run concurrently, and no one's failure prevents another's results
  // from being computed and written.
  const [windowFetch, intradayFetch, fiveMinuteFetch] = await Promise.all([
    fetchPathHistory(
      "daily-close",
      options.tickers,
      earliestDate,
      asOf,
      options.fetchDailyCloses,
      fetchConcurrency,
      endDateString,
      (p: DailyClose) => p.date,
    ),
    fetchPathHistory(
      "intraday",
      options.tickers,
      intradayFrom,
      asOf,
      options.fetchIntradayBars,
      fetchConcurrency,
      endDateString,
      (bar: IntradayBar) => localDatePart(bar.date),
    ),
    // 5-minute path (issue #30): only ever upgrades 3M's most recent
    // days (see buildIntradayResults) -- deliberately NOT treated as a
    // third path that can fail the whole run the way window/intraday
    // are (see the comment below where its failureReason is
    // intentionally left out of that check, and
    // packages/core/CLAUDE.md's "Mixed-granularity 3M assembly" section
    // for the full reasoning): a failure here just means 3M's recent
    // days fall back to 60-minute bars, identical to 3M's pre-#30
    // behavior, not a loss of previously-working data.
    fetchPathHistory(
      "5-minute",
      options.tickers,
      fiveMinuteFrom,
      asOf,
      options.fetchFiveMinuteBars,
      fetchConcurrency,
      endDateString,
      (bar: IntradayBar) => localDatePart(bar.date),
    ),
  ]);

  // Compute everything before writing anything, so a failure in the
  // optimizer (e.g. an unexpected data shape) can't leave some ranges'
  // S3 objects updated and others stale. This doesn't make the S3 writes
  // themselves atomic -- a failure partway through the write loop below
  // can still leave a mix of fresh and stale range files -- true
  // cross-range atomicity would need a different storage strategy (e.g.
  // a single combined manifest object) and is deliberately not built
  // here.
  const generatedAt = new Date().toISOString();

  const windowResults = windowFetch.failureReason
    ? []
    : buildWindowResults({
        history: windowFetch.history,
        dataAsOf: windowFetch.dataAsOf!,
        asOf,
        endDateString,
        generatedAt,
        startingCapital,
        maxTrades,
        skipped: windowFetch.skipped,
      });

  const intradayResults = intradayFetch.failureReason
    ? []
    : buildIntradayResults({
        history: intradayFetch.history,
        // Passed through regardless of fiveMinuteFetch.failureReason --
        // on abort/no-data, fiveMinuteFetch.history is empty (or has no
        // usable bars), which buildIntradayResults already handles as
        // "3M falls back to 60-minute bars for every day" with no
        // special-casing needed here.
        fiveMinuteHistory: fiveMinuteFetch.history,
        dataAsOf: intradayFetch.dataAsOf!,
        // Also passed through regardless of fiveMinuteFetch.failureReason
        // -- on abort/no-data this is null, and maxDateString(dataAsOf,
        // null) is just dataAsOf unchanged.
        fiveMinuteDataAsOf: fiveMinuteFetch.dataAsOf,
        asOf,
        endDateString,
        generatedAt,
        startingCapital,
        maxTradesPerDay,
        skipped: intradayFetch.skipped,
        fiveMinuteSkipped: fiveMinuteFetch.skipped,
      });

  if (windowResults.length === 0 && intradayResults.length === 0) {
    // Refuse to overwrite S3's existing (presumably good) results with
    // empty-but-schema-valid output -- better to fail the run loudly and
    // keep yesterday's data than to silently erase it. Generalizes the
    // original single-path guarantee to "both paths came up empty," not
    // just one.
    throw new Error(
      `pipeline aborted: neither the daily-close nor intraday fetch produced usable data -- refusing to overwrite existing results with empty output. ` +
        `Window (5Y/MAX) path: ${windowFetch.failureReason}. Intraday (1M/3M/1Y) path: ${intradayFetch.failureReason}.`,
    );
  }

  // Keep the original PRESET_RANGES order regardless of which path(s)
  // succeeded, rather than "all window ranges, then all intraday ranges."
  const resultByRange = new Map<PresetRange, PrecomputedResult>();
  for (const result of windowResults) resultByRange.set(result.range, result);
  for (const result of intradayResults) resultByRange.set(result.range, result);
  const results = PRESET_RANGES.filter((range) => resultByRange.has(range)).map((range) =>
    resultByRange.get(range)!,
  );

  // Independent writes to unrelated keys, already accepted as non-atomic
  // as a group (see the comment above) -- no reason to pay serial
  // network latency for them.
  await Promise.all(
    results.map((result) =>
      options.store.putObject(resultKey(result.range), JSON.stringify(result, null, 2)),
    ),
  );

  const skippedTickers = [
    ...new Set([...windowFetch.skipped, ...intradayFetch.skipped, ...fiveMinuteFetch.skipped]),
  ];

  if (windowFetch.failureReason || intradayFetch.failureReason) {
    // At least one path produced real, useful results and those have
    // already been written above -- but this run still needs to fail
    // the Lambda invocation, which is this system's *only* alerting
    // mechanism (see "no custom retry/alerting" on runNightlyPipeline in
    // src/run.ts). Before issue #28 there was only one path, so any
    // BlockedError/UnexpectedResponseError always aborted (and failed)
    // the whole run; after the #28 split, a persistent failure confined
    // to just one path (e.g. Yahoo starts blocking interval=60m
    // specifically while daily-close fetches keep working) must not let
    // the run "succeed" indefinitely while that path's ranges silently
    // serve increasingly stale data with nothing beyond a console.warn
    // buried in CloudWatch to notice it.
    //
    // Deliberately excludes fiveMinuteFetch.failureReason (issue #30):
    // that path's failure never leaves anything silently stale -- it
    // just means 3M's recent days fall back to already-shipped,
    // fully-correct 60-minute bars, the same as 3M's pre-#30 behavior --
    // so it doesn't need to meet this same "must still fail the run"
    // bar. Its status is still included in the message below purely for
    // operational visibility.
    throw new Error(
      `pipeline: wrote ${results.length} of ${PRESET_RANGES.length} ranges, but at least one path failed -- ` +
        `failing this run so it doesn't silently succeed while that path goes stale. ` +
        `Window (5Y/MAX) path: ${windowFetch.failureReason ?? "ok"}. ` +
        `Intraday (1M/3M/1Y) path: ${intradayFetch.failureReason ?? "ok"}. ` +
        `5-minute path (3M recent days only, non-fatal): ${fiveMinuteFetch.failureReason ?? "ok"}. ` +
        `Skipped tickers: ${skippedTickers.length > 0 ? skippedTickers.join(", ") : "(none)"}.`,
    );
  }

  return { results, skippedTickers };
}
