// The nightly precompute job: fetches full daily-close history for the
// whole ticker universe once, then for each preset range (1M/3M/1Y/5Y/
// MAX) slices that history to the range's window and runs the optimizer,
// writing one result JSON per range.
//
// Idempotency: each run writes to a fixed key per range (results/{range}
// .json), overwritten each run rather than accumulated as dated copies --
// re-running for the same day (or any day) just replaces the same
// objects with freshly computed content, no duplicate or conflicting
// state.
//
// Issue #28 split this into two independent, must-succeed-or-fail-the-
// run paths sharing the same fetch/abort machinery (fetchUniverseHistory,
// generalized below):
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
// These two paths' fetches run concurrently and fail independently: a
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
// Issue #30 added a different kind of fetch on top of that: a
// **granularity override** -- a finer-than-60-minute bar fetch that
// upgrades one range's days on a best-effort basis (5-minute bars for
// 3M's most recent ~59 days; older 3M days, and every other range, stay
// on 60-minute bars). Unlike the window/intraday split above, a
// granularity override is deliberately NOT held to the same "must still
// fail the run" standard -- see buildIntradayResults and
// packages/core/CLAUDE.md's "Mixed-granularity 1M/3M assembly" section
// for why an override's failure gracefully degrades its range back to
// pure 60-minute bars instead. Issue #29 added a second override
// (1-minute bars for 1M) following the exact same mechanism -- see
// buildGranularityOverrideSpecs below, which builds *the* list a future
// override extends: adding a third one is meant to be one array entry,
// not a new hand-duplicated block (issue #29's own code review found and
// fixed a real case of this promise not being kept -- see the comment on
// GranularityOverrideSpec).
//
// Issue #12 added a third, much simpler kind of addition: a SPY
// buy-and-hold comparison figure, computed once per range (all 5, not
// just window ranges -- it's a single well-defined whole-window figure
// regardless of trading model) from one extra, non-fatal daily-close
// fetch -- see fetchBenchmarkHistory/computeBenchmark below. Unlike a
// granularity override, this needs no worker pool at all (it's exactly
// one ticker, not ~503), and unlike the window/intraday split, its
// failure never fails the run -- see fetchBenchmarkHistory's own doc
// comment.

import {
  BlockedError,
  optimizeIntradayDays,
  optimizeAllVariants,
  PRESET_RANGES,
  presetRangeStartDate,
  resultKey,
  RESULTS_SCHEMA_VERSION,
  toDateString,
  UnexpectedResponseError,
  validatePrecomputedResult,
  type BenchmarkResult,
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
// How far back to fetch 1-minute bars for (issue #29, upgrading 1M --
// see packages/core/CLAUDE.md's "1-minute intraday bars" section). Same
// "N-1, not N" reasoning as FIVE_MINUTE_LOOKBACK_DAYS above: Yahoo's
// real retention wall for interval=1m bites at exactly 30 days back
// (verified live: 29 days back succeeds, 30 fails with a 422), so 29
// keeps every request a full day inside that wall. This is the one
// fact the original (pre-#30) plan for this issue got wrong in its own
// arithmetic -- Yahoo's error text literally says "30 days," which
// reads as "30 is safe," but the wall is actually AT 30, not past it.
const ONE_MINUTE_LOOKBACK_DAYS = 29;
// The buy-and-hold comparison ticker (issue #12) -- hardcoded, matching
// the issue's explicit out-of-scope note (no user-chosen ticker). SPY's
// own real inception (1993-01-29) naturally bounds what a fetch from
// DEFAULT_EARLIEST_DATE actually returns -- no special-casing needed at
// the fetch layer; see computeBenchmark's `truncated` handling for where
// that gap is surfaced instead.
const BENCHMARK_TICKER = "SPY";

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
  /** Union of tickers skipped by any fetch path -- window, intraday, or any granularity override (issue #30 added the first override, #29 a second) -- a ticker can be skipped from one path's fetch but not another's, but this summary doesn't distinguish which. */
  skippedTickers: string[];
}

