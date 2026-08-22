// Yahoo Finance data client: fetches daily adjusted-close price history,
// and (for issue #28) 60-minute intraday bars, via Yahoo's unofficial
// chart endpoint. See README.md and issue #3 for why this replaced the
// originally planned Stooq source (Stooq now actively blocks
// programmatic access with a JS proof-of-work anti-bot challenge).
//
// Verified empirically (see issue #3):
// - The endpoint requires a browser-like User-Agent; requests without one
//   get a misleading "Too Many Requests" response regardless of actual
//   request volume.
// - Dot-class share symbols (BRK.B, BF.B) use a hyphen on Yahoo (BRK-B,
//   BF-B), not a dot.
// - An invalid/delisted symbol returns HTTP 200 with a
//   `{ chart: { result: null, error: {...} } }` body, not an HTTP error.
//
// Verified empirically for 60m bars (see issue #28, and
// packages/core/CLAUDE.md's "60-minute intraday bars" section for the
// full retention table and details): the `interval=60m` param on the
// same endpoint returns up to 730 days of history in a single request,
// no chunking needed for any of 1M/3M/1Y. The request/response envelope
// (chart.result[], chart.error, meta.gmtoffset, indicators.quote/
// adjclose) is identical in shape to the daily-close case -- only the
// bar frequency and the per-bar timestamp's meaning (a specific
// intraday moment, not a market-open-anchored calendar day) differ.
//
// Verified empirically for 5m bars (issue #30, upgrading 3M's most
// recent days -- see packages/core/CLAUDE.md's "5-minute intraday bars"
// section): `interval=5m` on the same endpoint retains exactly 60 days
// of history, the same "N-1 succeeds, N fails" hard-wall pattern as the
// 730-day limit for 60m (59 days back succeeds; 60 days back gets a 422
// with `chart.error.description` reading "5m data not available for
// startTime=... The requested range must be within the last 60 days.").
// A single request per ticker is enough here too -- 60 days of 5-minute
// bars is well within what one chart-endpoint response returns, no
// chunking needed.
//
// Verified empirically for 1m bars (issue #29, upgrading 1M -- see
// packages/core/CLAUDE.md's "1-minute intraday bars" section): unlike
// 60m/5m, `interval=1m` needs TWO independent limits respected, not one:
// retention is a hard 30-day wall (29 days back succeeds, 30 fails with
// a 422 -- "N-1, not N" again, same pattern as 60m/5m), AND a single
// request may span at most 8 calendar days regardless of how recent it
// is (a request spanning exactly 8 days succeeds, 9 fails with a
// different 422). Covering a full ~29-day window therefore needs
// multiple chunked requests per ticker, unlike every other granularity
// here -- see fetchIntraday1mBars below.

import { isValidPrice } from "./is-valid-price";

const CHART_BASE_URL = "https://query1.finance.yahoo.com/v8/finance/chart";

// A realistic browser User-Agent. Required -- see note above.
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 500;
const MAX_RETRY_AFTER_MS = 30_000;
const REQUEST_TIMEOUT_MS = 15_000;
const ONE_DAY_SECONDS = 24 * 60 * 60;
// Interval string for the 60-minute intraday fetch added in issue #28.
// Hardcoded (not a parameter) on purpose -- a real "interval" parameter
// would only be worth adding if a caller needed to choose between
// several fixed granularities at runtime, which none currently do (each
// granularity has its own fetch function; see fetchFiveMinuteBars and
// fetchIntraday1mBars below for the 5-minute/1-minute ones added in
// issues #30/#29).
const INTRADAY_INTERVAL = "60m";
// Interval string for the 5-minute intraday fetch added in issue #30
// (upgrades the 3M range's most recent ~60 days -- see
// fetchFiveMinuteBars below and packages/core/CLAUDE.md's "5-minute
// intraday bars" section for the verified retention window).
const FIVE_MINUTE_INTERVAL = "5m";
// Interval string for the 1-minute intraday fetch added in issue #29
// (upgrades the 1M range -- see fetchIntraday1mBars below and
// packages/core/CLAUDE.md's "1-minute intraday bars" section for the
// verified retention window and chunk-span cap).
const ONE_MINUTE_INTERVAL = "1m";
// Largest span, in calendar days, a single interval=1m request may
// cover (verified live -- see the module header comment above).
// fetchIntraday1mBars splits any wider [from, to] into consecutive,
// non-overlapping windows of at most this many days. Purely internal to
// this module -- unlike the retention window (a caller-facing contract,
// documented on fetchIntraday1mBars itself), chunking is an
// implementation detail no caller needs to know about.
const ONE_MINUTE_CHUNK_DAYS = 8;
// HTTP status Yahoo has been empirically confirmed (see issue #3) to use
// for a genuinely nonexistent symbol.
const NOT_FOUND_STATUS = 404;

