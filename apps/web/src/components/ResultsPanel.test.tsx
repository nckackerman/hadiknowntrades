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
 * Submits an arbitrary guess through the DailyGuessForm currently on
 * screen (issue #34) -- every intraday-daily test below has to clear this
 * gate before it can assert on the actual revealed result, the same way a
 * real user would.
 *
 * The submit button's accessible name is matched *exactly* ("Reveal the
 * answer"), not with a loose /reveal/i regex -- since issue #80 added
 * DayOverview, every unguessed day's own row button also has "Guess to
 * reveal" in its accessible name, and a loose match found the first (and
 * wrong) one of those instead of the actual submit button.
 */
async function submitAnyGuess(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText(/what do you think/i), "1");
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
    expect(screen.getByText(/Buying and holding SPY instead/)).toBeInTheDocument();

    const withoutBenchmark: ResultsState = {
      status: "success",
      data: fixtureResult({ benchmark: null }),
    };
    rerender(<ResultsPanel range="1Y" state={withoutBenchmark} />);
    expect(screen.queryByText(/Buying and holding SPY/)).not.toBeInTheDocument();
  });

  describe("intraday-daily model (issue #28)", () => {
    // Every day's result is gated behind the guess-then-reveal flow
    // (issue #34, see DailyGuessForm/use-daily-guess.ts) -- a stored
    // guess is what unlocks HeroStat/PortfolioChart/the trade list, so
    // any test asserting on the actual revealed result has to clear that
    // gate first (submitAnyGuess), same as a real user would. Guesses
    // persist in the same jsdom `localStorage` across tests in this
    // file, so clear it after every test to keep them independent.
    afterEach(() => {
      window.localStorage.clear();
    });

    it("re-triggers HeroStat's reveal animation when switching days, instead of leaving the visible figure frozen on the previous day's value", async () => {
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

      const user = userEvent.setup();
      const data = fixtureIntradayResult();
      const state: ResultsState = { status: "success", data };
      const { rerender } = render(
        <ResultsPanel range="1M" state={state} selectedDay="2026-08-20" />,
      );
      await submitAnyGuess(user);

      // Day 1 (2026-08-20): endingBalance 25.
      expect(
        screen.getByText("$25.00", { selector: "span[aria-hidden]:not(.sr-only)" }),
      ).toBeInTheDocument();

      rerender(<ResultsPanel range="1M" state={state} selectedDay="2026-08-21" />);
      await submitAnyGuess(user);

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

    it("defaults to the most recent day when no day is selected", async () => {
      const user = userEvent.setup();
      const state: ResultsState = { status: "success", data: fixtureIntradayResult() };
      render(<ResultsPanel range="1M" state={state} />);
      // The date is visible in the guess prompt itself, before any guess
      // is submitted -- confirms the fallback-to-most-recent-day logic
      // runs even pre-reveal, not just after. Scoped to the prompt's own
      // label (not a bare screen.getByText) since issue #80's DayOverview
      // also renders "Aug 21, 2026" in its own day row.
      expect(screen.getByLabelText(/Aug 21, 2026/)).toBeInTheDocument();
      await submitAnyGuess(user);

      // Most recent day is 2026-08-21 (MSFT), not 2026-08-20 (AAPL).
      expect(screen.getAllByText(/MSFT/).length).toBeGreaterThan(0);
      expect(screen.queryByText(/AAPL/)).not.toBeInTheDocument();
    });

    it("labels each trade with 'at TIME', not 'on TIME' -- a real grammar bug caught in code review (TradeRow hardcoded the window model's 'on')", async () => {
      const user = userEvent.setup();
      const state: ResultsState = { status: "success", data: fixtureIntradayResult() };
      render(<ResultsPanel range="1M" state={state} />);
      await submitAnyGuess(user);

      expect(screen.getByText(/at 9:30 AM/)).toBeInTheDocument();
      expect(screen.getByText(/at 10:30 AM/)).toBeInTheDocument();
      expect(screen.queryByText(/on 9:30 AM/)).not.toBeInTheDocument();
    });

    it("shows the selected day's result when selectedDay matches an earlier day", async () => {
      const user = userEvent.setup();
      const state: ResultsState = { status: "success", data: fixtureIntradayResult() };
      render(<ResultsPanel range="1M" state={state} selectedDay="2026-08-20" />);
      await submitAnyGuess(user);

      expect(screen.getAllByText(/AAPL/).length).toBeGreaterThan(0);
      expect(screen.queryByText(/MSFT/)).not.toBeInTheDocument();
    });

    it("falls back to the most recent day when selectedDay doesn't match any day in the result", async () => {
      const user = userEvent.setup();
      const state: ResultsState = { status: "success", data: fixtureIntradayResult() };
      render(<ResultsPanel range="1M" state={state} selectedDay="2020-01-01" />);
      await submitAnyGuess(user);

      expect(screen.getAllByText(/MSFT/).length).toBeGreaterThan(0);
    });

    it("calls onSelectDay when a different day's row is clicked in DayOverview, even before that day has been guessed", async () => {
      const user = userEvent.setup();
      const onSelectDay = vi.fn();
      const state: ResultsState = { status: "success", data: fixtureIntradayResult() };
      render(<ResultsPanel range="1M" state={state} onSelectDay={onSelectDay} />);

      await user.click(screen.getByRole("button", { name: /Aug 20, 2026/ }));

      expect(onSelectDay).toHaveBeenCalledWith("2026-08-20");
    });

    describe("DayOverview (issue #80)", () => {
      it("lists every trading day in the range with its own trade count, even before any day has been guessed", () => {
        const state: ResultsState = { status: "success", data: fixtureIntradayResult() };
        render(<ResultsPanel range="1M" state={state} />);

        // fixtureIntradayResult's two days: 2026-08-20 (1 trade) and
        // 2026-08-21 (the default-selected, most recent day -- 1 trade
        // too, see its own fixture trades array).
        expect(screen.getByRole("button", { name: /Aug 20, 2026.*1 trade/ })).toBeInTheDocument();
        expect(screen.getByRole("button", { name: /Aug 21, 2026.*1 trade/ })).toBeInTheDocument();
      });

      it("never shows a day's dollar ending balance until that specific day has been guessed", async () => {
        const user = userEvent.setup();
        const state: ResultsState = { status: "success", data: fixtureIntradayResult() };
        render(<ResultsPanel range="1M" state={state} />);

        // Neither day's real ending balance ($25 for 08-20, $40 for
        // 08-21) is visible before any guess is submitted -- both rows
        // show the locked placeholder instead.
        expect(screen.getAllByText("Guess to reveal")).toHaveLength(2);
        expect(screen.queryByText("$25.00")).not.toBeInTheDocument();
        expect(screen.queryByText("$40.00")).not.toBeInTheDocument();

        // Guessing the currently-active day (2026-08-21, the default)
        // reveals only that row's balance -- the other day, still
        // unguessed, keeps its own placeholder. Scoped to the day's own
        // row (not a bare screen.getByText) since HeroStat's sr-only
        // figure reads the identical "$40.00" once revealed too.
        await submitAnyGuess(user);

        const revealedRow = screen.getByRole("button", { name: /Aug 21, 2026/ });
        expect(within(revealedRow).getByText("$40.00")).toBeInTheDocument();
        expect(screen.getAllByText("Guess to reveal")).toHaveLength(1);
      });
    });

    it("shows an empty state for a day with no trades", async () => {
      const user = userEvent.setup();
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
      await submitAnyGuess(user);

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

    it("renders the BenchmarkStat comparison line, disambiguated with the range, once the day's guess is revealed -- and never before (issue #12)", async () => {
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

      // Gated behind the same guess-then-reveal condition as the rest of
      // this day's content (issue #34) -- showing the benchmark before
      // the guess is submitted would partially spoil the real answer.
      expect(screen.queryByText(/Buying and holding SPY/)).not.toBeInTheDocument();

      await submitAnyGuess(user);

      // The whole-range benchmark (issue #12), disambiguated from the
      // single selected day everything else on screen is scoped to.
      expect(
        screen.getByText(/Buying and holding SPY over the past month instead/),
      ).toBeInTheDocument();
    });

    it("mentions maxTradesPerDay from the data, not a hardcoded literal", async () => {
      const user = userEvent.setup();
      const state: ResultsState = {
        status: "success",
        data: fixtureIntradayResult({ maxTradesPerDay: 5 }),
      };
      render(<ResultsPanel range="1M" state={state} />);
      await submitAnyGuess(user);

      expect(screen.getByText(/at most 5 same-day/i)).toBeInTheDocument();
    });

    describe("guess-then-reveal (issue #34)", () => {
      it("hides HeroStat, the chart, and the trade list behind a guess prompt before the user has guessed", () => {
        const state: ResultsState = { status: "success", data: fixtureIntradayResult() };
        render(<ResultsPanel range="1M" state={state} />);

        expect(screen.getByRole("button", { name: "Reveal the answer" })).toBeInTheDocument();
        expect(screen.queryByText("$40.00")).not.toBeInTheDocument();
        expect(screen.queryByText(/MSFT/)).not.toBeInTheDocument();
        expect(
          screen.queryByRole("img", { name: /portfolio value over time/i }),
        ).not.toBeInTheDocument();
        // The worst-case contrast stat (issue #31) must not spoil the
        // real answer before the guess is submitted either.
        expect(screen.queryByText("$4.00")).not.toBeInTheDocument();
        expect(screen.queryByText(/worst case/i)).not.toBeInTheDocument();
      });

      it("reveals the worst-case contrast stat alongside HeroStat once the guess is submitted, not before (issue #31)", async () => {
        const user = userEvent.setup();
        const state: ResultsState = { status: "success", data: fixtureIntradayResult() };
        render(<ResultsPanel range="1M" state={state} />);

        expect(screen.queryByText(/worst case/i)).not.toBeInTheDocument();

        await submitAnyGuess(user);

        // Most recent day (2026-08-21): worstCase.endingBalance 4, i.e. 0.2x.
        expect(screen.getByText("$4.00")).toBeInTheDocument();
        expect(screen.getByText("(0.2x)")).toBeInTheDocument();
      });

      it("prompts against the user's rescaled starting capital, not the raw per-day precomputed one -- regression test for a real bug found in code review: DailyGuessForm's prompt used to read activeDay.startingCapital directly, so the guess prompt disagreed with the rest of the page's rescaled dollar figures whenever a non-default starting capital was set", () => {
        const state: ResultsState = { status: "success", data: fixtureIntradayResult() };
        render(<ResultsPanel range="1M" state={state} startingCapital={500} />);

        expect(screen.getByText(/what do you think \$500\.00 turned into/i)).toBeInTheDocument();
        expect(
          screen.queryByText(/what do you think \$20\.00 turned into/i),
        ).not.toBeInTheDocument();
      });

      it("reveals the actual result once the user submits a guess, and shows their guess alongside it", async () => {
        const user = userEvent.setup();
        const state: ResultsState = { status: "success", data: fixtureIntradayResult() };
        render(<ResultsPanel range="1M" state={state} />);

        await user.type(screen.getByLabelText(/what do you think/i), "30");
        await user.click(screen.getByRole("button", { name: "Reveal the answer" }));

        expect(screen.queryByRole("button", { name: "Reveal the answer" })).not.toBeInTheDocument();
        expect(screen.getAllByText(/MSFT/).length).toBeGreaterThan(0);
        expect(screen.getByRole("img", { name: /portfolio value over time/i })).toBeInTheDocument();
        expect(screen.getByText(/you guessed \$30\.00/i)).toBeInTheDocument();
      });

      it("rescales the 'You guessed' figure when starting capital changes after the reveal, instead of leaving it stuck at the value guessed under the old capital -- real bug found in code review: HeroStat/the chart rescaled live on a post-reveal starting-capital edit but this line, driven by the raw stored guess, silently didn't", async () => {
        const user = userEvent.setup();
        const state: ResultsState = { status: "success", data: fixtureIntradayResult() };
        const { rerender } = render(<ResultsPanel range="1M" state={state} startingCapital={20} />);

        // Guessed while the prompt showed $20.00 starting capital.
        await user.type(screen.getByLabelText(/what do you think/i), "30");
        await user.click(screen.getByRole("button", { name: "Reveal the answer" }));
        expect(screen.getByText(/you guessed \$30\.00/i)).toBeInTheDocument();

        // Starting capital changes post-reveal (e.g. via StartingCapitalInput)
        // to 10x the original -- the guess was $30 against $20, so it must
        // now read as $300.00 to stay comparable to the also-rescaled
        // HeroStat/chart figures, not stay frozen at the stale $30.00.
        rerender(<ResultsPanel range="1M" state={state} startingCapital={200} />);

        expect(screen.getByText(/you guessed \$300\.00/i)).toBeInTheDocument();
        expect(screen.queryByText(/you guessed \$30\.00/i)).not.toBeInTheDocument();
      });

      it("persists the guess across a simulated reload (re-mount with the same localStorage) and skips straight to the reveal", async () => {
        const user = userEvent.setup();
        const state: ResultsState = { status: "success", data: fixtureIntradayResult() };
        const { unmount } = render(<ResultsPanel range="1M" state={state} />);

        await user.type(screen.getByLabelText(/what do you think/i), "15");
        await user.click(screen.getByRole("button", { name: "Reveal the answer" }));
        expect(screen.getAllByText(/MSFT/).length).toBeGreaterThan(0);

        unmount();
        render(<ResultsPanel range="1M" state={state} />);

        // No guess prompt on the "reload" -- straight to the revealed result.
        expect(screen.queryByRole("button", { name: "Reveal the answer" })).not.toBeInTheDocument();
        expect(screen.getAllByText(/MSFT/).length).toBeGreaterThan(0);
        expect(screen.getByText(/you guessed \$15\.00/i)).toBeInTheDocument();
      });

      it("asks for a fresh guess on a different day that hasn't been guessed yet, even after guessing another day", async () => {
        const user = userEvent.setup();
        const state: ResultsState = { status: "success", data: fixtureIntradayResult() };
        const { rerender } = render(
          <ResultsPanel range="1M" state={state} selectedDay="2026-08-21" />,
        );
        await submitAnyGuess(user);
        expect(screen.getAllByText(/MSFT/).length).toBeGreaterThan(0);

        rerender(<ResultsPanel range="1M" state={state} selectedDay="2026-08-20" />);

        expect(screen.getByRole("button", { name: "Reveal the answer" })).toBeInTheDocument();
        expect(screen.queryByText(/AAPL/)).not.toBeInTheDocument();
      });

      it("re-prompts for a guess on the same date when the range changes, instead of skipping straight to reveal (1M and 3M/1Y can genuinely differ on the same calendar date)", async () => {
        // Regression test for a real bug: guesses used to be keyed by
        // calendar date alone, so a guess submitted while on one range's
        // tab silently satisfied the guess-gate for the *same date* under
        // a different range too -- even though the underlying result for
        // that date can genuinely differ across 1M/3M/1Y's independent
        // granularity overrides (see daily-guess-storage.ts).
        const user = userEvent.setup();
        const state: ResultsState = { status: "success", data: fixtureIntradayResult() };
        const { rerender } = render(
          <ResultsPanel range="1M" state={state} selectedDay="2026-08-21" />,
        );
        await submitAnyGuess(user);
        expect(screen.getAllByText(/MSFT/).length).toBeGreaterThan(0);

        rerender(<ResultsPanel range="3M" state={state} selectedDay="2026-08-21" />);
        expect(screen.getByRole("button", { name: "Reveal the answer" })).toBeInTheDocument();
        expect(screen.queryByText(/MSFT/)).not.toBeInTheDocument();

        rerender(<ResultsPanel range="1Y" state={state} selectedDay="2026-08-21" />);
        expect(screen.getByRole("button", { name: "Reveal the answer" })).toBeInTheDocument();

        // Switching back to 1M still remembers the original guess.
        rerender(<ResultsPanel range="1M" state={state} selectedDay="2026-08-21" />);
        expect(screen.queryByRole("button", { name: "Reveal the answer" })).not.toBeInTheDocument();
        expect(screen.getAllByText(/MSFT/).length).toBeGreaterThan(0);
      });

      it('announces the reveal to screen readers via a role="status" live region once the guess is submitted, and stays silent before (issue #67)', async () => {
        const user = userEvent.setup();
        const state: ResultsState = { status: "success", data: fixtureIntradayResult() };
        render(<ResultsPanel range="1M" state={state} selectedDay="2026-08-21" />);

        // The live region exists in the DOM before the reveal -- so
        // assistive tech has already registered it and will catch the
        // upcoming content change -- but carries no announcement yet.
        expect(screen.getByRole("status", { name: "Day reveal status" })).toHaveTextContent("");

        await submitAnyGuess(user);

        expect(screen.getByRole("status", { name: "Day reveal status" })).toHaveTextContent(
          "Results revealed for Aug 21, 2026 (long only).",
        );
      });

      it("clears the reveal announcement when switching to a different day that hasn't been guessed yet", async () => {
        const user = userEvent.setup();
        const state: ResultsState = { status: "success", data: fixtureIntradayResult() };
        const { rerender } = render(
          <ResultsPanel range="1M" state={state} selectedDay="2026-08-21" />,
        );
        await submitAnyGuess(user);
        expect(screen.getByRole("status", { name: "Day reveal status" })).toHaveTextContent(
          "Results revealed for Aug 21, 2026 (long only).",
        );

        rerender(<ResultsPanel range="1M" state={state} selectedDay="2026-08-20" />);

        expect(screen.getByRole("status", { name: "Day reveal status" })).toHaveTextContent("");
      });

      it("does not wire the announcement to HeroStat's per-frame animating figure -- it stays a static sentence even mid-tween (issue #67)", async () => {
        // Regression guard for the exact trap apps/web/CLAUDE.md's
        // "Client-side animation" section documents: never let an
        // aria-live region announce every intermediate count-up value.
        // Here requestAnimationFrame is left un-mocked (jsdom's real
        // rAF backs it, see that same doc section), so useCountUp's
        // tween is still mid-flight when this assertion runs -- the
        // live region's text must already be the final static sentence
        // regardless, never an in-progress dollar figure.
        const user = userEvent.setup();
        const state: ResultsState = { status: "success", data: fixtureIntradayResult() };
        render(<ResultsPanel range="1M" state={state} selectedDay="2026-08-21" />);

        await submitAnyGuess(user);

        expect(screen.getByRole("status", { name: "Day reveal status" })).toHaveTextContent(
          "Results revealed for Aug 21, 2026 (long only).",
        );
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
    // Two of the tests below submit a guess (intraday-daily model), which
    // persists to the same jsdom localStorage across tests -- clear it
    // after every test to keep them independent, same as the
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

    it("renders the long+short variant for the intraday-daily model too, once guessed", async () => {
      const user = userEvent.setup();
      const state: ResultsState = { status: "success", data: fixtureIntradayResult() };
      render(<ResultsPanel range="1M" state={state} mode="long-short" />);
      await submitAnyGuess(user);

      // Most recent day (2026-08-21): longShort.endingBalance 400, ticker COIN.
      expect(screen.getAllByText(/COIN/).length).toBeGreaterThan(0);
      expect(screen.queryByText(/MSFT/)).not.toBeInTheDocument();
    });

    it("keeps the guess-gate independent per mode -- a guess made under long-only doesn't skip the reveal for long-short on the same day", async () => {
      const user = userEvent.setup();
      const state: ResultsState = { status: "success", data: fixtureIntradayResult() };
      const { rerender } = render(<ResultsPanel range="1M" state={state} mode="long" />);
      await submitAnyGuess(user);
      expect(screen.getAllByText(/MSFT/).length).toBeGreaterThan(0);

      rerender(<ResultsPanel range="1M" state={state} mode="long-short" />);
      expect(screen.getByRole("button", { name: "Reveal the answer" })).toBeInTheDocument();
    });

    it("re-announces the reveal when switching modes on a day already guessed under both modes, since the underlying content genuinely changes (issue #67 regression, found in code review)", async () => {
      // Unlike the previous test, both modes' guesses are already stored
      // before this test's own assertions run -- guess stays non-null on
      // both sides of the mode switch below, so the aria-live text is the
      // *only* signal a screen reader gets that the swapped-in content
      // (a genuinely different trade sequence -- see HeroStat's own
      // heroKey comment) is new. The fix must key the announcement on
      // mode, not just date, or this switch produces no DOM mutation at
      // all for assistive tech to notice.
      const user = userEvent.setup();
      const state: ResultsState = { status: "success", data: fixtureIntradayResult() };
      const { rerender } = render(<ResultsPanel range="1M" state={state} mode="long" />);
      await submitAnyGuess(user);
      rerender(<ResultsPanel range="1M" state={state} mode="long-short" />);
      await submitAnyGuess(user);
      expect(screen.getByRole("status", { name: "Day reveal status" })).toHaveTextContent(
        "Results revealed for Aug 21, 2026 (long + short).",
      );

      rerender(<ResultsPanel range="1M" state={state} mode="long" />);

      expect(screen.getByRole("status", { name: "Day reveal status" })).toHaveTextContent(
        "Results revealed for Aug 21, 2026 (long only).",
      );
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

      it("WorstCaseStat rescales from worstCase.startingCapital under mode='long' (real bug: the old code used the long-only track's startingCapital here even under long-only mode, since IntradayWorstCaseResult had no startingCapital of its own pre-#84)", async () => {
        const user = userEvent.setup();
        const state: ResultsState = { status: "success", data: fixtureChainedResult() };
        render(<ResultsPanel range="1M" state={state} selectedDay="2026-08-21" />);
        await submitAnyGuess(user);

        // Correct: rescaleFromStartingCapital(20, from=10, to=40) = 80.
        expect(screen.getByText("$80.00")).toBeInTheDocument();
        // The pre-fix bug's own number (from=activeDay.startingCapital=40=to, a no-op): 20.
        expect(screen.queryByText("$20.00")).not.toBeInTheDocument();
      });

      it("HeroStat rescales from the long-short track's own startingCapital under mode='long-short' (real bug: the old code always used activeDay.startingCapital, the long-only track's)", async () => {
        const user = userEvent.setup();
        const state: ResultsState = { status: "success", data: fixtureChainedResult() };
        render(
          <ResultsPanel range="1M" state={state} selectedDay="2026-08-21" mode="long-short" />,
        );
        await submitAnyGuess(user);

        // Correct: rescaleFromStartingCapital(300, from=60, to=40) = 200.
        expect(screen.getAllByText("$200.00").length).toBeGreaterThan(0);
        // The pre-fix bug's own number (from=activeDay.startingCapital=40=to, a no-op): 300.
        expect(screen.queryByText("$300.00")).not.toBeInTheDocument();
      });

      it("WorstCaseStat rescales from the long-short-worst track's own startingCapital under mode='long-short'", async () => {
        const user = userEvent.setup();
        const state: ResultsState = { status: "success", data: fixtureChainedResult() };
        render(
          <ResultsPanel range="1M" state={state} selectedDay="2026-08-21" mode="long-short" />,
        );
        await submitAnyGuess(user);

        // Correct: rescaleFromStartingCapital(15, from=5, to=40) = 120.
        expect(screen.getByText("$120.00")).toBeInTheDocument();
        // The pre-fix bug's own number (from=activeDay.startingCapital=40=to, a no-op): 15.
        expect(screen.queryByText("$15.00")).not.toBeInTheDocument();
      });

      it("dayOverviewRows' per-row figure rescales from the long-short track's own startingCapital under mode='long-short', matching HeroStat's own figure for the same day", async () => {
        const user = userEvent.setup();
        const state: ResultsState = { status: "success", data: fixtureChainedResult() };
        render(
          <ResultsPanel range="1M" state={state} selectedDay="2026-08-21" mode="long-short" />,
        );
        await submitAnyGuess(user);

        const revealedRow = screen.getByRole("button", { name: /Aug 21, 2026/ });
        // Same correct figure as HeroStat's own: rescaleFromStartingCapital(300, from=60, to=40) = 200.
        expect(within(revealedRow).getByText("$200.00")).toBeInTheDocument();
        expect(within(revealedRow).queryByText("$300.00")).not.toBeInTheDocument();
      });
    });

    describe("the whole-range running-balance headline (count-gated, section 4.2)", () => {
      it("stays masked with a progress placeholder before every day in the range has been individually revealed", () => {
        const state: ResultsState = { status: "success", data: fixtureChainedResult() };
        render(<ResultsPanel range="1M" state={state} selectedDay="2026-08-21" />);

        expect(
          screen.getByText(/reveal all 2 days below to see the range's full running balance/i),
        ).toBeInTheDocument();
        expect(screen.getByText(/0 of 2 revealed so far/i)).toBeInTheDocument();
      });

      it("stays masked even after revealing one of two days (count-gated, not unlocked by a single reveal)", async () => {
        const user = userEvent.setup();
        const state: ResultsState = { status: "success", data: fixtureChainedResult() };
        render(<ResultsPanel range="1M" state={state} selectedDay="2026-08-21" />);
        await submitAnyGuess(user);

        expect(screen.getByText(/1 of 2 revealed so far/i)).toBeInTheDocument();
      });

      it("announces its own unlock to screen readers via a dedicated aria-live region, distinct from the per-day reveal announcement (code review finding, fixed)", async () => {
        const user = userEvent.setup();
        const state: ResultsState = { status: "success", data: fixtureChainedResult() };
        const { rerender } = render(
          <ResultsPanel range="1M" state={state} selectedDay="2026-08-21" />,
        );

        // Empty before every day is revealed.
        expect(screen.getByRole("status", { name: "Whole-range reveal status" })).toHaveTextContent(
          "",
        );

        await submitAnyGuess(user);
        rerender(<ResultsPanel range="1M" state={state} selectedDay="2026-08-20" />);
        await submitAnyGuess(user);

        // Announces the unlock once every day is revealed -- a distinct
        // region from the per-day "Results revealed for..." announcement
        // (issue #67), which this same page also renders.
        expect(screen.getByRole("status", { name: "Whole-range reveal status" })).toHaveTextContent(
          /Whole-range running balance revealed/i,
        );
        expect(screen.getByRole("status", { name: "Day reveal status" })).toHaveTextContent(
          /Results revealed for/i,
        );
      });

      it("unlocks the real whole-range figure once every day in the range has been individually revealed, in any order", async () => {
        const user = userEvent.setup();
        const state: ResultsState = { status: "success", data: fixtureChainedResult() };
        const { rerender } = render(
          <ResultsPanel range="1M" state={state} selectedDay="2026-08-21" />,
        );
        await submitAnyGuess(user);

        rerender(<ResultsPanel range="1M" state={state} selectedDay="2026-08-20" />);
        await submitAnyGuess(user);

        // Both of the range's two days are now revealed -- the masked
        // placeholder is gone, and the real figure appears.
        expect(
          screen.queryByText(/reveal all 2 days below to see the range's full running balance/i),
        ).not.toBeInTheDocument();

        // The range's own root startingCapital is 20; the final chained
        // day's (2026-08-21) long-only endingBalance is 100; the display
        // capital defaults to activeDay.startingCapital, which is now
        // 2026-08-20's own (20, the range's first day) since that's the
        // currently-selected day after the rerender above.
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
        const { rerender } = render(
          <ResultsPanel range="1M" state={state} selectedDay="2026-08-21" startingCapital={40} />,
        );
        await submitAnyGuess(user);
        rerender(
          <ResultsPanel range="1M" state={state} selectedDay="2026-08-20" startingCapital={40} />,
        );
        await submitAnyGuess(user);

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

      expect(screen.getByText(/Buying and holding SPY instead/)).toBeInTheDocument();
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
