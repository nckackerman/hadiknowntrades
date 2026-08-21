import type { PrecomputedResult, PresetRange } from "@hadiknowntrades/core";
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useResults } from "./use-results";

function fixtureResult(): PrecomputedResult {
  return {
    schemaVersion: 2,
    model: "window",
    range: "1Y",
    generatedAt: "2026-08-21T19:50:21.468Z",
    dataAsOf: "2026-08-21",
    startDate: "2025-08-21",
    endDate: "2026-08-21",
    maxTrades: 3,
    startingCapital: 20,
    endingBalance: 42,
    trades: [],
    universeSize: 503,
    skippedTickers: [],
  };
}

describe("useResults", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("starts in the loading state", () => {
    vi.mocked(fetch).mockReturnValue(new Promise(() => {})); // never resolves
    const { result } = renderHook(() => useResults("1Y"));

    expect(result.current).toEqual({ status: "loading" });
  });

  it("transitions to success with the parsed body on a 200", async () => {
    const data = fixtureResult();
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify(data), { status: 200 }));

    const { result } = renderHook(() => useResults("1Y"));

    await waitFor(() => expect(result.current.status).toBe("success"));
    expect(result.current).toEqual({ status: "success", data });
  });

  it("transitions to error with the API's error/message shape on a non-2xx response", async () => {
    const body = {
      error: "not_found",
      message: 'No precomputed results are available yet for range "1Y".',
    };
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify(body), { status: 404 }));

    const { result } = renderHook(() => useResults("1Y"));

    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current).toEqual({ status: "error", httpStatus: 404, ...body });
  });

  it("transitions to a network_error when the fetch itself rejects", async () => {
    vi.mocked(fetch).mockRejectedValue(new Error("Failed to fetch"));

    const { result } = renderHook(() => useResults("1Y"));

    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current).toMatchObject({ status: "error", error: "network_error" });
  });

  it("requests the range-specific endpoint", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify(fixtureResult()), { status: 200 }),
    );

    renderHook(() => useResults("MAX"));

    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/results?range=MAX"));
  });

  it("re-fetches and resets to loading when the range changes", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify(fixtureResult()), { status: 200 }),
    );

    const { result, rerender } = renderHook(
      ({ range }: { range: PresetRange }) => useResults(range),
      {
        initialProps: { range: "1Y" },
      },
    );
    await waitFor(() => expect(result.current.status).toBe("success"));

    rerender({ range: "5Y" as const });
    expect(result.current).toEqual({ status: "loading" });

    await waitFor(() => expect(fetch).toHaveBeenLastCalledWith("/api/results?range=5Y"));
  });
});
