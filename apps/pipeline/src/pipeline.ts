// The nightly precompute job: fetches full daily-close history for the
// whole ticker universe once, then for each preset range (1W/1M/3M/1Y/5Y/
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
//   - the "intraday" path (1W/1M/3M/1Y): one 60-minute-bar fetch (from the
//     1Y start date -- comfortably covers all four, same "fetch once,
//     slice many" pattern), then optimizeIntradayDays run ONCE over the
//     full fetched history and sliced per range afterward (a given day's
//     own result never depends on which range window it falls inside --
//     range slicing only ever drops whole out-of-range days, never bars
//     within an in-range one -- so running the DP once and filtering its
//     output is equivalent to, and much cheaper than, re-running it per
//     range given 1W/1M/3M/1Y are nested subsets of each other).
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
  anchorDateToDate,
  BlockedError,
  collectTradingDates,
  customRangeAnchors,
  optimizeIntradayDays,
  optimizeAllVariants,
  PRESET_RANGES,
  presetRangeStartDate,
  resultKey,
  customResultKey,
  CUSTOM_ANCHORS_MANIFEST_KEY,
  daysBeforeUtc,
  RESULTS_SCHEMA_VERSION,
  toDateString,
  UnexpectedResponseError,
  validatePrecomputedResult,
  validateCustomWindowResult,
  validateCustomAnchorsManifest,
  type AnchorDate,
  type BenchmarkResult,
  type BenchmarkSeries,
  type CustomAnchorsManifest,
  type CustomWindowResult,
  type DailyClose,
  type IntradayBar,
  type IntradayDayResult,
  type IntradayResult,
  type OptimizationResult,
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
// Caps how many S3 putObject calls (issue #47's write loop) run at once
// -- same value/spirit as DEFAULT_FETCH_CONCURRENCY, mirrored rather
// than reused outright since fetch concurrency and write concurrency are
// conceptually independent knobs (Yahoo's own request-volume tolerance
// vs. S3's), even though they happen to default to the same number today
// (code review finding, issue #11): before this, the write loop fired
// every job's putObject via one unbounded Promise.allSettled, unlike
// every fetch pool's own bounded worker count -- up to 258 concurrent
// S3 writes (6 preset ranges + up to 252 custom anchors) with no cap,
// never exercised against real S3 (this PR's own live verification
// explicitly excluded S3 writes -- see packages/core/CLAUDE.md's
// "Custom date-range anchors" section).
const DEFAULT_WRITE_CONCURRENCY = 10;
// How far back to fetch 5-minute bars for (issue #30, upgrading 3M's
// most recent days -- see packages/core/CLAUDE.md's "5-minute intraday
// bars" section). Yahoo's real retention wall for interval=5m is
// exactly 60 days back (verified live: 59 days back succeeds, 60 fails
// with a 422); requesting 59 keeps every request a full day inside that
// wall rather than right at the boundary. Deliberately NOT reusing
// presetRangeStartDate here -- that function only subtracts whole
// months/years, and this needs a plain days-back offset instead (see
// the imported daysBeforeUtc from @hadiknowntrades/core).
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
// How much of the already-fetched SPY daily-close series to persist on
// every PrecomputedResult (issue #126, `benchmarkSeries`). Unlike the
// two lookback constants above, this is NOT a Yahoo retention wall --
// the full series is already in memory from the benchmark fetch (see
// fetchBenchmarkHistory), so this is purely a "how much is worth
// storing" product number, chosen and stated here rather than deferred
// to whatever a consumer turns out to want.
//
// 90 calendar days is ~62 real trading days: comfortably more than
// issue #128's Call Board history strip needs (a rolling 3-day
// lookahead plus a visible run of resolved calls), with enough slack
// that a user who lapses for a couple of months still comes back to a
// series that covers the whole gap rather than a truncated one. The
// cost side is negligible -- ~62 `{date, close}` entries is ~2.5KB of
// JSON per range file, ~15KB across all 6.
const BENCHMARK_SERIES_TRAILING_DAYS = 90;

// The "window" (whole-window, daily-close) ranges vs. the "intraday"
// (per-day, 60m-bar) ranges introduced by issue #28. Together these must
// cover every PresetRange exactly once -- see pipeline.test.ts's
// "covers every PresetRange between the two paths" test, which checks
// this against the real PRESET_RANGES export rather than leaving it an
// unenforced comment.
const WINDOW_RANGES: readonly PresetRange[] = ["5Y", "MAX"];
const INTRADAY_RANGES: readonly PresetRange[] = ["1W", "1M", "3M", "1Y"];

export interface ResultStore {
  putObject(key: string, body: string): Promise<void>;
}

export interface PipelineRunSummary {
  results: PrecomputedResult[];
  /** One entry per successfully-written custom-range anchor (issue #11) -- kept separate from `results` (which stays exactly the 6 preset ranges, matching every prior release's shape) rather than merged into it. Empty whenever RunPipelineOptions.computeCustomAnchors was false (the default). */
  customResults: CustomWindowResult[];
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
  /** Max same-day trades per day for the intraday (1W/1M/3M/1Y) path. */
  maxTradesPerDay?: number;
  earliestDate?: Date;
  fetchConcurrency?: number;
  /** Caps concurrent S3 putObject calls in the final write loop -- see DEFAULT_WRITE_CONCURRENCY's own comment for why this is a separate knob from fetchConcurrency despite sharing its default value. */
  writeConcurrency?: number;
  /**
   * Opts into computing+writing a CustomWindowResult (plus the anchors
   * manifest, CustomAnchorsManifest) for every custom start-date anchor
   * (issue #11's coarsened design, day-granularity anchors since issue
   * #75 -- see docs/plans/issue-75-plan.md), alongside the 6 preset
   * ranges. Defaults to `false` -- deliberately, unlike every other
   * RunPipelineOptions default above (which are sourced inside this
   * file): src/run.ts (the real nightly entry point) is the one place
   * that opts in for real. This keeps every existing test of this file
   * that doesn't care about this feature completely unaffected by its
   * introduction -- see apps/pipeline/CLAUDE.md's "Custom date-range
   * anchors" section for the full reasoning.
   *
   * **Issue #75 changed this from a precomputed `readonly AnchorMonth[]`
   * list to this boolean** -- day-granularity anchors can only be
   * derived from the window path's own already-fetched history (via
   * `customRangeAnchors(collectTradingDates(windowFetch.history),
   * asOf)`, packages/core), which isn't available until *after*
   * `runPipeline`'s own fetch completes, unlike the month scheme's
   * anchors (a pure function of calendar time alone, computable by
   * `src/run.ts` before ever calling `runPipeline`). The anchor list
   * itself is now computed inside `runPipeline`, right where
   * `buildCustomWindowResults` is called, not passed in from outside.
   */
  computeCustomAnchors?: boolean;
}

interface UniverseFetchResult<TBar> {
  history: Map<string, TBar[]>;
  /** Every ticker that failed individually (TickerNotFoundError/TransientFetchError) before -- or independently of -- any abort, so this information isn't lost even when `abortError` is also set. */
  skipped: string[];
  /** Set once any worker hits a systemic failure; `history` still holds whatever was fetched before the abort was noticed, but callers that don't trust partial data on abort should ignore it (see fetchPathHistory). */
  abortError: BlockedError | UnexpectedResponseError | null;
}

/**
 * The one bounded-worker-pool shape every concurrency-capped loop in
 * this file builds on: at most `concurrency` workers, each repeatedly
 * pulling the next index off one shared cursor (`[0, itemCount)`) and
 * awaiting `perItem(index)` for it, until either every index has been
 * claimed or `perItem` signals to stop dispatching new work by
 * returning `true`.
 *
 * **Factored out so there's exactly one implementation of this pattern
 * in this file (issue #11 code review finding, second round)**:
 * `fetchUniverseHistory` (every fetch pool, issue #28) and
 * `mapWithConcurrency` (the S3 write loop, issue #11) used to each hand-
 * roll their own copy of this exact "N workers pulling the next index
 * off a shared cursor" loop -- a previous fix round asked for
 * `mapWithConcurrency` to "mirror" `fetchUniverseHistory`'s own shape,
 * which produced a second, independently-written copy instead of true
 * reuse. Both now call this one function; only what each does *per
 * item* differs.
 *
 * A worker checks `stopped` *before* claiming its next index, the same
 * place `fetchUniverseHistory`'s original abort check lived -- an
 * in-flight `perItem` call already underway when another worker signals
 * stop still runs to completion (there's no cheap way to cancel it
 * without threading an AbortSignal through the caller's own async work),
 * but no further indices get claimed once the flag is set.
 */
async function runWorkerPool(
  itemCount: number,
  concurrency: number,
  perItem: (index: number) => Promise<boolean | void>,
): Promise<void> {
  let nextIndex = 0;
  let stopped = false;

  async function worker(): Promise<void> {
    for (;;) {
      if (stopped) return;
      const i = nextIndex++;
      if (i >= itemCount) return;
      if (await perItem(i)) stopped = true;
    }
  }

  const workerCount = Math.min(concurrency, itemCount);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
}