export interface DailyClose {
  /** Trading day, in the exchange's local timezone, as YYYY-MM-DD. */
  date: string;
  /** Split- and dividend-adjusted close price. */
  close: number;
}

/**
 * One 60-minute intraday price bar (issue #28). Structurally identical
 * to DailyClose ({ date, close }) on purpose, so it flows through the
 * same daily-close-shaped machinery elsewhere in this codebase
 * (optimizeTrades, buildCalendar, apps/pipeline's fetchUniverseHistory/
 * findMaxDate) with no adapter shim needed. The only difference is what
 * `date` holds: here, a full local datetime string
 * ("2026-08-21T14:30:00"), not a plain calendar date -- see
 * unixToLocalDateTimeString.
 */
export interface IntradayBar {
  date: string;
  close: number;
}

/** Thrown when Yahoo definitively reports the symbol has no data (invalid, delisted, or mistyped). */
export class TickerNotFoundError extends Error {
  constructor(
    public readonly symbol: string,
    reason: string,
  ) {
    super(`No data for symbol "${symbol}": ${reason}`);
    this.name = "TickerNotFoundError";
  }
}

/**
 * Thrown on HTTP 401/403 -- distinct from TickerNotFoundError on purpose.
 * A block means "we can't fetch anything right now," not "this symbol
 * doesn't exist" -- conflating the two is exactly the failure mode this
 * client's migration off Stooq was meant to move away from. Not retried:
 * an active block is unlikely to clear within a few seconds of backoff.
 */
export class BlockedError extends Error {
  constructor(
    public readonly symbol: string,
    public readonly status: number,
  ) {
    super(`Request for symbol "${symbol}" was blocked (HTTP ${status})`);
    this.name = "BlockedError";
  }
}

/**
 * Thrown on a non-retryable HTTP status this client doesn't have a
 * specific interpretation for (i.e. not 401/403, and not the 404 we've
 * empirically confirmed Yahoo uses for a genuinely nonexistent symbol).
 * Distinct from TickerNotFoundError so callers don't mistake "the request
 * itself was malformed" (a client-side bug, likely permanent regardless
 * of symbol) for "this specific ticker has no data."
 */
export class UnexpectedResponseError extends Error {
  constructor(
    public readonly symbol: string,
    public readonly status: number,
  ) {
    super(`Unexpected response for symbol "${symbol}": HTTP ${status}`);
    this.name = "UnexpectedResponseError";
  }
}

/** Thrown when the request fails for a non-permanent reason after all retries are exhausted. */
export class TransientFetchError extends Error {
  constructor(
    public readonly symbol: string,
    cause: unknown,
  ) {
    super(`Failed to fetch data for symbol "${symbol}" after ${MAX_RETRIES} attempts`, { cause });
    this.name = "TransientFetchError";
  }
}

/**
 * Maps a commonly-quoted ticker symbol to Yahoo's own symbol format.
 * Yahoo uses a hyphen for share-class suffixes where the common quote
 * uses a dot, e.g. "BRK.B" -> "BRK-B".
 */
export function toYahooSymbol(symbol: string): string {
  return symbol.replace(/\./g, "-");
}

interface YahooChartResult {
  meta: { gmtoffset: number };
  // Verified live: absent entirely (not an empty array) for a range
  // with no trading data, e.g. a weekend-only window.
  timestamp?: number[];
  indicators: {
    // Verified live: `[{}]` (no `close` key at all) for an empty range —
    // not `[{ close: [] }]`.
    quote: [{ close?: (number | null)[] }] | [];
    adjclose?: [{ adjclose?: (number | null)[] }];
  };
}

