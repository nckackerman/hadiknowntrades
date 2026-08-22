import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  BlockedError,
  fetchDailyCloses,
  fetchFiveMinuteBars,
  fetchIntraday1mBars,
  fetchIntradayBars,
  TickerNotFoundError,
  toYahooSymbol,
  TransientFetchError,
  UnexpectedResponseError,
} from "./yahoo-client.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function validChartBody(overrides: { timestamp?: number[]; adjclose?: (number | null)[] } = {}) {
  const timestamp = overrides.timestamp ?? [1704205800, 1704292200];
  const adjclose = overrides.adjclose ?? [183.4, 182.03];
  return {
    chart: {
      result: [
        {
          meta: { gmtoffset: -14400 },
          timestamp,
          indicators: {
            quote: [{ close: timestamp.map(() => 100) }],
            adjclose: [{ adjclose }],
          },
        },
      ],
      error: null,
    },
  };
}

describe("toYahooSymbol", () => {
  it("maps a dot share-class suffix to a hyphen", () => {
    expect(toYahooSymbol("BRK.B")).toBe("BRK-B");
    expect(toYahooSymbol("BF.B")).toBe("BF-B");
  });

  it("leaves plain symbols unchanged", () => {
    expect(toYahooSymbol("AAPL")).toBe("AAPL");
  });
});

