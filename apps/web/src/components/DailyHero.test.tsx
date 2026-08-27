import { render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { IntradayDayResult, IntradayTrade } from "@hadiknowntrades/core";

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
    // $20, so a test that accidentally renders this raw value instead
    // of the recompounded-from-$20 one fails loudly.
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
  it("renders a loading placeholder before the fetch resolves", () => {
    stubResultsFetch({ model: "intraday-daily", days: [day()] });
    const { container } = render(<DailyHero mode="long" />);

    expect(container.querySelector('[aria-hidden="true"].animate-pulse')).not.toBeNull();
    expect(screen.queryByText(/Yesterday/)).toBeNull();
  });

  it("renders nothing once loaded if the range has no trading days (a fetch error, or nothing published yet)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    const { container } = render(<DailyHero mode="long" />);

    await waitFor(() => {
      expect(container.querySelector(".animate-pulse")).toBeNull();
    });
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the real date, statement, figures and ticker sequence for the most recent day (issue #161's own Acceptance criteria)", async () => {
    stubResultsFetch({
      model: "intraday-daily",
      days: [day({ date: "2026-08-24" }), day({ date: "2026-08-25" })],
    });
    render(<DailyHero mode="long" />);

    // The eyebrow names the *most recent* day (2026-08-25, a Tuesday),
    // not the first day in the array.
    expect(await screen.findByText(/Yesterday · Tuesday, August 25, 2026/)).toBeInTheDocument();

    expect(screen.getByText("2 trades")).toBeInTheDocument();
    // A fresh $20 -> $20 * (172.80/170.10) * (87.10/84.50), NOT the raw
    // chained day.endingBalance (34.5) or day.startingCapital (28.12).
    expect(screen.getByText("$20.00")).toBeInTheDocument();
    const expectedEnding = 20 * (172.8 / 170.1) * (87.1 / 84.5);
    expect(screen.getByText(`$${expectedEnding.toFixed(2)}`)).toBeInTheDocument();
    expect(screen.queryByText("$34.50")).toBeNull();
    expect(screen.queryByText("$28.12")).toBeNull();

    // Scoped to the hero card itself -- "AVGO"/"PLTR" also legitimately
    // appear a second time each, below, in the trades-narration section
    // (see the next test), so an unscoped query would find two matches.
    const heroSection = screen.getByText(/Yesterday · /).closest("section")!;
    expect(within(heroSection).getByText("AVGO")).toBeInTheDocument();
    expect(within(heroSection).getByText("PLTR")).toBeInTheDocument();

    const scrollCue = screen.getByRole("link", { name: "See the trades ↓" });
    expect(scrollCue).toHaveAttribute("href", "#daily-hero-trades");
  });

  it('renders a "Yesterday\'s trades" section narrating each trade in past tense, by time of day', async () => {
    stubResultsFetch({ model: "intraday-daily", days: [day()] });
    render(<DailyHero mode="long" />);

    const heading = await screen.findByRole("heading", { name: "Yesterday's trades" });
    // The scroll cue's own href targets this exact section (see the
    // test above).
    const section = document.getElementById("daily-hero-trades");
    expect(section).not.toBeNull();
    expect(section).toContainElement(heading);

    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0]!.textContent).toContain("Had you known, you'd have bought");
    expect(items[0]!.textContent).toContain("at 9:35 AM at $170.10");
    expect(items[0]!.textContent).toContain("at 10:40 AM at $172.80");
    expect(items[1]!.textContent).toContain("Finally, you'd have bought");
  });

  it("shows an empty-day fallback and no trades section for a day with no trades", async () => {
    stubResultsFetch({ model: "intraday-daily", days: [day({ trades: [] })] });
    render(<DailyHero mode="long" />);

    expect(
      await screen.findByText(/No trade would have beaten holding cash on/),
    ).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Yesterday's trades" })).toBeNull();
    expect(screen.queryByRole("link", { name: "See the trades ↓" })).toBeNull();
  });

  it("switches to the day's long+short trades under long-short mode (issue #13)", async () => {
    stubResultsFetch({ model: "intraday-daily", days: [day()] });
    render(<DailyHero mode="long-short" />);

    expect(await screen.findByText("1 trade")).toBeInTheDocument();
    // Scoped to the hero card -- "SHORTED" legitimately appears a second
    // time below, in the trades-narration section.
    const heroSection = screen.getByText(/Yesterday · /).closest("section")!;
    expect(within(heroSection).getByText("SHORTED")).toBeInTheDocument();
    expect(screen.queryByText("AVGO")).toBeNull();
  });
});