export interface RunPipelineOptions {
  tickers: readonly string[];
  fetchDailyCloses: (symbol: string, from: Date, to: Date) => Promise<DailyClose[]>;
  fetchIntradayBars: (symbol: string, from: Date, to: Date) => Promise<IntradayBar[]>;
  /** 5-minute bars (issue #30) -- upgrades the 3M range's most recent days; see buildGranularityOverrideSpecs/"Mixed-granularity 1M/3M assembly" in packages/core/CLAUDE.md. */
  fetchFiveMinuteBars: (symbol: string, from: Date, to: Date) => Promise<IntradayBar[]>;
  /** 1-minute bars (issue #29) -- upgrades the 1M range's days, day-chunked internally by the fetch function itself (Yahoo caps interval=1m at 8 days/request); see buildGranularityOverrideSpecs/"Mixed-granularity 1M/3M assembly" in packages/core/CLAUDE.md. Same best-effort granularity-override pattern as fetchFiveMinuteBars, not a path that can fail the whole run. */
  fetchIntraday1mBars: (symbol: string, from: Date, to: Date) => Promise<IntradayBar[]>;
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

/** `date` minus a plain number of calendar days, in UTC (issue #30) -- used for every granularity override's lookback window; presetRangeStartDate's month/year subtraction doesn't cover a plain days-back offset. */
function daysBeforeUtc(date: Date, days: number): Date {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() - days);
  return result;
}

/**
 * Drops any bar past `endDateString` (same "don't trust data past what
 * was requested" reasoning as findMaxDate above) and any ticker left
 * with zero bars afterward. Shared between the base 60-minute history
 * and every granularity override's history in buildIntradayResults
 * (issue #30 -- factored out of what was originally two copy-pasted
 * copies of this loop, one per granularity, caught in code review).
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
 * optimizeIntradayDays calls over different bar granularities -- every
 * granularity override (issue #30's 3M/5-minute, issue #29's 1M/1-minute,
 * and any future one) uses this same, granularity-agnostic function; see
 * "Mixed-granularity 1M/3M assembly" in packages/core/CLAUDE.md. For a
 * date only one array covers, that array's day wins by default. For a
 * date **both** cover, this does NOT unconditionally prefer the finer
 * granularity -- a real bug caught in #30's code review: the two
 * granularities can see different ticker universes for the same day
 * (e.g. a ticker's finer-granularity fetch failed while its 60-minute
 * fetch succeeded), so the finer day can legitimately have *worse*
 * coverage, and therefore a worse achievable outcome, than the
 * 60-minute day for that same date -- silently taking the finer version
 * regardless would make the range's result strictly worse than what
 * 60-minute-only data would have shown, undermining this app's whole
 * "best possible outcome" premise. Instead: when both cover a date, keep
 * whichever day's `endingBalance` is actually higher (both were run
 * with the same `startingCapital`, so ending balance is directly
 * comparable as "the better outcome").
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
 * Runs fetchUniverseHistory for one path (window, intraday, or a
 * granularity override) and classifies the outcome: a systemic abort or
 * "zero usable data" both become a non-null `failureReason` (rather
 * than throwing) so one path's failure doesn't prevent another path's
 * results from being computed and written (see the module header
 * comment) -- `runPipeline` decides separately whether an overall
 * failure should still fail the run.
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

/**
 * Fetches SPY's daily closes for the buy-and-hold comparison stat (issue
 * #12) -- reuses the same `fetchDailyCloses` function the window path
 * already carries (RunPipelineOptions), just called once more for a
 * different symbol, rather than the ~503-ticker `fetchUniverseHistory`
 * worker-pool-plus-abort-classification machinery: that machinery exists
 * to distinguish "this one ticker failed" from "something systemic is
 * wrong" across hundreds of tickers, a distinction that's meaningless
 * for exactly one ticker (there's no "skip this ticker, keep going"
 * option when it's the only ticker). A flat try/catch that turns *any*
 * failure into "no benchmark this run" is simpler and equally correct
 * here.
 *
 * Non-fatal by design: a benchmark fetch failure never contributes to
 * runPipeline's "at least one path failed" throw condition (see the
 * final check in runPipeline) -- same reasoning as a granularity
 * override's failure (see this file's module header comment): losing
 * the benchmark stat for a run means every range's comparison figure is
 * simply absent (`benchmark: null`), not that a range serves stale or
 * broken *primary* data.
 */
async function fetchBenchmarkHistory(
  fetchFn: RunPipelineOptions["fetchDailyCloses"],
  from: Date,
  to: Date,
): Promise<{ closes: DailyClose[]; error: string | null }> {
  try {
    const closes = await fetchFn(BENCHMARK_TICKER, from, to);
    return { closes, error: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      `[pipeline] benchmark (${BENCHMARK_TICKER}) fetch failed, comparison stat omitted this run: ${message}`,
    );
    return { closes: [], error: message };
  }
}