/**
 * Fetches full history (from..to) for every ticker, with bounded
 * concurrency (via runWorkerPool above). A ticker that fails with
 * TickerNotFoundError or TransientFetchError is skipped (logged,
 * doesn't fail the run) -- those are per-ticker problems. Generic over
 * the bar shape so the same concurrency/abort/skip logic backs both the
 * daily-close fetch and the intraday-bar fetch (issue #28) instead of a
 * second copy-pasted worker pool.
 *
 * BlockedError or UnexpectedResponseError set `abortError` and signal
 * runWorkerPool to stop (by returning `true`) rather than throwing: a
 * block means we shouldn't keep firing off hundreds more requests, and
 * an unexpected-response is documented (see yahoo-client.ts) as "likely
 * permanent regardless of symbol" -- i.e. a systemic problem, not a
 * per-ticker one, so treating it as an ordinary skip would risk masking
 * a total data-fetch failure as a handful of unlucky tickers. Returning
 * `abortError` instead of throwing preserves whatever `skipped` had
 * already been accumulated from tickers that failed individually
 * *before* the abort -- a caller that discards `history` on abort (see
 * fetchPathHistory) can still keep that real per-ticker bookkeeping
 * instead of losing it along with the untrusted partial data.
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
  let abortError: BlockedError | UnexpectedResponseError | null = null;

  await runWorkerPool(tickers.length, concurrency, async (i) => {
    const ticker = tickers[i]!;
    try {
      const series = await fetchFn(ticker, from, to);
      history.set(ticker, series);
    } catch (error) {
      if (error instanceof BlockedError || error instanceof UnexpectedResponseError) {
        abortError = error;
        return true;
      }
      skipped.push(ticker);
      console.warn(
        `[pipeline] skipping ${ticker}: ${error instanceof Error ? error.message : error}`,
      );
    }
    return false;
  });

  return { history, skipped, abortError };
}

/**
 * Runs `worker` over `items` with at most `concurrency` running at once
 * (via runWorkerPool above), collecting every outcome (success or
 * failure) as a Promise.allSettled-shaped result array, in original item
 * order -- backs the pipeline's own S3 write loop (issue #11 code review
 * finding): before this existed, the write loop fired every WriteJob's
 * putObject via one unbounded `Promise.allSettled`, the only place in
 * this file with no concurrency cap at all, unlike every fetch pool's
 * own DEFAULT_FETCH_CONCURRENCY.
 *
 * A generic, item-order-preserving instantiation of runWorkerPool rather
 * than a call into fetchUniverseHistory itself: that function's own
 * return shape (BlockedError/UnexpectedResponseError abort
 * classification, a `history` Map<string, TBar[]>) is daily-close/
 * intraday-bar-fetch-specific in a way that doesn't generalize to "run
 * an arbitrary async job over an arbitrary item list, never aborting
 * early," which is all the write loop actually needs -- this function
 * never returns `true` from its own runWorkerPool callback, so every
 * item always gets a chance to run regardless of an earlier item's
 * outcome.
 */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);

  await runWorkerPool(items.length, concurrency, async (i) => {
    try {
      const value = await worker(items[i]!, i);
      results[i] = { status: "fulfilled", value };
    } catch (reason) {
      results[i] = { status: "rejected", reason };
    }
  });

  return results;
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
 * "best possible outcome" premise.
 *
 * **Issue #13 fix: the long-only bundle (`endingBalance`/`trades`/
 * `worstCase`) and the long+short bundle (the whole `longShort` field,
 * itself best+worst) are picked *independently* of each other, each via
 * its own endingBalance comparison** -- see mergeDayVariants below. The
 * original version of this function (pre-#13-code-review) picked a
 * date's whole IntradayDayResult wholesale based only on the long-only
 * `endingBalance` comparison, silently ignoring the parallel `longShort`
 * field entirely: whichever source won the long-only comparison also
 * had its `longShort` field carried along for the ride, even when the
 * *other* source's `longShort.endingBalance` was actually higher (a
 * realistic split, since `IntradayDayResult.longShort` is a genuinely
 * independent search per intraday-optimizer.ts, and different
 * granularities can see different ticker universes) -- silently
 * violating this function's own "keeps whichever day's outcome is
 * actually higher" invariant for the long+short mode specifically.
 *
 * This is safe (not a "cherry-pick fields from two unrelated
 * computations" hazard) precisely because each bundle's own fields were
 * always computed together, from the same source day's actual bars, by
 * the same optimizeAllVariants call: `trades` always matches its own
 * sibling `endingBalance`, and `longShort.trades` always matches
 * `longShort.endingBalance`, regardless of which of the two bundles'
 * source day ends up winning independently.
 */
interface MergeDaysByGranularityOutcome {
  days: IntradayDayResult[];
  /**
   * One entry per date where mergeDayVariants had to fall back instead
   * of combining the two sources' bundles (see that function's own doc
   * comment) -- expected to be empty on every real run (the underlying
   * cross-check is proven to never actually fire, see below), but
   * plumbed through to buildIntradayResults' own `failures` return so a
   * violation, if the "never" premise is ever wrong, still fails the run
   * via computeFailures instead of only being visible as a console.error
   * buried in CloudWatch.
   */
  failures: string[];
}

function mergeDaysByGranularity(
  primaryDays: IntradayDayResult[],
  overrideDays: IntradayDayResult[],
): MergeDaysByGranularityOutcome {
  const byDate = new Map<string, IntradayDayResult>();
  const failures: string[] = [];
  for (const day of primaryDays) byDate.set(day.date, day);
  for (const day of overrideDays) {
    const existing = byDate.get(day.date);
    if (!existing) {
      byDate.set(day.date, day);
      continue;
    }
    const { day: merged, fallback } = mergeDayVariants(existing, day);
    if (fallback) failures.push(fallback);
    byDate.set(day.date, merged);
  }
  return {
    days: [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)),
    failures,
  };
}

/**
 * Combines two IntradayDayResults for the *same* date, sourced from two
 * different granularities -- see mergeDaysByGranularity's own doc
 * comment for why this exists. Picks the long-only bundle
 * (`endingBalance`/`trades`/`worstCase`) from whichever source has the
 * higher `endingBalance`, and the long+short bundle (the whole
 * `longShort` field) from whichever source has the higher
 * `longShort.endingBalance` -- independently of each other. Ties (equal
 * `endingBalance`) keep `a` (the primary/60-minute day) for each bundle,
 * matching this function's pre-existing tie-break (the original
 * `day.endingBalance > existing.endingBalance`, strict, only replacing
 * `existing` on a real improvement).
 *
 * **Why this can never violate results-schema.ts's own write-time
 * cross-checks** (`longShort.endingBalance >= endingBalance` and
 * `longShort.worstCase.endingBalance <= worstCase.endingBalance`,
 * checked on every stored day) **even though the two bundles can now
 * come from different source days:**
 *
 * Write `X` = the long-only winner (`a` or `b`, whichever has the higher
 * `endingBalance`) and `Y` = the long+short winner. `merged.endingBalance
 * = X.endingBalance` and `merged.longShort = Y.longShort`.
 *
 * - `merged.longShort.endingBalance >= merged.endingBalance`: if `X ===
 *   Y`, this is exactly the existing same-source invariant (always true
 *   by construction, per optimizer.ts's own optimizeAllVariants doc
 *   comment: a long+short max-search over a strict superset of the
 *   long-only candidate set can never do worse). If `X !== Y`, then by
 *   definition `Y.longShort.endingBalance > X.longShort.endingBalance`,
 *   and `X.longShort.endingBalance >= X.endingBalance` holds for `X` on
 *   its own (the same same-source invariant) -- chaining the two:
 *   `merged.longShort.endingBalance = Y.longShort.endingBalance >
 *   X.longShort.endingBalance >= X.endingBalance = merged.endingBalance`.
 * - `merged.longShort.worstCase.endingBalance <=
 *   merged.worstCase.endingBalance`: this is the one that needs real
 *   care -- a same-source-only argument does NOT obviously carry over
 *   once the two bundles can come from different sources. **A prior
 *   version of this comment's proof for this bullet had a real
 *   directional algebra error, caught in a later code-review round: it
 *   described flipping `Y`'s own longShort-*worst* sequence into a
 *   candidate for `Y`'s own longShort-*best* search, which actually
 *   derives `Y.longShort.worstCase.endingBalance >= startingCapital^2 /
 *   Y.longShort.endingBalance` (a *lower* bound on the product, the
 *   opposite of what's needed) -- not the `<=` the old text claimed.
 *   Both the corrected derivation below and a 20,000-trial randomized
 *   brute-force check against the real `optimizeAllVariants` (varied
 *   ticker counts, trade counts, and price ranges down to 0.0001,
 *   specifically to stress the reciprocal-price short's near-zero
 *   overflow regime; 2,087 of those trials genuinely exercised the
 *   `X !== Y` disagreeing-winners case this proof depends on) found
 *   **zero violations** -- the corrected proof's conclusion is the same
 *   as the original's stated (if mis-derived) conclusion, it just needed
 *   the right derivation to actually be trustworthy.**
 *
 *   The corrected derivation, by a structural property of this
 *   optimizer's reciprocal-price short model (see optimizer.ts's header
 *   comment): for *any* single source `S`, flipping every leg of a
 *   candidate sequence (long <-> short, same slots, same day) turns a
 *   sequence worth `v` into one worth `startingCapital^2 / v`, and the
 *   flipped sequence is always a *valid* candidate wherever the original
 *   was (same day, same candidate pool, includeShorts=true both ways).
 *   Two flips are used, each pairing a sequence with the search *most
 *   directly bounded* by its flip -- flipping into a *max* search only
 *   ever yields a *lower* bound on that search's result (the max can't be
 *   beaten by one specific candidate); flipping into a *min* search only
 *   ever yields an *upper* bound (symmetric reasoning): (1) flipping `X`'s
 *   own long-only-*worst* sequence is a valid candidate for `X`'s own
 *   longShort-*best* search (a max search) -- giving a lower bound,
 *   `X.longShort.endingBalance >= startingCapital^2 /
 *   X.worstCase.endingBalance`, i.e. `X.worstCase.endingBalance >=
 *   startingCapital^2 / X.longShort.endingBalance`. (2) flipping `Y`'s own
 *   longShort-*best* sequence is a valid candidate for `Y`'s own
 *   longShort-*worst* search (a min search) -- giving an upper bound,
 *   `Y.longShort.worstCase.endingBalance <= startingCapital^2 /
 *   Y.longShort.endingBalance` (this is the step the old text got
 *   backwards: it must be *best* flipped into the *worst* search, not
 *   *worst* into the *best* search, to land on a `<=` instead of a `>=`).
 *   Since (by definition of `Y` winning) `Y.longShort.endingBalance >
 *   X.longShort.endingBalance` (or `>=` on an exact tie, still enough
 *   below), we get `startingCapital^2 / Y.longShort.endingBalance <=
 *   startingCapital^2 / X.longShort.endingBalance <=
 *   X.worstCase.endingBalance = merged.worstCase.endingBalance`. Chaining:
 *   `merged.longShort.worstCase.endingBalance =
 *   Y.longShort.worstCase.endingBalance <= startingCapital^2 /
 *   Y.longShort.endingBalance <= merged.worstCase.endingBalance`. QED --
 *   this holds unconditionally (no guard needed to make it *true*), and
 *   is exercised directly in pipeline.test.ts with a fixture where the
 *   two granularities disagree on which is long-only-best vs.
 *   long-short-best.
 *
 * **Defense in depth regardless of the proof above (code review
 * follow-up, second round)**: a *provably* safe invariant is still worth
 * containing rather than trusted blindly at runtime, especially given
 * this exact proof was already wrong once. Unlike the first cross-check
 * review round's fix (a bare `throw` on violation -- correct in spirit,
 * but with no try/catch anywhere between this function and
 * `buildIntradayResults`, so a real violation would have crashed the
 * *entire* `runPipeline` invocation, discarding every other already-
 * computed range's and day's results too), a violation here now falls
 * back to using the long-only winner's own day *wholesale* for both
 * bundles (see the code below) -- trivially safe, since a single day
 * from a single `optimizeAllVariants` call always satisfies both
 * cross-checks internally by construction (the same guarantee
 * `results-schema.ts`'s own validator already relies on) -- and reports
 * it as a failure through `mergeDaysByGranularity`'s own return value,
 * which `buildIntradayResults` folds into its `failures` (fatal, reaches
 * `computeFailures`) exactly like an override solve failure. Contained
 * (this one day, and only the merge that hit it, degrades instead of
 * crashing every other range/day) but not silent (still fails the run --
 * a violation, if it ever actually happens despite the proof above,
 * means either this proof or one of its premises broke, which is exactly
 * the kind of thing this system's only alerting mechanism exists to
 * catch, not paper over).
 *
 * **Known, accepted limitation, documented rather than engineered
 * around (same "neither override is held to the same alerting standard"
 * class of documented tradeoff this codebase has already accepted
 * elsewhere -- see "Granularity overrides" in this file's own module
 * header)**: `barIntervalMinutes` is a single scalar per day, so on the
 * (rare) date where the two bundles' winners come from different source
 * granularities, the merged day's `barIntervalMinutes` reflects only the
 * long-only bundle's source (`X`), not necessarily the granularity that
 * actually produced the `longShort` bundle shown alongside it. There's no
 * way to represent two different granularities in one scalar field
 * without a schema change; the vastly more common case -- one
 * granularity strictly better across both bundles, or only one
 * granularity covering a date at all -- is unaffected and exact.
 */
