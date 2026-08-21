// The nightly precompute job: fetches full daily-close history for the
// whole ticker universe once, then for each preset range (1M/3M/1Y/5Y/
// MAX) slices that history to the range's window and runs the optimizer,
// writing one result JSON per range.
//
// Idempotency: each run writes to a fixed key per range (results/{range}
// .json), overwriting the previous run's file rather than accumulating
// dated copies — re-running for the same day (or any day) just replaces
// the same objects with freshly computed content, no duplicate or
// conflicting state.

import {
  BlockedError,
  optimizeTrades,
  PRESET_RANGES,
  presetRangeStartDate,
  toDateString,
  UnexpectedResponseError,
  type DailyClose,
  type PresetRange,
  type Trade,
} from "@hadiknowntrades/core";

const SCHEMA_VERSION = 1;
const DEFAULT_STARTING_CAPITAL = 20;
const DEFAULT_MAX_TRADES = 3;
// Deliberately early enough to predate any current S&P 500 constituent's
// IPO — the Yahoo client naturally returns only what actually exists in
// range, so this just means "give me everything you have."
const DEFAULT_EARLIEST_DATE = new Date("1970-01-01T00:00:00Z");
const DEFAULT_FETCH_CONCURRENCY = 10;

export interface ResultStore {
  putObject(key: string, body: string): Promise<void>;
}

export interface PipelineResult {
  schemaVersion: number;
  range: PresetRange;
  generatedAt: string;
  /** The most recent trading date actually found in the fetched data — a fact about the data, which can lag the requested `endDate` (e.g. if the pipeline runs before the latest close is posted). */
  dataAsOf: string;
  startDate: string | null;
  /** The requested "as of" boundary for this run — see dataAsOf for what data was actually available. */
  endDate: string;
  startingCapital: number;
  endingBalance: number;
  trades: Trade[];
  universeSize: number;
  skippedTickers: string[];
}

export interface PipelineRunSummary {
  results: PipelineResult[];
  skippedTickers: string[];
}

export interface RunPipelineOptions {
  tickers: readonly string[];
  fetchDailyCloses: (symbol: string, from: Date, to: Date) => Promise<DailyClose[]>;
  store: ResultStore;
  /** Defaults to now. */
  asOf?: Date;
  startingCapital?: number;
  maxTrades?: number;
  earliestDate?: Date;
  fetchConcurrency?: number;
}

/**
 * Fetches full history (earliestDate..asOf) for every ticker, with
 * bounded concurrency. A ticker that fails with TickerNotFoundError or
 * TransientFetchError is skipped (logged, doesn't fail the run) — those
 * are per-ticker problems.
 *
 * BlockedError or UnexpectedResponseError abort the whole run: a block
 * means we shouldn't keep firing off hundreds more requests, and an
 * unexpected-response is documented (see yahoo-client.ts) as "likely
 * permanent regardless of symbol" — i.e. a systemic problem, not a
 * per-ticker one, so treating it as an ordinary skip would risk masking
 * a total data-fetch failure as a handful of unlucky tickers. Once any
 * worker hits one of these, a shared flag stops every worker from
 * starting a *new* fetch (an in-flight request already underway still
 * completes/rejects on its own — there's no cheap way to cancel it
 * without threading an AbortSignal through the fetch client — but no
 * further tickers get queued once the flag is set).
 */
async function fetchUniverseHistory(
  tickers: readonly string[],
  from: Date,
  to: Date,
  fetchDailyCloses: RunPipelineOptions["fetchDailyCloses"],
  concurrency: number,
): Promise<{ history: Map<string, DailyClose[]>; skipped: string[] }> {
  const history = new Map<string, DailyClose[]>();
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
        const series = await fetchDailyCloses(ticker, from, to);
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

  if (abortError) throw abortError;

  return { history, skipped };
}

/**
 * The most recent date actually present across the whole fetched
 * universe, not exceeding upperBound, or null if there's no such data.
 * Excluding anything past upperBound keeps this consistent with the
 * per-range window filter below — a fetch client returning data past
 * what was requested (in violation of its own contract) shouldn't make
 * dataAsOf claim freshness beyond what was actually asked for.
 */
function findMaxDate(history: Map<string, DailyClose[]>, upperBound: string): string | null {
  let max: string | null = null;
  for (const series of history.values()) {
    for (const point of series) {
      if (point.date > upperBound) continue;
      if (max === null || point.date > max) max = point.date;
    }
  }
  return max;
}

export async function runPipeline(options: RunPipelineOptions): Promise<PipelineRunSummary> {
  const asOf = options.asOf ?? new Date();
  const startingCapital = options.startingCapital ?? DEFAULT_STARTING_CAPITAL;
  const maxTrades = options.maxTrades ?? DEFAULT_MAX_TRADES;
  const earliestDate = options.earliestDate ?? DEFAULT_EARLIEST_DATE;
  const fetchConcurrency = options.fetchConcurrency ?? DEFAULT_FETCH_CONCURRENCY;
  const endDateString = toDateString(asOf);

  const { history, skipped } = await fetchUniverseHistory(
    options.tickers,
    earliestDate,
    asOf,
    options.fetchDailyCloses,
    fetchConcurrency,
  );

  const dataAsOf = findMaxDate(history, endDateString);
  if (dataAsOf === null) {
    // Refuse to overwrite S3's existing (presumably good) results with
    // empty-but-schema-valid output — better to fail the run loudly and
    // keep yesterday's data than to silently erase it.
    throw new Error(
      `pipeline aborted: no ticker data was successfully fetched (${skipped.length} of ${options.tickers.length} tickers skipped) — refusing to overwrite existing results with empty output`,
    );
  }

  const generatedAt = new Date().toISOString();

  // Compute everything before writing anything, so a failure in
  // optimizeTrades (e.g. an unexpected data shape) can't leave some
  // ranges' S3 objects updated and others stale. This doesn't make the
  // 5 S3 writes themselves atomic — a failure partway through the write
  // loop below can still leave a mix of fresh and stale range files —
  // true cross-range atomicity would need a different storage strategy
  // (e.g. a single combined manifest object) and is deliberately not
  // built here; issue #5's acceptance criteria only calls for
  // idempotency, which this satisfies.
  const results: PipelineResult[] = PRESET_RANGES.map((range) => {
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
      schemaVersion: SCHEMA_VERSION,
      range,
      generatedAt,
      dataAsOf,
      startDate: startDateString,
      endDate: endDateString,
      startingCapital,
      endingBalance: optimized.endingBalance,
      trades: optimized.trades,
      universeSize: windowed.size,
      skippedTickers: [...skipped],
    };
  });

  for (const result of results) {
    await options.store.putObject(`results/${result.range}.json`, JSON.stringify(result, null, 2));
  }

  return { results, skippedTickers: skipped };
}
