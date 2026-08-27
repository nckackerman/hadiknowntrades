import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { IntradayDayResult, IntradayTrade } from "@hadiknowntrades/core";

import { dailyChallengeStartingCapitalFor } from "@/lib/daily-challenge";
import { formatHeroCurrency, formatPercent } from "@/lib/format-currency";
import { stubPrefersReducedMotion } from "@/lib/stub-prefers-reduced-motion.test-util";

import { DailyHero } from "./DailyHero";

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
    // A real, chained (issue #84) startingCapital -- deliberately NOT
    // what dailyChallengeStartingCapitalFor(date) returns (issue #174),
    // so a test that accidentally renders this raw value instead of the
    // date-seeded one fails loudly.
    startingCapital: 28.12,
    endingBalance: 34.5,
    barIntervalMinutes: 60,
    trades: [
      trade({ ticker: "AVGO", openPrice: 170.1, closePrice: 172.8 }),
      trade({
        ticker: "PLTR",
        openTime: "11:02:00",
        openPrice: 84.5,
        closeTime: "13:15:00",
        closePrice: 87.1,
      }),
    ],
    worstCase: { startingCapital: 28.12, endingBalance: 27, trades: [] },
    longShort: {
      startingCapital: 30,
      endingBalance: 40,
      trades: [trade({ ticker: "SHORTED", direction: "short" })],
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

describe("DailyHero", () => {
  it("renders a loading placeholder before the fetch resolves, in the same reduced-height default showcase box", () => {
    stubResultsFetch({ model: "intraday-daily", days: [day()] });
    const { container } = render(<DailyHero mode="long" />);

    const placeholder = container.querySelector('[aria-hidden="true"].animate-pulse');
    expect(placeholder).not.toBeNull();
    expect(placeholder).toHaveClass("min-h-[13.9rem]");
  });

  it("renders nothing once loaded if the range has no trading days (a fetch error, or nothing published yet)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    const { container } = render(<DailyHero mode="long" />);

    await waitFor(() => {
      expect(container.querySelector(".animate-pulse")).toBeNull();
    });
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the statement and figures for the most recent day, in the reduced-height default showcase box, with no date text of its own (issue #187 -- the date moved to ResultsPage.tsx's own header)", async () => {
    stubResultsFetch({
      model: "intraday-daily",
      days: [day({ date: "2026-08-24" }), day({ date: "2026-08-25" })],
    });
    const { container } = render(<DailyHero mode="long" />);

    // The statement names the *most recent* day's trade count (2026-08-25,
    // not the first day in the array) without naming the date itself --
    // the eyebrow date line that used to do that moved up into
    // ResultsPage.tsx's own header (issue #187).
    expect(await screen.findByText(/Had you known/)).toBeInTheDocument();
    expect(screen.queryByText(/Yesterday/)).toBeNull();

    expect(screen.getByText("2 trades")).toBeInTheDocument();
    // A fresh, date-seeded starting capital (issue #174) ->
    // that * (172.80/170.10) * (87.10/84.50), NOT the raw chained
    // day.endingBalance (34.5) or day.startingCapital (28.12).
    const seededStartingCapital = dailyChallengeStartingCapitalFor("2026-08-25");
    const expectedEnding = seededStartingCapital * (172.8 / 170.1) * (87.1 / 84.5);
    expect(screen.getByText(formatHeroCurrency(seededStartingCapital))).toBeInTheDocument();
    expect(screen.getByText(formatHeroCurrency(expectedEnding))).toBeInTheDocument();
    expect(screen.queryByText("$34.50")).toBeNull();
    expect(screen.queryByText("$28.12")).toBeNull();

    const section = screen.getByLabelText("Yesterday's result");
    expect(section).toHaveClass("min-h-[13.9rem]");
    expect(container.children).toHaveLength(1);
  });

  it('hides the chart until "Watch it happen" is clicked, and the box only reserves the tall chart slot once revealed (issue #162, and the grow-on-reveal redesign)', async () => {
    const user = userEvent.setup();
    stubResultsFetch({ model: "intraday-daily", days: [day()] });
    const { container } = render(<DailyHero mode="long" />);

    // Genuinely absent from the DOM, not just visually hidden -- the
    // acceptance criterion is a DOM query, not a visual check.
    const section = await screen.findByLabelText("Yesterday's result");
    expect(container.querySelector("svg")).toBeNull();
    expect(screen.queryByRole("img", { name: /portfolio value over time/i })).toBeNull();
    // Before the reveal, the box only carries its half-height default
    // floor -- the tall chart-slot height class isn't applied yet, since
    // the chart hasn't mounted to grow the box into it.
    expect(section).toHaveClass("min-h-[13.9rem]");
    expect(section).not.toHaveClass("h-[24rem]");

    const button = screen.getByRole("button", { name: "Watch it happen" });
    await user.click(button);

    expect(container.querySelector("svg")).not.toBeNull();
    expect(screen.getByRole("img", { name: /portfolio value over time/i })).toBeInTheDocument();
    // The chart's own slot now reserves its tall height, which is what
    // grows the box's real rendered height past its default floor.
    expect(container.querySelector(".h-\\[24rem\\]")).not.toBeNull();
  });

  it('does not render a "Watch it happen" button or chart for a zero-trade day, in the same reduced-height default box, with no date text (issue #187)', async () => {
    stubResultsFetch({ model: "intraday-daily", days: [day({ trades: [] })] });
    const { container } = render(<DailyHero mode="long" />);

    const section = await screen.findByText(/No trade would have beaten holding cash/);
    expect(screen.queryByRole("button", { name: "Watch it happen" })).toBeNull();
    expect(container.querySelector("svg")).toBeNull();
    expect(section.closest("section")).toHaveClass("min-h-[13.9rem]");
    // No date text remains inside the box -- the eyebrow's own inline
    // date reference moved to ResultsPage.tsx's own header (issue #187).
    expect(screen.queryByText(/2026/)).toBeNull();
  });

  it('no longer renders TradeNarrationList/"Yesterday\'s trades"/"See the trades ↓" anywhere (issue #175)', async () => {
    stubResultsFetch({ model: "intraday-daily", days: [day()] });
    render(<DailyHero mode="long" />);

    await screen.findByText(/Had you known/);
    expect(screen.queryByRole("heading", { name: "Yesterday's trades" })).toBeNull();
    expect(screen.queryByRole("link", { name: "See the trades ↓" })).toBeNull();
    expect(screen.queryByRole("list")).toBeNull();
  });

  it("folds each trade's own return into its ticker chip, colored for a gain and a loss (issue #175)", async () => {
    stubResultsFetch({
      model: "intraday-daily",
      days: [
        day({
          trades: [
            trade({ ticker: "AVGO", openPrice: 170.1, closePrice: 172.8 }), // gain
            trade({
              ticker: "LOSER",
              openTime: "11:02:00",
              openPrice: 100,
              closeTime: "13:15:00",
              closePrice: 90,
            }), // loss
          ],
        }),
      ],
    });
    render(<DailyHero mode="long" />);

    await screen.findByText(/Had you known/);

    const gainReturn = 172.8 / 170.1 - 1;
    const lossReturn = 90 / 100 - 1;

    const gainPercent = screen.getByText(formatPercent(gainReturn));
    expect(gainPercent).toHaveStyle({ color: "var(--status-good)" });
    // Screen-reader-shaped check: the chip's own accessible text content
    // conveys both the ticker and its return together, not just the
    // visual layout -- see issue #175's own Scope item 3.
    const gainChip = gainPercent.closest("span")!.parentElement!;
    expect(gainChip.textContent).toBe(`AVGO ${formatPercent(gainReturn)}`);

    const lossPercent = screen.getByText(formatPercent(lossReturn));
    expect(lossPercent).toHaveStyle({ color: "var(--status-critical)" });
    const lossChip = lossPercent.closest("span")!.parentElement!;
    expect(lossChip.textContent).toBe(`LOSER ${formatPercent(lossReturn)}`);
  });

  it("shows an empty-day fallback for a day with no trades", async () => {
    stubResultsFetch({ model: "intraday-daily", days: [day({ trades: [] })] });
    render(<DailyHero mode="long" />);

    expect(await screen.findByText(/No trade would have beaten holding cash/)).toBeInTheDocument();
  });

  it("switches to the day's long+short trades under long-short mode (issue #13)", async () => {
    stubResultsFetch({ model: "intraday-daily", days: [day()] });
    render(<DailyHero mode="long-short" />);

    expect(await screen.findByText("1 trade")).toBeInTheDocument();
    expect(screen.getByText("SHORTED")).toBeInTheDocument();
    expect(screen.queryByText("AVGO")).toBeNull();
  });

  describe("one-time entrance animation (issue #175)", () => {
    it("plays the entrance animation by default, and a re-render doesn't replay it", async () => {
      const user = userEvent.setup();
      stubResultsFetch({ model: "intraday-daily", days: [day()] });
      render(<DailyHero mode="long" />);

      // The statement is this box's own first line since issue #187
      // moved the old eyebrow date line out into ResultsPage.tsx's own
      // header -- it inherits the eyebrow's former entrance timing.
      const statement = await screen.findByText(/Had you known/);
      expect(statement).toHaveClass("daily-hero-fade-up-animate");
      const watchButton = screen.getByRole("button", { name: "Watch it happen" });
      expect(watchButton).toHaveClass("daily-hero-pop-animate");

      // An unrelated state change within the same mounted instance (the
      // click itself) doesn't remove or re-add the statement's own
      // already-settled animate class -- it's a plain, unconditional
      // string, never touched again once this instance mounted.
      await user.click(watchButton);
      expect(statement).toHaveClass("daily-hero-fade-up-animate");
    });

    it("skips the animation entirely under prefers-reduced-motion, rendering the settled state immediately", async () => {
      stubPrefersReducedMotion(true);
      stubResultsFetch({ model: "intraday-daily", days: [day()] });
      render(<DailyHero mode="long" />);

      const statement = await screen.findByText(/Had you known/);
      // Settled values (real text) are visible immediately regardless --
      // only the animate classes themselves are gated.
      await waitFor(() => {
        expect(statement).not.toHaveClass("daily-hero-fade-up-animate");
      });
      expect(screen.getByRole("button", { name: "Watch it happen" })).not.toHaveClass(
        "daily-hero-pop-animate",
      );
    });
  });
});
