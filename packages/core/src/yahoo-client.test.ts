import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  fetchDailyCloses,
  TickerNotFoundError,
  toYahooSymbol,
  TransientFetchError,
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
  });
});