interface YahooChartResponse {
  chart: {
    // Yahoo's own schema uses an array here even though a single symbol
    // request only ever returns zero or one result.
    result: YahooChartResult[] | null;
    error: { code: string; description: string } | null;
  };
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 408 || status >= 500;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Parses a Retry-After header (either delta-seconds or an HTTP-date, per
 * RFC 9110 §10.2.3) into milliseconds to wait, capped at
 * MAX_RETRY_AFTER_MS so a server-supplied value can't stall a batch job
 * indefinitely. Returns null if absent or unparseable.
 */
function parseRetryAfterMs(header: string | null): number | null {
  if (!header) return null;
  let ms: number | null = null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) {
    ms = seconds * 1000;
  } else {
    const dateMs = Date.parse(header);
    if (!Number.isNaN(dateMs)) ms = dateMs - Date.now();
  }
  return ms === null ? null : Math.min(MAX_RETRY_AFTER_MS, Math.max(0, ms));
}

/** Exponential backoff with +/-20% jitter, so concurrent retries (e.g. many symbols rate-limited around the same moment) don't resynchronize into identical bursts. */
function backoffWithJitter(attempt: number): number {
  const base = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
  const jitter = base * 0.2 * (Math.random() * 2 - 1);
  return Math.round(base + jitter);
}

/**
 * Shared request/retry/error-classification loop behind both
 * fetchDailyCloses and fetchIntradayBars (issue #28) -- everything about
 * *how* to talk to the chart endpoint (UA header, timeout, backoff,
 * status-code classification, malformed-shape detection) is identical
 * regardless of interval; only the URL and how to parse one bar's date
 * differ, both supplied by the caller.
 */
async function fetchChartSeries<T extends { date: string; close: number }>(
  symbol: string,
  url: string,
  parse: (result: YahooChartResult) => T[],
  options: { fetchImpl?: typeof fetch },
): Promise<T[]> {
  const fetchImpl = options.fetchImpl ?? fetch;

  let lastError: unknown;
  let retryAfterMs: number | null = null;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      await sleep(retryAfterMs ?? backoffWithJitter(attempt));
      retryAfterMs = null;
    }

    let response: Response;
    try {
      response = await fetchImpl(url, {
        headers: { "User-Agent": USER_AGENT },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      // Network error or timeout -- treat as transient and retry.
      lastError = error;
      continue;
    }

    if (response.status === 401 || response.status === 403) {
      throw new BlockedError(symbol, response.status);
    }

    if (!response.ok) {
      if (isRetryableStatus(response.status)) {
        lastError = new Error(`HTTP ${response.status}`);
        retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
        continue;
      }
      if (response.status === NOT_FOUND_STATUS) {
        throw new TickerNotFoundError(symbol, `HTTP ${response.status}`);
      }
      // A non-retryable status we don't have a specific interpretation
      // for (not 401/403, not the confirmed "not found" status) -- don't
      // conflate it with "ticker doesn't exist."
      throw new UnexpectedResponseError(symbol, response.status);
    }

    let body: YahooChartResponse;
    try {
      body = (await response.json()) as YahooChartResponse;
    } catch (error) {
      // A 200 with a non-JSON body (e.g. an HTML anti-bot interstitial)
      // -- treat as transient rather than crashing the whole batch.
      lastError = error;
      continue;
    }

    if (body.chart.error) {
      // Yahoo's own definitive answer: this symbol has no data. Not
      // retried. Note: this same field is also how Yahoo reports an
      // out-of-retention interval/range request (e.g. "1m data not
      // available ... must be within the last 30 days") -- see
      // packages/core/CLAUDE.md's 60m retention section. Callers of
      // fetchIntradayBars must keep their requested range within the
      // documented retention window so that case can't occur in
      // practice; if it ever does, it will misleadingly surface here as
      // "ticker not found" rather than "range too large."
      throw new TickerNotFoundError(symbol, body.chart.error.description);
    }

    const [firstResult] = body.chart.result ?? [];
    // Runtime-validate the shape beyond what the `as` cast promises —
    // Yahoo's response is untrusted input, and a raw TypeError from an
    // unguarded access here would escape the retry loop unwrapped.
    if (!firstResult || !Array.isArray(firstResult.indicators?.quote)) {
      lastError = new Error("empty or malformed result: missing quote data");
      continue;
    }

    const timestamps = firstResult.timestamp ?? [];
    const parsed = parse(firstResult);
    if (timestamps.length > 0 && parsed.length === 0) {
      // Timestamps present but nothing survived parsing (no price data
      // at all, or every close was invalid -- e.g. all zero/NaN during a
      // feed glitch) lines up with a malformed/glitchy response, not a
      // legitimately empty range (which has zero timestamps too) -- retry
      // rather than silently returning an empty result that looks
      // identical to "no trading days here." Checked on the *parsed*
      // output, not the raw close array, so this still catches the case
      // where every raw value was present but invalid and got filtered
      // out inside parse().
      lastError = new Error("malformed result: timestamps present but no valid close data");
      continue;
    }

    return parsed;
  }

  throw new TransientFetchError(symbol, lastError);
}

