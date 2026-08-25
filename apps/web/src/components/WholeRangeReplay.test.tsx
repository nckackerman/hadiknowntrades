import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PortfolioPoint } from "@/lib/portfolio-series";
import { createRafPump } from "@/lib/raf-pump.test-util";
import { stubPrefersReducedMotion } from "@/lib/stub-prefers-reduced-motion.test-util";
import { WholeRangeReplay } from "./WholeRangeReplay";

// A two-day, one-trade chained-intraday fixture -- mirrors
// deriveWholeRangeIntradaySeries's own point shape (one leading boundary
// point per trading day, datetime-labeled, no trailing boundary point).
const POINTS: PortfolioPoint[] = [
  { date: "2025-08-20T09:30:00", value: 20, event: null },
  { date: "2025-08-21T09:30:00", value: 20, event: null },
  {
    date: "2025-08-21T10:30:00",
    value: 20,
    event: { type: "open", direction: "long", ticker: "AAPL", price: 100 },
  },
  { date: "2025-08-21T11:30:00", value: 20, event: null },
  {
    date: "2025-08-21T11:30:00",
    value: 40,
    event: { type: "close", direction: "long", ticker: "AAPL", price: 200 },
  },
];

const REWIND_COMPLETE_NOW = 1700;

const BASE_PROPS = {
  rangeLabel: "the past week",
  startingCapital: 20,
  finalBalance: 40,
  points: POINTS,
  tradeCount: 1,
  worstCaseEndingBalance: 15,
  worstCaseStartingCapital: 20,
  guess: 30,
  guessStartingCapital: 20,
  onSubmitGuess: vi.fn(),
  chartKey: "1W-2025-08-21-long",
};

function statusRegion() {
  return screen.getByRole("status", { name: "Whole-range replay status" });
}