describe("fetchDailyCloses", () => {
  const from = new Date("2024-01-01T00:00:00Z");
  const to = new Date("2024-01-05T00:00:00Z");

  it("parses a valid response into date/close pairs using adjclose", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, validChartBody()));

    const result = await fetchDailyCloses("AAPL", from, to, { fetchImpl });

    expect(result).toEqual([
      { date: "2024-01-02", close: 183.4 },
      { date: "2024-01-03", close: 182.03 },
    ]);
  });

  it("sends a browser-like User-Agent header", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, validChartBody()));

    await fetchDailyCloses("AAPL", from, to, { fetchImpl });

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["User-Agent"]).toMatch(/Mozilla/);
  });

  it("skips days with a null close value", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(
        200,
        validChartBody({
          timestamp: [1704205800, 1704292200, 1704378600],
          adjclose: [183.4, null, 179.72],
        }),
      ),
    );

    const result = await fetchDailyCloses("AAPL", from, to, { fetchImpl });

    expect(result).toEqual([
      { date: "2024-01-02", close: 183.4 },
      { date: "2024-01-04", close: 179.72 },
    ]);
  });

  it("falls back to raw close when adjclose is absent", async () => {
    const body = validChartBody();
    const [firstResult] = body.chart.result;
    if (!firstResult) throw new Error("test fixture is missing its chart result");
    delete (firstResult.indicators as { adjclose?: unknown }).adjclose;
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, body));

    const result = await fetchDailyCloses("AAPL", from, to, { fetchImpl });

    expect(result).toEqual([
      { date: "2024-01-02", close: 100 },
      { date: "2024-01-03", close: 100 },
    ]);
  });

  it("throws TickerNotFoundError when Yahoo reports a chart error (e.g. delisted/invalid symbol)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        chart: { result: null, error: { code: "Not Found", description: "No data found" } },
      }),
    );

    await expect(fetchDailyCloses("NOTASYMBOL", from, to, { fetchImpl })).rejects.toThrow(
      TickerNotFoundError,
    );
  });

  it("throws TickerNotFoundError immediately on a non-retryable HTTP error (no retries)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(404, {}));

    await expect(fetchDailyCloses("AAPL", from, to, { fetchImpl })).rejects.toThrow(
      TickerNotFoundError,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([401, 403])(
    "throws BlockedError immediately on HTTP %d, distinct from TickerNotFoundError (no retries)",
    async (status) => {
      const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(status, {}));

      const error = await fetchDailyCloses("AAPL", from, to, { fetchImpl }).catch((e) => e);

      expect(error).toBeInstanceOf(BlockedError);
      expect(error).not.toBeInstanceOf(TickerNotFoundError);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    },
  );

  it("throws UnexpectedResponseError (not TickerNotFoundError) on a non-retryable status other than 404/401/403", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(400, {}));

    const error = await fetchDailyCloses("AAPL", from, to, { fetchImpl }).catch((e) => e);

    expect(error).toBeInstanceOf(UnexpectedResponseError);
    expect(error).not.toBeInstanceOf(TickerNotFoundError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("returns an empty array for a legitimately empty range without retrying or erroring", async () => {
    // Verified live (issue #3 follow-up): Yahoo's real response for a
    // range with no trading data (e.g. a weekend-only window) omits
    // `timestamp` entirely and returns `quote: [{}]` / `adjclose: [{}]`
    // — no `close`/`adjclose` key at all, not even an empty array. A
    // hand-guessed `{ timestamp: [], quote: [{ close: [] }] }` fixture
    // would NOT have caught the real bug this shape triggered.
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        chart: {
          result: [
            {
              meta: { gmtoffset: -14400 },
              indicators: { quote: [{}], adjclose: [{}] },
            },
          ],
          error: null,
        },
      }),
    );

    const result = await fetchDailyCloses("AAPL", from, to, { fetchImpl });

    expect(result).toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("pads period2 so the requested end date is fully covered", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, validChartBody()));

    await fetchDailyCloses("AAPL", from, to, { fetchImpl });

    const [url] = fetchImpl.mock.calls[0] as [string];
    const period2 = Number(new URL(url).searchParams.get("period2"));
    const requestedEndSeconds = Math.floor(to.getTime() / 1000);
    expect(period2).toBeGreaterThanOrEqual(requestedEndSeconds + 24 * 60 * 60);
  });

  it("passes an AbortSignal (timeout) to the fetch call", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, validChartBody()));

    await fetchDailyCloses("AAPL", from, to, { fetchImpl });

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  describe("retry behavior", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("retries on a 5xx response and succeeds if a later attempt works", async () => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse(500, {}))
        .mockResolvedValueOnce(jsonResponse(200, validChartBody()));

      const promise = fetchDailyCloses("AAPL", from, to, { fetchImpl });
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result.length).toBe(2);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it("retries on a network error and succeeds if a later attempt works", async () => {
      const fetchImpl = vi
        .fn()
        .mockRejectedValueOnce(new Error("network down"))
        .mockResolvedValueOnce(jsonResponse(200, validChartBody()));

      const promise = fetchDailyCloses("AAPL", from, to, { fetchImpl });
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result.length).toBe(2);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it("throws TransientFetchError after exhausting retries on persistent 5xx", async () => {
      const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(503, {}));

      const promise = fetchDailyCloses("AAPL", from, to, { fetchImpl });
      const expectation = expect(promise).rejects.toThrow(TransientFetchError);
      await vi.runAllTimersAsync();
      await expectation;
    });

    it("retries a 200 response with a non-JSON body (e.g. an anti-bot HTML page) instead of crashing", async () => {
      const htmlResponse = new Response("<html>not json</html>", { status: 200 });
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(htmlResponse)
        .mockResolvedValueOnce(jsonResponse(200, validChartBody()));

      const promise = fetchDailyCloses("AAPL", from, to, { fetchImpl });
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result.length).toBe(2);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it("retries an empty/malformed result shape instead of throwing immediately", async () => {
      const malformed = { chart: { result: [], error: null } };
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse(200, malformed))
        .mockResolvedValueOnce(jsonResponse(200, validChartBody()));

      const promise = fetchDailyCloses("AAPL", from, to, { fetchImpl });
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result.length).toBe(2);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it("retries when timestamps are present but close data is entirely empty (malformed, not legitimately empty)", async () => {
      const malformed = {
        chart: {
          result: [
            {
              meta: { gmtoffset: -14400 },
              timestamp: [1704205800, 1704292200],
              indicators: { quote: [{ close: [] }], adjclose: [{ adjclose: [] }] },
            },
          ],
          error: null,
        },
      };
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse(200, malformed))
        .mockResolvedValueOnce(jsonResponse(200, validChartBody()));

      const promise = fetchDailyCloses("AAPL", from, to, { fetchImpl });
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result.length).toBe(2);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it("caps the Retry-After wait instead of honoring an arbitrarily large server-supplied value", async () => {
      const rateLimited = new Response(JSON.stringify({}), {
        status: 429,
        headers: { "Retry-After": "3600" }, // 1 hour — should be capped
      });
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(rateLimited)
        .mockResolvedValueOnce(jsonResponse(200, validChartBody()));

      const promise = fetchDailyCloses("AAPL", from, to, { fetchImpl });

      // The cap (30s) should have elapsed and triggered the retry well
      // before the full requested hour would have.
      await vi.advanceTimersByTimeAsync(31_000);
      const result = await promise;

      expect(result.length).toBe(2);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it("retries when every close is present but invalid (all zero), not just when the array is empty", async () => {
      // Regression test: the malformed-response check used to look at
      // the raw close array length, which is non-empty here even though
      // every value is invalid and gets filtered out by parseChartResult
      // — the check must run on the *parsed* output, not the raw shape.
      const allInvalid = {
        chart: {
          result: [
            {
              meta: { gmtoffset: -14400 },
              timestamp: [1704205800, 1704292200],
              indicators: { quote: [{ close: [0, 0] }], adjclose: [{ adjclose: [0, 0] }] },
            },
          ],
          error: null,
        },
      };
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse(200, allInvalid))
        .mockResolvedValueOnce(jsonResponse(200, validChartBody()));

      const promise = fetchDailyCloses("AAPL", from, to, { fetchImpl });
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result.length).toBe(2);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it("waits at least the Retry-After duration before retrying a 429", async () => {
      const rateLimited = new Response(JSON.stringify({}), {
        status: 429,
        headers: { "Retry-After": "5" },
      });
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(rateLimited)
        .mockResolvedValueOnce(jsonResponse(200, validChartBody()));

      const promise = fetchDailyCloses("AAPL", from, to, { fetchImpl });

      // Advancing only 1s (less than Retry-After: 5) should NOT trigger the retry yet.
      await vi.advanceTimersByTimeAsync(1000);
      expect(fetchImpl).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(4500);
      const result = await promise;

      expect(result.length).toBe(2);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    });
  });
});