/**
 * Fetches daily adjusted-close prices for a symbol over a date range.
 *
 * @param symbol Ticker as commonly quoted, e.g. "AAPL", "BRK.B". Mapped
 *   internally to Yahoo's symbol format.
 * @param from Start of the range (inclusive).
 * @param to End of the range (inclusive) -- internally padded by a day so
 *   that whatever time-of-day `to` carries, its calendar date is still
 *   covered even though daily bars are timestamped at market open, not
 *   midnight.
 * @param options.fetchImpl Override for the fetch implementation (tests).
 */
export async function fetchDailyCloses(
  symbol: string,
  from: Date,
  to: Date,
  options: { fetchImpl?: typeof fetch } = {},
): Promise<DailyClose[]> {
  const yahooSymbol = toYahooSymbol(symbol);
  const period1 = Math.floor(from.getTime() / 1000);
  const period2 = Math.floor(to.getTime() / 1000) + ONE_DAY_SECONDS;
  const url =
    `${CHART_BASE_URL}/${encodeURIComponent(yahooSymbol)}` +
    `?period1=${period1}&period2=${period2}&interval=1d&includeAdjustedClose=true`;

  return fetchChartSeries(symbol, url, parseDailyChartResult, options);
}

/**
 * Fetches 60-minute intraday price bars for a symbol over a date range
 * (issue #28). Yahoo's retention for `interval=60m` is 730 days
 * (verified -- see packages/core/CLAUDE.md), which comfortably covers
 * 1M/3M/1Y in a single request with no chunking; the caller is
 * responsible for keeping `from`/`to` within that window (see the
 * chart.error note in fetchChartSeries for what happens if it isn't).
 *
 * @param symbol Ticker as commonly quoted, e.g. "AAPL", "BRK.B". Mapped
 *   internally to Yahoo's symbol format.
 * @param from Start of the range (inclusive).
 * @param to End of the range (inclusive) -- like fetchDailyCloses,
 *   internally padded by a day so the requested day's market-hours bars
 *   are fully covered regardless of what time-of-day `to` carries (e.g.
 *   a caller passing a midnight-UTC "as of" date, matching this
 *   package's own `toDateString` convention, would otherwise land
 *   `period2` before that day's 9:30am-ET-and-later bars exist, silently
 *   dropping the whole day). The pipeline's per-range slicing already
 *   discards anything past its own requested end date, so this padding
 *   never leaks an extra day into a written result.
 * @param options.fetchImpl Override for the fetch implementation (tests).
 */
export async function fetchIntradayBars(
  symbol: string,
  from: Date,
  to: Date,
  options: { fetchImpl?: typeof fetch } = {},
): Promise<IntradayBar[]> {
  const yahooSymbol = toYahooSymbol(symbol);
  const period1 = Math.floor(from.getTime() / 1000);
  const period2 = Math.floor(to.getTime() / 1000) + ONE_DAY_SECONDS;
  const url =
    `${CHART_BASE_URL}/${encodeURIComponent(yahooSymbol)}` +
    `?period1=${period1}&period2=${period2}&interval=${INTRADAY_INTERVAL}&includeAdjustedClose=true`;

  return fetchChartSeries(symbol, url, parseIntradayChartResult, options);
}