/**
 * Computes the whole-window SPY buy-and-hold comparison (issue #12) for
 * one range from the single shared SPY `closes` array -- called once per
 * range from both buildWindowResults and buildIntradayResults, not
 * re-derived per model.
 *
 * Returns `null` only when there's no usable SPY data at all inside this
 * range's window (either the fetch failed entirely -- `closes` is empty
 * -- or, hypothetically, SPY simply has no bars overlapping this specific
 * window). This is deliberately distinct from the MAX/1993 case below,
 * where a real, honest (if truncated) comparison is still returned.
 *
 * **The MAX/1993 case**: MAX's own window is unbounded
 * (`presetRangeStartDate("MAX", asOf)` returns `null` -- "as far back as
 * anything has data"), but SPY's own inception is 1993-01-29. `inWindow`
 * is still non-empty here (it has all of SPY's real history up to
 * `endDateString`), so this returns a real comparison, just one whose
 * `startDate`/`startPrice` reflect SPY's own actual earliest available
 * close rather than the range's nominal (nonexistent, for MAX) start.
 *
 * `truncated` is true whenever SPY's history genuinely doesn't reach
 * back to the range's own requested start -- for MAX this is
 * unconditionally true (`rangeStartString` is always `null` for an
 * unbounded window, and SPY's real, finite inception is always "later"
 * than "as far back as anything has data"). For every other bounded
 * range, this is deliberately checked against SPY's *overall* earliest
 * fetched date (`earliestOverall`, across the whole `closes` array), not
 * against `start.date` (the actual first bar found *inside* the
 * window). Those two differ in a real, non-hypothetical way: a range's
 * nominal `rangeStartString` is a plain calendar date with no guarantee
 * of being a real trading day -- weekends/holidays land there routinely
 * (empirically, ~28% of days across a 2-year sample for every bounded
 * range, checked live rather than assumed), so `start.date` (the
 * nearest actual trading day at-or-after it) is *routinely* a few days
 * later than `rangeStartString` even when SPY's history reaches back
 * decades further -- exactly the same "use whichever data is actually
 * available inside the window" behavior buildWindowResults' own
 * optimizer input already relies on with no "truncated" concept at all.
 * Comparing `start.date` directly against `rangeStartString` (an earlier
 * draft of this function did exactly that) would flag `truncated: true`
 * on a large fraction of days for every bounded range, not just MAX --
 * defeating the whole point of a flag meant to catch a genuine
 * historical-depth gap. `earliestOverall` isolates that real case
 * instead: it only exceeds `rangeStartString` when SPY's data doesn't
 * reach back that far *at all*, regardless of which specific day inside
 * the window happened to have the first trading-day bar.
 */
function computeBenchmark(
  closes: readonly DailyClose[],
  range: PresetRange,
  asOf: Date,
  endDateString: string,
  startingCapital: number,
): BenchmarkResult | null {
  const rangeStart = presetRangeStartDate(range, asOf);
  const rangeStartString = rangeStart ? toDateString(rangeStart) : null;
  const inWindow = closes.filter(
    (c) => (!rangeStartString || c.date >= rangeStartString) && c.date <= endDateString,
  );
  if (inWindow.length === 0) return null;

  // Explicit min/max by date comparison, not array position
  // (inWindow[0]/inWindow.at(-1)) -- defensive against fetchDailyCloses's
  // return order, which isn't a documented contract anywhere in
  // packages/core (see packages/core/CLAUDE.md's benchmark section).
  let start = inWindow[0]!;
  let end = inWindow[0]!;
  for (const close of inWindow) {
    if (close.date < start.date) start = close;
    if (close.date > end.date) end = close;
  }

  // closes is non-empty here (inWindow is a non-empty subset of it), so
  // this initial value is always overwritten by a real element at least
  // once below -- see the doc comment above for why this is compared
  // against rangeStartString instead of start.date.
  let earliestOverall = closes[0]!.date;
  for (const close of closes) {
    if (close.date < earliestOverall) earliestOverall = close.date;
  }

  return {
    ticker: BENCHMARK_TICKER,
    startDate: start.date,
    startPrice: start.close,
    endDate: end.date,
    endPrice: end.close,
    endingBalance: startingCapital * (end.close / start.close),
    truncated: rangeStartString === null || earliestOverall > rangeStartString,
  };
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
  /** SPY buy-and-hold comparison (issue #12), precomputed once per range by runPipeline -- see computeBenchmark. */
  benchmarksByRange: Map<PresetRange, BenchmarkResult | null>;
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
  benchmarksByRange,
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

    // Same windowed history, same startingCapital/maxTrades for all 4
    // direction x instrument-set combinations, so optimizeAllVariants
    // builds this range's calendar/ticker-sort once and reuses it for
    // all 4 runs instead of separate calls (issue #13 extends issue
    // #31's original best/worst sharing to also cover long-only vs.
    // long+short).
    const { longOnly, longShort } = optimizeAllVariants(windowed, {
      startingCapital,
      maxTrades,
    });

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
      endingBalance: longOnly.best.endingBalance,
      trades: longOnly.best.trades,
      worstCase: { endingBalance: longOnly.worst.endingBalance, trades: longOnly.worst.trades },
      longShort: {
        endingBalance: longShort.best.endingBalance,
        trades: longShort.best.trades,
        worstCase: { endingBalance: longShort.worst.endingBalance, trades: longShort.worst.trades },
      },
      universeSize: windowed.size,
      skippedTickers: [...skipped],
      benchmark: benchmarksByRange.get(range) ?? null,
    };
  });
}

