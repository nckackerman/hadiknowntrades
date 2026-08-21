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
  /** Union of tickers skipped by either fetch path (a ticker can be skipped from one path's fetch but not the other's, but this summary doesn't distinguish which). */
  skippedTickers: string[];
}

export interface RunPipelineOptions {
  tickers: readonly string[];
  fetchDailyCloses: (symbol: string, from: Date, to: Date) => Promise<DailyClose[]>;
  fetchIntradayBars: (symbol: string, from: Date, to: Date) => Promise<IntradayBar[]>;
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

interface BuildIntradayResultsOptions {
  history: Map<string, IntradayBar[]>;
  dataAsOf: string;
  asOf: Date;
  endDateString: string;
  generatedAt: string;
  startingCapital: number;
  maxTradesPerDay: number;
  skipped: readonly string[];
}

function buildIntradayResults({
  history,
  dataAsOf,
  asOf,
  endDateString,
  generatedAt,
  startingCapital,
  maxTradesPerDay,
  skipped,
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
  const cappedHistory = new Map<string, IntradayBar[]>();
  for (const [ticker, series] of history) {
    const sliced = series.filter((bar) => localDatePart(bar.date) <= endDateString);
    if (sliced.length > 0) cappedHistory.set(ticker, sliced);
  }
  const allDays = optimizeIntradayDays(cappedHistory, { startingCapital, maxTradesPerDay });

  return INTRADAY_RANGES.map((range) => {
    // Never null: presetRangeStartDate only returns null for "MAX",
    // which isn't one of INTRADAY_RANGES.
    const startDate = presetRangeStartDate(range, asOf)!;
    const startDateString = toDateString(startDate);

    const days = allDays.filter((day) => day.date >= startDateString && day.date <= endDateString);

    // universeSize for this specific range: tickers with at least one
    // bar inside this range's window -- recomputed per range (cheap, no
    // DP) since it does legitimately vary by range even though `days`
    // itself is now shared/sliced rather than recomputed.
    let universeSize = 0;
    for (const series of cappedHistory.values()) {
      const hasBarInRange = series.some((bar) => {
        const date = localDatePart(bar.date);
        return date >= startDateString && date <= endDateString;
      });
      if (hasBarInRange) universeSize++;
    }

    return {
      schemaVersion: RESULTS_SCHEMA_VERSION,
      model: "intraday-daily",
      range,
      generatedAt,
      dataAsOf,
      endDate: endDateString,
      maxTradesPerDay,
      startingCapital,
      days,
      universeSize,
      skippedTickers: [...skipped],
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

  // The two paths' fetches are independent (see module header comment):
  // run concurrently, and neither's failure prevents the other's
  // results from being computed and written.
  const [windowFetch, intradayFetch] = await Promise.all([
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
        dataAsOf: intradayFetch.dataAsOf!,
        asOf,
        endDateString,
        generatedAt,
        startingCapital,
        maxTradesPerDay,
        skipped: intradayFetch.skipped,
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

  const skippedTickers = [...new Set([...windowFetch.skipped, ...intradayFetch.skipped])];

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
    throw new Error(
      `pipeline: wrote ${results.length} of ${PRESET_RANGES.length} ranges, but at least one path failed -- ` +
        `failing this run so it doesn't silently succeed while that path goes stale. ` +
        `Window (5Y/MAX) path: ${windowFetch.failureReason ?? "ok"}. ` +
        `Intraday (1M/3M/1Y) path: ${intradayFetch.failureReason ?? "ok"}. ` +
        `Skipped tickers: ${skippedTickers.length > 0 ? skippedTickers.join(", ") : "(none)"}.`,
    );
  }

  return { results, skippedTickers };
}
