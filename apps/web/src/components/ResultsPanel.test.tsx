import {
  RESULTS_SCHEMA_VERSION,
  type CustomWindowResult,
  type IntradayResult,
  type WindowResult,
} from "@hadiknowntrades/core";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { stubMatchMedia } from "@/lib/stub-match-media.test-util";
import type { ResultsState } from "@/lib/use-results";
import { ResultsPanel } from "./ResultsPanel";

/**
 * Submits an arbitrary guess through WholeRangeBalance's guess form
 * (issue #91) -- the page's one remaining guess-then-reveal gate, scoped
 * to the whole range rather than any individual day. Any intraday-daily
 * test asserting on the whole-range headline/BenchmarkStat/chart has to
 * clear this gate first, the same way a real user would -- individual
 * days' own content needs no guess at all (see WholeRangeBalance's own
 * doc comment for why per-day guessing was removed entirely).
 */
async function submitWholeRangeGuess(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText(/what do you think it became/i), "1");
  await user.click(screen.getByRole("button", { name: "Reveal the answer" }));
}

function fixtureResult(overrides: Partial<WindowResult> = {}): WindowResult {
  return {
    schemaVersion: RESULTS_SCHEMA_VERSION,
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
        direction: "long",
        openDate: "2025-08-21",
        openPrice: 45.5,
        closeDate: "2026-06-25",
        closePrice: 2335,
      },
      {
        ticker: "MNST",
        direction: "long",
        openDate: "2026-07-21",
        openPrice: 47.22999954223633,
        closeDate: "2026-07-28",
        closePrice: 97.73999786376953,
      },
      {
        ticker: "MRNA",
        direction: "long",
        openDate: "2026-08-06",
        openPrice: 53.86000061035156,
        closeDate: "2026-08-19",
        closePrice: 174.3800048828125,
      },
    ],
    worstCase: {
      endingBalance: 4.2,
      trades: [
        {
          ticker: "ZBRA",
          direction: "long",
          openDate: "2025-08-21",
          openPrice: 300,
          closeDate: "2026-08-21",
          closePrice: 63,
        },
      ],
    },
    // The long+short counterpart (issue #13) -- deliberately distinct
    // figures/tickers from the long-only fields above, so a test can tell
    // which variant actually rendered.
    longShort: {
      endingBalance: 9000,
      trades: [
        {
          ticker: "COIN",
          direction: "short",
          openDate: "2025-08-21",
          openPrice: 500,
          closeDate: "2026-01-01",
          closePrice: 50,
        },
      ],
      worstCase: {
        endingBalance: 2,
        trades: [
          {
            ticker: "ZBRA",
            direction: "long",
            openDate: "2025-08-21",
            openPrice: 300,
            closeDate: "2026-08-21",
            closePrice: 63,
          },
        ],
      },
    },
    universeSize: 503,
    skippedTickers: [],
    benchmark: null,
    ...overrides,
  };
}

function fixtureIntradayResult(overrides: Partial<IntradayResult> = {}): IntradayResult {
  return {
    schemaVersion: RESULTS_SCHEMA_VERSION,
    model: "intraday-daily",
    range: "1M",
    generatedAt: "2026-08-21T19:50:21.468Z",
    dataAsOf: "2026-08-21",
    endDate: "2026-08-21",
    maxTradesPerDay: 3,
    startingCapital: 20,
    universeSize: 503,
    skippedTickers: [],
    benchmark: null,
    days: [
      {
        date: "2026-08-20",
        startingCapital: 20,
        endingBalance: 25,
        barIntervalMinutes: 60,
        trades: [
          {
            ticker: "AAPL",
            direction: "long",
            date: "2026-08-20",
            openTime: "09:30:00",
            openPrice: 100,
            closeTime: "10:30:00",
            closePrice: 125,
          },
        ],
        worstCase: {
          startingCapital: 20,
          endingBalance: 12,
          trades: [
            {
              ticker: "GOOG",
              direction: "long",
              date: "2026-08-20",
              openTime: "09:30:00",
              openPrice: 100,
              closeTime: "10:30:00",
              closePrice: 60,
            },
          ],
        },
        // The long+short counterpart (issue #13) -- deliberately distinct
        // figures/tickers, so a test can tell which variant rendered.
        longShort: {
          startingCapital: 20,
          endingBalance: 90,
          trades: [
            {
              ticker: "COIN",
              direction: "short",
              date: "2026-08-20",
              openTime: "09:30:00",
              openPrice: 100,
              closeTime: "10:30:00",
              closePrice: 20,
            },
          ],
          worstCase: {
            startingCapital: 20,
            endingBalance: 8,
            trades: [
              {
                ticker: "GOOG",
                direction: "long",
                date: "2026-08-20",
                openTime: "09:30:00",
                openPrice: 100,
                closeTime: "10:30:00",
                closePrice: 60,
              },
            ],
          },
        },
      },
      {
        date: "2026-08-21",
        startingCapital: 20,
        endingBalance: 40,
        barIntervalMinutes: 60,
        trades: [
          {
            ticker: "MSFT",
            direction: "long",
            date: "2026-08-21",
            openTime: "09:30:00",
            openPrice: 200,
            closeTime: "10:30:00",
            closePrice: 400,
          },
        ],
        worstCase: {
          startingCapital: 20,
          endingBalance: 4,
          trades: [
            {
              ticker: "TSLA",
              direction: "long",
              date: "2026-08-21",
              openTime: "09:30:00",
              openPrice: 200,
              closeTime: "10:30:00",
              closePrice: 40,
            },
          ],
        },
        // The long+short counterpart (issue #13) -- deliberately distinct
        // figures/tickers, so a test can tell which variant rendered.
        longShort: {
          startingCapital: 20,
          endingBalance: 400,
          trades: [
            {
              ticker: "COIN",
              direction: "short",
              date: "2026-08-21",
              openTime: "09:30:00",
              openPrice: 200,
              closeTime: "10:30:00",
              closePrice: 20,
            },
          ],
          worstCase: {
            startingCapital: 20,
            endingBalance: 2,
            trades: [
              {
                ticker: "TSLA",
                direction: "long",
                date: "2026-08-21",
                openTime: "09:30:00",
                openPrice: 200,
                closeTime: "10:30:00",
                closePrice: 40,
              },
            ],
          },
        },
      },
    ],
    ...overrides,
  };
}