/**
 * Everything needed to fetch, solve, and report on one granularity
 * override (issue #30's 3M/5-minute; issue #29's 1M/1-minute) -- the
 * list `buildGranularityOverrideSpecs` returns below is *the* extension
 * point for this whole mechanism: `runPipeline` (fetching),
 * `buildIntradayResults` (solving + merging), and `runPipeline`'s final
 * error message (status reporting) all iterate over that list generically
 * instead of naming each override.
 *
 * This replaces an earlier design (still visible in issue #29's own git
 * history) that instead threaded a hand-duplicated `fiveMinute*`/
 * `oneMinute*` field pair through `BuildIntradayResultsOptions`,
 * `runPipeline`'s `Promise.all`, and the final error message -- a real
 * violation of the exact promise this mechanism's own #30 code comment
 * made ("adds one map entry instead of a third bespoke branch"), caught
 * in #29's code review: adding 1M's override required touching every
 * one of those spots by hand instead of just appending to a list. Now,
 * adding a third override means adding one entry to the list
 * `buildGranularityOverrideSpecs` returns (plus one new `fetch*Bars`
 * field on `RunPipelineOptions`, since fetching a genuinely new bar
 * granularity always needs a new fetch function from the caller) and
 * nothing else in this file.
 */
interface GranularityOverrideSpec {
  /** Which range this override upgrades. */
  range: PresetRange;
  /** Human label for fetchPathHistory's logging and the final status message (e.g. "5-minute", "1-minute"). */
  label: string;
  /** Bar granularity in minutes, stamped onto every day optimizeIntradayDays produces from this override's history. */
  barIntervalMinutes: number;
  /** Start of this override's own retention-bounded lookback window (see the per-issue *_LOOKBACK_DAYS constants above). */
  from: Date;
  /** The underlying per-ticker fetch function. */
  fetchBars: (symbol: string, from: Date, to: Date) => Promise<IntradayBar[]>;
}

/** One spec's fetch outcome, paired back up with the spec that produced it -- see buildGranularityOverrideSpecs/runPipeline for how these are built and fetched. */
interface GranularityOverrideInput {
  spec: GranularityOverrideSpec;
  outcome: PathFetchOutcome<IntradayBar>;
}

/**
 * Builds the granularity-override spec list for a given run -- a plain
 * function (not a module-level constant) only because each spec's
 * `from` depends on `asOf` and each `fetchBars` comes from
 * `RunPipelineOptions`, both only known once `runPipeline` is called.
 * **This is the list a future granularity override extends**: add one
 * entry here (and one new `fetch*Bars` field on `RunPipelineOptions`,
 * wired up in apps/pipeline/src/run.ts) -- nothing else in this file
 * needs to change, since fetching (runPipeline), solving+merging
 * (buildIntradayResults), and status reporting (runPipeline's error
 * message) all iterate over this list generically.
 */