function mergeDayVariants(
  a: IntradayDayResult,
  b: IntradayDayResult,
): { day: IntradayDayResult; fallback: string | null } {
  const longOnlyWinner = b.endingBalance > a.endingBalance ? b : a;
  const longShortWinner = b.longShort.endingBalance > a.longShort.endingBalance ? b : a;
  const merged: IntradayDayResult =
    longOnlyWinner === longShortWinner
      ? longOnlyWinner
      : { ...longOnlyWinner, longShort: longShortWinner.longShort };

  // Defense in depth for the proof in this function's own doc comment
  // (code review follow-up, second round): the proof shows these two
  // cross-checks (mirroring results-schema.ts's own write-time
  // invariants) hold unconditionally by construction, but it rests on
  // premises about the reciprocal-price short model and
  // results-schema.ts's own threshold definitions -- premises a future
  // change to either could silently invalidate without anything here
  // noticing, and this exact proof was already once wrong in a way that
  // still happened to reach the right conclusion (see the doc comment
  // above) -- reason enough not to trust it blindly at runtime. Unlike
  // the first review round's fix (a bare throw here), a violation is
  // now *contained*: fall back to the long-only winner's own day
  // wholesale for both bundles (trivially safe -- a single day from one
  // optimizeAllVariants call always satisfies both cross-checks
  // internally by construction) rather than propagate a throw out of
  // mergeDaysByGranularity/buildIntradayResults and crash the entire
  // runPipeline invocation, discarding every other already-computed
  // range's and day's results too. The violation is still reported
  // (`fallback`, non-null), not silently swallowed -- see
  // mergeDaysByGranularity's own MergeDaysByGranularityOutcome doc
  // comment for how that reaches buildIntradayResults' failures and, from
  // there, computeFailures/this system's alerting.
  const violations: string[] = [];
  if (merged.longShort.endingBalance < merged.endingBalance) {
    violations.push(
      `longShort.endingBalance (${merged.longShort.endingBalance}) below its long-only counterpart (${merged.endingBalance})`,
    );
  }
  if (merged.longShort.worstCase.endingBalance > merged.worstCase.endingBalance) {
    violations.push(
      `longShort.worstCase.endingBalance (${merged.longShort.worstCase.endingBalance}) above its long-only counterpart (${merged.worstCase.endingBalance})`,
    );
  }

  if (violations.length === 0) {
    return { day: merged, fallback: null };
  }

  return {
    day: longOnlyWinner,
    fallback:
      `${merged.date}: cross-source merge would have violated ${violations.join("; ")} -- ` +
      `should be impossible by construction, see mergeDayVariants' own doc comment; falling ` +
      `back to the long-only winner's own day wholesale for both bundles instead of crashing`,
  };
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
 * one range or custom anchor from the single shared SPY `closes` array --
 * called once per range from both buildWindowResults and
 * buildIntradayResults, and once per custom anchor from
 * buildCustomWindowResults (issue #11), not re-derived per model.
 *
 * Takes `rangeStartString` directly (a plain YYYY-MM-DD string or null
 * for "unbounded") rather than a `PresetRange` + `asOf` pair to derive it
 * from internally -- generalized (issue #11) so the exact same function
 * serves both a preset range's own `presetRangeStartDate` output and a
 * custom anchor's month-start date, with no PresetRange-specific
 * branching inside this function at all. Every caller computes its own
 * `rangeStartString` the same way `presetRangeStartDate` already did
 * internally here before this generalization.
 *
 * Returns `null` only when there's no usable SPY data at all inside this
 * window (either the fetch failed entirely -- `closes` is empty -- or,
 * hypothetically, SPY simply has no bars overlapping this specific
 * window). This is deliberately distinct from the MAX/1993 case below,
 * where a real, honest (if truncated) comparison is still returned.
 *
 * **The MAX/1993 case**: MAX's own window is unbounded
 * (`presetRangeStartDate("MAX", asOf)` returns `null` -- "as far back as
 * anything has data"), but SPY's own inception is 1993-01-29. `inWindow`
 * is still non-empty here (it has all of SPY's real history up to
 * `endDateString`), so this returns a real comparison, just one whose
 * `startDate`/`startPrice` reflect SPY's own actual earliest available
 * close rather than the range's nominal (nonexistent, for MAX) start. A
 * custom anchor's `rangeStartString` is never null (see custom-range-
 * anchors.ts), so this null-start case is MAX-only in practice today.
 *
 * `truncated` is true whenever SPY's history genuinely doesn't reach
 * back to the window's own requested start -- for a null start
 * (MAX) this is unconditionally true (SPY's real, finite inception is
 * always "later" than "as far back as anything has data"). For every
 * other bounded window, this is deliberately checked against SPY's
 * *overall* earliest fetched date (`earliestOverall`, across the whole
 * `closes` array), not against `start.date` (the actual first bar found
 * *inside* the window). Those two differ in a real, non-hypothetical
 * way: a nominal `rangeStartString` is a plain calendar date with no
 * guarantee of being a real trading day -- weekends/holidays land there
 * routinely (empirically, ~28% of days across a 2-year sample for every
 * bounded preset range, checked live rather than assumed), so
 * `start.date` (the nearest actual trading day at-or-after it) is
 * *routinely* a few days later than `rangeStartString` even when SPY's
 * history reaches back decades further -- exactly the same "use
 * whichever data is actually available inside the window" behavior
 * computeWindowOptimization's own slicing filter already relies on with
 * no "truncated" concept at all. Comparing `start.date` directly against
 * `rangeStartString` (an earlier draft of this function did exactly
 * that) would flag `truncated: true` on a large fraction of days for
 * every bounded window, not just MAX -- defeating the whole point of a
 * flag meant to catch a genuine historical-depth gap. `earliestOverall`
 * isolates that real case instead: it only exceeds `rangeStartString`
 * when SPY's data doesn't reach back that far *at all*, regardless of
 * which specific day inside the window happened to have the first
 * trading-day bar.
 */
function computeBenchmark(
  closes: readonly DailyClose[],
  rangeStartString: string | null,
  endDateString: string,
  startingCapital: number,
): BenchmarkResult | null {
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

/**
 * Slices a trailing window out of the *same* SPY `closes` array
 * computeBenchmark above already reads, into the `benchmarkSeries` field
 * every PrecomputedResult carries (issue #126) -- see BenchmarkSeries
 * (packages/core/src/results-schema.ts) for the shape and
 * BENCHMARK_SERIES_TRAILING_DAYS above for the window size.
 *
 * **No new fetch, and no new failure mode.** fetchBenchmarkHistory
 * already holds SPY's full daily series in memory; this issue is purely
 * about persisting a slice of it instead of discarding everything but
 * the start/end pair. Consequently it inherits that fetch's
 * deliberately non-fatal contract verbatim (see fetchBenchmarkHistory's
 * own doc comment): a failed SPY fetch yields an empty `closes` array
 * here, this returns `null`, and every range's stored result carries
 * `benchmarkSeries: null` for that run -- exactly as it already carries
 * `benchmark: null` -- without contributing to runPipeline's "at least
 * one path failed" throw. Readers must render sanely with the field
 * null; that requirement is stated on the field itself, and covered by
 * a test in apps/web.
 *
 * "Non-fatal" here means exactly what it already means for `benchmark`:
 * a *fetch* failure degrades to null and the run still succeeds. A
 * *malformed* series that somehow got built anyway still trips
 * validatePrecomputedResult and fails the run, the same as a NaN
 * `benchmark.endPrice` already would -- that's issue #47's write-time
 * gate doing its job, not this field being held to a stricter standard
 * than its sibling.
 *
 * Called **once per run**, not once per range: the window is a fixed
 * trailing span off `asOf`, deliberately independent of any range's own
 * start date (see BenchmarkSeries' own doc comment for why the consumer
 * wants it that way), so the identical object is stamped onto all 6
 * preset results.
 *
 * Returns null (rather than an empty series) when nothing lands in the
 * window, mirroring computeBenchmark's own `inWindow.length === 0`
 * guard, so a reader never has to distinguish "no data" from "an empty
 * array."
 *
 * Sorts its own slice ascending rather than trusting the fetched order
 * -- same defensive posture (and same reason) as computeBenchmark's
 * explicit min/max scan just above: fetchDailyCloses' return order is
 * "ascending in practice," not a documented contract (see
 * packages/core/CLAUDE.md). Here it matters more than there, since
 * ordering is part of this field's own published contract, not just an
 * internal convenience.
 */
function computeBenchmarkSeries(
  closes: readonly DailyClose[],
  fromDateString: string,
  endDateString: string,
): BenchmarkSeries | null {
  const inWindow = closes
    .filter((c) => c.date >= fromDateString && c.date <= endDateString)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  if (inWindow.length === 0) return null;

  return {
    ticker: BENCHMARK_TICKER,
    trailingDays: BENCHMARK_SERIES_TRAILING_DAYS,
    closes: inWindow.map((c) => ({ date: c.date, close: c.close })),
  };
}

// computeWindowOptimization's own binary-search slicing (issue #11 code
// review finding) -- see sortedHistory's own doc comment for the full
// reasoning; these two are its plain array-index helpers.

/**
 * The first index in a date-ascending-sorted DailyClose[] whose `date` is
 * >= `startDateString` (i.e. `series.length` if every entry is before
 * it). Assumes `series` is already sorted ascending by date -- see
 * sortedHistory, which is what guarantees that here.
 */
function lowerBoundByDate(series: readonly DailyClose[], startDateString: string): number {
  let lo = 0;
  let hi = series.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (series[mid]!.date < startDateString) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

/**
 * The exclusive upper bound (first index whose `date` is > `endDateString`,
 * i.e. `series.length` if every entry qualifies) in a date-ascending-
 * sorted DailyClose[] -- the `<=` counterpart to lowerBoundByDate above.
 */
function upperBoundByDate(series: readonly DailyClose[], endDateString: string): number {
  let lo = 0;
  let hi = series.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (series[mid]!.date <= endDateString) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

// computeWindowOptimization is called once per preset window range (2x,
// buildWindowResults) and once per custom anchor (up to a few thousand
// at the day-granularity anchor scale issue #75 introduced, well past
// the original month scheme's 252) against the *exact same* `history`
// Map reference (buildCustomWindowResults, issue #11's custom anchors --
// see runPipeline, which builds windowFetch.history once and
// passes it to both callers unmodified). A WeakMap keyed by that Map's
// own object identity means the one-time cost of sorting every ticker's
// series is paid at most once per pipeline run, however many times
// computeWindowOptimization runs against it -- and a WeakMap (not a
// plain Map) so this never holds a history Map alive past whatever the
// caller itself keeps referenced.
const sortedHistoryCache = new WeakMap<Map<string, DailyClose[]>, Map<string, DailyClose[]>>();

/**
 * Returns `history` with every ticker's DailyClose[] sorted ascending by
 * date, cached by `history`'s own object identity (see
 * sortedHistoryCache above) so the sort only ever runs once per distinct
 * history Map.
 *
 * **Why sort explicitly rather than trust the fetch client's own return
 * order (issue #11 code review finding)**: computeWindowOptimization
 * used to slice each ticker's window via a plain `Array.prototype.filter`
 * scan -- correct regardless of array order, but O(days) per call, which
 * buildCustomWindowResults pays once per anchor per ticker per run (up to
 * a few thousand anchors at issue #75's day granularity). Replacing that
 * with a binary search (lowerBoundByDate/upperBoundByDate
 * above) cuts each call to O(log days), but a binary search is only
 * correct over a genuinely sorted array -- and this codebase deliberately
 * does NOT treat fetchDailyCloses's return order as a trusted contract
 * elsewhere (computeBenchmark's own explicit min/max scan, findMaxDate
 * above; see apps/pipeline/CLAUDE.md's own note that Yahoo's order is
 * "date-ascending in practice," not documented). Sorting once here (an
 * O(tickers x days log days) cost paid at most once per run, not per
 * call) guarantees the property lowerBoundByDate/upperBoundByDate need,
 * rather than assuming it.
 */
function sortedHistory(history: Map<string, DailyClose[]>): Map<string, DailyClose[]> {
  const cached = sortedHistoryCache.get(history);
  if (cached) return cached;
  const sorted = new Map<string, DailyClose[]>();
  for (const [ticker, series] of history) {
    sorted.set(
      ticker,
      [...series].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)),
    );
  }
  sortedHistoryCache.set(history, sorted);
  return sorted;
}

/**
 * The windowed-slice + optimizeAllVariants computation shared by every
 * whole-window result -- both the 5Y/MAX preset ranges (buildWindowResults)
 * and every custom start-date anchor (buildCustomWindowResults, issue
 * #11). Factored out so the two call sites can't drift on how a window's
 * long-only/long+short, best/worst-case trade sequences are derived from
 * the shared, already-fetched history -- there is exactly one place this
 * slicing + DP call happens for the whole-window model.
 *
 * **Uses optimizeAllVariants, not optimizeBothDirections (issue #13/#11
 * integration)**: issue #11 originally wired this to the long-only-only
 * optimizeBothDirections (issue #31's best/worst sharing), since it
 * predates issue #13's short-selling mode; issue #13 itself only reached
 * buildWindowResults directly (bypassing this shared helper, which didn't
 * exist yet on that branch). Merging the two features means every
 * whole-window result -- preset range or custom anchor -- gets the same
 * long+short `longShort` sibling, computed off the same one shared
 * OptimizerState per window (see optimizeAllVariants' own doc comment for
 * why running all 4 direction x instrument-set combinations together is
 * cheaper than four separate calls).
 */
function computeWindowOptimization(
  history: Map<string, DailyClose[]>,
  startDateString: string | null,
  endDateString: string,
  startingCapital: number,
  maxTrades: number,
): {
  windowed: Map<string, DailyClose[]>;
  longOnly: { best: OptimizationResult; worst: OptimizationResult };
  longShort: { best: OptimizationResult; worst: OptimizationResult };
} {
  const sorted = sortedHistory(history);
  const windowed = new Map<string, DailyClose[]>();
  for (const [ticker, series] of sorted) {
    const startIndex = startDateString ? lowerBoundByDate(series, startDateString) : 0;
    const endIndex = upperBoundByDate(series, endDateString);
    if (endIndex > startIndex) windowed.set(ticker, series.slice(startIndex, endIndex));
  }

  // Same windowed history, same startingCapital/maxTrades for all 4
  // direction x instrument-set combinations, so optimizeAllVariants
  // builds this window's calendar/ticker-sort once and reuses it for all
  // 4 runs instead of four separate optimizeTrades/optimizeWorstTrades-
  // style calls.
  const { longOnly, longShort } = optimizeAllVariants(windowed, { startingCapital, maxTrades });
  return { windowed, longOnly, longShort };
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
  /** The trailing SPY daily-close series (issue #126), computed once per *run* rather than per range -- see computeBenchmarkSeries for why it's range-independent. Null when the (non-fatal) SPY fetch produced nothing usable. */
  benchmarkSeries: BenchmarkSeries | null;
}

/** buildWindowResults' own return shape (code review follow-up to issue #13) -- see its own doc comment for why a per-range compute failure needs a side channel rather than either propagating (aborting every other range's already-computable result) or being silently swallowed. */
interface BuildWindowResultsOutcome {
  results: WindowResult[];
  /** One entry per range whose own optimizeAllVariants call threw, formatted `"RANGE: <error message>"` -- empty in the overwhelmingly common case. */
  failures: string[];
}

/**
 * Builds every window-path range's result, containing a per-range
 * compute failure to just that range (code review follow-up to issue
 * #13) rather than letting it propagate out of the whole `.map()` and
 * abort every other range's already-computable result too. This matters
 * concretely for this issue specifically: a short's reciprocal-price
 * payoff (P[open]/P[close]) is unbounded above as the covering price
 * approaches zero (see optimizer.ts's own header comment), so a real
 * S&P 500 constituent's price collapsing toward near-zero at some point
 * within a range's window (plausible over 5Y/MAX, though not yet
 * observed in practice) can overflow `endingBalance` past
 * Number.MAX_VALUE and trip optimizeAllVariants' own finite-endingBalance
 * guard (OptimizerInputError) -- which, before this fix, would have
 * thrown synchronously out of this `.map()` and taken down 5Y *and* MAX
 * in one go, instead of just the one affected range. (Issue #11's
 * custom-anchor windows are computed by a sibling function,
 * buildCustomWindowResults, with its own identical per-anchor try/catch
 * -- see CustomWindowResultsBuild.failures' own doc comment -- rather
 * than sharing this one, since a custom anchor's own failure shouldn't
 * take down a preset range's already-computable result or vice versa.)
 *
 * A range that fails this way is dropped from `results` -- exactly as if
 * its own fetch had failed -- but, unlike a granularity override's
 * failure (see "Granularity overrides" in this file's own module header,
 * and mergeDaysByGranularity's own doc comment), this is NOT treated as
 * non-fatal: `failures` is folded by runPipeline into the same
 * aggregated "at least one path or write failed" throw that issue #47's
 * write-time validation failures already use (see the top of this file's
 * own "Write-time result self-validation" note) -- a range that
 * genuinely couldn't be computed at all means that range is either
 * missing from this run's output or, on a later run, silently stuck
 * serving whatever it last had, exactly the "silently stale forever"
 * failure mode this system's must-fail-the-run alerting exists to catch
 * (see "Two independent paths" above) -- a routine per-ticker skip is
 * not.
 */
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
  benchmarkSeries,
}: BuildWindowResultsOptions): BuildWindowResultsOutcome {
  const results: WindowResult[] = [];
  const failures: string[] = [];

  for (const range of WINDOW_RANGES) {
    try {
      const startDate = presetRangeStartDate(range, asOf);
      const startDateString = startDate ? toDateString(startDate) : null;

      // Same windowed history, same startingCapital/maxTrades for all 4
      // direction x instrument-set combinations, so computeWindowOptimization
      // (via optimizeAllVariants) builds this range's calendar/ticker-sort
      // once and reuses it for all 4 runs instead of separate calls
      // (issue #13 extends issue #31's original best/worst sharing to
      // also cover long-only vs. long+short) -- and, since this is the
      // same computeWindowOptimization every custom-range anchor below
      // also calls (issue #11/#13 integration), the two families of
      // whole-window results can't drift on how that's done.
      const { windowed, longOnly, longShort } = computeWindowOptimization(
        history,
        startDateString,
        endDateString,
        startingCapital,
        maxTrades,
      );

      results.push({
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
          worstCase: {
            endingBalance: longShort.worst.endingBalance,
            trades: longShort.worst.trades,
          },
        },
        universeSize: windowed.size,
        skippedTickers: [...skipped],
        benchmark: benchmarksByRange.get(range) ?? null,
        benchmarkSeries,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[pipeline] skipping ${range} (window path): ${message}`);
      failures.push(`${range}: ${message}`);
    }
  }

  return { results, failures };
}

interface BuildCustomWindowResultsOptions {
  /** Reuses the window path's own already-fetched history (issue #11) -- no separate fetch for this feature at all. */
  history: Map<string, DailyClose[]>;
  dataAsOf: string;
  endDateString: string;
  generatedAt: string;
  startingCapital: number;
  maxTrades: number;
  skipped: readonly string[];
  /** SPY's raw fetched closes (issue #12) -- computeBenchmark is called once per anchor here, mirroring buildWindowResults/buildIntradayResults's per-range calls, since a custom anchor's own start date isn't one of the 6 PRESET_RANGES benchmarksByRange is keyed by. */
  benchmarkCloses: readonly DailyClose[];
  /** The anchor points to compute a result for -- see RunPipelineOptions.computeCustomAnchors's own doc comment for why this is empty unless the caller opted in. */
  anchors: readonly AnchorDate[];
}

/**
 * buildCustomWindowResults's return value: the actual computed results,
 * plus a count of how many requested anchors were validly skipped
 * (duplicate, malformed, or future-dated -- see the loop below) rather
 * than genuinely failing. runPipeline's own `expectedResultCount` (the
 * denominator in its aggregated-failure message) subtracts this count so
 * the "wrote N of M" ratio doesn't overstate the real gap for a future
 * caller whose anchor list isn't as clean as customRangeAnchors's own
 * (which never produces a duplicate/malformed/future-dated entry today).
 */
interface CustomWindowResultsBuild {
  results: CustomWindowResult[];
  /** Requested anchors skipped for a legitimate reason (not a failure) -- see the loop below for the three cases. */
  validlySkippedCount: number;
  /**
   * One entry per anchor whose own computeWindowOptimization call threw
   * (issue #13/#11 integration, mirroring BuildWindowResultsOutcome.failures'
   * own reasoning above) -- now that this function calls the same
   * optimizeAllVariants-backed computeWindowOptimization buildWindowResults
   * does, a custom anchor's window is exposed to the exact same short-
   * payoff-overflow risk a preset range's window is (see that doc comment
   * for the mechanism), and with up to a few thousand anchors computed
   * per run (issue #75's day granularity), containing a failure to just
   * the one affected anchor -- rather than
   * letting it propagate out of this whole loop and abort every other
   * already-computable anchor too -- matters even more here than it does
   * for the 2 window ranges. Folded by runPipeline into the same
   * aggregated `computeFailures` list buildWindowResults'/
   * buildIntradayResults' own failures already feed, so a custom anchor's
   * compute failure gets the identical "must still fail the run" alerting
   * treatment.
   */
  failures: string[];
}

/**
 * Computes one CustomWindowResult per requested anchor (issue #11's
 * coarsened design, day-granularity anchors since issue #75) --
 * structurally the same per-window computation as buildWindowResults
 * above (same computeWindowOptimization call, same DailyClose history,
 * same long-only + long+short variants via issue #13's
 * optimizeAllVariants), just keyed by AnchorDate instead of PresetRange
 * and with no "MAX-style unbounded start" case (every anchor's start is
 * always a real, bounded trading day -- see custom-range-anchors.ts).
 *
 * **Issue #75 simplified the per-anchor startDate derivation**: the old
 * month scheme's anchor (`YYYY-MM`) needed converting to a real date (the
 * 1st of that month) via `anchorMonthToDate` before it could be used as
 * a `startDateString`. A day-granularity anchor (`YYYY-MM-DD`) *is*
 * already the exact `startDateString` this function needs -- no
 * Date-and-back round trip required. `anchorDateToDate` is still called,
 * purely as a defensive well-formedness check (see the malformed-anchor
 * skip branch below), not to derive a different string from its result.
 */
function buildCustomWindowResults({
  history,
  dataAsOf,
  endDateString,
  generatedAt,
  startingCapital,
  maxTrades,
  skipped,
  benchmarkCloses,
  anchors,
}: BuildCustomWindowResultsOptions): CustomWindowResultsBuild {
  const results: CustomWindowResult[] = [];
  let validlySkippedCount = 0;
  const failures: string[] = [];
  // Defensive de-dup guard (code review finding, issue #11): customResultKey
  // is a pure function of anchorDate alone, so two anchors list entries
  // sharing the same anchorDate would otherwise silently collide on the
  // same S3 key with no error surfaced -- not reachable via the one real
  // caller today (customRangeAnchors, packages/core, which never
  // produces a duplicate -- see that function's own "has no duplicates"
  // test), but nothing stops a future/test caller from passing a
  // caller-supplied `anchors` list that does.
  const seenAnchors = new Set<AnchorDate>();

  for (const anchor of anchors) {
    if (seenAnchors.has(anchor)) {
      console.warn(
        `[pipeline] skipping duplicate custom-range anchor "${anchor}" (already computed a result for it this run)`,
      );
      validlySkippedCount++;
      continue;
    }
    seenAnchors.add(anchor);

    if (!anchorDateToDate(anchor)) {
      // Defensive only -- customRangeAnchors (packages/core) never
      // produces a malformed anchor itself, but a caller could in
      // principle pass an arbitrary list (e.g. a test). Skip rather than
      // crash the whole nightly run over one bad string.
      console.warn(`[pipeline] skipping malformed custom-range anchor "${anchor}"`);
      validlySkippedCount++;
      continue;
    }
    // The anchor string itself IS the startDateString (see this
    // function's own doc comment) -- no Date-and-back conversion needed
    // at day granularity, unlike the old month scheme.
    const startDateString = anchor;
    // Defensive only, not expected in practice: customRangeAnchors's
    // newest anchor is always "today" (or the most recent real trading
    // day at/before it), which can never be later than endDateString --
    // but a caller-supplied anchor list (tests, or a future asOf/anchor-
    // list mismatch) could in principle include one. A future-dated
    // anchor has literally nothing to compute (there's no data past
    // endDateString), so skip it rather than writing a degenerate
    // always-empty CustomWindowResult.
    if (startDateString > endDateString) {
      console.warn(
        `[pipeline] skipping future-dated custom-range anchor "${anchor}" (starts ${startDateString}, after endDate ${endDateString})`,
      );
      validlySkippedCount++;
      continue;
    }

    // Contained per-anchor (issue #13/#11 integration) -- see
    // CustomWindowResultsBuild.failures' own doc comment for why this
    // needs the same try/catch buildWindowResults already has, not a
    // bare loop body that lets one anchor's overflow take down every
    // other already-computable anchor too.
    try {
      const { windowed, longOnly, longShort } = computeWindowOptimization(
        history,
        startDateString,
        endDateString,
        startingCapital,
        maxTrades,
      );

      results.push({
        schemaVersion: RESULTS_SCHEMA_VERSION,
        model: "custom-window",
        anchorDate: anchor,
        generatedAt,
        dataAsOf,
        startDate: startDateString,
        endDate: endDateString,
        maxTrades,
        startingCapital,
        endingBalance: longOnly.best.endingBalance,
        trades: longOnly.best.trades,
        worstCase: {
          endingBalance: longOnly.worst.endingBalance,
          trades: longOnly.worst.trades,
        },
        longShort: {
          endingBalance: longShort.best.endingBalance,
          trades: longShort.best.trades,
          worstCase: {
            endingBalance: longShort.worst.endingBalance,
            trades: longShort.worst.trades,
          },
        },
        universeSize: windowed.size,
        skippedTickers: [...skipped],
        benchmark: computeBenchmark(
          benchmarkCloses,
          startDateString,
          endDateString,
          startingCapital,
        ),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[pipeline] skipping custom-range anchor "${anchor}": ${message}`);
      failures.push(`custom:${anchor}: ${message}`);
    }
  }

  return { results, validlySkippedCount, failures };
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
  /** Every range this override's fetch serves (issue #60: 1W reuses 1M's 1-minute fetch, so this is a set, not a single range). */
  ranges: readonly PresetRange[];
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
      ranges: ["3M"],
      label: "5-minute",
      barIntervalMinutes: 5,
      from: daysBeforeUtc(asOf, FIVE_MINUTE_LOOKBACK_DAYS),
      fetchBars: options.fetchFiveMinuteBars,
    },
    {
      // 1W reuses this exact fetch/solve/merge output wholesale (issue
      // #60) -- 1W's own 7-day window sits comfortably inside this
      // override's ~29-day lookback, so no second fetch spec is needed;
      // see packages/core/CLAUDE.md's "1-week (1W) preset range" section.
      ranges: ["1M", "1W"],
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
  /** The trailing SPY daily-close series (issue #126), computed once per *run* rather than per range -- see computeBenchmarkSeries for why it's range-independent. Null when the (non-fatal) SPY fetch produced nothing usable. */
  benchmarkSeries: BenchmarkSeries | null;
}

/** buildIntradayResults' own return shape (code review follow-up to issue #13) -- mirrors BuildWindowResultsOutcome's own "results plus a side channel of failure strings" shape. */
interface BuildIntradayResultsOutcome {
  results: IntradayResult[];
  /**
   * One entry per day that failed to *solve* at all, formatted
   * `"YYYY-MM-DD: <error message>"` for the base 60-minute pass or
   * `"<label> override (<range>): YYYY-MM-DD: <error message>"` for a
   * granularity override's own pass (see optimizeIntradayDays' own
   * OptimizeIntradayResult.skippedDays doc comment for where each
   * message string comes from). **Both are included here, and both are
   * fatal** -- a third code-review round on issue #13's PR caught that an
   * earlier version of this file deliberately excluded override-day solve
   * failures, reasoning (by analogy to an override *fetch* failure) that
   * mergeDaysByGranularity's fallback to the base 60-minute day makes an
   * override-only day failure "graceful" the same way a missing override
   * fetch is. That analogy doesn't actually hold: a fetch failure means
   * the finer-grained data was never available in the first place (a
   * data-availability gap, genuinely nothing to alert on); a solve
   * failure means the data *was* fetched successfully and something
   * broke while computing over it (a correctness bug, e.g. a future
   * change re-triggering the reciprocal-price overflow guard, or a
   * genuinely new defect) -- exactly the kind of problem this system's
   * only alerting mechanism (see the top of this file) exists to catch,
   * regardless of whether mergeDaysByGranularity happens to paper over
   * the missing day for that one range. The per-day try/catch inside
   * optimizeIntradayDays still *contains* the failure (one bad day can't
   * crash the whole run before other days/ranges get a chance to write);
   * this field is what keeps containment from also meaning invisibility.
   * A per-ticker *fetch* failure on an override (a ticker's finer data
   * just isn't available) stays non-fatal, unaffected by this -- see
   * `overrideStatusLines` in runPipeline, which reports that case
   * separately and still doesn't fold it in here.
   *
   * A third source feeds this same list (code review follow-up, second
   * round): `mergeDaysByGranularity`'s own merge-fallback reports (see
   * `MergeDaysByGranularityOutcome.failures`' own doc comment), formatted
   * the same `"<label> override (<range>): <message>"` way as an override
   * solve failure above. Expected to be empty on every real run (the
   * cross-check it guards is proven safe by construction, see
   * `mergeDayVariants`), but folded in here rather than only
   * `console.error`-ed, for the identical "contained but not silent"
   * reason as everything else in this field.
   */
  failures: string[];
}

/**
 * Chains `startingCapital`/`endingBalance` across a single range's
 * already-finalized `days[]` array (issue #84), independently per track
 * (long-only best, worst, long+short best, long+short worst -- see
 * IntradayDayResult/IntradayWorstCaseResult/IntradayLongShortResult):
 * day 0 starts every track at `rootStartingCapital` (the range's own
 * configured constant); day N (N > 0) starts each track at that same
 * track's own day-N-1 `endingBalance`, never another track's.
 *
 * **Must run strictly after the per-range slice and the granularity-
 * override merge, never before or inside `optimizeIntradayDays`
 * itself** -- see docs/plans/issue-84-plan.md section 6.2 for the full
 * argument, restated briefly here: `optimizeIntradayDays` is called
 * once over the full fetched history and its output is shared/sliced
 * across 1W/1M/3M/1Y, so it has no idea which range(s) will later slice
 * it and can't chain from "the right" first day; and
 * `mergeDaysByGranularity`/`mergeDayVariants` compare two sources'
 * `endingBalance`s under the assumption both were solved with the
 * *same* flat `startingCapital` (see that function's own doc comment)
 * -- chaining before that merge would make the two sources' capitals
 * diverge and silently turn that comparison into an apples-to-oranges
 * one. This function is called only after both have already happened,
 * as a pure post-processing pass over one range's own already-decided
 * `days` array.
 *
 * Each day's own per-track *ratio* (`endingBalance / startingCapital`,
 * ANY track) is preserved from the input `days` (unchained, flat-
 * `startingCapital`) before being reapplied against the running chained
 * capital -- this is what keeps a day's own optimal trade sequence
 * (`trades`) valid: `trades` themselves hold literal ticker prices, not
 * dollar allocations, so they need no rescaling at all (see
 * `Trade`/`IntradayTrade`'s own fields).
 *
 * Every existing per-day cross-check invariant
 * (`worstCase.endingBalance <= endingBalance`,
 * `longShort.endingBalance >= endingBalance`,
 * `longShort.worstCase.endingBalance <= worstCase.endingBalance`)
 * survives this transform by induction -- see the plan's section 6.3 for
 * the full proof (all four tracks start from the identical root capital
 * on day 0, and each day's own ratio ordering is capital-invariant, so
 * multiplying same-signed ordered quantities preserves the ordering at
 * every day).
 *
 * **Float precision (issue #84 code review finding)**: the general case
 * below computes `runningCapital * (day.endingBalance /
 * day.startingCapital)` -- a divide-then-multiply round trip that isn't
 * guaranteed to reproduce `day.endingBalance` bit-for-bit even when
 * `runningCapital === day.startingCapital` (floating-point division
 * isn't always exactly invertible by the following multiplication).
 * `chainedEndingBalance` below special-cases exactly that "no real
 * rescale needed" case -- most notably day 0, where every one of the
 * four tracks' `runningCapital` starts out *exactly* equal to the
 * unchained day's own `startingCapital` by construction -- and returns
 * `day.endingBalance` untouched instead of round-tripping it through
 * division. This removes the single highest-risk case for the proof
 * above (day 0, where two tracks tying exactly is most likely) at
 * essentially zero cost; a later day's rounding, if it ever meaningfully
 * matters, is still caught defensively by `results-schema.ts`'s own
 * write-time cross-checks (`validatePrecomputedResult` throws and fails
 * the run rather than shipping a violated invariant silently) -- the
 * same "provably safe on paper, still worth containing" posture this
 * file's own `mergeDayVariants` already established. Live-verified (see
 * apps/pipeline/CLAUDE.md's own "Chained per-day starting capital"
 * section): 0 cross-check violations across 338 real chained trading
 * days.
 */
function chainedEndingBalance(
  runningCapital: number,
  originalStartingCapital: number,
  originalEndingBalance: number,
): number {
  if (runningCapital === originalStartingCapital) return originalEndingBalance;
  return runningCapital * (originalEndingBalance / originalStartingCapital);
}

function chainStartingCapital(
  days: IntradayDayResult[],
  rootStartingCapital: number,
): IntradayDayResult[] {
  let longOnlyCapital = rootStartingCapital;
  let worstCapital = rootStartingCapital;
  let longShortCapital = rootStartingCapital;
  let longShortWorstCapital = rootStartingCapital;

  return days.map((day) => {
    const chained: IntradayDayResult = {
      ...day,
      startingCapital: longOnlyCapital,
      endingBalance: chainedEndingBalance(longOnlyCapital, day.startingCapital, day.endingBalance),
      worstCase: {
        ...day.worstCase,
        startingCapital: worstCapital,
        endingBalance: chainedEndingBalance(
          worstCapital,
          day.worstCase.startingCapital,
          day.worstCase.endingBalance,
        ),
      },
      longShort: {
        ...day.longShort,
        startingCapital: longShortCapital,
        endingBalance: chainedEndingBalance(
          longShortCapital,
          day.longShort.startingCapital,
          day.longShort.endingBalance,
        ),
        worstCase: {
          ...day.longShort.worstCase,
          startingCapital: longShortWorstCapital,
          endingBalance: chainedEndingBalance(
            longShortWorstCapital,
            day.longShort.worstCase.startingCapital,
            day.longShort.worstCase.endingBalance,
          ),
        },
      },
    };

    longOnlyCapital = chained.endingBalance;
    worstCapital = chained.worstCase.endingBalance;
    longShortCapital = chained.longShort.endingBalance;
    longShortWorstCapital = chained.longShort.worstCase.endingBalance;

    return chained;
  });
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
  benchmarkSeries,
}: BuildIntradayResultsOptions): BuildIntradayResultsOutcome {
  // Solve every trading day once, over the full fetched history (capped
  // only at endDateString, same "don't trust data past what was
  // requested" reasoning as findMaxDate above) -- a given day's own
  // optimizeIntradayDays result never depends on which range window it
  // happens to fall inside, since 1W/1M/3M/1Y range-slicing only ever drops
  // whole out-of-range days, never bars within an in-range one. Re-
  // running the DP separately per range (as an earlier version of this
  // function did) redundantly re-solved the same day up to 3 times,
  // since each range is a strict subset of the next.
  const cappedHistory = capHistoryToEndDate(history, endDateString);
  // skippedDays here are fatal -- see BuildIntradayResultsOutcome's own
  // doc comment: every intraday range depends on this base 60-minute
  // pass, so a day it can't solve is genuinely missing (or, on a later
  // run, silently stale) for every range covering it.
  const { days: sixtyMinuteDays, skippedDays: baseFailures } = optimizeIntradayDays(cappedHistory, {
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
  const overrideSolveFailures: string[] = [];
  for (const { spec, outcome } of overrides) {
    const cappedOverrideHistory = capHistoryToEndDate(outcome.history, endDateString);
    // This override's own skippedDays ARE folded into this function's
    // `failures` (a third code-review round's must-fix, see
    // BuildIntradayResultsOutcome's own doc comment for the full
    // reasoning) -- unlike an override *fetch* failure (a per-ticker
    // data-availability gap, genuinely non-fatal), a solve failure here
    // means real fetched data broke the optimizer, which is exactly what
    // this system's alerting exists to catch. optimizeIntradayDays' own
    // per-day try/catch still contains it (this override's other days,
    // and every other range/path, still compute and write normally) --
    // containment and fatality are independent axes here, not the same
    // thing.
    const { days: overrideDays, skippedDays: overrideSkippedDays } = optimizeIntradayDays(
      cappedOverrideHistory,
      {
        startingCapital,
        maxTradesPerDay,
        barIntervalMinutes: spec.barIntervalMinutes,
      },
    );
    for (const entry of overrideSkippedDays) {
      overrideSolveFailures.push(`${spec.label} override (${spec.ranges.join("/")}): ${entry}`);
    }
    // This override's actual per-day results: whichever of the two
    // granularities produced the better outcome for each day (see
    // mergeDaysByGranularity -- NOT an unconditional "finer granularity
    // always wins"). If overrideDays is empty (fetch failure, solve
    // failure, or no data), this is just sixtyMinuteDays unchanged -- the
    // graceful-degradation path for *this range's stored output*, even
    // though a solve failure specifically still fails the run above via
    // overrideSolveFailures. mergeFailures (expected empty on every real
    // run -- see mergeDayVariants' own doc comment) folds in the same way
    // overrideSkippedDays does above, for the identical "contained but
    // not silent" reason.
    const { days: mergedDays, failures: mergeFailures } = mergeDaysByGranularity(
      sixtyMinuteDays,
      overrideDays,
    );
    for (const entry of mergeFailures) {
      overrideSolveFailures.push(`${spec.label} override (${spec.ranges.join("/")}): ${entry}`);
    }
    const override: GranularityOverride = {
      days: mergedDays,
      extraHistories: [cappedOverrideHistory],
      extraSkipped: outcome.skipped,
      extraDataAsOf: outcome.dataAsOf,
    };
    for (const range of spec.ranges) {
      granularityOverrides.set(range, override);
    }
  }

  const results: IntradayResult[] = INTRADAY_RANGES.map((range) => {
    // Never null: presetRangeStartDate only returns null for "MAX",
    // which isn't one of INTRADAY_RANGES.
    const startDate = presetRangeStartDate(range, asOf)!;
    const startDateString = toDateString(startDate);

    const override = granularityOverrides.get(range);
    const sourceDays = override?.days ?? sixtyMinuteDays;
    const slicedDays = sourceDays.filter(
      (day) => day.date >= startDateString && day.date <= endDateString,
    );
    // Chain each of this range's own already-sliced, already-merged days'
    // starting/ending balances (issue #84) -- see chainStartingCapital's
    // own doc comment for why this must run exactly here (after slicing,
    // after the granularity-override merge), independently per range
    // (each range's own chain starts fresh at rootStartingCapital on its
    // own first day, not wherever the shared underlying day array's
    // global first day happens to be).
    const days = chainStartingCapital(slicedDays, startingCapital);

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
      benchmarkSeries,
    };
  });

  return { results, failures: [...baseFailures, ...overrideSolveFailures] };
}

export async function runPipeline(options: RunPipelineOptions): Promise<PipelineRunSummary> {
  const asOf = options.asOf ?? new Date();
  const startingCapital = options.startingCapital ?? DEFAULT_STARTING_CAPITAL;
  const maxTrades = options.maxTrades ?? DEFAULT_MAX_TRADES;
  const maxTradesPerDay = options.maxTradesPerDay ?? DEFAULT_MAX_TRADES_PER_DAY;
  const earliestDate = options.earliestDate ?? DEFAULT_EARLIEST_DATE;
  const fetchConcurrency = options.fetchConcurrency ?? DEFAULT_FETCH_CONCURRENCY;
  const writeConcurrency = options.writeConcurrency ?? DEFAULT_WRITE_CONCURRENCY;
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
  // handling. All 6 PRESET_RANGES get an entry, not just the two window
  // ranges: the benchmark is a single well-defined whole-window figure
  // regardless of which trading model (window vs. intraday-daily) a
  // given range uses.
  const benchmarksByRange = new Map<PresetRange, BenchmarkResult | null>(
    PRESET_RANGES.map((range) => {
      const rangeStart = presetRangeStartDate(range, asOf);
      const rangeStartString = rangeStart ? toDateString(rangeStart) : null;
      return [
        range,
        computeBenchmark(benchmarkFetch.closes, rangeStartString, endDateString, startingCapital),
      ];
    }),
  );

  // The trailing SPY daily-close series (issue #126) -- computed once
  // per run from the same already-fetched `closes` array
  // benchmarksByRange above reads, then stamped identically onto all 6
  // preset results (it's deliberately range-independent, unlike the
  // per-range benchmark summary -- see computeBenchmarkSeries and
  // BenchmarkSeries' own doc comments). Null when the non-fatal SPY
  // fetch failed or covered no days in the window, exactly like every
  // range's `benchmark` already is.
  const benchmarkSeries = computeBenchmarkSeries(
    benchmarkFetch.closes,
    toDateString(daysBeforeUtc(asOf, BENCHMARK_SERIES_TRAILING_DAYS)),
    endDateString,
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

  // Per-range (window) / per-day (intraday) compute failures -- e.g. a
  // short's reciprocal-price payoff overflowing OptimizerInputError's
  // finite-endingBalance guard for one range/day's data -- are contained
  // by buildWindowResults/buildIntradayResults themselves (code review
  // follow-up to issue #13) rather than thrown synchronously here, so
  // one outlier range/day can't take down every other range's/day's
  // already-computable result. `computeFailures` collects what they
  // report and is folded into the same "at least one path or write
  // failed" aggregated throw below as failedWrites already is -- see
  // BuildWindowResultsOutcome/BuildIntradayResultsOutcome's own doc
  // comments for why these specifically need to stay fatal (unlike a
  // granularity override's own non-fatal failures).
  const windowBuild = windowFetch.failureReason
    ? { results: [], failures: [] }
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
        benchmarkSeries,
      });
  const windowResults = windowBuild.results;

  const intradayBuild = intradayFetch.failureReason
    ? { results: [], failures: [] }
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
        benchmarkSeries,
      });
  const intradayResults = intradayBuild.results;

  // Custom start-date anchors (issue #11's coarsened design, real
  // trading-day anchors since issue #75) -- purely derived compute over
  // the window path's *already-fetched* history, no separate fetch, so
  // this is gated behind windowFetch.failureReason the exact same way
  // windowResults itself is above: if the window path has no usable
  // history, there's nothing to slice (or derive a trading-day calendar
  // from) for any anchor either. Empty unless the caller opts in via
  // `computeCustomAnchors` (see RunPipelineOptions' own doc comment) --
  // src/run.ts is the one real caller that does, for the actual nightly
  // run.
  //
  // **Computed here, not passed in from outside (issue #75's real,
  // deliberate shift -- see RunPipelineOptions.computeCustomAnchors's own
  // doc comment)**: `customRangeAnchors` (packages/core) needs a real
  // trading-day calendar, which only exists once the fetch over
  // `windowFetch.history` has run -- data this function only has *after*
  // its own fetch above completes, unlike the old month scheme's anchors
  // (a pure function of calendar time alone, computable before ever
  // calling runPipeline). Uses `collectTradingDates`, not
  // `buildCalendar(...).dates` (code review finding, fixed) --
  // `buildCalendar` also reindexes every ticker's full price series into
  // a `pricesByTicker` map this call never reads, real avoidable compute
  // on every nightly run given this whole issue's own live-benchmarked
  // finding that pipeline compute time is the binding constraint (see
  // `collectTradingDates`'s own doc comment, packages/core/src/optimizer.ts).
  const customAnchors: readonly AnchorDate[] =
    options.computeCustomAnchors && !windowFetch.failureReason
      ? customRangeAnchors(collectTradingDates(windowFetch.history), asOf)
      : [];

  const customBuild: CustomWindowResultsBuild = windowFetch.failureReason
    ? { results: [], validlySkippedCount: 0, failures: [] }
    : buildCustomWindowResults({
        history: windowFetch.history,
        dataAsOf: windowFetch.dataAsOf!,
        endDateString,
        generatedAt,
        startingCapital,
        maxTrades,
        skipped: windowFetch.skipped,
        benchmarkCloses: benchmarkFetch.closes,
        anchors: customAnchors,
      });
  const customResults = customBuild.results;
  // Folded into the same aggregated compute-failures list as the window/
  // intraday paths' own (code review follow-up to issue #13, extended at
  // merge time to also cover issue #11's custom anchors -- see
  // CustomWindowResultsBuild.failures' own doc comment for why a custom
  // anchor's compute failure needs the identical per-anchor containment
  // buildWindowResults already has, not just for the 2 preset window
  // ranges).
  const computeFailures = [
    ...windowBuild.failures,
    ...intradayBuild.failures,
    ...customBuild.failures,
  ];

  // The published anchors manifest (issue #75) is computed further
  // below, once the actual per-anchor S3 write outcomes are known --
  // NOT here from customBuild.results (compute success alone) -- see
  // the manifest's own comment near the write loop for why that
  // distinction is load-bearing, not cosmetic.

  if (windowResults.length === 0 && intradayResults.length === 0) {
    // Refuse to overwrite S3's existing (presumably good) results with
    // empty-but-schema-valid output -- better to fail the run loudly and
    // keep yesterday's data than to silently erase it. Generalizes the
    // original single-path guarantee to "both paths came up empty," not
    // just one.
    throw new Error(
      `pipeline aborted: neither the daily-close nor intraday fetch produced usable data -- refusing to overwrite existing results with empty output. ` +
        `Window (5Y/MAX) path: ${windowFetch.failureReason}. Intraday (1W/1M/3M/1Y) path: ${intradayFetch.failureReason}.`,
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
  // instead of shipping silently to S3. Each job's own validate-then-
  // putObject callback must stay `async` -- a synchronous throw from
  // validatePrecomputedResult inside a non-async callback would
  // propagate out of mapWithConcurrency's own `worker(...)` call
  // (outside its try/catch) and abort that worker's whole loop instead
  // of becoming this one job's own recorded rejection; wrapping in
  // `async` turns that throw into an ordinary rejected promise `await`
  // catches, so every other job's write still gets a chance to start --
  // see apps/pipeline/CLAUDE.md's "write whatever succeeded, then still
  // throw" guarantee, which this must not break.
  //
  // mapWithConcurrency (Promise.allSettled semantics under a bounded
  // worker pool), not a bare Promise.all: validation is synchronous and
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
  // mapWithConcurrency waits for every write to finish, succeed or fail,
  // before this function decides anything -- see failedWrites below for
  // how a rejection is turned into part of the aggregated error instead.
  //
  // Bounded by writeConcurrency (issue #11 code review finding) rather
  // than firing all writeJobs.length (up to 258: 6 preset + up to 252
  // custom anchors) putObject calls at once -- this had never been
  // tested against real S3 (this feature's own live verification
  // explicitly excluded S3 writes, see packages/core/CLAUDE.md's "Custom
  // date-range anchors" section), and every other network-bound loop in
  // this file (every fetch pool) already bounds its own concurrency the
  // same way.
  //
  // Custom-range anchor results (issue #11) are folded into this exact
  // same write loop/aggregation rather than getting a separate lifecycle
  // -- a WriteJob abstracts over "which validator, which key" so both
  // families share one mapWithConcurrency call and one failedWrites
  // list. This is deliberate, not incidental: an anchor result is
  // derived from the *same already-required-to-succeed*
  // windowFetch.history as the 5Y/MAX ranges, so there's no reason to
  // hold it to a looser standard the way a granularity override's own
  // best-effort failure is (see that section's own comment above) -- a
  // write failure for a custom anchor gets exactly the same "fail the
  // whole run, this is the only alerting mechanism" treatment as a
  // preset range's write failure.
  interface WriteJob {
    key: string;
    label: string;
    validate: () => void;
    body: string;
  }
  const presetWriteJobs: WriteJob[] = results.map((result) => ({
    key: resultKey(result.range),
    label: result.range,
    validate: () => validatePrecomputedResult(result),
    body: JSON.stringify(result, null, 2),
  }));
  const customWriteJobs: WriteJob[] = customResults.map((result) => ({
    key: customResultKey(result.anchorDate),
    label: `custom:${result.anchorDate}`,
    validate: () => validateCustomWindowResult(result),
    body: JSON.stringify(result, null, 2),
  }));
  const primaryWriteJobs = [...presetWriteJobs, ...customWriteJobs];

  const primaryWriteOutcomes = await mapWithConcurrency(
    primaryWriteJobs,
    writeConcurrency,
    async (job) => {
      job.validate();
      await options.store.putObject(job.key, job.body);
      return job.label;
    },
  );

  // The published anchors manifest (issue #75) -- the picker-facing list
  // of which specific days apps/web's calendar UI may offer, published
  // as its own small S3 object (results-schema.ts's CustomAnchorsManifest,
  // read by apps/web's GET /api/custom-anchors) since day-granularity
  // anchors are no longer derivable client-side the way the old month
  // scheme's were (see custom-range-anchors.ts's own doc comment).
  //
  // **Built from the real primaryWriteOutcomes above, not from
  // customBuild.results / customResults alone (a real bug found in code
  // review, fixed)**: computing this from compute *success* rather than
  // write *success* meant a transient putObject failure on one anchor's
  // own result -- while every other write in the same batch, including
  // the manifest's own eventual write, succeeded -- would still have
  // published that anchor as selectable, even though nothing was ever
  // actually stored at its key. A user picking that date would 404 for
  // up to 24h, until the next nightly run overwrote the stale manifest.
  // customWriteJobs[i] and customResults[i] share the same index (both
  // built from one customResults.map(...) call), so
  // primaryWriteOutcomes[presetWriteJobs.length + i] is customResults[i]'s
  // own real write outcome -- correlated by that shared index, not
  // re-derived from anything else.
  //
  // Necessarily a *second*, later write phase (see manifestWriteOutcomes
  // below) rather than folded into primaryWriteJobs above: which anchors
  // succeeded can only be known once primaryWriteOutcomes has actually
  // settled, and the manifest's own content depends on that outcome --
  // so the manifest can't be written in the same batch as the writes it
  // needs to observe the result of.
  //
  // Only the anchors that actually got a *written* CustomWindowResult go
  // in the manifest -- an anchor buildCustomWindowResults validly
  // skipped (duplicate/malformed/future-dated, none reachable via the
  // one real caller today), whose own compute failed, or whose own
  // write failed has no stored result to serve, and publishing it as
  // "selectable" would just be a 404 waiting to happen. Sorted ascending
  // (oldest first) per CustomAnchorsManifest.anchors' own documented
  // contract -- the opposite of customRangeAnchors' own newest-first
  // convention, since a calendar UI wants to walk forward through
  // months. Skipped entirely (leaving any previously-published manifest
  // untouched, same "gracefully stale" posture as every preset range's
  // own written-if-succeeded behavior) when there's nothing to publish
  // -- an empty manifest would itself fail
  // validateCustomAnchorsManifest's own non-empty check below.
  const successfulCustomAnchorDates = customResults
    .filter((_, i) => primaryWriteOutcomes[presetWriteJobs.length + i]?.status === "fulfilled")
    .map((result) => result.anchorDate)
    .sort();
  const customAnchorsManifest: CustomAnchorsManifest | null =
    options.computeCustomAnchors && successfulCustomAnchorDates.length > 0
      ? { schemaVersion: RESULTS_SCHEMA_VERSION, anchors: successfulCustomAnchorDates }
      : null;

  // The manifest's own WriteJob, held to the exact same "must fail the
  // run" standard as every preset/custom-anchor write above (see the
  // comment above for why it's derived from the same already-required-
  // to-succeed window-path history, not a looser-standard granularity-
  // override-style write): a manifest write failure means apps/web's
  // picker either serves a stale anchor list or 404s its own fetch
  // entirely, which is exactly the "silently stale forever" failure
  // mode this system's alerting exists to catch. Run through its own
  // mapWithConcurrency call (trivially one job today, but kept
  // consistent with primaryWriteJobs' own bounded-concurrency shape
  // rather than a bare inline putObject) -- concatenated back into one
  // combined writeJobs/writeOutcomes pair below so every downstream
  // consumer (failedWrites, writtenCount) still sees one unified view,
  // unaware this was two sequential phases rather than one batch.
  const manifestWriteJobs: WriteJob[] = customAnchorsManifest
    ? [
        {
          key: CUSTOM_ANCHORS_MANIFEST_KEY,
          label: "custom-anchors-manifest",
          validate: () => validateCustomAnchorsManifest(customAnchorsManifest),
          body: JSON.stringify(customAnchorsManifest, null, 2),
        },
      ]
    : [];
  const manifestWriteOutcomes = await mapWithConcurrency(
    manifestWriteJobs,
    writeConcurrency,
    async (job) => {
      job.validate();
      await options.store.putObject(job.key, job.body);
      return job.label;
    },
  );

  const writeJobs = [...primaryWriteJobs, ...manifestWriteJobs];
  const writeOutcomes = [...primaryWriteOutcomes, ...manifestWriteOutcomes];

  // Every rejection, not just the first -- plain Promise.all (and a
  // naive "throw on the first rejected settlement" loop) would only
  // ever surface one job's problem even when multiple are independently
  // broken in the same run, hiding real information from whoever reads
  // the thrown error. Paired with the job's own label (rather than just
  // the bare error message) since a putObject failure -- unlike a
  // ResultValidationError, which already names its own range/anchor --
  // has no other way to say which one it was.
  const failedWrites = writeOutcomes
    .map((outcome, i) => ({ outcome, label: writeJobs[i]!.label }))
    .filter(
      (entry): entry is typeof entry & { outcome: PromiseRejectedResult } =>
        entry.outcome.status === "rejected",
    )
    .map(({ outcome, label }) => {
      const reason = outcome.reason;
      return `${label}: ${reason instanceof Error ? reason.message : String(reason)}`;
    });
  const writtenCount = writeOutcomes.filter((outcome) => outcome.status === "fulfilled").length;

  const skippedTickers = [
    ...new Set([
      ...windowFetch.skipped,
      ...intradayFetch.skipped,
      ...overrideInputs.flatMap(({ outcome }) => outcome.skipped),
    ]),
  ];

  if (
    windowFetch.failureReason ||
    intradayFetch.failureReason ||
    failedWrites.length > 0 ||
    computeFailures.length > 0
  ) {
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
    // not a separate throw for fetch-time vs. write-time problems. A
    // per-range/per-day *compute* failure (code review follow-up to
    // issue #13 -- see BuildWindowResultsOutcome/
    // BuildIntradayResultsOutcome's own doc comments) is folded in the
    // same way: it's contained so it doesn't take down every other
    // range's/day's already-computable result, but the range/day it did
    // take down is genuinely missing this run, which is exactly the
    // "silently stale forever" failure mode this alerting exists to
    // catch.
    //
    // Deliberately excludes every granularity override's failureReason
    // (issues #30/#29) -- i.e. that override's own *fetch* coming back
    // empty or aborting: this never leaves anything silently stale, it
    // just means that override's range falls back to already-shipped,
    // fully-correct 60-minute bars, the same as its pre-override
    // behavior, so a fetch failure alone doesn't need to meet this same
    // "must still fail the run" bar. Each override's fetch status is
    // still included in the message below purely for operational
    // visibility. This is NOT the same as an override *solve* failure
    // (optimizeIntradayDays throwing on data the override's fetch DID
    // successfully return) -- that case IS folded into computeFailures
    // above (a third code-review round's must-fix; see
    // BuildIntradayResultsOutcome's own doc comment for why "the data
    // just isn't available" and "the data broke the optimizer" need
    // different fatality, even though both degrade the same way in the
    // stored output via mergeDaysByGranularity's fallback).
    const overrideStatusLines = overrideInputs
      .map(
        ({ spec, outcome }) =>
          `${spec.label} path (${spec.ranges.join("/")} only, non-fatal): ${outcome.failureReason ?? "ok"}.`,
      )
      .join(" ");
    const benchmarkStatusLine = `Benchmark (${BENCHMARK_TICKER}, non-fatal): ${benchmarkFetch.error ?? "ok"}.`;
    const writeFailureLines =
      failedWrites.length > 0
        ? ` Write failures (${failedWrites.length} of ${writeJobs.length} computed result(s)):\n` +
          failedWrites.map((message) => `  - ${message}`).join("\n")
        : "";
    const computeFailureLines =
      computeFailures.length > 0
        ? ` Compute failures (${computeFailures.length} range(s)/day(s)/anchor(s) that could not be solved at all):\n` +
          computeFailures.map((message) => `  - ${message}`).join("\n")
        : "";
    // The denominator here is the *ideal* total for a fully-healthy run
    // (every preset range, plus every requested custom anchor) -- not
    // just writeJobs.length (how many results were actually built and
    // attempted), which would understate the gap whenever a whole path
    // failed before any of its results were even built (e.g. "wrote 2 of
    // 2" reads as a clean 100%, hiding that a failed path meant only 2
    // were ever attempted out of an expected 5). Preserves this
    // message's original "wrote N of 5 ranges" framing (pre-issue #11)
    // while generalizing to also count custom anchors.
    //
    // Subtracts customBuild.validlySkippedCount (a duplicate, malformed,
    // or future-dated anchor buildCustomWindowResults itself chose to
    // skip, not a failure) so this ratio doesn't overstate the real gap
    // for a future caller whose anchor list isn't as clean as
    // customRangeAnchors's own (which never produces one of these today
    // -- see that function's own tests). Zero for the one real production
    // caller in practice, so this is a no-op there. Adds 1 for the
    // manifest whenever it was actually attempted (issue #75) --
    // `customAnchorsManifest !== null`, not just `options.computeCustomAnchors`,
    // since the manifest is skipped entirely (no write attempted) when
    // there were zero custom-anchor results to publish -- see that
    // constant's own comment above.
    const expectedResultCount =
      PRESET_RANGES.length +
      customAnchors.length -
      customBuild.validlySkippedCount +
      (customAnchorsManifest ? 1 : 0);
    throw new Error(
      `pipeline: wrote ${writtenCount} of ${expectedResultCount} expected result(s) (${PRESET_RANGES.length} preset range(s), ${customAnchors.length} custom anchor(s) requested; ${writeJobs.length} actually computed), but at least one path or write failed -- ` +
        `failing this run so it doesn't silently succeed while that path goes stale. ` +
        `Window (5Y/MAX) path: ${windowFetch.failureReason ?? "ok"}. ` +
        `Intraday (1W/1M/3M/1Y) path: ${intradayFetch.failureReason ?? "ok"}. ` +
        `${overrideStatusLines} ` +
        `${benchmarkStatusLine} ` +
        `Skipped tickers: ${skippedTickers.length > 0 ? skippedTickers.join(", ") : "(none)"}.` +
        writeFailureLines +
        computeFailureLines,
    );
  }

  // Every write succeeded -- if any had failed, the block above would
  // already have thrown before reaching here.
  return { results, customResults, skippedTickers };
}
