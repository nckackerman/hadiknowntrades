import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { IntradayDayResult, IntradayTrade } from "@hadiknowntrades/core";

import type { Mode } from "./mode";
import { useDailyChallenge, type UseDailyChallengeResult } from "./use-daily-challenge";

function trade(overrides: Partial<IntradayTrade> = {}): IntradayTrade {
  return {
    ticker: "AVGO",
    direction: "long",
    date: "2026-08-25",
    openTime: "09:35:00",
    openPrice: 170.1,
    closeTime: "10:40:00",
    closePrice: 172.8,
    ...overrides,
  };
}

function day(overrides: Partial<IntradayDayResult> = {}): IntradayDayResult {
  return {
    date: "2026-08-25",
    startingCapital: 28.12,
    endingBalance: 34.5,
    barIntervalMinutes: 60,
    trades: [trade()],
    worstCase: { startingCapital: 28.12, endingBalance: 27, trades: [] },
    longShort: {
      startingCapital: 30,
      endingBalance: 40,
      trades: [],
      worstCase: { startingCapital: 30, endingBalance: 29, trades: [] },
    },
    ...overrides,
  };
}

function stubResultsFetch(body: unknown): void {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => body }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useDailyChallenge", () => {
  it("reports loading: true, dailyChallenge: null before the fetch resolves", () => {
    stubResultsFetch({ model: "intraday-daily", days: [day()] });
    const { result } = renderHook(() => useDailyChallenge("long"));

    expect(result.current).toEqual({ dailyChallenge: null, loading: true });
  });

  it("recompounds the most recent day in data.days from a fresh $20 once the fetch resolves", async () => {
    stubResultsFetch({
      model: "intraday-daily",
      days: [day({ date: "2026-08-24" }), day({ date: "2026-08-25" })],
    });
    const { result } = renderHook(() => useDailyChallenge("long"));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.dailyChallenge).not.toBeNull();
    expect(result.current.dailyChallenge!.date).toBe("2026-08-25");
    expect(result.current.dailyChallenge!.startingCapital).toBe(20);
    expect(result.current.dailyChallenge!.endingBalance).toBeCloseTo(20 * (172.8 / 170.1));
  });

  it("degrades to loading: false, dailyChallenge: null on a fetch error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    const { result } = renderHook(() => useDailyChallenge("long"));

    await act(async () => {});
    expect(result.current).toEqual({ dailyChallenge: null, loading: false });
  });

  it("degrades to loading: false, dailyChallenge: null for a window-model result (no trading days to recompound)", async () => {
    stubResultsFetch({ model: "window", trades: [] });
    const { result } = renderHook(() => useDailyChallenge("long"));

    await act(async () => {});
    expect(result.current).toEqual({ dailyChallenge: null, loading: false });
  });

  it("degrades to loading: false, dailyChallenge: null when the range has no trading days yet", async () => {
    stubResultsFetch({ model: "intraday-daily", days: [] });
    const { result } = renderHook(() => useDailyChallenge("long"));

    await act(async () => {});
    expect(result.current).toEqual({ dailyChallenge: null, loading: false });
  });

  it("re-derives from the long+short variant when mode changes (issue #13)", async () => {
    stubResultsFetch({
      model: "intraday-daily",
      days: [
        day({
          longShort: {
            startingCapital: 30,
            endingBalance: 40,
            trades: [trade({ ticker: "SHORTED", direction: "short" })],
            worstCase: { startingCapital: 30, endingBalance: 29, trades: [] },
          },
        }),
      ],
    });
    const { result, rerender } = renderHook<UseDailyChallengeResult, { mode: Mode }>(
      ({ mode }) => useDailyChallenge(mode),
      { initialProps: { mode: "long" } },
    );

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.dailyChallenge!.trades[0]!.ticker).toBe("AVGO");

    rerender({ mode: "long-short" });
    expect(result.current.dailyChallenge!.trades[0]!.ticker).toBe("SHORTED");
  });
});