function buildGranularityOverrideSpecs(
  options: RunPipelineOptions,
  asOf: Date,
): GranularityOverrideSpec[] {
  return [
    {
      range: "3M",
      label: "5-minute",
      barIntervalMinutes: 5,
      from: daysBeforeUtc(asOf, FIVE_MINUTE_LOOKBACK_DAYS),
      fetchBars: options.fetchFiveMinuteBars,
    },
    {
      range: "1M",
      label: "1-minute",
      barIntervalMinutes: 1,
      // Deliberately NOT presetRangeStartDate("1M", asOf) -- that can
      // land up to 31 calendar days back (one day past interval=1m's
      // retention wall whenever asOf falls after a 31-day-long source
      // month), a real bug this issue's plan review caught before any
      // code was written. daysBeforeUtc(asOf, 29) sidesteps that
      // entirely: it's always exactly 29 days back, never a
      // calendar-month-dependent value -- see ONE_MINUTE_LOOKBACK_DAYS
      // above and packages/core/CLAUDE.md's "1-minute intraday bars"
      // section for the live-verified wall this is derived from.
      from: daysBeforeUtc(asOf, ONE_MINUTE_LOOKBACK_DAYS),
      fetchBars: options.fetchIntraday1mBars,
    },
  ];
}

/**
 * A per-range override of the pure 60-minute day results, keyed by
 * PresetRange (issue #30 -- 3M's 5-minute override; issue #29 -- 1M's
 * 1-minute override; see the comment on `granularityOverrides` in
 * buildIntradayResults for why this is a lookup rather than a hardcoded
 * `range === "3M"` check). Everything a range needs beyond the base
 * 60-minute data lives together here so adding another range's override
 * later means adding one `GranularityOverrideSpec` entry, not a
 * hand-written branch alongside the existing ones.
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
  dataAsOf: string;
  asOf: Date;
  endDateString: string;
  generatedAt: string;
  startingCapital: number;
  maxTradesPerDay: number;
  skipped: readonly string[];
  /**
   * One entry per granularity override (issue #30's 3M/5-minute, issue
   * #29's 1M/1-minute, any future one), each pairing a
   * GranularityOverrideSpec with its own fetch's outcome. An override's
   * history can legitimately be empty (that fetch aborted, or found no
   * usable data): its range then falls back to 60-minute bars for every
   * day, identical to that range's pre-override behavior, rather than
   * failing anything -- see runPipeline's own comment on why an
   * override's failure doesn't fail the run.
   */
  overrides: readonly GranularityOverrideInput[];
  /** SPY buy-and-hold comparison (issue #12), precomputed once per range by runPipeline -- see computeBenchmark. */
  benchmarksByRange: Map<PresetRange, BenchmarkResult | null>;
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
  overrides,
  benchmarksByRange,
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

  // Solve + merge each override's own granularity against the base
  // 60-minute days, once per override, via one loop rather than one
  // hand-duplicated block per granularity -- see
  // GranularityOverrideSpec's own doc comment for why this used to be
  // (and no longer is) a real, code-review-flagged violation of "adding
  // an override should be localized."
  const granularityOverrides = new Map<PresetRange, GranularityOverride>();
  for (const { spec, outcome } of overrides) {
    const cappedOverrideHistory = capHistoryToEndDate(outcome.history, endDateString);
    const overrideDays = optimizeIntradayDays(cappedOverrideHistory, {
      startingCapital,
      maxTradesPerDay,
      barIntervalMinutes: spec.barIntervalMinutes,
    });
    // This override's actual per-day results: whichever of the two
    // granularities produced the better outcome for each day (see
    // mergeDaysByGranularity -- NOT an unconditional "finer granularity
    // always wins"). If overrideDays is empty (fetch failure or no
    // data), this is just sixtyMinuteDays unchanged -- the graceful-
    // degradation path.
    granularityOverrides.set(spec.range, {
      days: mergeDaysByGranularity(sixtyMinuteDays, overrideDays),
      extraHistories: [cappedOverrideHistory],
      extraSkipped: outcome.skipped,
      extraDataAsOf: outcome.dataAsOf,
    });
  }

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
    // override fetch but succeeded the 60-minute one) still legitimately
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
    // skippedTickers -- a ticker missing only from the override fetch
    // doesn't affect a range with no override for it, but it is
    // genuinely absent from this range's override-sourced days (see
    // mergeDaysByGranularity's doc comment on why a day's whole
    // tickers-considered set can shift, not a per-ticker splice), so
    // it's worth surfacing there.
    const rangeSkipped = [...new Set([...skipped, ...(override?.extraSkipped ?? [])])];

    // dataAsOf for this range: the later of the base intraday fetch's
    // freshness and this range's own override data source, if any --
    // a real bug caught in code review: a range's merged days can
    // include one sourced only from its override fetch, so dataAsOf
    // must reflect that fetch's freshness too, not just the 60-minute
    // one's, or it can understate how fresh this range's own data
    // actually is.
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
      benchmark: benchmarksByRange.get(range) ?? null,
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
  const granularityOverrideSpecs = buildGranularityOverrideSpecs(options, asOf);

  // The window and intraday fetches, plus every granularity override's
  // fetch, are all independent (see module header comment): run
  // concurrently, and no one's failure prevents another's results from
  // being computed and written. Granularity-override fetches are
  // gathered via their own inner Promise.all -- still fully concurrent
  // with each other and with the two outer fetches, just returned as one
  // array (in `granularityOverrideSpecs` order) instead of separate named
  // bindings, since the whole point of that list is that its length
  // isn't hardcoded here.
  const [windowFetch, intradayFetch, overrideOutcomes, benchmarkFetch] = await Promise.all([
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
    // Each override reuses fetchConcurrency rather than a separate,
    // lower knob -- true even for issue #29's 1-minute override, whose
    // fetchIntraday1mBars chunks each ticker's request internally: those
    // chunks are issued *sequentially* per ticker, not concurrently, so
    // peak simultaneous connections stays bounded by fetchConcurrency
    // exactly like every other path regardless of an override's own
    // request volume per ticker -- there's no burst-risk reason to lower
    // it further, just a longer wall-clock time for that override's pool
    // to finish.
    Promise.all(
      granularityOverrideSpecs.map((spec) =>
        fetchPathHistory(
          spec.label,
          options.tickers,
          spec.from,
          asOf,
          spec.fetchBars,
          fetchConcurrency,
          endDateString,
          (bar: IntradayBar) => localDatePart(bar.date),
        ),
      ),
    ),
    // The buy-and-hold benchmark (issue #12) -- a single extra HTTP
    // request per run (one ticker, not a ~503-ticker pool), negligible
    // next to the paths above; see fetchBenchmarkHistory's own doc
    // comment for why it deliberately skips fetchUniverseHistory's
    // heavier machinery.
    fetchBenchmarkHistory(options.fetchDailyCloses, earliestDate, asOf),
  ]);
  const overrideInputs: GranularityOverrideInput[] = granularityOverrideSpecs.map((spec, i) => ({
    spec,
    outcome: overrideOutcomes[i]!,
  }));

  // Computed once per range from the single shared SPY closes array (or
  // an empty array if the fetch failed entirely -- computeBenchmark's
  // own inWindow.length === 0 guard then returns null for every range
  // uniformly) -- see computeBenchmark for the MAX/1993-truncation
  // handling. All 5 PRESET_RANGES get an entry, not just the two window
  // ranges: the benchmark is a single well-defined whole-window figure
  // regardless of which trading model (window vs. intraday-daily) a
  // given range uses.
  const benchmarksByRange = new Map<PresetRange, BenchmarkResult | null>(
    PRESET_RANGES.map((range) => [
      range,
      computeBenchmark(benchmarkFetch.closes, range, asOf, endDateString, startingCapital),
    ]),
  );

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
        benchmarksByRange,
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
        // Passed through regardless of each override's own
        // failureReason -- on abort/no-data, that override's history is
        // empty (or has no usable bars), which buildIntradayResults
        // already handles as "this range falls back to 60-minute bars
        // for every day" with no special-casing needed here.
        overrides: overrideInputs,
        benchmarksByRange,
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
  // network latency for them. Each result is self-validated (issue #47)
  // immediately before its own putObject call, so a malformed result
  // (e.g. a refactor bug producing a NaN endingBalance) fails loudly
  // instead of shipping silently to S3. The callback must stay `async`
  // -- a synchronous throw from validatePrecomputedResult inside a
  // non-async .map() callback would propagate out of .map() itself and
  // abort the whole loop before later, still-valid results ever get a
  // chance to write; wrapping in `async` turns that throw into this one
  // result's own rejected promise instead, so every other result's write
  // still gets a chance to start -- see apps/pipeline/CLAUDE.md's "write
  // whatever succeeded, then still throw" guarantee, which this must
  // not break.
  //
  // Promise.allSettled, not Promise.all: validation is synchronous and
  // effectively instant, but putObject is real S3 I/O taking real time.
  // With Promise.all, one range's validation failure rejects almost
  // immediately, and Promise.all rejects the whole thing as soon as ANY
  // input promise rejects -- it does not wait for the others to settle.
  // That rejection would propagate out of runPipeline to the Lambda
  // handler, and AWS can freeze/recycle the execution environment as
  // soon as the handler's returned promise settles, potentially cutting
  // off other, valid ranges' still-in-flight S3 writes before they
  // finish -- silently breaking the exact "write whatever succeeded"
  // guarantee this comment claims to preserve (the in-memory test store
  // can't catch this: it has no real I/O delay, so every write there
  // resolves before the rejection even has a chance to race it).
  // allSettled waits for every write to finish, succeed or fail, before
  // this function decides anything -- see failedWrites below for how a
  // rejection is turned into part of the aggregated error instead.
  const writeOutcomes = await Promise.allSettled(
    results.map(async (result) => {
      validatePrecomputedResult(result);
      await options.store.putObject(resultKey(result.range), JSON.stringify(result, null, 2));
      return result.range;
    }),
  );
  // Every rejection, not just the first -- plain Promise.all (and a
  // naive "throw on the first rejected settlement" loop) would only
  // ever surface one range's problem even when multiple ranges are
  // independently broken in the same run, hiding real information from
  // whoever reads the thrown error. Paired with the range it belongs to
  // (rather than just the bare error message) since a putObject failure
  // -- unlike a ResultValidationError, which already names its own range
  // -- has no other way to say which range it was.
  const failedWrites = writeOutcomes
    .map((outcome, i) => ({ outcome, range: results[i]!.range }))
    .filter(
      (entry): entry is typeof entry & { outcome: PromiseRejectedResult } =>
        entry.outcome.status === "rejected",
    )
    .map(({ outcome, range }) => {
      const reason = outcome.reason;
      return `${range}: ${reason instanceof Error ? reason.message : String(reason)}`;
    });
  const writtenCount = writeOutcomes.filter((outcome) => outcome.status === "fulfilled").length;

  const skippedTickers = [
    ...new Set([
      ...windowFetch.skipped,
      ...intradayFetch.skipped,
      ...overrideInputs.flatMap(({ outcome }) => outcome.skipped),
    ]),
  ];

  if (windowFetch.failureReason || intradayFetch.failureReason || failedWrites.length > 0) {
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
    // buried in CloudWatch to notice it. A write-time failure (issue #47
    // self-validation, or a real putObject error) is folded into this
    // same throw for the same reason -- one aggregated error per run,
    // not a separate throw for fetch-time vs. write-time problems.
    //
    // Deliberately excludes every granularity override's failureReason
    // (issues #30/#29): an override's failure never leaves anything
    // silently stale -- it just means that override's range falls back
    // to already-shipped, fully-correct 60-minute bars, the same as its
    // pre-override behavior -- so overrides don't need to meet this same
    // "must still fail the run" bar. Each override's status is still
    // included in the message below purely for operational visibility.
    const overrideStatusLines = overrideInputs
      .map(
        ({ spec, outcome }) =>
          `${spec.label} path (${spec.range} only, non-fatal): ${outcome.failureReason ?? "ok"}.`,
      )
      .join(" ");
    const benchmarkStatusLine = `Benchmark (${BENCHMARK_TICKER}, non-fatal): ${benchmarkFetch.error ?? "ok"}.`;
    const writeFailureLines =
      failedWrites.length > 0
        ? ` Write failures (${failedWrites.length} of ${results.length} computed result(s)):\n` +
          failedWrites.map((message) => `  - ${message}`).join("\n")
        : "";
    throw new Error(
      `pipeline: wrote ${writtenCount} of ${PRESET_RANGES.length} ranges, but at least one path or write failed -- ` +
        `failing this run so it doesn't silently succeed while that path goes stale. ` +
        `Window (5Y/MAX) path: ${windowFetch.failureReason ?? "ok"}. ` +
        `Intraday (1M/3M/1Y) path: ${intradayFetch.failureReason ?? "ok"}. ` +
        `${overrideStatusLines} ` +
        `${benchmarkStatusLine} ` +
        `Skipped tickers: ${skippedTickers.length > 0 ? skippedTickers.join(", ") : "(none)"}.` +
        writeFailureLines,
    );
  }

  // Every write succeeded -- if any had failed, the block above would
  // already have thrown before reaching here.
  return { results, skippedTickers };
}