/**
 * Fetches 5-minute intraday price bars for a symbol over a date range
 * (issue #30 -- upgrades the 3M range's most recent ~60 days from
 * 60-minute to 5-minute granularity; the remaining older portion of 3M
 * stays on fetchIntradayBars' 60-minute bars, since 5-minute data isn't
 * retained that far back). Yahoo's retention for `interval=5m` is a hard
 * 60-day wall (verified live -- see packages/core/CLAUDE.md's
 * "5-minute intraday bars" section): a request 59 days back succeeds, a
 * request 60 days back gets a 422 with `chart.error.description` reading
 * "5m data not available for startTime=... The requested range must be
 * within the last 60 days." The caller is responsible for keeping
 * `from` within that window: verified live (unlike the chart.error note
 * on fetchChartSeries might suggest) that this specific out-of-retention
 * case never reaches that branch at all -- the response's HTTP status is
 * 422, which fetchChartSeries's status-code check throws as
 * UnexpectedResponseError *before* ever parsing the JSON body far enough
 * to see chart.error, not a "this symbol has no data" TickerNotFoundError.
 * That matters operationally: UnexpectedResponseError is a systemic-abort
 * signal to apps/pipeline's fetchUniverseHistory, not a per-ticker skip --
 * see apps/pipeline/CLAUDE.md's "5-minute path" section for how the
 * pipeline avoids that ever mattering in practice (it requests a
 * conservative 59-day-back window, one day inside the verified wall, and
 * treats the whole 5-minute path as best-effort/gracefully-degradable
 * regardless of which error class trips it). Same envelope, same
 * single-request-no-chunking shape as fetchIntradayBars -- shares
 * fetchChartSeries and parseIntradayChartResult with it, differing only
 * in the interval string.
 *
 * @param symbol Ticker as commonly quoted, e.g. "AAPL", "BRK.B". Mapped
 *   internally to Yahoo's symbol format.
 * @param from Start of the range (inclusive) -- must be within the last
 *   60 days of "now" at request time (see above).
 * @param to End of the range (inclusive) -- like fetchIntradayBars,
 *   internally padded by a day so the requested day's market-hours bars
 *   are fully covered regardless of what time-of-day `to` carries.
 * @param options.fetchImpl Override for the fetch implementation (tests).
 */
export async function fetchFiveMinuteBars(
  symbol: string,
  from: Date,
  to: Date,
  options: { fetchImpl?: typeof fetch } = {},
): Promise<IntradayBar[]> {
  const yahooSymbol = toYahooSymbol(symbol);
  const period1 = Math.floor(from.getTime() / 1000);
  const period2 = Math.floor(to.getTime() / 1000) + ONE_DAY_SECONDS;
  const url =
    `${CHART_BASE_URL}/${encodeURIComponent(yahooSymbol)}` +
    `?period1=${period1}&period2=${period2}&interval=${FIVE_MINUTE_INTERVAL}&includeAdjustedClose=true`;

  return fetchChartSeries(symbol, url, parseIntradayChartResult, options);
}

