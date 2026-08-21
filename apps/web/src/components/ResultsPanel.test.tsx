import type { IntradayResult, WindowResult } from "@hadiknowntrades/core";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { ResultsState } from "@/lib/use-results";
import { ResultsPanel } from "./ResultsPanel";

function fixtureResult(overrides: Partial<WindowResult> = {}): WindowResult {
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
    endingBalance: 6876.860256895814,
    trades: [
      {
        ticker: "SNDK",
        buyDate: "2025-08-21",
        buyPrice: 45.5,
        sellDate: "2026-06-25",
        sellPrice: 2335,
      },
      {
        ticker: "MNST",
        buyDate: "2026-07-21",
        buyPrice: 47.22999954223633,
        sellDate: "2026-07-28",
        sellPrice: 97.73999786376953,
      },
      {
        ticker: "MRNA",
        buyDate: "2026-08-06",
        buyPrice: 53.86000061035156,
        sellDate: "2026-08-19",
        sellPrice: 174.3800048828125,
      },
    ],
    universeSize: 503,
    skippedTickers: [],
    ...overrides,
  };
}

function fixtureIntradayResult(overrides: Partial<IntradayResult> = {}): IntradayResult {
  return {
    schemaVersion: 2,
    model: "intraday-daily",
    range: "1M",
    generatedAt: "2026-08-21T19:50:21.468Z",
    dataAsOf: "2026-08-21",
    endDate: "2026-08-21",
    maxTradesPerDay: 3,
    startingCapital: 20,
    universeSize: 503,
    skippedTickers: [],
    days: [
      {
        date: "2026-08-20",
        startingCapital: 20,
        endingBalance: 25,
        trades: [
          {
            ticker: "AAPL",
            date: "2026-08-20",
            buyTime: "09:30:00",
            buyPrice: 100,
            sellTime: "10:30:00",
            sellPrice: 125,
          },
        ],
      },
      {
        date: "2026-08-21",
        startingCapital: 20,
        endingBalance: 40,
        trades: [
          {
            ticker: "MSFT",
            date: "2026-08-21",
            buyTime: "09:30:00",
            buyPrice: 200,
            sellTime: "10:30:00",
            sellPrice: 400,
          },
        ],
      },
    ],
    ...overrides,
  };
}

