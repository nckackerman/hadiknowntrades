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
  dataAsOf: string;
  startDate: string | null;
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
 * are per-ticker problems. BlockedError aborts the whole run immediately:
 * it signals we're broadly blocked, and continuing to fire off hundreds
 * more requests would be both pointless and antisocial to the upstream
 * service.
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

  async function worker(): Promise<void> {
    for (;;) {
      const i = nextIndex++;
      if (i >= tickers.length) return;
      const ticker = tickers[i]!;
      try {
        const series = await fetchDailyCloses(ticker, from, to);
        history.set(ticker, series);
      } catch (error) {
        if (error instanceof BlockedError) throw error;
        skipped.push(ticker);
        console.warn(
          `[pipeline] skipping ${ticker}: ${error instanceof Error ? error.message : error}`,
        );
      }
    }
  }

  const workerCount = Math.min(concurrency, tickers.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  return { history, skipped };
}

export async function runPipeline(options: RunPipelineOptions): Promise<PipelineRunSummary> {
  const asOf = options.asOf ?? new Date();
  const startingCapital = options.startingCapital ?? DEFAULT_STARTING_CAPITAL;
  const maxTrades = options.maxTrades ?? DEFAULT_MAX_TRADES;
  const earliestDate = options.earliestDate ?? DEFAULT_EARLIEST_DATE;
  const fetchConcurrency = options.fetchConcurrency ?? DEFAULT_FETCH_CONCURRENCY;

  const { history, skipped } = await fetchUniverseHistory(
    options.tickers,
    earliestDate,
    asOf,
    options.fetchDailyCloses,
    fetchConcurrency,
  );

  const results: PipelineResult[] = [];
  for (const range of PRESET_RANGES) {
    const startDate = presetRangeStartDate(range, asOf);
    const startDateString = startDate ? toDateString(startDate) : null;

    const windowed = new Map<string, DailyClose[]>();
    for (const [ticker, series] of history) {
      const sliced = startDateString ? series.filter((p) => p.date >= startDateString) : series;
      if (sliced.length > 0) windowed.set(ticker, sliced);
    }

    const optimized = optimizeTrades(windowed, { startingCapital, maxTrades });

    const result: PipelineResult = {
      schemaVersion: SCHEMA_VERSION,
      range,
      generatedAt: new Date().toISOString(),
      dataAsOf: toDateString(asOf),
      startDate: startDateString,
      endDate: toDateString(asOf),
      startingCapital,
      endingBalance: optimized.endingBalance,
      trades: optimized.trades,
      universeSize: windowed.size,
      skippedTickers: skipped,
    };
    results.push(result);

    await options.store.putObject(`results/${range}.json`, JSON.stringify(result, null, 2));
  }

  return { results, skippedTickers: skipped };
}
