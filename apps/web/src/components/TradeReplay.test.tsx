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

// The rewind intro beat (issue #97) is 700ms -- with performance.now()
// pinned to 1000 (see each test's own vi.spyOn(performance, "now")
// call), any raf.tick(now) with `now >= 1700` completes it in a single
// tick, auto-advancing phase straight to "playing" -- see
// use-trade-replay.test.ts's own identical constant for the full
// reasoning.
const REWIND_COMPLETE_NOW = 1700;

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

// The overlay's own date readout text (issue #107) can't be located by
// exact text match alone once real trade playback begins -- once a
// point past the window's own opening one is revealed,
// PortfolioChart's always-rendered ChartDataTable disclosure gets a row
// for that same date too, and `screen.getByText` throws on more than
// one match. The readout's own label ("Rewinding to" or "Watching",
// whichever is currently rendered) is unambiguous, so this walks from
// there instead, reading its very next sibling's own text -- while
// "rewinding" that's a sibling `<p>` (the value row, holding only the
// date); while "playing" it's a sibling `<span>` inside the same label
// `<p>` (the date folded into the label line itself, see
// TradeReplay.tsx's own heroSlot doc comment on the playing branch for
// why) -- either way, `.textContent` on the immediate next sibling is
// exactly the date, so this needs no phase-specific branching.
function readoutDate(label: "Rewinding to" | "Watching"): string | null {
  return screen.getByText(label).nextElementSibling?.textContent ?? null;
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

  it("clicking Watch it happen begins with a rewind-to-start-date readout before real trade playback (issue #97)", async () => {
    vi.spyOn(performance, "now").mockReturnValue(1000);
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2024-06-15T00:00:00Z"));
    const raf = createRafPump();
    const user = userEvent.setup();
    render(<TradeReplay {...BASE_PROPS} />);

    await user.click(screen.getByRole("button", { name: "Watch it happen" }));

    // A brief backward-ticking date readout, not the real trade
    // callout/hero figure yet -- "Skip to end" is already available
    // here too (issue #97's own "works identically" acceptance
    // criterion, exercised more fully in a sibling test below).
    expect(screen.getByText("Rewinding to")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Skip to end" })).toBeInTheDocument();
    // Never announced to assistive tech -- purely visual/decorative,
    // same as the playing-phase figure (see TradeReplay.tsx's own
    // `announced` doc comment).
    expect(statusRegion()).toHaveTextContent("");

    raf.tick(1000); // t=0: the readout starts at "now"
    expect(readoutDate("Rewinding to")).toBe("Jun 15, 2024");

    raf.tick(REWIND_COMPLETE_NOW); // lands exactly on the result's own start date

    // Auto-advances into real playback on its own -- no second click
    // needed, per the issue's own "no manual second step" acceptance
    // criterion. "Rewinding to" is gone, replaced by "Watching" (issue
    // #107's own carried-through readout, see TradeReplay.tsx's own
    // heroSlot doc comment for why the label text changes here) --
    // still showing a date, now the result's own real start date
    // ("Jan 1, 2024," POINTS[0]'s own date) rather than the rewind's
    // tweened value, with no visible gap between the two. Only one
    // "Starting from" match now (the real, still-mounted HeroStat's own
    // caption) -- the overlay's own label reads "Watching" instead, not
    // a second "Starting from".
    expect(screen.queryByText("Rewinding to")).not.toBeInTheDocument();
    expect(readoutDate("Watching")).toBe("Jan 1, 2024");
    expect(screen.getAllByText("Starting from")).toHaveLength(1);
  });

  it("Skip to end during the rewind readout works identically to Skip to end during trade playback (issue #97)", async () => {
    createRafPump();
    const user = userEvent.setup();
    render(<TradeReplay {...BASE_PROPS} />);

    await user.click(screen.getByRole("button", { name: "Watch it happen" }));
    expect(screen.getByText("Rewinding to")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Skip to end" }));

    // Lands on the exact same final state a Skip to end from mid-
    // playback does (see the sibling "Skip to end works at any point
    // during playback" test) -- the real hero/chart, a "Replay" button,
    // and the finished announcement.
    expect(screen.queryByText("Rewinding to")).not.toBeInTheDocument();
    expect(screen.getByText("Worst case, same budget")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /portfolio value over time/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Replay" })).toBeInTheDocument();
    expect(statusRegion()).toHaveTextContent("Replay finished. Ending balance $40.00.");
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

  it("pauses on each trade event, announcing it once (not per-frame) and showing a matching visible callout, with the date readout advancing alongside it (issue #107)", async () => {
    vi.spyOn(performance, "now").mockReturnValue(1000);
    const raf = createRafPump();
    const user = userEvent.setup();
    render(<TradeReplay {...BASE_PROPS} />);

    await user.click(screen.getByRole("button", { name: "Watch it happen" }));
    raf.tick(REWIND_COMPLETE_NOW); // completes the rewind intro beat (issue #97), landing on "playing"
    raf.tick(1000); // mid-tween toward the open event
    raf.tick(1300); // arrives at the open event, pauses

    const openCallout = "Bought AAPL on Jan 2, 2024 at $100.00.";
    // Two matches: the aria-hidden visible callout, and the sr-only
    // status region -- both hold the identical sentence.
    expect(screen.getAllByText(openCallout)).toHaveLength(2);
    expect(statusRegion()).toHaveTextContent(openCallout);
    // The date readout (issue #107) lands on this same event's own real
    // date, alongside the callout -- "landing on each trade's real
    // event date at the moment its callout shows," per the issue's own
    // acceptance criterion.
    expect(readoutDate("Watching")).toBe("Jan 2, 2024");

    raf.tick(1900); // pause elapses, mid-trade flat vertex reached (no event)
    raf.tick(2200);
    raf.tick(2500); // arrives at the close event, pauses -- the real 100% return

    const closeCallout = "Sold AAPL on Jan 5, 2024 at $200.00 (+100.0%).";
    expect(screen.getAllByText(closeCallout)).toHaveLength(2);
    expect(statusRegion()).toHaveTextContent(closeCallout);
    // The readout advanced again, past the earlier "Jan 2, 2024".
    expect(readoutDate("Watching")).toBe("Jan 5, 2024");
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
    // now -- its own "Starting from" caption is reachable even mid-flight
    // (this click alone lands on "rewinding", not "playing" -- no raf
    // ticks are pumped in this test -- but the overlay's own label reads
    // "Rewinding to"/"Watching" in either non-live phase, issue #107, not
    // a second "Starting from", so `getAllByText` here returns exactly
    // one match: the real HeroStat's own caption).
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

  it("shows the multiplier badge throughout idle -> rewinding -> playing -> done, never disappearing (code review, issue #96 follow-up round five)", async () => {
    vi.spyOn(performance, "now").mockReturnValue(1000);
    const raf = createRafPump();
    const user = userEvent.setup();
    render(<TradeReplay {...BASE_PROPS} />);

    // BASE_PROPS is a $20 -> $40 result, a 2x multiplier -- present in
    // HeroStat's own badge before playback starts.
    expect(screen.getByText("(2x)")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Watch it happen" }));

    // Mid-rewind (issue #97): only the real, always-mounted HeroStat's
    // own badge is present -- the rewind's own overlay is just the date
    // readout, with no multiplier badge of its own to attach one to.
    expect(screen.getByText("(2x)")).toBeInTheDocument();

    raf.tick(REWIND_COMPLETE_NOW); // completes the rewind, landing on "playing"

    // The playing-phase overlay must carry the exact same badge, not
    // just the "$X -> $Y" figure -- this was the original round-five
    // bug (the badge vanished for the whole playback run). Two matches
    // while playing: the real (visually hidden, but still mounted)
    // HeroStat's own badge, and the overlay's -- see
    // HeroAndWorstCase.tsx's own heroSlot doc comment for why HeroStat
    // stays mounted underneath the overlay.
    expect(screen.getAllByText("(2x)")).toHaveLength(2);

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
