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

import { isValidPrice } from "./is-valid-price";

const CHART_BASE_URL = "https://query1.finance.yahoo.com/v8/finance/chart";

// A realistic browser User-Agent. Required — see note above.
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 500;
const MAX_RETRY_AFTER_MS = 30_000;
const REQUEST_TIMEOUT_MS = 15_000;
const ONE_DAY_SECONDS = 24 * 60 * 60;
// Interval string for the intraday fetch added in issue #28. Hardcoded
// (not a parameter) on purpose -- finer granularities (1m for 1M, 5m for
// the most recent 60 days of 3M) are deliberately deferred to follow-up
// issues #29/#30 in the same milestone; widening this to a real
// parameter then is a small, low-risk change once those are in scope.
const INTRADAY_INTERVAL = "60m";
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
 * Thrown on HTTP 401/403 — distinct from TickerNotFoundError on purpose.
 * A block means "we can't fetch anything right now," not "this symbol
 * doesn't exist" — conflating the two is exactly the failure mode this
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
 * fetchDailyCloses and fetchIntradayBars (issue #28) — everything about
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
      // Network error or timeout — treat as transient and retry.
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
      // for (not 401/403, not the confirmed "not found" status) — don't
      // conflate it with "ticker doesn't exist."
      throw new UnexpectedResponseError(symbol, response.status);
    }

    let body: YahooChartResponse;
    try {
      body = (await response.json()) as YahooChartResponse;
    } catch (error) {
      // A 200 with a non-JSON body (e.g. an HTML anti-bot interstitial)
      // — treat as transient rather than crashing the whole batch.
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
      // at all, or every close was invalid — e.g. all zero/NaN during a
      // feed glitch) lines up with a malformed/glitchy response, not a
      // legitimately empty range (which has zero timestamps too) — retry
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
 * @param to End of the range (inclusive) — internally padded by a day so
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
 * (verified — see packages/core/CLAUDE.md), which comfortably covers
 * 1M/3M/1Y in a single request with no chunking; the caller is
 * responsible for keeping `from`/`to` within that window (see the
 * chart.error note in fetchChartSeries for what happens if it isn't).
 *
 * @param symbol Ticker as commonly quoted, e.g. "AAPL", "BRK.B". Mapped
 *   internally to Yahoo's symbol format.
 * @param from Start of the range (inclusive).
 * @param to End of the range (inclusive). Unlike fetchDailyCloses, this
 *   is NOT padded by a day: intraday bars already sit at real intraday
 *   moments within the trading day (not anchored near midnight), so the
 *   day-padding daily bars need to guarantee full calendar-day coverage
 *   would only pull in an extra day's worth of bars beyond what the
 *   caller asked for.
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
  const period2 = Math.floor(to.getTime() / 1000);
  const url =
    `${CHART_BASE_URL}/${encodeURIComponent(yahooSymbol)}` +
    `?period1=${period1}&period2=${period2}&interval=${INTRADAY_INTERVAL}&includeAdjustedClose=true`;

  return fetchChartSeries(symbol, url, parseIntradayChartResult, options);
}

function extractCloses(result: YahooChartResult): (number | null | undefined)[] {
  const { indicators } = result;
  const quote = indicators.quote[0];
  return indicators.adjclose?.[0]?.adjclose ?? quote?.close ?? [];
}

function parseDailyChartResult(result: YahooChartResult): DailyClose[] {
  const timestamp = result.timestamp ?? [];
  const closes = extractCloses(result);
  const { meta } = result;

  const out: DailyClose[] = [];
  for (let i = 0; i < timestamp.length; i++) {
    const ts = timestamp[i];
    const close = closes[i];
    if (ts === undefined || close === null || close === undefined) continue;
    // A non-positive or non-finite close is never legitimate — a stock
    // price can't be <= 0 — so treat a glitched bar from the upstream
    // feed as missing data for that day rather than passing it through
    // to downstream consumers (e.g. the optimizer, which would otherwise
    // divide by it).
    if (!isValidPrice(close)) {
      console.warn(
        `[yahoo-client] ignoring invalid close on ${unixToLocalDateString(ts, meta.gmtoffset)}: ${close}`,
      );
      continue;
    }
    out.push({
      date: unixToLocalDateString(ts, meta.gmtoffset),
      close,
    });
  }
  return out;
}

function parseIntradayChartResult(result: YahooChartResult): IntradayBar[] {
  const timestamp = result.timestamp ?? [];
  const closes = extractCloses(result);
  const { meta } = result;

  const out: IntradayBar[] = [];
  for (let i = 0; i < timestamp.length; i++) {
    const ts = timestamp[i];
    const close = closes[i];
    if (ts === undefined || close === null || close === undefined) continue;
    if (!isValidPrice(close)) {
      console.warn(
        `[yahoo-client] ignoring invalid intraday close on ${unixToLocalDateTimeString(ts, meta.gmtoffset)}: ${close}`,
      );
      continue;
    }
    out.push({
      date: unixToLocalDateTimeString(ts, meta.gmtoffset),
      close,
    });
  }
  return out;
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
 * flagged as a risk for — verified live during issue #28's
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
 * hours/minutes/seconds instead of truncating to a calendar date — for
 * 60-minute intraday bars (issue #28), where the time-of-day is real
 * data, not an artifact to discard.
 *
 * Shares unixToLocalDateString's DST caveat (`meta.gmtoffset` is the
 * *current* offset applied uniformly to every timestamp in the range,
 * not the historically-correct one per timestamp) — see that function's
 * doc comment. Unlike daily bars, this was a real open question for
 * intraday bars specifically (first/last bar of a day sit close to
 * market open/close, not safely mid-day) — resolved by live
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