describe("ResultsPanel", () => {
  it("shows a loading state while the request is in flight", () => {
    render(<ResultsPanel range="1Y" state={{ status: "loading" }} />);

    expect(screen.getByText(/loading results/i)).toBeInTheDocument();
  });

  it("shows a not-found message for a range that hasn't been published yet", () => {
    const state: ResultsState = {
      status: "error",
      httpStatus: 404,
      error: "not_found",
      message: 'No precomputed results are available yet for range "1Y".',
    };
    render(<ResultsPanel range="1Y" state={state} />);

    expect(screen.getByRole("alert")).toHaveTextContent(/not published yet/i);
  });

  it("shows a server-misconfigured message for a 500", () => {
    const state: ResultsState = {
      status: "error",
      httpStatus: 500,
      error: "server_misconfigured",
      message: "Results storage is not configured.",
    };
    render(<ResultsPanel range="1Y" state={state} />);

    expect(screen.getByRole("alert")).toHaveTextContent(/temporarily unavailable/i);
  });

  it("shows an upstream-error message for a 502 upstream_error", () => {
    const state: ResultsState = {
      status: "error",
      httpStatus: 502,
      error: "upstream_error",
      message: "Failed to read precomputed results.",
    };
    render(<ResultsPanel range="1Y" state={state} />);

    expect(screen.getByRole("alert")).toHaveTextContent(/couldn't load results/i);
  });

  it("shows a corrupted-data message for a 502 corrupt_data", () => {
    const state: ResultsState = {
      status: "error",
      httpStatus: 502,
      error: "corrupt_data",
      message: "Stored results could not be parsed.",
    };
    render(<ResultsPanel range="1Y" state={state} />);

    expect(screen.getByRole("alert")).toHaveTextContent(/look corrupted/i);
  });

  it("shows a corrupted-data message for a 502 schema_mismatch", () => {
    const state: ResultsState = {
      status: "error",
      httpStatus: 502,
      error: "schema_mismatch",
      message: "Stored results are in an unrecognized format.",
    };
    render(<ResultsPanel range="1Y" state={state} />);

    expect(screen.getByRole("alert")).toHaveTextContent(/look corrupted/i);
  });

  it("shows a network-error message when the fetch itself fails", () => {
    const state: ResultsState = {
      status: "error",
      httpStatus: 0,
      error: "network_error",
      message: "Failed to fetch",
    };
    render(<ResultsPanel range="1Y" state={state} />);

    expect(screen.getByRole("alert")).toHaveTextContent(/couldn't reach the server/i);
  });

  it("shows an empty state when a successful response has zero trades", () => {
    const state: ResultsState = {
      status: "success",
      data: fixtureResult({ trades: [], endingBalance: 20 }),
    };
    render(<ResultsPanel range="1Y" state={state} />);

    expect(screen.getByText(/no trade would have beaten holding cash/i)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("renders the hero stat, chart, and trade list for a full success response", () => {
    const state: ResultsState = { status: "success", data: fixtureResult() };
    render(<ResultsPanel range="1Y" state={state} />);

    expect(screen.getAllByText("$20.00").length).toBeGreaterThan(0);
    expect(screen.getAllByText("$6.9K").length).toBeGreaterThan(0);
    expect(screen.getByRole("img", { name: /portfolio value over time/i })).toBeInTheDocument();
    expect(screen.getAllByText(/SNDK/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/MNST/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/MRNA/).length).toBeGreaterThan(0);
  });

  it("mentions maxTrades from the data, not a hardcoded literal", () => {
    const state: ResultsState = { status: "success", data: fixtureResult({ maxTrades: 5 }) };
    render(<ResultsPanel range="1Y" state={state} />);

    expect(screen.getByText(/at most 5 sequential/i)).toBeInTheDocument();
  });

  it("renders fewer than 3 trades gracefully", () => {
    const state: ResultsState = {
      status: "success",
      data: fixtureResult({
        trades: [
          {
            ticker: "AAPL",
            buyDate: "2025-08-21",
            buyPrice: 100,
            sellDate: "2025-09-01",
            sellPrice: 110,
          },
        ],
        endingBalance: 22,
      }),
    };
    render(<ResultsPanel range="1Y" state={state} />);

    expect(screen.getAllByText(/AAPL/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/no trade would have beaten/i)).not.toBeInTheDocument();
  });

  describe("intraday-daily model (issue #28)", () => {
    it("re-triggers HeroStat's reveal animation when switching days, instead of leaving the visible figure frozen on the previous day's value", () => {
      // Regression test for a real bug caught in code review: HeroStat
      // was rendered without a `key` in the intraday branch, so
      // switching days updated its props in place (ResultsPanel doesn't
      // remount its success subtree just because `selectedDay` changed)
      // -- useCountUp's reveal only re-runs on mount (see its own doc
      // comment), so without the key the visible figure stayed on the
      // *previous* day's fully-animated value while the sr-only figure
      // (driven directly by the prop) correctly updated -- the two
      // silently disagreeing.
      vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb: FrameRequestCallback) => {
        // Complete the reveal on the very first frame, deterministically.
        cb(performance.now() + 100_000);
        return 1;
      });

      const data = fixtureIntradayResult();
      const state: ResultsState = { status: "success", data };
      const { rerender } = render(
        <ResultsPanel range="1M" state={state} selectedDay="2026-08-20" />,
      );

      // Day 1 (2026-08-20): endingBalance 25.
      expect(
        screen.getByText("$25.00", { selector: "span[aria-hidden]:not(.sr-only)" }),
      ).toBeInTheDocument();

      rerender(<ResultsPanel range="1M" state={state} selectedDay="2026-08-21" />);

      // Day 2 (2026-08-21): endingBalance 40 -- the visible figure must
      // update to match, not stay frozen at day 1's $25.00.
      expect(
        screen.getByText("$40.00", { selector: "span[aria-hidden]:not(.sr-only)" }),
      ).toBeInTheDocument();
      expect(
        screen.queryByText("$25.00", { selector: "span[aria-hidden]:not(.sr-only)" }),
      ).not.toBeInTheDocument();

      vi.restoreAllMocks();
    });

    it("defaults to the most recent day when no day is selected", () => {
      const state: ResultsState = { status: "success", data: fixtureIntradayResult() };
      render(<ResultsPanel range="1M" state={state} />);

      // Most recent day is 2026-08-21 (MSFT), not 2026-08-20 (AAPL).
      expect(screen.getAllByText(/MSFT/).length).toBeGreaterThan(0);
      expect(screen.queryByText(/AAPL/)).not.toBeInTheDocument();
      expect(screen.getByText(/Aug 21, 2026/)).toBeInTheDocument();
    });

    it("labels each trade with 'at TIME', not 'on TIME' -- a real grammar bug caught in code review (TradeRow hardcoded the window model's 'on')", () => {
      const state: ResultsState = { status: "success", data: fixtureIntradayResult() };
      render(<ResultsPanel range="1M" state={state} />);

      expect(screen.getByText(/at 9:30 AM/)).toBeInTheDocument();
      expect(screen.getByText(/at 10:30 AM/)).toBeInTheDocument();
      expect(screen.queryByText(/on 9:30 AM/)).not.toBeInTheDocument();
    });

    it("shows the selected day's result when selectedDay matches an earlier day", () => {
      const state: ResultsState = { status: "success", data: fixtureIntradayResult() };
      render(<ResultsPanel range="1M" state={state} selectedDay="2026-08-20" />);

      expect(screen.getAllByText(/AAPL/).length).toBeGreaterThan(0);
      expect(screen.queryByText(/MSFT/)).not.toBeInTheDocument();
    });

    it("falls back to the most recent day when selectedDay doesn't match any day in the result", () => {
      const state: ResultsState = { status: "success", data: fixtureIntradayResult() };
      render(<ResultsPanel range="1M" state={state} selectedDay="2020-01-01" />);

      expect(screen.getAllByText(/MSFT/).length).toBeGreaterThan(0);
    });

    it("calls onSelectDay when a different day is chosen from the DaySelector", async () => {
      const user = userEvent.setup();
      const onSelectDay = vi.fn();
      const state: ResultsState = { status: "success", data: fixtureIntradayResult() };
      render(<ResultsPanel range="1M" state={state} onSelectDay={onSelectDay} />);

      await user.selectOptions(screen.getByRole("combobox"), "2026-08-20");

      expect(onSelectDay).toHaveBeenCalledWith("2026-08-20");
    });

    it("shows an empty state for a day with no trades", () => {
      const state: ResultsState = {
        status: "success",
        data: fixtureIntradayResult({
          days: [{ date: "2026-08-21", startingCapital: 20, endingBalance: 20, trades: [] }],
        }),
      };
      render(<ResultsPanel range="1M" state={state} />);

      expect(screen.getByText(/no trade would have beaten holding cash on/i)).toBeInTheDocument();
    });

    it("shows a fallback message when the range has no trading days at all", () => {
      const state: ResultsState = {
        status: "success",
        data: fixtureIntradayResult({ days: [] }),
      };
      render(<ResultsPanel range="1M" state={state} />);

      expect(screen.getByText(/no trading days are available/i)).toBeInTheDocument();
    });

    it("mentions maxTradesPerDay from the data, not a hardcoded literal", () => {
      const state: ResultsState = {
        status: "success",
        data: fixtureIntradayResult({ maxTradesPerDay: 5 }),
      };
      render(<ResultsPanel range="1M" state={state} />);

      expect(screen.getByText(/at most 5 same-day/i)).toBeInTheDocument();
    });
  });
});
