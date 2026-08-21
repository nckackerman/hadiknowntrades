// Yahoo Finance data client: fetches daily adjusted-close price history via
// Yahoo's unofficial chart endpoint. See README.md and issue #3 for why
// this replaced the originally planned Stooq source (Stooq now actively
// blocks programmatic access with a JS proof-of-work anti-bot challenge).
//
// Verified empirically (see issue #3):
// - The endpoint requires a browser-like User-Agent; requests without one
//   get a misleading "Too Many Requests" response regardless of actual
//   request volume.
// - Dot-class share symbols (BRK.B, BF.B) use a hyphen on Yahoo (BRK-B,
//   BF-B), not a dot.
// - An invalid/delisted symbol returns HTTP 200 with a
//   `{ chart: { result: null, error: {...} } }` body, not an HTTP error.

const CHART_BASE_URL = "https://query1.finance.yahoo.com/v8/finance/chart";

// A realistic browser User-Agent. Required — see note above.
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 500;
const REQUEST_TIMEOUT_MS = 15_000;
const ONE_DAY_SECONDS = 24 * 60 * 60;

export interface DailyClose {
  /** Trading day, in the exchange's local timezone, as YYYY-MM-DD. */
  date: string;
  /** Split- and dividend-adjusted close price. */
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
  timestamp: number[];
  indicators: {
    quote: [{ close: (number | null)[] }] | [];
    adjclose?: [{ adjclose: (number | null)[] }];
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
 * RFC 9110 §10.2.3) into milliseconds to wait. Returns null if absent or
 * unparseable.
 */
function parseRetryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const dateMs = Date.parse(header);
  if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - Date.now());
  return null;
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
  const fetchImpl = options.fetchImpl ?? fetch;
  const yahooSymbol = toYahooSymbol(symbol);
  const period1 = Math.floor(from.getTime() / 1000);
  const period2 = Math.floor(to.getTime() / 1000) + ONE_DAY_SECONDS;
  const url =
    `${CHART_BASE_URL}/${encodeURIComponent(yahooSymbol)}` +
    `?period1=${period1}&period2=${period2}&interval=1d&includeAdjustedClose=true`;

  let lastError: unknown;
  let retryAfterMs: number | null = null;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      await sleep(retryAfterMs ?? RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
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
      throw new TickerNotFoundError(symbol, `HTTP ${response.status}`);
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
      // Yahoo's own definitive answer: this symbol has no data. Not retried.
      throw new TickerNotFoundError(symbol, body.chart.error.description);
    }

    const [firstResult] = body.chart.result ?? [];
    if (!firstResult || firstResult.indicators.quote.length === 0) {
      // Ambiguous/malformed shape rather than a definitive "not found" —
      // could be a transient partial response, so retry rather than fail
      // the whole batch on one glitchy response.
      lastError = new Error("empty or malformed result");
      continue;
    }

    return parseChartResult(firstResult);
  }

  throw new TransientFetchError(symbol, lastError);
}

function parseChartResult(result: YahooChartResult): DailyClose[] {
  const { timestamp, indicators, meta } = result;
  const quote = indicators.quote[0];
  const closes = indicators.adjclose?.[0]?.adjclose ?? quote?.close ?? [];

  const out: DailyClose[] = [];
  for (let i = 0; i < timestamp.length; i++) {
    const ts = timestamp[i];
    const close = closes[i];
    if (ts === undefined || close === null || close === undefined) continue;
    out.push({
      date: unixToLocalDateString(ts, meta.gmtoffset),
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
 * table to fix properly; not worth the complexity unless intraday data
 * (where timestamps do sit near day boundaries) is ever added.
 */
function unixToLocalDateString(unixSeconds: number, gmtoffsetSeconds: number): string {
  const localMs = (unixSeconds + gmtoffsetSeconds) * 1000;
  const d = new Date(localMs);
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