function fixtureCustomWindowResult(
  overrides: Partial<CustomWindowResult> = {},
): CustomWindowResult {
  return {
    schemaVersion: RESULTS_SCHEMA_VERSION,
    model: "custom-window",
    anchorDate: "2019-03-01",
    generatedAt: "2026-08-21T19:50:21.468Z",
    dataAsOf: "2026-08-21",
    startDate: "2019-03-01",
    endDate: "2026-08-21",
    maxTrades: 3,
    startingCapital: 20,
    endingBalance: 6876.860256895814,
    trades: [
      {
        ticker: "SNDK",
        direction: "long",
        openDate: "2019-03-01",
        openPrice: 45.5,
        closeDate: "2026-06-25",
        closePrice: 2335,
      },
    ],
    worstCase: {
      endingBalance: 4.2,
      trades: [
        {
          ticker: "ZBRA",
          direction: "long",
          openDate: "2019-03-01",
          openPrice: 300,
          closeDate: "2026-08-21",
          closePrice: 63,
        },
      ],
    },
    // The long+short counterpart (issue #13/#11 integration) --
    // apps/pipeline's buildCustomWindowResults now calls the same
    // optimizeAllVariants every WindowResult already does, so every
    // CustomWindowResult carries a real longShort field too. A genuine
    // short trade (COIN, direction "short") in `best.trades` so a test
    // that switches to mode="long-short" under a custom anchor can assert
    // on it the same way the window/intraday fixtures below do.
    longShort: {
      endingBalance: 9000,
      trades: [
        {
          ticker: "COIN",
          direction: "short",
          openDate: "2019-03-01",
          openPrice: 200,
          closeDate: "2026-06-25",
          closePrice: 10,
        },
      ],
      worstCase: {
        endingBalance: 2,
        trades: [
          {
            ticker: "ZBRA",
            direction: "long",
            openDate: "2019-03-01",
            openPrice: 300,
            closeDate: "2026-08-21",
            closePrice: 63,
          },
        ],
      },
    },
    universeSize: 503,
    skippedTickers: [],
    benchmark: null,
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

  it("shows an unsupported-start-date message for a 400 invalid_anchor", () => {
    const state: ResultsState = {
      status: "error",
      httpStatus: 400,
      error: "invalid_anchor",
      message: 'Unsupported or missing "anchor" query parameter. Received: bogus.',
    };
    render(<ResultsPanel range="1Y" state={state} />);

    expect(screen.getByRole("alert")).toHaveTextContent(/unsupported start date/i);
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
    // The worst-case contrast stat (issue #31) renders alongside HeroStat
    // -- window model, no reveal gate to clear.
    expect(screen.getByText("$4.20")).toBeInTheDocument();
    expect(screen.getByText("(0.2x)")).toBeInTheDocument();
    expect(screen.getAllByText(/MRNA/).length).toBeGreaterThan(0);
  });

  it("mentions maxTrades from the data, not a hardcoded literal", () => {
    const state: ResultsState = { status: "success", data: fixtureResult({ maxTrades: 5 }) };
    render(<ResultsPanel range="1Y" state={state} />);

    expect(screen.getByText(/at most 5 sequential/i)).toBeInTheDocument();
  });

  it("passes the user's rescaled starting capital into TradeList, not the raw precomputed startingCapital -- regression test for a real bug found in code review: a merge auto-resolved this call with no conflict and silently left TradeList's dollar figures unrescaled (hero stat showing a rescaled figure while the trade narration below still said 'turning your $20.00 into ...')", () => {
    const state: ResultsState = { status: "success", data: fixtureResult() };
    render(<ResultsPanel range="1Y" state={state} startingCapital={500} />);

    // The hero stat and the first trade's narrated starting figure must
    // agree: both rescaled to $500.00, not the raw precomputed $20.00.
    expect(screen.getAllByText("$500.00").length).toBeGreaterThan(0);
    expect(screen.queryByText(/turning your \$20\.00/i)).not.toBeInTheDocument();
    expect(screen.getByText(/turning your \$500\.00/i)).toBeInTheDocument();
  });

  it("renders fewer than 3 trades gracefully", () => {
    const state: ResultsState = {
      status: "success",
      data: fixtureResult({
        trades: [
          {
            ticker: "AAPL",
            direction: "long",
            openDate: "2025-08-21",
            openPrice: 100,
            closeDate: "2025-09-01",
            closePrice: 110,
          },
        ],
        endingBalance: 22,
      }),
    };
    render(<ResultsPanel range="1Y" state={state} />);

    expect(screen.getAllByText(/AAPL/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/no trade would have beaten/i)).not.toBeInTheDocument();
  });

  it("renders the BenchmarkStat comparison line when the result has a benchmark, and omits it entirely when benchmark is null (issue #12)", () => {
    const withBenchmark: ResultsState = {
      status: "success",
      data: fixtureResult({
        benchmark: {
          ticker: "SPY",
          startDate: "2025-08-21",
          startPrice: 400,
          endDate: "2026-08-21",
          endPrice: 460,
          endingBalance: 23,
          truncated: false,
        },
      }),
    };
    const { rerender } = render(<ResultsPanel range="1Y" state={withBenchmark} />);
    expect(
      screen.getByText(/Buying and holding SPY over the past year instead/),
    ).toBeInTheDocument();

    const withoutBenchmark: ResultsState = {
      status: "success",
      data: fixtureResult({ benchmark: null }),
    };
    rerender(<ResultsPanel range="1Y" state={withoutBenchmark} />);
    expect(screen.queryByText(/Buying and holding SPY/)).not.toBeInTheDocument();
  });

  describe("intraday-daily model (issue #28)", () => {
    // The whole-range headline/BenchmarkStat/chart are gated behind the
    // whole-range guess-then-reveal flow (issue #91, see
    // WholeRangeBalance/use-range-guess.ts) -- a stored guess is what
    // unlocks them, so any test asserting on that content has to clear
    // that gate first (submitWholeRangeGuess), same as a real user
    // would. Individual days' own HeroStat/worst-case/trade list are
    // *not* gated -- issue #91 removed per-day guessing entirely, so
    // most tests below need no guess at all. Guesses persist in the
    // same jsdom `localStorage` across tests in this file, so clear it
    // after every test to keep them independent.
    afterEach(() => {
      window.localStorage.clear();
    });

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

      // Most recent day is 2026-08-21 (MSFT), not 2026-08-20 (AAPL) --
      // shown immediately, no guess required (issue #91).
      expect(screen.getAllByText(/MSFT/).length).toBeGreaterThan(0);
      expect(screen.queryByText(/AAPL/)).not.toBeInTheDocument();
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

    it('announces which day/mode is showing via a role="status" live region, and updates it on every day/mode switch (issue #67, restored by issue #91 code review)', () => {
      const state: ResultsState = { status: "success", data: fixtureIntradayResult() };
      const { rerender } = render(
        <ResultsPanel range="1M" state={state} selectedDay="2026-08-20" />,
      );

      expect(screen.getByRole("status", { name: "Selected day status" })).toHaveTextContent(
        "Showing results for Aug 20, 2026 (long only).",
      );

      rerender(
        <ResultsPanel range="1M" state={state} selectedDay="2026-08-21" mode="long-short" />,
      );

      expect(screen.getByRole("status", { name: "Selected day status" })).toHaveTextContent(
        "Showing results for Aug 21, 2026 (long + short).",
      );
    });

    it("calls onSelectDay when a different day's row is clicked in DayOverview", async () => {
      const user = userEvent.setup();
      const onSelectDay = vi.fn();
      const state: ResultsState = { status: "success", data: fixtureIntradayResult() };
      render(<ResultsPanel range="1M" state={state} onSelectDay={onSelectDay} />);

      await user.click(screen.getByRole("button", { name: /Aug 20, 2026/ }));

      expect(onSelectDay).toHaveBeenCalledWith("2026-08-20");
    });

    describe("DayOverview (issue #80)", () => {
      it("lists every trading day in the range with its own trade count", () => {
        const state: ResultsState = { status: "success", data: fixtureIntradayResult() };
        render(<ResultsPanel range="1M" state={state} />);

        // fixtureIntradayResult's two days: 2026-08-20 (1 trade) and
        // 2026-08-21 (the default-selected, most recent day -- 1 trade
        // too, see its own fixture trades array).
        expect(screen.getByRole("button", { name: /Aug 20, 2026.*1 trade/ })).toBeInTheDocument();
        expect(screen.getByRole("button", { name: /Aug 21, 2026.*1 trade/ })).toBeInTheDocument();
      });

      it("shows every day's real dollar ending balance immediately, with no guess required (issue #91)", () => {
        const state: ResultsState = { status: "success", data: fixtureIntradayResult() };
        render(<ResultsPanel range="1M" state={state} />);

        // Both days' real ending balances ($25 for 08-20, $40 for 08-21)
        // are visible without any guess -- issue #91 removed the
        // per-day "Guess to reveal" gate entirely.
        expect(screen.queryByText("Guess to reveal")).not.toBeInTheDocument();
        const dayOne = screen.getByRole("button", { name: /Aug 20, 2026/ });
        expect(within(dayOne).getByText("$25.00")).toBeInTheDocument();
        const dayTwo = screen.getByRole("button", { name: /Aug 21, 2026/ });
        expect(within(dayTwo).getByText("$40.00")).toBeInTheDocument();
      });
    });

    it("shows an empty state for a day with no trades", () => {
      const state: ResultsState = {
        status: "success",
        data: fixtureIntradayResult({
          days: [
            {
              date: "2026-08-21",
              startingCapital: 20,
              endingBalance: 20,
              barIntervalMinutes: 60,
              trades: [],
              worstCase: { startingCapital: 20, endingBalance: 20, trades: [] },
              longShort: {
                startingCapital: 20,
                endingBalance: 20,
                trades: [],
                worstCase: { startingCapital: 20, endingBalance: 20, trades: [] },
              },
            },
          ],
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

    it("renders the BenchmarkStat comparison line, disambiguated with the range, once the whole-range guess is revealed -- and never before (issue #12, issue #91)", async () => {
      const user = userEvent.setup();
      const state: ResultsState = {
        status: "success",
        data: fixtureIntradayResult({
          benchmark: {
            ticker: "SPY",
            startDate: "2026-07-21",
            startPrice: 400,
            endDate: "2026-08-21",
            endPrice: 420,
            endingBalance: 21,
            truncated: false,
          },
        }),
      };
      render(<ResultsPanel range="1M" state={state} />);

      // Gated behind the whole-range guess-then-reveal condition (issue
      // #91) -- showing the benchmark before that guess is submitted
      // would spoil the whole-range answer it's compared against.
      expect(screen.queryByText(/Buying and holding SPY/)).not.toBeInTheDocument();

      await submitWholeRangeGuess(user);

      // The whole-range benchmark (issue #12), disambiguated from the
      // single selected day the day drill-down below is scoped to.
      expect(
        screen.getByText(/Buying and holding SPY over the past month instead/),
      ).toBeInTheDocument();
    });

    it("mentions maxTradesPerDay from the data, not a hardcoded literal", () => {
      const state: ResultsState = {
        status: "success",
        data: fixtureIntradayResult({ maxTradesPerDay: 5 }),
      };
      render(<ResultsPanel range="1M" state={state} />);

      expect(screen.getByText(/at most 5 same-day/i)).toBeInTheDocument();
    });

    describe("whole-range guess-then-reveal (issue #91)", () => {
      it("shows each day's HeroStat/worst-case stat/trade list immediately, with no guess required, while keeping the whole-range headline/benchmark/chart masked", () => {
        const state: ResultsState = { status: "success", data: fixtureIntradayResult() };
        render(<ResultsPanel range="1M" state={state} />);

        // Day-level content (most recent day, 2026-08-21) is visible
        // immediately -- issue #91 removed per-day guessing entirely.
        expect(screen.getAllByText(/MSFT/).length).toBeGreaterThan(0);
        expect(screen.getByText("$4.00")).toBeInTheDocument(); // worstCase.endingBalance for 2026-08-21
        expect(screen.getByText("(0.2x)")).toBeInTheDocument();
        // The whole-range chart stays masked until the whole-range guess
        // is revealed.
        expect(
          screen.queryByRole("img", { name: /portfolio value over time/i }),
        ).not.toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Reveal the answer" })).toBeInTheDocument();
      });

      it("prompts the whole-range guess against the user's rescaled starting capital, not the raw precomputed one", () => {
        const state: ResultsState = { status: "success", data: fixtureIntradayResult() };
        render(<ResultsPanel range="1M" state={state} startingCapital={500} />);

        expect(screen.getByText(/starting from \$500\.00/i)).toBeInTheDocument();
        expect(screen.queryByText(/starting from \$20\.00/i)).not.toBeInTheDocument();
      });

      it("reveals the whole-range figure, benchmark, and chart once the user submits a guess, and shows their guess alongside it", async () => {
        const user = userEvent.setup();
        const state: ResultsState = { status: "success", data: fixtureIntradayResult() };
        render(<ResultsPanel range="1M" state={state} />);

        await user.type(screen.getByLabelText(/what do you think it became/i), "30");
        await user.click(screen.getByRole("button", { name: "Reveal the answer" }));

        expect(screen.queryByRole("button", { name: "Reveal the answer" })).not.toBeInTheDocument();
        expect(screen.getByRole("img", { name: /portfolio value over time/i })).toBeInTheDocument();
        expect(screen.getByText(/you guessed \$30\.00/i)).toBeInTheDocument();
      });

      it("rescales the 'You guessed' figure when starting capital changes after the reveal, instead of leaving it stuck at the value guessed under the old capital", async () => {
        const user = userEvent.setup();
        const state: ResultsState = { status: "success", data: fixtureIntradayResult() };
        const { rerender } = render(<ResultsPanel range="1M" state={state} startingCapital={20} />);

        // Guessed while the prompt showed $20.00 starting capital.
        await user.type(screen.getByLabelText(/what do you think it became/i), "30");
        await user.click(screen.getByRole("button", { name: "Reveal the answer" }));
        expect(screen.getByText(/you guessed \$30\.00/i)).toBeInTheDocument();

        // Starting capital changes post-reveal (e.g. via StartingCapitalInput)
        // to 10x the original -- the guess was $30 against $20, so it must
        // now read as $300.00, not stay frozen at the stale $30.00.
        rerender(<ResultsPanel range="1M" state={state} startingCapital={200} />);

        expect(screen.getByText(/you guessed \$300\.00/i)).toBeInTheDocument();
        expect(screen.queryByText(/you guessed \$30\.00/i)).not.toBeInTheDocument();
      });

      it("persists the guess across a simulated reload (re-mount with the same localStorage) and skips straight to the reveal", async () => {
        const user = userEvent.setup();
        const state: ResultsState = { status: "success", data: fixtureIntradayResult() };
        const { unmount } = render(<ResultsPanel range="1M" state={state} />);

        await submitWholeRangeGuess(user);
        expect(screen.getByRole("img", { name: /portfolio value over time/i })).toBeInTheDocument();

        unmount();
        render(<ResultsPanel range="1M" state={state} />);

        // No guess prompt on the "reload" -- straight to the revealed result.
        expect(screen.queryByRole("button", { name: "Reveal the answer" })).not.toBeInTheDocument();
        expect(screen.getByRole("img", { name: /portfolio value over time/i })).toBeInTheDocument();
      });

      it("keeps the whole-range reveal in place when switching the selected day (guessing is range-scoped, not per-day)", async () => {
        const user = userEvent.setup();
        const state: ResultsState = { status: "success", data: fixtureIntradayResult() };
        const { rerender } = render(
          <ResultsPanel range="1M" state={state} selectedDay="2026-08-21" />,
        );
        await submitWholeRangeGuess(user);
        expect(screen.getByRole("img", { name: /portfolio value over time/i })).toBeInTheDocument();

        rerender(<ResultsPanel range="1M" state={state} selectedDay="2026-08-20" />);

        expect(screen.queryByRole("button", { name: "Reveal the answer" })).not.toBeInTheDocument();
        expect(screen.getByRole("img", { name: /portfolio value over time/i })).toBeInTheDocument();
      });

      it("re-prompts for a guess when the range changes, instead of skipping straight to reveal (a guess for one range must not satisfy another)", async () => {
        const user = userEvent.setup();
        const state: ResultsState = { status: "success", data: fixtureIntradayResult() };
        const { rerender } = render(<ResultsPanel range="1M" state={state} />);
        await submitWholeRangeGuess(user);
        expect(screen.getByRole("img", { name: /portfolio value over time/i })).toBeInTheDocument();

        rerender(<ResultsPanel range="3M" state={state} />);
        expect(screen.getByRole("button", { name: "Reveal the answer" })).toBeInTheDocument();

        rerender(<ResultsPanel range="1Y" state={state} />);
        expect(screen.getByRole("button", { name: "Reveal the answer" })).toBeInTheDocument();

        // Switching back to 1M still remembers the original guess.
        rerender(<ResultsPanel range="1M" state={state} />);
        expect(screen.queryByRole("button", { name: "Reveal the answer" })).not.toBeInTheDocument();
      });
    });
  });

  describe("mode (issue #13): long-only vs. long+short variant selection", () => {
    // Regression tests for the exact class of mistake apps/web/CLAUDE.md
    // already documents happening *twice* for effectiveStartingCapital
    // (issue #15) -- a component quietly reading the raw/wrong-variant
    // field instead of the thread-through value. fixtureResult's own
    // `longShort` figures/tickers are deliberately distinct from the
    // long-only ones so a test can tell which variant actually rendered.
    // One test below submits a whole-range guess (intraday-daily model),
    // which persists to the same jsdom localStorage across tests --
    // clear it after every test to keep them independent, same as the
    // "intraday-daily model" describe block above.
    afterEach(() => {
      window.localStorage.clear();
    });

    it("defaults to the long-only variant when mode is omitted", () => {
      const state: ResultsState = { status: "success", data: fixtureResult() };
      render(<ResultsPanel range="1Y" state={state} />);

      expect(screen.getAllByText("$6.9K").length).toBeGreaterThan(0);
      expect(screen.getAllByText(/SNDK/).length).toBeGreaterThan(0);
      expect(screen.queryByText(/COIN/)).not.toBeInTheDocument();
      expect(screen.queryByText("$9K")).not.toBeInTheDocument();
    });

    it("renders the long+short variant's HeroStat/trade list when mode='long-short' (window model)", () => {
      const state: ResultsState = { status: "success", data: fixtureResult() };
      render(<ResultsPanel range="1Y" state={state} mode="long-short" />);

      expect(screen.getAllByText("$9K").length).toBeGreaterThan(0);
      expect(screen.getAllByText(/COIN/).length).toBeGreaterThan(0);
      expect(screen.queryByText(/SNDK/)).not.toBeInTheDocument();
    });

    it("renders the long+short variant's WorstCaseStat when mode='long-short' (window model)", () => {
      const state: ResultsState = { status: "success", data: fixtureResult() };
      render(<ResultsPanel range="1Y" state={state} mode="long-short" />);

      // longShort.worstCase.endingBalance is 2 (vs. the long-only 4.2).
      expect(screen.getByText("$2.00")).toBeInTheDocument();
      expect(screen.queryByText("$4.20")).not.toBeInTheDocument();
    });

    it("renders the long+short variant for the intraday-daily model too, with no guess required (issue #91)", () => {
      const state: ResultsState = { status: "success", data: fixtureIntradayResult() };
      render(<ResultsPanel range="1M" state={state} mode="long-short" />);

      // Most recent day (2026-08-21): longShort.endingBalance 400, ticker COIN.
      expect(screen.getAllByText(/COIN/).length).toBeGreaterThan(0);
      expect(screen.queryByText(/MSFT/)).not.toBeInTheDocument();
    });

    it("keeps the whole-range guess-gate independent per mode -- a guess made under long-only doesn't unlock the reveal for long-short (issue #91)", async () => {
      const user = userEvent.setup();
      const state: ResultsState = { status: "success", data: fixtureIntradayResult() };
      const { rerender } = render(<ResultsPanel range="1M" state={state} mode="long" />);
      await submitWholeRangeGuess(user);
      expect(screen.getByRole("img", { name: /portfolio value over time/i })).toBeInTheDocument();

      rerender(<ResultsPanel range="1M" state={state} mode="long-short" />);
      expect(screen.getByRole("button", { name: "Reveal the answer" })).toBeInTheDocument();
    });
  });

  describe("issue #84: chained per-track starting capital", () => {
    afterEach(() => {
      window.localStorage.clear();
    });

    /**
     * A genuinely-chained two-day fixture where all four tracks
     * (long-only, worst, long-short, long-short-worst) have diverging
     * per-day startingCapital -- day 1 starts every track at the root
     * (20); day 2's own startingCapital for each track equals day 1's
     * own endingBalance for that *same* track, exactly the shape a real
     * chained pipeline result has. Deliberately picked so the long-only
     * track's day-2 startingCapital (40) differs from every other
     * track's (10 / 60 / 5) -- this is what makes the pre-fix bug (every
     * rescale using activeDay.startingCapital regardless of which track
     * it was rescaling) produce a genuinely different, wrong number from
     * the fix.
     */
    function fixtureChainedResult(): IntradayResult {
      return fixtureIntradayResult({
        startingCapital: 20,
        days: [
          {
            date: "2026-08-20",
            startingCapital: 20,
            endingBalance: 40,
            barIntervalMinutes: 60,
            trades: [
              {
                ticker: "AAPL",
                direction: "long",
                date: "2026-08-20",
                openTime: "09:30:00",
                openPrice: 10,
                closeTime: "10:30:00",
                closePrice: 20,
              },
            ],
            worstCase: { startingCapital: 20, endingBalance: 10, trades: [] },
            longShort: {
              startingCapital: 20,
              endingBalance: 60,
              trades: [],
              worstCase: { startingCapital: 20, endingBalance: 5, trades: [] },
            },
          },
          {
            date: "2026-08-21",
            // Chained from 2026-08-20's own endingBalance, per track.
            startingCapital: 40,
            endingBalance: 100,
            barIntervalMinutes: 60,
            trades: [
              {
                ticker: "MSFT",
                direction: "long",
                date: "2026-08-21",
                openTime: "09:30:00",
                openPrice: 10,
                closeTime: "10:30:00",
                closePrice: 25,
              },
            ],
            worstCase: { startingCapital: 10, endingBalance: 20, trades: [] },
            longShort: {
              startingCapital: 60,
              endingBalance: 300,
              trades: [],
              worstCase: { startingCapital: 5, endingBalance: 15, trades: [] },
            },
          },
        ],
      });
    }

    describe("HeroAndWorstCase rescales from each track's own chained startingCapital, not the long-only track's", () => {
      // No explicit `startingCapital` prop passed below -- effectiveStartingCapital
      // then defaults to activeDay.startingCapital (40, the long-only
      // track's own value for 2026-08-21, the most recent/default-selected
      // day). That default is what makes the pre-fix bug's own "from"
      // value (also always activeDay.startingCapital) coincide with the
      // display "to" value under mode "long" -- i.e. a no-op rescale --
      // so a pre-fix WorstCaseStat would show the *raw, unrescaled*
      // worstCase.endingBalance (20) instead of the correctly-rescaled
      // 80; the same shape of divergence applies to every assertion
      // below.

      it("WorstCaseStat rescales from worstCase.startingCapital under mode='long' (real bug: the old code used the long-only track's startingCapital here even under long-only mode, since IntradayWorstCaseResult had no startingCapital of its own pre-#84)", () => {
        const state: ResultsState = { status: "success", data: fixtureChainedResult() };
        render(<ResultsPanel range="1M" state={state} selectedDay="2026-08-21" />);

        // Scoped to WorstCaseStat's own container (not a bare
        // screen.getByText) since issue #91 made DayOverview's own rows
        // show every day's real dollar figure unconditionally too, and
        // this fixture's day-1 row happens to land on the same $80.00.
        const worstCase = screen.getByText("Worst case, same budget").parentElement!;
        // Correct: rescaleFromStartingCapital(20, from=10, to=40) = 80.
        expect(within(worstCase).getByText("$80.00")).toBeInTheDocument();
        // The pre-fix bug's own number (from=activeDay.startingCapital=40=to, a no-op): 20.
        expect(within(worstCase).queryByText("$20.00")).not.toBeInTheDocument();
      });

      it("HeroStat rescales from the long-short track's own startingCapital under mode='long-short' (real bug: the old code always used activeDay.startingCapital, the long-only track's)", () => {
        const state: ResultsState = { status: "success", data: fixtureChainedResult() };
        render(
          <ResultsPanel range="1M" state={state} selectedDay="2026-08-21" mode="long-short" />,
        );

        // Correct: rescaleFromStartingCapital(300, from=60, to=40) = 200.
        expect(screen.getAllByText("$200.00").length).toBeGreaterThan(0);
        // The pre-fix bug's own number (from=activeDay.startingCapital=40=to, a no-op): 300.
        expect(screen.queryByText("$300.00")).not.toBeInTheDocument();
      });

      it("WorstCaseStat rescales from the long-short-worst track's own startingCapital under mode='long-short'", () => {
        const state: ResultsState = { status: "success", data: fixtureChainedResult() };
        render(
          <ResultsPanel range="1M" state={state} selectedDay="2026-08-21" mode="long-short" />,
        );

        // Scoped to WorstCaseStat's own container -- see the mode='long'
        // test above for why (DayOverview's own rows can land on the
        // same figure).
        const worstCase = screen.getByText("Worst case, same budget").parentElement!;
        // Correct: rescaleFromStartingCapital(15, from=5, to=40) = 120.
        expect(within(worstCase).getByText("$120.00")).toBeInTheDocument();
        // The pre-fix bug's own number (from=activeDay.startingCapital=40=to, a no-op): 15.
        expect(within(worstCase).queryByText("$15.00")).not.toBeInTheDocument();
      });

      it("dayOverviewRows' per-row figure rescales from the long-short track's own startingCapital under mode='long-short', matching HeroStat's own figure for the same day", () => {
        const state: ResultsState = { status: "success", data: fixtureChainedResult() };
        render(
          <ResultsPanel range="1M" state={state} selectedDay="2026-08-21" mode="long-short" />,
        );

        const revealedRow = screen.getByRole("button", { name: /Aug 21, 2026/ });
        // Same correct figure as HeroStat's own: rescaleFromStartingCapital(300, from=60, to=40) = 200.
        expect(within(revealedRow).getByText("$200.00")).toBeInTheDocument();
        expect(within(revealedRow).queryByText("$300.00")).not.toBeInTheDocument();
      });
    });

    describe("the whole-range running-balance headline (issue #91: guess-then-reveal, independent of any per-day state)", () => {
      it("stays masked with a guess prompt before the whole-range guess is submitted", () => {
        const state: ResultsState = { status: "success", data: fixtureChainedResult() };
        render(<ResultsPanel range="1M" state={state} selectedDay="2026-08-21" />);

        expect(screen.getByLabelText(/what do you think it became/i)).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Reveal the answer" })).toBeInTheDocument();
      });

      it("announces its own unlock to screen readers via a dedicated aria-live region", async () => {
        const user = userEvent.setup();
        const state: ResultsState = { status: "success", data: fixtureChainedResult() };
        render(<ResultsPanel range="1M" state={state} selectedDay="2026-08-21" />);

        // Empty before the guess is submitted.
        expect(screen.getByRole("status", { name: "Whole-range reveal status" })).toHaveTextContent(
          "",
        );

        await submitWholeRangeGuess(user);

        expect(screen.getByRole("status", { name: "Whole-range reveal status" })).toHaveTextContent(
          /Whole-range running balance revealed/i,
        );
      });

      it("unlocks the real whole-range figure once the whole-range guess is submitted", async () => {
        const user = userEvent.setup();
        const state: ResultsState = { status: "success", data: fixtureChainedResult() };
        // The range's own first day (2026-08-20) is selected, so
        // effectiveStartingCapital defaults to its own startingCapital (20).
        render(<ResultsPanel range="1M" state={state} selectedDay="2026-08-20" />);
        await submitWholeRangeGuess(user);

        // The range's own root startingCapital is 20; the final chained
        // day's (2026-08-21) long-only endingBalance is 100.
        // rescaleFromStartingCapital(100, from=20 [root], to=20) = 100 --
        // i.e. unrescaled, since root === the current display capital here.
        // Scoped to the headline's own container (not screen.getByText
        // directly) since "$20.00" and "$100.00" can each also appear
        // elsewhere on the page (e.g. HeroStat, DayOverview rows).
        const headline = screen.getByText(
          "Whole-range running balance -- carried day to day, start to finish",
        ).parentElement!;
        expect(within(headline).getByText("$20.00")).toBeInTheDocument();
        expect(within(headline).getByText("$100.00")).toBeInTheDocument();
      });

      it("computes the whole-range figure from the range's own root, not a per-day rescale that would cancel the chaining back out", async () => {
        // This is the one call site apps/web/CLAUDE.md's own "rescaleFromStartingCapital's
        // per-day pattern silently cancels out..." section specifically
        // warns against reusing the per-day pattern for -- this test
        // pins the correct (root-based) number down explicitly.
        const user = userEvent.setup();
        const state: ResultsState = { status: "success", data: fixtureChainedResult() };
        render(
          <ResultsPanel range="1M" state={state} selectedDay="2026-08-21" startingCapital={40} />,
        );
        await submitWholeRangeGuess(user);

        // rescaleFromStartingCapital(100, from=20 [the range's own root],
        // to=40 [the user's chosen display capital]) = 200. A (wrong)
        // per-day rescale would instead use the final day's own
        // (chained) startingCapital, 40, as "from" -- rescaleFromStartingCapital(100,
        // from=40, to=40) = 100 unrescaled -- a different, incorrect number.
        const headline = screen.getByText(
          "Whole-range running balance -- carried day to day, start to finish",
        ).parentElement!;
        expect(within(headline).getByText("$200.00")).toBeInTheDocument();
        expect(within(headline).queryByText("$100.00")).not.toBeInTheDocument();
      });

      it("renders WholeRangeReplay (not a bare PortfolioChart) once revealed -- a 'Watch it happen' button now exists, which the old bare chart call never had", async () => {
        const user = userEvent.setup();
        const state: ResultsState = { status: "success", data: fixtureChainedResult() };
        render(<ResultsPanel range="1M" state={state} selectedDay="2026-08-21" />);
        await submitWholeRangeGuess(user);

        expect(screen.getByRole("button", { name: "Watch it happen" })).toBeInTheDocument();
        expect(screen.getByRole("img", { name: /portfolio value over time/i })).toBeInTheDocument();
      });

      it("computes and rescales the whole-range worst-case figure (issue #105) from the range's own root, mirroring wholeRangeFinalBalance's own pattern -- mode='long'", async () => {
        const user = userEvent.setup();
        const state: ResultsState = { status: "success", data: fixtureChainedResult() };
        render(
          <ResultsPanel range="1M" state={state} selectedDay="2026-08-21" startingCapital={100} />,
        );
        await submitWholeRangeGuess(user);

        // finalDay (2026-08-21).worstCase = { startingCapital: 10, endingBalance: 20 };
        // wholeRangeWorstCaseStartingCapital is always the range's own
        // root (20), not the day's own chained worstCase.startingCapital
        // -- rescaleFromStartingCapital(20, from=20 [root], to=100) = 100.
        const caption = screen.getByText(
          "Whole-range running balance -- carried day to day, start to finish",
        );
        const row = caption.closest(".relative")!.parentElement!;
        const worstCase = within(row).getByText("Worst case, same budget").parentElement!;
        expect(within(worstCase).getByText("$100.00")).toBeInTheDocument();
      });

      it("computes and rescales the whole-range worst-case figure from the long+short track under mode='long-short'", async () => {
        const user = userEvent.setup();
        const state: ResultsState = { status: "success", data: fixtureChainedResult() };
        render(
          <ResultsPanel
            range="1M"
            state={state}
            selectedDay="2026-08-21"
            mode="long-short"
            startingCapital={100}
          />,
        );
        await submitWholeRangeGuess(user);

        // finalDay.longShort.worstCase = { startingCapital: 5, endingBalance: 15 };
        // still rescaled from the range's own root (20), not the track's
        // own chained worstCase.startingCapital (5) --
        // rescaleFromStartingCapital(15, from=20 [root], to=100) = 75.
        const caption = screen.getByText(
          "Whole-range running balance -- carried day to day, start to finish",
        );
        const row = caption.closest(".relative")!.parentElement!;
        const worstCase = within(row).getByText("Worst case, same budget").parentElement!;
        expect(within(worstCase).getByText("$75.00")).toBeInTheDocument();
      });
    });
  });

  describe("custom-window model (issue #11)", () => {
    // The `range` prop is a harmless placeholder in this mode (see
    // ResultsPanelProps' own doc comment) -- never read by the
    // custom-window render path, which derives its own copy from the
    // anchor's own startDate instead of RANGE_COPY[range].

    it("shows an empty state when a successful response has zero trades", () => {
      const state: ResultsState<CustomWindowResult> = {
        status: "success",
        data: fixtureCustomWindowResult({ trades: [], endingBalance: 20 }),
      };
      render(<ResultsPanel range="1Y" state={state} />);

      expect(
        screen.getByText(/no trade would have beaten holding cash since mar 1, 2019/i),
      ).toBeInTheDocument();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });

    it("renders the hero stat, chart, and trade list for a full success response, with 'since <date>' copy instead of a preset range label", () => {
      const state: ResultsState<CustomWindowResult> = {
        status: "success",
        data: fixtureCustomWindowResult(),
      };
      render(<ResultsPanel range="1Y" state={state} />);

      expect(screen.getAllByText("$20.00").length).toBeGreaterThan(0);
      expect(screen.getAllByText("$6.9K").length).toBeGreaterThan(0);
      expect(screen.getByRole("img", { name: /portfolio value over time/i })).toBeInTheDocument();
      expect(screen.getAllByText(/SNDK/).length).toBeGreaterThan(0);
      expect(screen.getByText(/best possible outcome since mar 1, 2019/i)).toBeInTheDocument();
      // The worst-case contrast stat (issue #31) renders alongside HeroStat here too.
      expect(screen.getByText("$4.20")).toBeInTheDocument();
    });

    it("mentions maxTrades from the data, not a hardcoded literal", () => {
      const state: ResultsState<CustomWindowResult> = {
        status: "success",
        data: fixtureCustomWindowResult({ maxTrades: 5 }),
      };
      render(<ResultsPanel range="1Y" state={state} />);

      expect(screen.getByText(/at most 5 sequential/i)).toBeInTheDocument();
    });

    it("renders the BenchmarkStat comparison line when the result has a benchmark", () => {
      const state: ResultsState<CustomWindowResult> = {
        status: "success",
        data: fixtureCustomWindowResult({
          benchmark: {
            ticker: "SPY",
            startDate: "2019-03-01",
            startPrice: 280,
            endDate: "2026-08-21",
            endPrice: 540,
            endingBalance: 38.57,
            truncated: false,
          },
        }),
      };
      render(<ResultsPanel range="1Y" state={state} />);

      expect(
        screen.getByText(/Buying and holding SPY since mar 1, 2019 instead/i),
      ).toBeInTheDocument();
    });

    it("passes the user's rescaled starting capital into TradeList, not the raw precomputed startingCapital", () => {
      const state: ResultsState<CustomWindowResult> = {
        status: "success",
        data: fixtureCustomWindowResult(),
      };
      render(<ResultsPanel range="1Y" state={state} startingCapital={500} />);

      expect(screen.getAllByText("$500.00").length).toBeGreaterThan(0);
      expect(screen.queryByText(/turning your \$20\.00/i)).not.toBeInTheDocument();
      expect(screen.getByText(/turning your \$500\.00/i)).toBeInTheDocument();
    });

    // Regression tests for the issue #11/#13 integration -- a
    // CustomWindowResult now carries the same longShort sibling field
    // WindowResult already had, and WindowResultBody selects a variant
    // for it exactly the same way it does for a preset range.
    it("defaults to the long-only variant when mode is omitted", () => {
      const state: ResultsState<CustomWindowResult> = {
        status: "success",
        data: fixtureCustomWindowResult(),
      };
      render(<ResultsPanel range="1Y" state={state} />);

      expect(screen.getAllByText("$6.9K").length).toBeGreaterThan(0);
      expect(screen.getAllByText(/SNDK/).length).toBeGreaterThan(0);
      expect(screen.queryByText(/COIN/)).not.toBeInTheDocument();
    });

    it("renders the long+short variant's HeroStat/trade list when mode='long-short'", () => {
      const state: ResultsState<CustomWindowResult> = {
        status: "success",
        data: fixtureCustomWindowResult(),
      };
      render(<ResultsPanel range="1Y" state={state} mode="long-short" />);

      expect(screen.getAllByText("$9K").length).toBeGreaterThan(0);
      expect(screen.getAllByText(/COIN/).length).toBeGreaterThan(0);
      expect(screen.queryByText(/SNDK/)).not.toBeInTheDocument();
    });

    it("renders the long+short variant's WorstCaseStat when mode='long-short'", () => {
      const state: ResultsState<CustomWindowResult> = {
        status: "success",
        data: fixtureCustomWindowResult(),
      };
      render(<ResultsPanel range="1Y" state={state} mode="long-short" />);

      // longShort.worstCase.endingBalance is 2 (vs. the long-only 4.2).
      expect(screen.getByText("$2.00")).toBeInTheDocument();
      expect(screen.queryByText("$4.20")).not.toBeInTheDocument();
    });
  });

  describe("range/anchor switch fade-in transition (issue #65)", () => {
    // jsdom in this repo's Vitest setup has no window.matchMedia at all
    // (see prefers-reduced-motion.ts's own doc comment) -- stubMatchMedia
    // gives every test in this block a deterministic answer for
    // prefersReducedMotion()'s own "(prefers-reduced-motion: reduce)"
    // query instead of silently relying on that missing-matchMedia
    // fallback.
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("applies the fade-in class to the window model's success wrapper when motion is allowed", () => {
      stubMatchMedia({ "(prefers-reduced-motion: reduce)": false });
      const state: ResultsState = { status: "success", data: fixtureResult() };
      const { container } = render(<ResultsPanel range="1Y" state={state} />);

      expect(container.querySelector(".flex.flex-col.gap-8")).toHaveClass("results-fade-in");
    });

    it("omits the fade-in class from the window model's success wrapper under prefers-reduced-motion", () => {
      stubMatchMedia({ "(prefers-reduced-motion: reduce)": true });
      const state: ResultsState = { status: "success", data: fixtureResult() };
      const { container } = render(<ResultsPanel range="1Y" state={state} />);

      expect(container.querySelector(".flex.flex-col.gap-8")).not.toHaveClass("results-fade-in");
    });

    it("applies the fade-in class to the custom-window model's success wrapper when motion is allowed", () => {
      stubMatchMedia({ "(prefers-reduced-motion: reduce)": false });
      const state: ResultsState<CustomWindowResult> = {
        status: "success",
        data: fixtureCustomWindowResult(),
      };
      const { container } = render(<ResultsPanel range="1Y" state={state} />);

      expect(container.querySelector(".flex.flex-col.gap-8")).toHaveClass("results-fade-in");
    });

    it("omits the fade-in class from the custom-window model's success wrapper under prefers-reduced-motion", () => {
      stubMatchMedia({ "(prefers-reduced-motion: reduce)": true });
      const state: ResultsState<CustomWindowResult> = {
        status: "success",
        data: fixtureCustomWindowResult(),
      };
      const { container } = render(<ResultsPanel range="1Y" state={state} />);

      expect(container.querySelector(".flex.flex-col.gap-8")).not.toHaveClass("results-fade-in");
    });

    it("applies the fade-in class to the intraday-daily model's success wrapper when motion is allowed", () => {
      stubMatchMedia({ "(prefers-reduced-motion: reduce)": false });
      const state: ResultsState = { status: "success", data: fixtureIntradayResult() };
      const { container } = render(<ResultsPanel range="1M" state={state} />);

      expect(container.querySelector(".flex.flex-col.gap-8")).toHaveClass("results-fade-in");
    });

    it("omits the fade-in class from the intraday-daily model's success wrapper under prefers-reduced-motion", () => {
      stubMatchMedia({ "(prefers-reduced-motion: reduce)": true });
      const state: ResultsState = { status: "success", data: fixtureIntradayResult() };
      const { container } = render(<ResultsPanel range="1M" state={state} />);

      expect(container.querySelector(".flex.flex-col.gap-8")).not.toHaveClass("results-fade-in");
    });

    // Regression test for a real bug found in `high` code review: the
    // first version of this feature re-read prefersReducedMotion() on
    // every ResultsPanel render, not just at the wrapper's own mount --
    // so if the OS-level preference changed value between two renders of
    // an *already-mounted* wrapper (no new fetch, same `state.status ===
    // "success"` the whole time), the fade-in class would flip on
    // already-visible content, restarting the CSS animation on what's
    // supposed to be an instant, unrelated re-render. FadeInWrapper's
    // useState lazy initializer fixes this by only ever reading
    // prefersReducedMotion() once, at the wrapper's own mount -- this
    // test re-renders the *same* mounted success tree (same `state`
    // reference, no unmount) with the stubbed media query flipped in
    // between, and asserts the class doesn't move either time.
    it("keeps the fade-in class fixed across a re-render of an already-mounted wrapper, even if the OS motion preference changes mid-session", () => {
      stubMatchMedia({ "(prefers-reduced-motion: reduce)": false });
      const state: ResultsState = { status: "success", data: fixtureResult() };
      const { container, rerender } = render(<ResultsPanel range="1Y" state={state} mode="long" />);
      expect(container.querySelector(".flex.flex-col.gap-8")).toHaveClass("results-fade-in");

      // Flip the stubbed preference, then re-render the same wrapper with
      // an unrelated prop change (mode) -- this must not unmount/remount
      // WindowResultBody's own FadeInWrapper.
      stubMatchMedia({ "(prefers-reduced-motion: reduce)": true });
      rerender(<ResultsPanel range="1Y" state={state} mode="long-short" />);

      expect(container.querySelector(".flex.flex-col.gap-8")).toHaveClass("results-fade-in");
    });
  });
});
