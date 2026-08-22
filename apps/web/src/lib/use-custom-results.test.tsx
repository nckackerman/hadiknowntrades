import { RESULTS_SCHEMA_VERSION, type CustomWindowResult } from "@hadiknowntrades/core";
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useCustomResults } from "./use-custom-results";

function fixtureResult(): CustomWindowResult {
  return {
    schemaVersion: RESULTS_SCHEMA_VERSION,
    model: "custom-window",
    anchorMonth: "2019-03",
    generatedAt: "2026-08-21T19:50:21.468Z",
    dataAsOf: "2026-08-21",
    startDate: "2019-03-01",
    endDate: "2026-08-21",
    maxTrades: 3,
    startingCapital: 20,
    endingBalance: 42,
    trades: [],
    worstCase: { endingBalance: 20, trades: [] },
    universeSize: 503,
    skippedTickers: [],
    benchmark: null,
  };
}

describe("useCustomResults", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns null (no fetch) when anchor is null", () => {
    const { result } = renderHook(() => useCustomResults(null));

    expect(result.current).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("starts in the loading state when anchor is non-null", () => {
    vi.mocked(fetch).mockReturnValue(new Promise(() => {})); // never resolves
    const { result } = renderHook(() => useCustomResults("2019-03"));

    expect(result.current).toEqual({ status: "loading" });
  });

  it("transitions to success with the parsed body on a 200", async () => {
    const data = fixtureResult();
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify(data), { status: 200 }));

    const { result } = renderHook(() => useCustomResults("2019-03"));

    await waitFor(() => expect(result.current?.status).toBe("success"));
    expect(result.current).toEqual({ status: "success", data });
  });

  it("transitions to error with the API's error/message shape on a non-2xx response", async () => {
    const body = {
      error: "not_found",
      message: 'No precomputed results are available for the custom start date "2019-03".',
    };
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify(body), { status: 404 }));

    const { result } = renderHook(() => useCustomResults("2019-03"));

    await waitFor(() => expect(result.current?.status).toBe("error"));
    expect(result.current).toEqual({ status: "error", httpStatus: 404, ...body });
  });

  it("transitions to a network_error when the fetch itself rejects", async () => {
    vi.mocked(fetch).mockRejectedValue(new Error("Failed to fetch"));

    const { result } = renderHook(() => useCustomResults("2019-03"));

    await waitFor(() => expect(result.current?.status).toBe("error"));
    expect(result.current).toMatchObject({ status: "error", error: "network_error" });
  });

  it("requests the anchor-specific endpoint", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify(fixtureResult()), { status: 200 }),
    );

    renderHook(() => useCustomResults("2019-03"));

    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/results?anchor=2019-03"));
  });

  it("re-fetches and resets to loading when the anchor changes", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify(fixtureResult()), { status: 200 }),
    );

    const { result, rerender } = renderHook(
      ({ anchor }: { anchor: string | null }) => useCustomResults(anchor),
      { initialProps: { anchor: "2019-03" } },
    );
    await waitFor(() => expect(result.current?.status).toBe("success"));

    rerender({ anchor: "2020-01" });
    expect(result.current).toEqual({ status: "loading" });

    await waitFor(() => expect(fetch).toHaveBeenLastCalledWith("/api/results?anchor=2020-01"));
  });

  it("resets to null (stops fetching) when the anchor becomes null", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify(fixtureResult()), { status: 200 }),
    );

    const { result, rerender } = renderHook(
      ({ anchor }: { anchor: string | null }) => useCustomResults(anchor),
      { initialProps: { anchor: "2019-03" } as { anchor: string | null } },
    );
    await waitFor(() => expect(result.current?.status).toBe("success"));

    rerender({ anchor: null });
    expect(result.current).toBeNull();
  });
});
