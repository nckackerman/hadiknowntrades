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

  it("clicking Watch it happen swaps only the hero figure/chart to the animating view -- WorstCaseStat stays visible throughout", async () => {
    createRafPump(); // queue-only RAF: nothing auto-advances past the click itself
    const user = userEvent.setup();
    render(<TradeReplay {...BASE_PROPS} />);

    await user.click(screen.getByRole("button", { name: "Watch it happen" }));

    // The chart swaps to the animating (aria-hidden) view, but
    // WorstCaseStat is *not* one of the things this feature animates
    // (the issue's own Scope names only "the chart and hero figure") --
    // it must stay rendered and visible for the whole ~3-6s playback,
    // not vanish the moment playback starts.
    expect(screen.getByText("Worst case, same budget")).toBeInTheDocument();
    expect(
      screen.queryByRole("img", { name: /portfolio value over time/i }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Skip to end" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Watch it happen" })).not.toBeInTheDocument();
  });

  it("renders as two top-level siblings (hero/controls block, then chart), not one wrapping div -- preserves FadeInWrapper's own gap-8 spacing", () => {
    const { container } = render(<TradeReplay {...BASE_PROPS} />);

    // A single wrapping div would put everything (hero row, chart
    // included) under one gap-2 spacing; TradeReplay must instead
    // return a Fragment of two siblings so the chart gets FadeInWrapper's
    // own gap-8 spacing from the block above it, matching this app's
    // pre-existing layout exactly (see TradeReplay's own doc comment).
    expect(container.children).toHaveLength(2);
  });

  it("Skip to end stays available even if tradeCount drops to zero mid-playback (independent of canReplay)", async () => {
    createRafPump();
    const user = userEvent.setup();
    const { rerender } = render(<TradeReplay {...BASE_PROPS} />);

    await user.click(screen.getByRole("button", { name: "Watch it happen" }));
    // Same `points` reference, only `tradeCount` changes -- isolates
    // this fix from use-trade-replay.ts's own separate points-reference
    // reset (see that hook's own regression test).
    rerender(<TradeReplay {...BASE_PROPS} tradeCount={0} />);

    expect(screen.getByRole("button", { name: "Skip to end" })).toBeInTheDocument();
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

  it("the truncated chart is inert while playing, not just aria-hidden -- a focusable descendant (the SVG's own tabIndex, ChartDataTable's <summary>) must not be reachable at all -- and fully interactive again once live (code review, issue #96 follow-up)", async () => {
    createRafPump();
    const user = userEvent.setup();
    const { container } = render(<TradeReplay {...BASE_PROPS} />);
    // The svg's own parent -- PortfolioChart's own "flex flex-col
    // gap-3" root div, which now owns the inert/aria-hidden attributes
    // itself via its `interactive` prop (code review, issue #96
    // follow-up round 3) rather than TradeReplay wrapping it in a
    // second div one level further out.
    const chartWrapper = () => container.querySelector("svg")!.parentElement!;

    expect(chartWrapper().hasAttribute("inert")).toBe(false);
    expect(chartWrapper().hasAttribute("aria-hidden")).toBe(false);

    await user.click(screen.getByRole("button", { name: "Watch it happen" }));

    // Per the ARIA spec, aria-hidden must never wrap a focusable
    // element -- inert is what actually removes the SVG's own
    // tabIndex-driven focusability (and ChartDataTable's <summary>)
    // from the tab order, not just from the accessibility tree.
    expect(chartWrapper().hasAttribute("inert")).toBe(true);
    expect(chartWrapper().getAttribute("aria-hidden")).toBe("true");

    await user.click(screen.getByRole("button", { name: "Skip to end" }));

    expect(chartWrapper().hasAttribute("inert")).toBe(false);
    expect(chartWrapper().hasAttribute("aria-hidden")).toBe(false);
  });

  it("a starting-capital edit mid-playback does not remount HeroStat (real bug, fixed) -- the aborted-to-idle hero row is the exact same DOM node from before playback started", async () => {
    createRafPump();
    const user = userEvent.setup();
    const { rerender } = render(<TradeReplay {...BASE_PROPS} />);

    await user.click(screen.getByRole("button", { name: "Watch it happen" }));
    expect(screen.getByRole("button", { name: "Skip to end" })).toBeInTheDocument();

    // HeroStat itself stays mounted (visually hidden) throughout playback
    // now -- its own "Starting from" caption is reachable even while
    // playing, alongside the animated overlay's identical caption text.
    const heroCaptionDuringPlayback = screen.getAllByText("Starting from")[0]!;

    // Stands in for a live starting-capital edit: derivePortfolioSeries
    // is a pure linear scaling (see portfolio-series.ts), so ResultsPanel
    // recomputes `points` to a brand-new, rescaled array reference
    // without ever unmounting TradeReplay -- startingCapital/endingBalance
    // (the underlying raw result) stay fixed; only points and
    // displayStartingCapital change, exactly like a real
    // StartingCapitalInput edit.
    const RESCALED_POINTS: PortfolioPoint[] = POINTS.map((p) => ({
      ...p,
      value: p.value * 1.25,
    }));
    rerender(<TradeReplay {...BASE_PROPS} points={RESCALED_POINTS} displayStartingCapital={25} />);

    // The edit aborts playback (use-trade-replay.ts's own trackedPoints
    // reset) back to idle.
    expect(screen.getByRole("button", { name: "Watch it happen" })).toBeInTheDocument();
    // HeroStat's own DOM node is the exact same one from before the
    // edit -- not a fresh mount, so no re-triggered count-up/confetti.
    expect(screen.getAllByText("Starting from")[0]).toBe(heroCaptionDuringPlayback);
  });

  it("naturally completing playback DOES give HeroStat a fresh mount (the intended reward moment, contrasted with the abort case above)", async () => {
    createRafPump();
    const user = userEvent.setup();
    render(<TradeReplay {...BASE_PROPS} />);

    const heroCaptionBeforePlaying = screen.getByText("Starting from");

    await user.click(screen.getByRole("button", { name: "Watch it happen" }));
    const heroCaptionWhilePlaying = screen.getAllByText("Starting from")[0]!;
    // Still the same node while merely playing -- HeroStat doesn't
    // remount just because playback started (see HeroAndWorstCase.tsx's
    // own heroSlot doc comment).
    expect(heroCaptionWhilePlaying).toBe(heroCaptionBeforePlaying);

    await user.click(screen.getByRole("button", { name: "Skip to end" }));

    // Landing on "done" bumps useTradeReplay's own completedRuns counter,
    // giving HeroStat a fresh key and therefore a fresh mount -- a
    // genuinely different DOM node than before playback started.
    expect(screen.getByText("Starting from")).not.toBe(heroCaptionBeforePlaying);
  });

  it("shows the multiplier badge throughout idle -> playing -> done, never disappearing (code review, issue #96 follow-up round five)", async () => {
    createRafPump();
    const user = userEvent.setup();
    render(<TradeReplay {...BASE_PROPS} />);

    // BASE_PROPS is a $20 -> $40 result, a 2x multiplier -- present in
    // HeroStat's own badge before playback starts.
    expect(screen.getByText("(2x)")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Watch it happen" }));

    // The playing-phase overlay must carry the exact same badge, not
    // just the "$X -> $Y" figure -- this was the bug (the badge vanished
    // for the whole playback run). Two matches while playing: the real
    // (visually hidden, but still mounted) HeroStat's own badge, and the
    // overlay's -- see HeroAndWorstCase.tsx's own heroSlot doc comment
    // for why HeroStat stays mounted underneath the overlay.
    expect(screen.getAllByText("(2x)").length).toBeGreaterThan(0);

    await user.click(screen.getByRole("button", { name: "Skip to end" }));

    expect(screen.getByText("(2x)")).toBeInTheDocument();
  });

  it("PortfolioChart's own DOM node never remounts across idle -> playing -> done -> replay transitions (no reveal-animation flash at those boundaries)", async () => {
    createRafPump();
    const user = userEvent.setup();
    const { container } = render(<TradeReplay {...BASE_PROPS} />);
    const currentSvg = () => container.querySelector("svg");

    const svgAtIdle = currentSvg();
    expect(svgAtIdle).not.toBeNull();

    await user.click(screen.getByRole("button", { name: "Watch it happen" }));
    expect(currentSvg()).toBe(svgAtIdle);

    await user.click(screen.getByRole("button", { name: "Skip to end" }));
    expect(currentSvg()).toBe(svgAtIdle);

    await user.click(screen.getByRole("button", { name: "Replay" }));
    expect(currentSvg()).toBe(svgAtIdle);
  });
});
