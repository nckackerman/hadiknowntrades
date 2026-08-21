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

export interface DailyClose {
  /** Trading day, in the exchange's local timezone, as YYYY-MM-DD. */
  date: string;
  /** Split- and dividend-adjusted close price. */
  close: number;
}

/** Thrown when Yahoo reports the symbol has no data (invalid, delisted, or mistyped). */
export class TickerNotFoundError extends Error {
  constructor(
    public readonly symbol: string,
    reason: string,
  ) {
    super(`No data for symbol "${symbol}": ${reason}`);
    this.name = "TickerNotFoundError";
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
    quote: [{ close: (number | null)[] }];
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
 * Fetches daily adjusted-close prices for a symbol over a date range.
 *
 * @param symbol Ticker as commonly quoted, e.g. "AAPL", "BRK.B". Mapped
 *   internally to Yahoo's symbol format.
 * @param from Start of the range (inclusive).
 * @param to End of the range (inclusive).
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
  const period2 = Math.floor(to.getTime() / 1000);
  const url =
    `${CHART_BASE_URL}/${encodeURIComponent(yahooSymbol)}` +
    `?period1=${period1}&period2=${period2}&interval=1d&includeAdjustedClose=true`;

  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      await sleep(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
    }

    let response: Response;
    try {
      response = await fetchImpl(url, { headers: { "User-Agent": USER_AGENT } });
    } catch (error) {
      lastError = error;
      continue;
    }

    if (!response.ok) {
      if (isRetryableStatus(response.status)) {
        lastError = new Error(`HTTP ${response.status}`);
        continue;
      }
      throw new TickerNotFoundError(symbol, `HTTP ${response.status}`);
    }

    const body = (await response.json()) as YahooChartResponse;

    if (body.chart.error) {
      throw new TickerNotFoundError(symbol, body.chart.error.description);
    }
    const [firstResult] = body.chart.result ?? [];
    if (!firstResult) {
      throw new TickerNotFoundError(symbol, "empty result");
    }

    return parseChartResult(firstResult);
  }

  throw new TransientFetchError(symbol, lastError);
}

function parseChartResult(result: YahooChartResult): DailyClose[] {
  const { timestamp, indicators, meta } = result;
  const closes = indicators.adjclose?.[0]?.adjclose ?? indicators.quote[0].close;

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
 * Converts a UTC unix timestamp (seconds) plus the exchange's UTC offset
 * (seconds) into a YYYY-MM-DD date string in the exchange's local time,
 * avoiding off-by-one-day errors from a naive UTC conversion.
 */
function unixToLocalDateString(unixSeconds: number, gmtoffsetSeconds: number): string {
  const localMs = (unixSeconds + gmtoffsetSeconds) * 1000;
  const d = new Date(localMs);
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