describe("fetchIntradayBars", () => {
  const from = new Date("2024-01-01T00:00:00Z");
  const to = new Date("2024-01-05T00:00:00Z");

  it("parses a valid response into full local-datetime/close pairs (issue #28)", async () => {
    // Same two timestamps as fetchDailyCloses's fixtures, gmtoffset -4h
    // (EDT) -- 1704205800 -> 2024-01-02T10:30:00 local, not just
    // "2024-01-02": the whole point of this function vs. fetchDailyCloses
    // is keeping the time-of-day, not truncating to a calendar date.
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, validChartBody()));

    const result = await fetchIntradayBars("AAPL", from, to, { fetchImpl });

    expect(result).toEqual([
      { date: "2024-01-02T10:30:00", close: 183.4 },
      { date: "2024-01-03T10:30:00", close: 182.03 },
    ]);
  });

  it("requests interval=60m, distinct from fetchDailyCloses's interval=1d", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, validChartBody()));

    await fetchIntradayBars("AAPL", from, to, { fetchImpl });

    const [url] = fetchImpl.mock.calls[0] as [string];
    expect(new URL(url).searchParams.get("interval")).toBe("60m");
  });

  it("pads period2 by a day, same as fetchDailyCloses -- a midnight-UTC `to` (e.g. toDateString's convention) must still cover that day's market-hours bars", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, validChartBody()));

    await fetchIntradayBars("AAPL", from, to, { fetchImpl });

    const [url] = fetchImpl.mock.calls[0] as [string];
    const period2 = Number(new URL(url).searchParams.get("period2"));
    const requestedEndSeconds = Math.floor(to.getTime() / 1000);
    expect(period2).toBeGreaterThanOrEqual(requestedEndSeconds + 24 * 60 * 60);
  });

  it("shares the same error classification as fetchDailyCloses (e.g. BlockedError on 401, not retried)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(401, {}));

    const error = await fetchIntradayBars("AAPL", from, to, { fetchImpl }).catch((e) => e);

    expect(error).toBeInstanceOf(BlockedError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("shares the same malformed-shape retry as fetchDailyCloses", async () => {
    vi.useFakeTimers();
    try {
      const malformed = { chart: { result: [], error: null } };
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse(200, malformed))
        .mockResolvedValueOnce(jsonResponse(200, validChartBody()));

      const promise = fetchIntradayBars("AAPL", from, to, { fetchImpl });
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result.length).toBe(2);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("fetchFiveMinuteBars", () => {
  const from = new Date("2024-01-01T00:00:00Z");
  const to = new Date("2024-01-05T00:00:00Z");

  it("parses a valid response into full local-datetime/close pairs, same shape as fetchIntradayBars (issue #30)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, validChartBody()));

    const result = await fetchFiveMinuteBars("AAPL", from, to, { fetchImpl });

    expect(result).toEqual([
      { date: "2024-01-02T10:30:00", close: 183.4 },
      { date: "2024-01-03T10:30:00", close: 182.03 },
    ]);
  });

  it("requests interval=5m, distinct from fetchIntradayBars's interval=60m", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, validChartBody()));

    await fetchFiveMinuteBars("AAPL", from, to, { fetchImpl });

    const [url] = fetchImpl.mock.calls[0] as [string];
    expect(new URL(url).searchParams.get("interval")).toBe("5m");
  });

  it("pads period2 by a day, same as fetchIntradayBars/fetchDailyCloses", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, validChartBody()));

    await fetchFiveMinuteBars("AAPL", from, to, { fetchImpl });

    const [url] = fetchImpl.mock.calls[0] as [string];
    const period2 = Number(new URL(url).searchParams.get("period2"));
    const requestedEndSeconds = Math.floor(to.getTime() / 1000);
    expect(period2).toBeGreaterThanOrEqual(requestedEndSeconds + 24 * 60 * 60);
  });

  it("shares the same error classification as fetchIntradayBars (e.g. BlockedError on 401, not retried)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(401, {}));

    const error = await fetchFiveMinuteBars("AAPL", from, to, { fetchImpl }).catch((e) => e);

    expect(error).toBeInstanceOf(BlockedError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("surfaces an out-of-retention request as UnexpectedResponseError, not TickerNotFoundError -- verified live that Yahoo's 422 status short-circuits fetchChartSeries before it ever inspects chart.error (issue #30's 60-day retention wall)", async () => {
    const outOfRetention = {
      chart: {
        result: null,
        error: {
          code: "Unprocessable Entity",
          description:
            "5m data not available for startTime=1700000000 and endTime=1705000000. The requested range must be within the last 60 days.",
        },
      },
    };
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(422, outOfRetention));

    const error = await fetchFiveMinuteBars("AAPL", from, to, { fetchImpl }).catch((e) => e);

    expect(error).toBeInstanceOf(UnexpectedResponseError);
    expect(fetchImpl).toHaveBeenCalledTimes(1); // 422 isn't a retryable status
  });
});