describe("WholeRangeReplay (issue #105)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe("guess-then-reveal gate", () => {
    it("renders no button and no chart before the guess is revealed -- genuinely absent, not just visually hidden", () => {
      const { container } = render(
        <WholeRangeReplay {...BASE_PROPS} guess={null} guessStartingCapital={null} points={[]} />,
      );

      expect(screen.queryByRole("button", { name: /watch it happen/i })).not.toBeInTheDocument();
      expect(
        screen.queryByRole("img", { name: /portfolio value over time/i }),
      ).not.toBeInTheDocument();
      expect(screen.queryByRole("status", { name: "Whole-range replay status" })).toBeNull();
      // The guess form itself (WholeRangeBalance's own unrevealed
      // branch) is what's showing instead.
      expect(screen.getByRole("button", { name: /reveal the answer/i })).toBeInTheDocument();
      expect(container.querySelector("svg")).toBeNull();
    });

    it("renders the button and chart once the guess is revealed", () => {
      render(<WholeRangeReplay {...BASE_PROPS} />);

      expect(screen.getByRole("button", { name: "Watch it happen" })).toBeInTheDocument();
      expect(screen.getByRole("img", { name: /portfolio value over time/i })).toBeInTheDocument();
      expect(statusRegion()).toHaveTextContent("");
    });
  });

  describe("canReplay gate (tradeCount / reduced motion)", () => {
    it("renders no button for a zero-trade result, even though the chart/worst-case stat still render", () => {
      render(<WholeRangeReplay {...BASE_PROPS} tradeCount={0} />);

      expect(screen.queryByRole("button", { name: /watch it happen/i })).not.toBeInTheDocument();
      expect(screen.getByRole("img", { name: /portfolio value over time/i })).toBeInTheDocument();
      expect(screen.getByText("Worst case, same budget")).toBeInTheDocument();
    });

    it("renders no button under reduced motion", () => {
      stubPrefersReducedMotion(true);

      render(<WholeRangeReplay {...BASE_PROPS} />);

      expect(screen.queryByRole("button", { name: /watch it happen/i })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /replay/i })).not.toBeInTheDocument();
      expect(screen.getByRole("img", { name: /portfolio value over time/i })).toBeInTheDocument();
    });

    it("Skip to end stays available regardless of canReplay, matching TradeReplay.tsx's own established distinction", async () => {
      createRafPump();
      const user = userEvent.setup();
      const { rerender } = render(<WholeRangeReplay {...BASE_PROPS} />);

      await user.click(screen.getByRole("button", { name: "Watch it happen" }));
      rerender(<WholeRangeReplay {...BASE_PROPS} tradeCount={0} />);

      expect(screen.getByRole("button", { name: "Skip to end" })).toBeInTheDocument();
    });
  });

  it("clicking Watch it happen swaps only the headline/worst-case-adjacent overlay to the animating view -- the worst-case stat itself stays visible throughout", async () => {
    createRafPump();
    const user = userEvent.setup();
    render(<WholeRangeReplay {...BASE_PROPS} />);

    await user.click(screen.getByRole("button", { name: "Watch it happen" }));

    expect(screen.getByText("Worst case, same budget")).toBeInTheDocument();
    expect(
      screen.queryByRole("img", { name: /portfolio value over time/i }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Skip to end" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Watch it happen" })).not.toBeInTheDocument();
    expect(screen.getByText("Watching")).toBeInTheDocument();
  });

  it("pauses on each trade event, announcing it once and showing a matching chart-anchored callout", async () => {
    vi.spyOn(performance, "now").mockReturnValue(1000);
    const raf = createRafPump();
    const user = userEvent.setup();
    render(<WholeRangeReplay {...BASE_PROPS} />);

    await user.click(screen.getByRole("button", { name: "Watch it happen" }));
    raf.tick(REWIND_COMPLETE_NOW); // completes the rewind intro beat, landing on "playing"
    raf.tick(1000); // mid-tween toward the flat vertex (no event)
    raf.tick(1300); // reaches the flat vertex (no event, no pause)

    raf.tick(1600); // mid-tween toward the open event
    raf.tick(1900); // arrives at the open event, pauses

    const openCallout = "Bought AAPL on Aug 21, 10:30 AM at $100.00.";
    const openMatches = screen.getAllByText(openCallout);
    expect(openMatches).toHaveLength(2);
    expect(statusRegion()).toHaveTextContent(openCallout);
    expect(openMatches.some((el) => el.classList.contains("marker-landing-bubble"))).toBe(true);
  });

  it("Skip to end works at any point during playback, landing on the exact same final state as a non-animated load", async () => {
    createRafPump();
    const user = userEvent.setup();
    render(<WholeRangeReplay {...BASE_PROPS} />);

    await user.click(screen.getByRole("button", { name: "Watch it happen" }));
    await user.click(screen.getByRole("button", { name: "Skip to end" }));

    expect(screen.getByRole("img", { name: /portfolio value over time/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Replay" })).toBeInTheDocument();
    expect(statusRegion()).toHaveTextContent("Replay finished. Ending balance $40.00.");
    // Lands back on the real, static headline -- no confetti/count-up
    // machinery exists on WholeRangeBalance to replay (a considered
    // tradeoff, see WholeRangeReplay.tsx's own doc comment). "$40.00"
    // appears twice once "done" (the headline plus ChartDataTable's own
    // row for the same final value) -- both real, static content, not a
    // stray animated leftover.
    expect(screen.getAllByText("$40.00").length).toBeGreaterThanOrEqual(1);
  });

  it("a day switch (an unrelated re-render that leaves `points`' own identity untouched, mirroring ResultsPanel's wholeRangePoints memo never depending on the selected day) does not disturb an in-flight replay", async () => {
    createRafPump();
    const user = userEvent.setup();
    const { rerender } = render(<WholeRangeReplay {...BASE_PROPS} />);

    await user.click(screen.getByRole("button", { name: "Watch it happen" }));
    expect(screen.getByRole("button", { name: "Skip to end" })).toBeInTheDocument();

    // Same `points` reference (the real ResultsPanel.tsx behavior for a
    // DayOverview day switch, since `wholeRangePoints`' own dependency
    // array never includes the selected day) -- only re-rendered, as any
    // unrelated parent state change would do.
    rerender(<WholeRangeReplay {...BASE_PROPS} />);

    expect(screen.getByRole("button", { name: "Skip to end" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /watch it happen/i })).not.toBeInTheDocument();
  });

  it("a genuine points-identity change (a mode/starting-capital edit) resets playback back to idle", async () => {
    createRafPump();
    const user = userEvent.setup();
    const { rerender } = render(<WholeRangeReplay {...BASE_PROPS} />);

    await user.click(screen.getByRole("button", { name: "Watch it happen" }));

    const RESCALED_POINTS: PortfolioPoint[] = POINTS.map((p) => ({ ...p, value: p.value * 2 }));
    rerender(<WholeRangeReplay {...BASE_PROPS} points={RESCALED_POINTS} />);

    expect(screen.getByRole("button", { name: "Watch it happen" })).toBeInTheDocument();
  });

  it("the worst-case figure is rescaled from its own raw/native-root pair (issue #105's own contract, not a pre-rescaled one)", () => {
    render(
      <WholeRangeReplay
        {...BASE_PROPS}
        startingCapital={40}
        worstCaseStartingCapital={20}
        worstCaseEndingBalance={15}
      />,
    );

    // rescaleFromStartingCapital(15, 20, 40) === 30.
    expect(screen.getByText("$30.00")).toBeInTheDocument();
  });
});