/**
 * Fetches 1-minute intraday price bars for a symbol over a date range
 * (issue #29 -- upgrades the 1M range from 60-minute to 1-minute
 * granularity, following the same GranularityOverride pattern
 * fetchFiveMinuteBars established for 3M). Two independent limits on
 * `interval=1m`, both verified live (see packages/core/CLAUDE.md's
 * "1-minute intraday bars" section) and both different from every other
 * granularity this client fetches:
 *
 * - **Retention is a hard 30-day wall**, the same "N-1 succeeds, N
 *   fails" pattern as 5m's 60-day / 60m's 730-day limits: a request 29
 *   days back succeeds, 30 days back gets a 422 with
 *   `chart.error.description` reading "1m data not available for
 *   startTime=... The requested range must be within the last 30
 *   days." Same operational gotcha as fetchFiveMinuteBars: this status
 *   is 422 (`!response.ok`), so fetchChartSeries throws
 *   `UnexpectedResponseError` from the status-code branch, not
 *   `TickerNotFoundError` from `chart.error` -- the caller is
 *   responsible for staying inside the window (apps/pipeline requests a
 *   conservative 29-day-back window, one day inside the verified wall,
 *   and treats the whole 1-minute path as best-effort/
 *   gracefully-degradable regardless of which error class trips it, same
 *   as the 5-minute path).
 * - **A single request may span at most 8 calendar days**
 *   (ONE_MINUTE_CHUNK_DAYS), regardless of how recent it is -- a
 *   *separate* limit from retention: a request spanning exactly 8 days
 *   succeeds, 9 days fails with a *different* 422
 *   (`chart.error.description`: "Only 8 days worth of 1m granularity
 *   data are allowed to be fetched per request."). Unlike every other
 *   fetch function in this file, this means one logical `[from, to]`
 *   request here can require **multiple sequential HTTP requests**:
 *   this function transparently splits the (already end-padded) total
 *   range into consecutive, non-overlapping <=8-day chunks and awaits
 *   them one at a time (not concurrently -- this fetch isn't
 *   latency-sensitive, and firing every chunk at once per ticker would
 *   multiply peak simultaneous connections for no benefit; see
 *   apps/pipeline/CLAUDE.md's "1-minute path" section), concatenating
 *   the results. Only the conceptual *last* chunk carries the padded
 *   end -- computing the padded total range once and chunking *that*
 *   (rather than padding every chunk independently) means intermediate
 *   chunk seams can't overlap and double-count a bar by construction.
 *   A defensive dedup-by-`date` pass still runs when concatenating,
 *   cheap insurance against that invariant ever regressing. If any
 *   chunk's request ultimately fails (after its own retries, or
 *   immediately for BlockedError/TickerNotFoundError/
 *   UnexpectedResponseError), that error propagates and this function's
 *   caller gets nothing for this ticker -- earlier chunks' already-
 *   fetched bars are discarded rather than returning a partial month,
 *   matching every other fetch function's all-or-nothing per-ticker
 *   contract.
 *
 * @param symbol Ticker as commonly quoted, e.g. "AAPL", "BRK.B". Mapped
 *   internally to Yahoo's symbol format.
 * @param from Start of the range (inclusive) -- must be within the last
 *   30 days of "now" at request time (see above).
 * @param to End of the range (inclusive) -- like fetchFiveMinuteBars,
 *   internally padded by a day so the requested day's market-hours bars
 *   are fully covered regardless of what time-of-day `to` carries; the
 *   padding is applied once to the whole range, then chunked (see
 *   above), not re-applied per chunk.
 * @param options.fetchImpl Override for the fetch implementation (tests).
 */
export async function fetchIntraday1mBars(
  symbol: string,
  from: Date,
  to: Date,
  options: { fetchImpl?: typeof fetch } = {},
): Promise<IntradayBar[]> {
  const period1Total = Math.floor(from.getTime() / 1000);
  const period2Total = Math.floor(to.getTime() / 1000) + ONE_DAY_SECONDS;
  const chunkSeconds = ONE_MINUTE_CHUNK_DAYS * ONE_DAY_SECONDS;

  const out: IntradayBar[] = [];
  const seenDates = new Set<string>();
  let chunkStart = period1Total;
  while (chunkStart < period2Total) {
    const chunkEnd = Math.min(chunkStart + chunkSeconds, period2Total);
    // Sequential, not Promise.all'd -- see the doc comment above.
    const bars = await fetchOneMinuteChunk(symbol, chunkStart, chunkEnd, options);
    for (const bar of bars) {
      if (seenDates.has(bar.date)) continue;
      seenDates.add(bar.date);
      out.push(bar);
    }
    chunkStart = chunkEnd;
  }
  return out;
}

function fetchOneMinuteChunk(
  symbol: string,
  period1: number,
  period2: number,
  options: { fetchImpl?: typeof fetch },
): Promise<IntradayBar[]> {
  const yahooSymbol = toYahooSymbol(symbol);
  const url =
    `${CHART_BASE_URL}/${encodeURIComponent(yahooSymbol)}` +
    `?period1=${period1}&period2=${period2}&interval=${ONE_MINUTE_INTERVAL}&includeAdjustedClose=true`;

  return fetchChartSeries(symbol, url, parseIntradayChartResult, options);
}