describe("fetchIntraday1mBars (issue #29)", () => {
  // A ~30-day range: 29 days from `from` to `to`, plus the 1-day
  // end-padding every intraday fetch adds, gives a total 30-day span --
  // chunked into 8+8+8+6 days (4 chunks), matching this issue's own
  // worked example (Yahoo caps a single interval=1m request at 8 days).
  const from = new Date("2024-01-01T00:00:00Z");
  const to = new Date("2024-01-30T00:00:00Z");
  const ONE_DAY_SECONDS = 24 * 60 * 60;
  const ONE_MINUTE_CHUNK_DAYS = 8; // mirrors the module-private constant of the same name

  function chunkBoundaries(fromDate: Date, toDate: Date): { period1: number; period2: number }[] {
    const period1Total = Math.floor(fromDate.getTime() / 1000);
    const period2Total = Math.floor(toDate.getTime() / 1000) + ONE_DAY_SECONDS;
    const chunkSeconds = ONE_MINUTE_CHUNK_DAYS * ONE_DAY_SECONDS;
    const chunks: { period1: number; period2: number }[] = [];
    let start = period1Total;
    while (start < period2Total) {
      const end = Math.min(start + chunkSeconds, period2Total);
      chunks.push({ period1: start, period2: end });
      start = end;
    }
    return chunks;
  }

  it("parses a valid response into full local-datetime/close pairs, same shape as fetchIntradayBars/fetchFiveMinuteBars", async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => jsonResponse(200, validChartBody()));

    const result = await fetchIntraday1mBars("AAPL", from, to, { fetchImpl });

    // The first chunk's response wins for these two dates (every later
    // chunk's mocked response repeats the same fixture dates, deduped
    // away) -- see the dedup test below for that behavior in isolation.
    expect(result).toEqual([
      { date: "2024-01-02T10:30:00", close: 183.4 },
      { date: "2024-01-03T10:30:00", close: 182.03 },
    ]);
  });

  it("requests interval=1m", async () => {
    // A fresh Response per call -- a mockResolvedValue'd single Response
    // instance would have its body consumed by the first of 4 chunk
    // fetches and throw "Body is unusable" on the rest.
    const fetchImpl = vi.fn().mockImplementation(async () => jsonResponse(200, validChartBody()));

    await fetchIntraday1mBars("AAPL", from, to, { fetchImpl });

    const [url] = fetchImpl.mock.calls[0] as [string];
    expect(new URL(url).searchParams.get("interval")).toBe("1m");
  });

  it("splits a ~30-day range into 4 chunks of at most 8 days each, only the final chunk padded", async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => jsonResponse(200, validChartBody()));

    await fetchIntraday1mBars("AAPL", from, to, { fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(4);
    const expected = chunkBoundaries(from, to);
    expect(expected).toHaveLength(4);
    // 8+8+8+6 days.
    expect(expected.map((c) => (c.period2 - c.period1) / ONE_DAY_SECONDS)).toEqual([8, 8, 8, 6]);

    fetchImpl.mock.calls.forEach((call, i) => {
      const [url] = call as [string];
      const params = new URL(url).searchParams;
      expect(Number(params.get("period1"))).toBe(expected[i]!.period1);
      expect(Number(params.get("period2"))).toBe(expected[i]!.period2);
    });

    // Non-overlapping: each chunk's end is exactly the next chunk's start.
    for (let i = 0; i < expected.length - 1; i++) {
      expect(expected[i]!.period2).toBe(expected[i + 1]!.period1);
    }
    // Only the last chunk's period2 carries the day-padding (i.e. sits
    // strictly past the requested `to`, converted to seconds).
    const requestedToSeconds = Math.floor(to.getTime() / 1000);
    expect(expected[expected.length - 1]!.period2).toBeGreaterThanOrEqual(
      requestedToSeconds + ONE_DAY_SECONDS,
    );
    for (let i = 0; i < expected.length - 1; i++) {
      expect(expected[i]!.period2).toBeLessThan(requestedToSeconds + ONE_DAY_SECONDS);
    }
  });

  it("issues exactly 1 chunk request for a range within a single 8-day window", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, validChartBody()));
    const shortFrom = new Date("2024-01-01T00:00:00Z");
    const shortTo = new Date("2024-01-03T00:00:00Z"); // 2 days + 1 day padding = 3 days, well under 8.

    await fetchIntraday1mBars("AAPL", shortFrom, shortTo, { fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("fetches chunks sequentially, not concurrently", async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    const fetchImpl = vi.fn().mockImplementation(async () => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((resolve) => setTimeout(resolve, 5));
      concurrent--;
      return jsonResponse(200, validChartBody());
    });

    await fetchIntraday1mBars("AAPL", from, to, { fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(maxConcurrent).toBe(1);
  });

  it("concatenates chunks in order, deduping any bar with a repeated `date` across a chunk seam", async () => {
    // 15 days from -> to, plus 1 day of end-padding = 16-day total span,
    // exactly 2 chunks of 8 days each (no remainder), so the two mocked
    // responses below map 1:1 to the two chunks.
    const twoChunkFrom = new Date("2024-01-01T00:00:00Z");
    const twoChunkTo = new Date("2024-01-16T00:00:00Z");

    // Chunk 1: two bars. Chunk 2: a duplicate of the second bar's date
    // (simulating a boundary artifact) plus one genuinely new bar.
    const chunk1 = validChartBody({
      timestamp: [1704205800, 1704292200], // 2024-01-02T10:30:00, 2024-01-03T10:30:00
      adjclose: [183.4, 182.03],
    });
    const chunk2 = validChartBody({
      timestamp: [1704292200, 1704378600], // 2024-01-03T10:30:00 (dup), 2024-01-04T10:30:00
      adjclose: [999, 179.72],
    });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, chunk1))
      .mockResolvedValueOnce(jsonResponse(200, chunk2));

    const result = await fetchIntraday1mBars("AAPL", twoChunkFrom, twoChunkTo, { fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result).toEqual([
      { date: "2024-01-02T10:30:00", close: 183.4 },
      { date: "2024-01-03T10:30:00", close: 182.03 }, // first occurrence wins, not chunk 2's 999
      { date: "2024-01-04T10:30:00", close: 179.72 },
    ]);
  });

  it.each([
    ["first", 0],
    ["middle", 1],
    ["last", 2],
  ])(
    "propagates a BlockedError from the %s chunk immediately, discarding earlier chunks' bars and skipping later ones",
    async (_label, failAt) => {
      // A 24-day range -> exactly 3 chunks of 8 days each.
      const threeChunkTo = new Date("2024-01-24T00:00:00Z");
      let callIndex = 0;
      const fetchImpl = vi.fn().mockImplementation(async () => {
        const isFailingChunk = callIndex === failAt;
        callIndex++;
        if (isFailingChunk) return jsonResponse(403, {});
        return jsonResponse(200, validChartBody());
      });

      const error = await fetchIntraday1mBars("AAPL", from, threeChunkTo, { fetchImpl }).catch(
        (e: unknown) => e,
      );

      expect(error).toBeInstanceOf(BlockedError);
      // No requests fired past the failing chunk.
      expect(fetchImpl).toHaveBeenCalledTimes(failAt + 1);
    },
  );

  it("discards all fetched bars for the ticker when a later chunk's TransientFetchError exhausts retries (no partial-month result)", async () => {
    vi.useFakeTimers();
    try {
      // A 16-day range -> exactly 2 chunks. First chunk succeeds; second
      // chunk fails every attempt.
      const twoChunkTo = new Date("2024-01-15T00:00:00Z");
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse(200, validChartBody()))
        .mockResolvedValue(jsonResponse(503, {}));

      const promise = fetchIntraday1mBars("AAPL", from, twoChunkTo, { fetchImpl });
      const expectation = expect(promise).rejects.toThrow(TransientFetchError);
      await vi.runAllTimersAsync();
      await expectation;
    } finally {
      vi.useRealTimers();
    }
  });

  it("surfaces an out-of-retention chunk as UnexpectedResponseError, not TickerNotFoundError -- same 422 short-circuit as fetchFiveMinuteBars (issue #29's 30-day retention wall)", async () => {
    const outOfRetention = {
      chart: {
        result: null,
        error: {
          code: "Unprocessable Entity",
          description:
            "1m data not available for startTime=1700000000 and endTime=1700604800. The requested range must be within the last 30 days.",
        },
      },
    };
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(422, outOfRetention));

    const error = await fetchIntraday1mBars("AAPL", from, to, { fetchImpl }).catch((e) => e);

    expect(error).toBeInstanceOf(UnexpectedResponseError);
    expect(fetchImpl).toHaveBeenCalledTimes(1); // 422 isn't a retryable status, and the first chunk already fails
  });
});
