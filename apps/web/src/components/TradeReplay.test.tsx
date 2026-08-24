import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PortfolioPoint } from "@/lib/portfolio-series";
import { createRafPump } from "@/lib/raf-pump.test-util";
import { stubPrefersReducedMotion } from "@/lib/stub-prefers-reduced-motion.test-util";
import { TradeReplay } from "./TradeReplay";

// Mirrors use-trade-replay.test.ts's own fixture -- a one-trade window,
// start flat at $20, an "open" event, a mid-trade flat vertex, a "close"
// event that doubles the balance to $40 (a real, easy-to-check 100%
// return), then a trailing flat point at the window's end.
const POINTS: PortfolioPoint[] = [
  { date: "2024-01-01", value: 20, event: null },
  {
    date: "2024-01-02",
    value: 20,
    event: { type: "open", direction: "long", ticker: "AAPL", price: 100 },
  },
  { date: "2024-01-05", value: 20, event: null },
  {
    date: "2024-01-05",
    value: 40,
    event: { type: "close", direction: "long", ticker: "AAPL", price: 200 },
  },
  { date: "2024-01-06", value: 40, event: null },
];

const BASE_PROPS = {
  points: POINTS,
  tradeCount: 1,
  heroKey: "test-result",
  startingCapital: 20,
  endingBalance: 40,
  worstCaseEndingBalance: 15,
  worstCaseStartingCapital: 20,
  displayStartingCapital: 20,
};

function statusRegion() {
  return screen.getByRole("status", { name: "Trade replay status" });
}

describe("TradeReplay (issue #96)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("renders the real, unmodified hero row and chart on first render -- never auto-plays", () => {
    render(<TradeReplay {...BASE_PROPS} />);

    expect(screen.getByText("Worst case, same budget")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /portfolio value over time/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Watch it happen" })).toBeInTheDocument();
    expect(statusRegion()).toHaveTextContent("");
  });

  it("renders no button at all when the result has no trades", () => {
    render(<TradeReplay {...BASE_PROPS} tradeCount={0} />);

    expect(screen.queryByRole("button", { name: /watch it happen/i })).not.toBeInTheDocument();
  });

  it("prefers-reduced-motion fully bypasses the feature: no button renders, real hero/chart shown as-is", () => {
    stubPrefersReducedMotion(true);

    render(<TradeReplay {...BASE_PROPS} />);

    expect(screen.queryByRole("button", { name: /watch it happen/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /replay/i })).not.toBeInTheDocument();
    // Zero information loss: the real chart/hero still render exactly as
    // they did before this feature existed.
    expect(screen.getByText("Worst case, same budget")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /portfolio value over time/i })).toBeInTheDocument();
  });

  it("clicking Watch it happen swaps to the truncated/interpolated view and offers Skip to end", async () => {
    createRafPump(); // queue-only RAF: nothing auto-advances past the click itself
    const user = userEvent.setup();
    render(<TradeReplay {...BASE_PROPS} />);

    await user.click(screen.getByRole("button", { name: "Watch it happen" }));

    // The real HeroStat/WorstCaseStat pairing and chart are gone --
    // replaced by the animating (aria-hidden) view.
    expect(screen.queryByText("Worst case, same budget")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("img", { name: /portfolio value over time/i }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Skip to end" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Watch it happen" })).not.toBeInTheDocument();
  });

  it("pauses on each trade event, announcing it once (not per-frame) and showing a matching visible callout", async () => {
    vi.spyOn(performance, "now").mockReturnValue(1000);
    const raf = createRafPump();
    const user = userEvent.setup();
    render(<TradeReplay {...BASE_PROPS} />);

    await user.click(screen.getByRole("button", { name: "Watch it happen" }));
    raf.tick(1000); // mid-tween toward the open event
    raf.tick(1300); // arrives at the open event, pauses

    const openCallout = "Bought AAPL on Jan 2, 2024 at $100.00.";
    // Two matches: the aria-hidden visible callout, and the sr-only
    // status region -- both hold the identical sentence.
    expect(screen.getAllByText(openCallout)).toHaveLength(2);
    expect(statusRegion()).toHaveTextContent(openCallout);

    raf.tick(1900); // pause elapses, mid-trade flat vertex reached (no event)
    raf.tick(2200);
    raf.tick(2500); // arrives at the close event, pauses -- the real 100% return

    const closeCallout = "Sold AAPL on Jan 5, 2024 at $200.00 (+100.0%).";
    expect(screen.getAllByText(closeCallout)).toHaveLength(2);
    expect(statusRegion()).toHaveTextContent(closeCallout);
  });

  it("Skip to end works at any point during playback, landing on the exact same final state as a non-animated load", async () => {
    createRafPump();
    const user = userEvent.setup();
    render(<TradeReplay {...BASE_PROPS} />);

    await user.click(screen.getByRole("button", { name: "Watch it happen" }));
    await user.click(screen.getByRole("button", { name: "Skip to end" }));

    // Hands off to the real final props -- the same HeroStat/WorstCaseStat/
    // PortfolioChart that would render on an ordinary, non-animated load.
    expect(screen.getByText("Worst case, same budget")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /portfolio value over time/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Replay" })).toBeInTheDocument();
    expect(statusRegion()).toHaveTextContent("Replay finished. Ending balance $40.00.");
  });

  it("Replay re-triggers playback without any network request", async () => {
    vi.stubGlobal("fetch", vi.fn());
    createRafPump();
    const user = userEvent.setup();
    render(<TradeReplay {...BASE_PROPS} />);

    await user.click(screen.getByRole("button", { name: "Watch it happen" }));
    await user.click(screen.getByRole("button", { name: "Skip to end" }));
    await user.click(screen.getByRole("button", { name: "Replay" }));

    expect(screen.getByRole("button", { name: "Skip to end" })).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });
});