function extractCloses(result: YahooChartResult): (number | null | undefined)[] {
  const { indicators } = result;
  const quote = indicators.quote[0];
  return indicators.adjclose?.[0]?.adjclose ?? quote?.close ?? [];
}

/**
 * Shared per-bar parsing loop behind both parseDailyChartResult and
 * parseIntradayChartResult (issue #28) -- the only difference between
 * the two is which timestamp-to-local-string function turns a bar's
 * unix timestamp into its `date` field, and what a skipped-invalid-bar
 * warning calls that bar ("close" vs. "intraday close").
 */
function parseBars<T extends { date: string; close: number }>(
  result: YahooChartResult,
  formatTimestamp: (unixSeconds: number, gmtoffsetSeconds: number) => string,
  warnLabel: string,
): T[] {
  const timestamp = result.timestamp ?? [];
  const closes = extractCloses(result);
  const { meta } = result;

  const out: T[] = [];
  for (let i = 0; i < timestamp.length; i++) {
    const ts = timestamp[i];
    const close = closes[i];
    if (ts === undefined || close === null || close === undefined) continue;
    // A non-positive or non-finite close is never legitimate -- a stock
    // price can't be <= 0 -- so treat a glitched bar from the upstream
    // feed as missing data rather than passing it through to downstream
    // consumers (e.g. the optimizer, which would otherwise divide by it).
    if (!isValidPrice(close)) {
      console.warn(
        `[yahoo-client] ignoring invalid ${warnLabel} on ${formatTimestamp(ts, meta.gmtoffset)}: ${close}`,
      );
      continue;
    }
    out.push({ date: formatTimestamp(ts, meta.gmtoffset), close } as T);
  }
  return out;
}

function parseDailyChartResult(result: YahooChartResult): DailyClose[] {
  return parseBars(result, unixToLocalDateString, "close");
}

function parseIntradayChartResult(result: YahooChartResult): IntradayBar[] {
  return parseBars(result, unixToLocalDateTimeString, "intraday close");
}

/**
 * Converts a UTC unix timestamp (seconds) plus a UTC offset (seconds)
 * into a YYYY-MM-DD date string in that local time.
 *
 * Known limitation: `meta.gmtoffset` reflects the exchange's *current*
 * UTC offset (at request time), not the historically-correct offset for
 * each individual timestamp in the range, so a range spanning a DST
 * transition uses one offset for the whole series. In practice this is
 * inert for daily bars: they're timestamped near market open (mid-morning
 * local time), and a 1-hour DST mismatch never pushes that far enough to
 * cross a calendar-day boundary. Would need a real per-date timezone
 * table to fix properly.
 *
 * Intraday bars (unixToLocalDateTimeString, below) are the case this was
 * flagged as a risk for -- verified live during issue #28's
 * implementation, see packages/core/CLAUDE.md's "60-minute intraday
 * bars" section for the result.
 */
function unixToLocalDateString(unixSeconds: number, gmtoffsetSeconds: number): string {
  const localMs = (unixSeconds + gmtoffsetSeconds) * 1000;
  const d = new Date(localMs);
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Same conversion as unixToLocalDateString, but keeping the
 * hours/minutes/seconds instead of truncating to a calendar date -- for
 * 60-minute intraday bars (issue #28), where the time-of-day is real
 * data, not an artifact to discard.
 *
 * Shares unixToLocalDateString's DST caveat (`meta.gmtoffset` is the
 * *current* offset applied uniformly to every timestamp in the range,
 * not the historically-correct one per timestamp) -- see that function's
 * doc comment. Unlike daily bars, this was a real open question for
 * intraday bars specifically (first/last bar of a day sit close to
 * market open/close, not safely mid-day) -- resolved by live
 * verification during implementation; see
 * packages/core/CLAUDE.md's "60-minute intraday bars" section for the
 * result.
 */
function unixToLocalDateTimeString(unixSeconds: number, gmtoffsetSeconds: number): string {
  const localMs = (unixSeconds + gmtoffsetSeconds) * 1000;
  const d = new Date(localMs);
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  const hours = String(d.getUTCHours()).padStart(2, "0");
  const minutes = String(d.getUTCMinutes()).padStart(2, "0");
  const seconds = String(d.getUTCSeconds()).padStart(2, "0");
  return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}`;
}
