import type { IntradayResult, WindowResult } from "@hadiknowntrades/core";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ResultsState } from "@/lib/use-results";
import { ResultsPanel } from "./ResultsPanel";

/**
 * Submits an arbitrary guess through the DailyGuessForm currently on
 * screen (issue #34) -- every intraday-daily test below has to clear this
 * gate before it can assert on the actual revealed result, the same way a
 * real user would.
 */
async function submitAnyGuess(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText(/what do you think/i), "1");
  await user.click(screen.getByRole("button", { name: /reveal/i }));
}

function fixtureResult(overrides: Partial<WindowResult> = {}): WindowResult {
  return {
    schemaVersion: 4,
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
    worstCase: {
      endingBalance: 4.2,
      trades: [
        {
          ticker: "ZBRA",
          buyDate: "2025-08-21",
          buyPrice: 300,
          sellDate: "2026-08-21",
          sellPrice: 63,
        },
      ],
    },
    universeSize: 503,
    skippedTickers: [],
    benchmark: null,
    ...overrides,
  };
}

function fixtureIntradayResult(overrides: Partial<IntradayResult> = {}): IntradayResult {
  return {
    schemaVersion: 4,
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
            date: "2026-08-20",
            buyTime: "09:30:00",
            buyPrice: 100,
            sellTime: "10:30:00",
            sellPrice: 125,
          },
        ],
        worstCase: {
          endingBalance: 12,
          trades: [
            {
              ticker: "GOOG",
              date: "2026-08-20",
              buyTime: "09:30:00",
              buyPrice: 100,
              sellTime: "10:30:00",
              sellPrice: 60,
            },
          ],
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
            date: "2026-08-21",
            buyTime: "09:30:00",
            buyPrice: 200,
            sellTime: "10:30:00",
            sellPrice: 400,
          },
        ],
        worstCase: {
          endingBalance: 4,
          trades: [
            {
              ticker: "TSLA",
              date: "2026-08-21",
              buyTime: "09:30:00",
              buyPrice: 200,
              sellTime: "10:30:00",
              sellPrice: 40,
            },
          ],
        },
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
      // runs even pre-reveal, not just after.
      expect(screen.getByText(/Aug 21, 2026/)).toBeInTheDocument();
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

    it("calls onSelectDay when a different day is chosen from the DaySelector, even before that day has been guessed", async () => {
      const user = userEvent.setup();
      const onSelectDay = vi.fn();
      const state: ResultsState = { status: "success", data: fixtureIntradayResult() };
      render(<ResultsPanel range="1M" state={state} onSelectDay={onSelectDay} />);

      await user.selectOptions(screen.getByRole("combobox"), "2026-08-20");

      expect(onSelectDay).toHaveBeenCalledWith("2026-08-20");
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
              worstCase: { endingBalance: 20, trades: [] },
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

        expect(screen.getByRole("button", { name: /reveal/i })).toBeInTheDocument();
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
        await user.click(screen.getByRole("button", { name: /reveal/i }));

        expect(screen.queryByRole("button", { name: /reveal/i })).not.toBeInTheDocument();
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
        await user.click(screen.getByRole("button", { name: /reveal/i }));
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
        await user.click(screen.getByRole("button", { name: /reveal/i }));
        expect(screen.getAllByText(/MSFT/).length).toBeGreaterThan(0);

        unmount();
        render(<ResultsPanel range="1M" state={state} />);

        // No guess prompt on the "reload" -- straight to the revealed result.
        expect(screen.queryByRole("button", { name: /reveal/i })).not.toBeInTheDocument();
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

        expect(screen.getByRole("button", { name: /reveal/i })).toBeInTheDocument();
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
        expect(screen.getByRole("button", { name: /reveal/i })).toBeInTheDocument();
        expect(screen.queryByText(/MSFT/)).not.toBeInTheDocument();

        rerender(<ResultsPanel range="1Y" state={state} selectedDay="2026-08-21" />);
        expect(screen.getByRole("button", { name: /reveal/i })).toBeInTheDocument();

        // Switching back to 1M still remembers the original guess.
        rerender(<ResultsPanel range="1M" state={state} selectedDay="2026-08-21" />);
        expect(screen.queryByRole("button", { name: /reveal/i })).not.toBeInTheDocument();
        expect(screen.getAllByText(/MSFT/).length).toBeGreaterThan(0);
      });
    });
  });
});
