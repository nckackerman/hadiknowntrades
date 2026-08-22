import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  BlockedError,
  fetchDailyCloses,
  fetchFiveMinuteBars,
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
