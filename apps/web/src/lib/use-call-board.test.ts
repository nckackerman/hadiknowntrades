import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DailyClose } from "@hadiknowntrades/core";

import { getCallBoardPick, saveResolvedCalls } from "./call-board-storage";
import { useCallBoard, useCallBoardCloses } from "./use-call-board";

// A Wednesday at 9:00 AM New York time (EDT = UTC-4), i.e. before that
// day's own 9:30 open -- so 2026-08-26 itself is still callable and leads
// the lookahead. See market-calendar.ts's `hasMarketOpened`.
const WEDNESDAY_BEFORE_OPEN = new Date("2026-08-26T13:00:00Z");
const WEDNESDAY_AFTER_OPEN = new Date("2026-08-26T14:00:00Z");
const SATURDAY = new Date("2026-08-29T13:00:00Z");
// Labor Day 2026 (first Monday of September) -- a scheduled market holiday.
const LABOR_DAY = new Date("2026-09-07T13:00:00Z");

/** Only `Date` is faked; real timers and the microtask queue are left alone, since the hydration correction rides on `queueMicrotask`. */
function freezeClock(at: Date): void {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(at);
}

const NO_CLOSES: readonly DailyClose[] = [];

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("useCallBoard", () => {
  it("reports an inert, clock-free board on the very first render, then corrects after mount", async () => {
    freezeClock(SATURDAY);
    const { result } = renderHook(() => useCallBoard(NO_CLOSES));

    expect(result.current.view).toEqual({
      board: {
        openCalls: [],
        resolved: [],
        stats: {
          resolvedCalls: 0,
          wins: 0,
          winRate: null,
          totalPoints: 0,
          currentStreak: 0,
          bestStreak: 0,
        },
      },
      // Deliberately false regardless of what day it actually is -- the
      // server can't know, so neither does the first client render.
      marketClosedToday: false,
      hydrated: false,
    });

    await act(async () => {});
    expect(result.current.view.hydrated).toBe(true);
    expect(result.current.view.marketClosedToday).toBe(true);
  });

  it("shows the next three trading sessions, unset, on a first visit", async () => {
    freezeClock(WEDNESDAY_BEFORE_OPEN);
    const { result } = renderHook(() => useCallBoard(NO_CLOSES));
    await act(async () => {});

    expect(result.current.view.board.openCalls).toEqual([
      { date: "2026-08-26", pick: null },
      { date: "2026-08-27", pick: null },
      { date: "2026-08-28", pick: null },
    ]);
    expect(result.current.view.board.resolved).toEqual([]);
    expect(result.current.view.board.stats).toMatchObject({
      resolvedCalls: 0,
      winRate: null,
      currentStreak: 0,
      bestStreak: 0,
    });
    expect(result.current.view.marketClosedToday).toBe(false);
  });

  it("drops today off the front once its own session has opened", async () => {
    freezeClock(WEDNESDAY_AFTER_OPEN);
    const { result } = renderHook(() => useCallBoard(NO_CLOSES));
    await act(async () => {});

    expect(result.current.view.board.openCalls.map((call) => call.date)).toEqual([
      "2026-08-27",
      "2026-08-28",
      "2026-08-31",
    ]);
  });

  it("skips the weekend and flags that today isn't a trading day", async () => {
    freezeClock(SATURDAY);
    const { result } = renderHook(() => useCallBoard(NO_CLOSES));
    await act(async () => {});

    expect(result.current.view.marketClosedToday).toBe(true);
    expect(result.current.view.board.openCalls.map((call) => call.date)).toEqual([
      "2026-08-31",
      "2026-09-01",
      "2026-09-02",
    ]);
  });

  it("skips a scheduled market holiday the same way", async () => {
    freezeClock(LABOR_DAY);
    const { result } = renderHook(() => useCallBoard(NO_CLOSES));
    await act(async () => {});

    expect(result.current.view.marketClosedToday).toBe(true);
    expect(result.current.view.board.openCalls.map((call) => call.date)).toEqual([
      "2026-09-08",
      "2026-09-09",
      "2026-09-10",
    ]);
  });

  it("saves a call immediately, with no separate lock-in step", async () => {
    freezeClock(WEDNESDAY_BEFORE_OPEN);
    const { result } = renderHook(() => useCallBoard(NO_CLOSES));
    await act(async () => {});

    let saved = false;
    act(() => {
      saved = result.current.makeCall("2026-08-27", "up-strong");
    });

    expect(saved).toBe(true);
    expect(getCallBoardPick("2026-08-27")).toBe("up-strong");
    expect(result.current.view.board.openCalls).toContainEqual({
      date: "2026-08-27",
      pick: "up-strong",
    });
  });

  it("lets an open call be changed, since nothing is locked until that session opens", async () => {
    freezeClock(WEDNESDAY_BEFORE_OPEN);
    const { result } = renderHook(() => useCallBoard(NO_CLOSES));
    await act(async () => {});

    act(() => {
      result.current.makeCall("2026-08-27", "up");
    });
    act(() => {
      result.current.makeCall("2026-08-27", "down-strong");
    });

    expect(getCallBoardPick("2026-08-27")).toBe("down-strong");
  });

  it("reports a refused write for a session that has already opened, and stores nothing", async () => {
    freezeClock(WEDNESDAY_AFTER_OPEN);
    const { result } = renderHook(() => useCallBoard(NO_CLOSES));
    await act(async () => {});

    let saved = true;
    act(() => {
      saved = result.current.makeCall("2026-08-26", "up");
    });

    expect(saved).toBe(false);
    expect(getCallBoardPick("2026-08-26")).toBeNull();
  });

  it("hydrates a previously-stored history after mount rather than during the first render", async () => {
    freezeClock(WEDNESDAY_BEFORE_OPEN);
    saveResolvedCalls([
      { date: "2026-08-24", pick: "up", actual: "up", moveFraction: 0.002, score: 2 },
      { date: "2026-08-25", pick: "up", actual: "down", moveFraction: -0.002, score: 0 },
    ]);

    const { result } = renderHook(() => useCallBoard(NO_CLOSES));
    // The very first render reads neither storage nor the clock, so the
    // server-rendered HTML and the client's hydration render always agree
    // -- see UNHYDRATED_VIEW's own doc comment.
    expect(result.current.view.hydrated).toBe(false);
    expect(result.current.view.board.resolved).toEqual([]);
    expect(result.current.view.board.openCalls).toEqual([]);
    expect(result.current.view.marketClosedToday).toBe(false);

    await waitFor(() => {
      expect(result.current.view.board.resolved).toHaveLength(2);
    });
    expect(result.current.view.board.stats).toMatchObject({
      resolvedCalls: 2,
      wins: 1,
      currentStreak: 0,
      bestStreak: 1,
    });
  });

  it("settles a stored pick once a real close series covers it", async () => {
    freezeClock(WEDNESDAY_BEFORE_OPEN);
    // A pick made for 2026-08-25 while it was still editable.
    vi.setSystemTime(new Date("2026-08-24T13:00:00Z"));
    const { result, rerender } = renderHook(
      ({ closes }: { closes: readonly DailyClose[] }) => useCallBoard(closes),
      { initialProps: { closes: NO_CLOSES } },
    );
    await act(async () => {});
    act(() => {
      result.current.makeCall("2026-08-25", "up-strong");
    });

    // The series arrives (the /api/results fetch resolving), now with the
    // called day closed: +1.0%, an exact "up-strong" match.
    vi.setSystemTime(WEDNESDAY_BEFORE_OPEN);
    const closes: DailyClose[] = [
      { date: "2026-08-24", close: 100 },
      { date: "2026-08-25", close: 101 },
    ];
    rerender({ closes });
    await waitFor(() => {
      expect(result.current.view.board.resolved).toHaveLength(1);
    });

    expect(result.current.view.board.resolved[0]).toMatchObject({
      date: "2026-08-25",
      pick: "up-strong",
      actual: "up-strong",
      score: 2,
    });
    expect(result.current.view.board.stats).toMatchObject({ wins: 1, currentStreak: 1 });
  });
});

describe("useCallBoardCloses", () => {
  it("returns the fetched result's benchmark series", async () => {
    const closes: DailyClose[] = [{ date: "2026-08-25", close: 101 }];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ benchmarkSeries: { ticker: "SPY", trailingDays: 90, closes } }),
      }),
    );

    const { result } = renderHook(() => useCallBoardCloses());
    await waitFor(() => {
      expect(result.current).toEqual(closes);
    });
  });

  it("degrades to an empty series when the fetch fails, rather than surfacing an error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));

    const { result } = renderHook(() => useCallBoardCloses());
    await act(async () => {});
    expect(result.current).toEqual([]);
  });

  it("degrades to an empty series when the stored result carries benchmarkSeries: null", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ benchmarkSeries: null }) }),
    );

    const { result } = renderHook(() => useCallBoardCloses());
    await act(async () => {});
    expect(result.current).toEqual([]);
  });

  it("keeps a stable array identity across re-renders, so useCallBoard's sync effect doesn't loop", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));

    const { result, rerender } = renderHook(() => useCallBoardCloses());
    await act(async () => {});
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });
});
