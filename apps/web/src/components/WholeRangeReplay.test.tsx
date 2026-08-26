import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PortfolioPoint } from "@/lib/portfolio-series";
import { createRafPump } from "@/lib/raf-pump.test-util";
import { stubPrefersReducedMotion } from "@/lib/stub-prefers-reduced-motion.test-util";
import {
  CHUNKED_WHOLE_RANGE_REPLAY_PACING,
  WHOLE_RANGE_REPLAY_PACING,
  WholeRangeReplay,
} from "./WholeRangeReplay";

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
  replaySupported: true,
  pacing: WHOLE_RANGE_REPLAY_PACING,
  segmentMode: "point" as const,
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

    it("renders children (issue #105 code review finding) only once revealed, between the button row and the chart -- mirroring TradeReplay.tsx's own children slot so BenchmarkStat/the methodology paragraph keep their pre-#105 relative position against the chart", () => {
      const { container, rerender } = render(
        <WholeRangeReplay {...BASE_PROPS} guess={null} guessStartingCapital={null} points={[]}>
          <p data-testid="probe">probe content</p>
        </WholeRangeReplay>,
      );

      expect(screen.queryByTestId("probe")).not.toBeInTheDocument();

      rerender(
        <WholeRangeReplay {...BASE_PROPS}>
          <p data-testid="probe">probe content</p>
        </WholeRangeReplay>,
      );

      const probe = screen.getByTestId("probe");
      expect(probe).toBeInTheDocument();
      // The probe sits after the button row and before the chart's own
      // <svg>, matching the real order BenchmarkStat/the paragraph had
      // before this issue.
      const button = screen.getByRole("button", { name: "Watch it happen" });
      const svg = container.querySelector("svg")!;
      expect(button.compareDocumentPosition(probe) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(probe.compareDocumentPosition(svg) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
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

    it("renders no button and no worst-case stat when replaySupported is false, even with real trades and no reduced motion (issue #105 code review: 1M/3M/1Y must never get this button; independent-review follow-up: nor the new worst-case stat, an undisclosed scope expansion beyond this issue's own 1W-only scope)", () => {
      render(<WholeRangeReplay {...BASE_PROPS} replaySupported={false} />);

      expect(screen.queryByRole("button", { name: /watch it happen/i })).not.toBeInTheDocument();
      // Zero information loss for an unsupported range beyond that -- the
      // chart/children still render exactly as they did before issue
      // #105. The worst-case stat, however, is new surface issue #105
      // introduced -- it must stay 1W-only, matching the pre-#105 shape
      // for every other range exactly (no new stat at all).
      expect(screen.getByRole("img", { name: /portfolio value over time/i })).toBeInTheDocument();
      expect(screen.queryByText("Worst case, same budget")).not.toBeInTheDocument();
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

  describe("chunked segment mode (issue #118, 1M/3M/1Y)", () => {
    // Three days, deliberately far fewer than NUM_CHUNKS (30) so every
    // day maps to its own chunk (1M's own common shape): day 1 is a
    // one-day/one-trade degenerate chunk (falls through to the existing
    // single-trade calloutText voice), day 2 has zero trades (advances
    // with no pause), day 3 has two trades (a genuine multi-trade chunk
    // needing the new summary voice).
    const CHUNK_POINTS: PortfolioPoint[] = [
      // Day 1 (2025-08-18): AAPL 100 -> 150, a 50% gain ($20 -> $30).
      { date: "2025-08-18T09:30:00", value: 20, event: null },
      {
        date: "2025-08-18T09:30:00",
        value: 20,
        event: { type: "open", direction: "long", ticker: "AAPL", price: 100 },
      },
      { date: "2025-08-18T10:30:00", value: 20, event: null },
      {
        date: "2025-08-18T10:30:00",
        value: 30,
        event: { type: "close", direction: "long", ticker: "AAPL", price: 150 },
      },
      // Day 2 (2025-08-19): no trades -- a single flat point.
      { date: "2025-08-19T12:00:00", value: 30, event: null },
      // Day 3 (2025-08-20): MSFT then GOOG.
      { date: "2025-08-20T09:30:00", value: 30, event: null },
      {
        date: "2025-08-20T09:30:00",
        value: 30,
        event: { type: "open", direction: "long", ticker: "MSFT", price: 100 },
      },
      { date: "2025-08-20T10:00:00", value: 30, event: null },
      {
        date: "2025-08-20T10:00:00",
        value: 36,
        event: { type: "close", direction: "long", ticker: "MSFT", price: 120 },
      },
      {
        date: "2025-08-20T10:15:00",
        value: 36,
        event: { type: "open", direction: "long", ticker: "GOOG", price: 200 },
      },
      { date: "2025-08-20T10:45:00", value: 36, event: null },
      {
        date: "2025-08-20T10:45:00",
        value: 32.4,
        event: { type: "close", direction: "long", ticker: "GOOG", price: 180 },
      },
    ];

    const CHUNK_PROPS = {
      ...BASE_PROPS,
      points: CHUNK_POINTS,
      tradeCount: 3,
      pacing: CHUNKED_WHOLE_RANGE_REPLAY_PACING,
      segmentMode: "chunk" as const,
    };

    it("a one-day/one-trade chunk falls through to the existing single-trade chart-anchored callout voice, a no-trade chunk advances with no pause, and a genuine multi-trade chunk shows the new summary voice as a plain (non-chart-anchored) line", async () => {
      vi.spyOn(performance, "now").mockReturnValue(1000);
      const raf = createRafPump();
      const user = userEvent.setup();
      render(<WholeRangeReplay {...CHUNK_PROPS} />);

      // Tick offsets derived from the real, imported pacing constant
      // (not hardcoded) so a future retuning of
      // CHUNKED_WHOLE_RANGE_REPLAY_PACING's own values doesn't also
      // require hand-recomputing every tick argument in this test.
      const { transitionMs, eventPauseMs, rewindMs } = CHUNKED_WHOLE_RANGE_REPLAY_PACING;
      let now = 1000;

      await user.click(screen.getByRole("button", { name: "Watch it happen" }));
      now += rewindMs;
      raf.tick(now); // completes the rewind, landing on "playing" (phaseStart resets to 1000)
      now = 1000 + transitionMs;
      raf.tick(now); // chunk 1's own transition completes -- pauses on the degenerate single-trade chunk

      const closeCallout = "Sold AAPL on Aug 18, 10:30 AM at $150.00 (+50.0%).";
      const closeMatches = screen.getAllByText(closeCallout);
      expect(closeMatches).toHaveLength(2); // the sr-only status region + the chart-anchored bubble
      expect(closeMatches.some((el) => el.classList.contains("marker-landing-bubble"))).toBe(true);
      // No genuine chunk-summary line yet -- this is the single-trade voice.
      expect(screen.queryByText(/2 trades/)).not.toBeInTheDocument();

      now += eventPauseMs;
      raf.tick(now); // the pause elapses -- advances toward chunk 2 (the no-trade day)
      now += transitionMs;
      raf.tick(now); // chunk 2's own transition completes -- no landing, falls straight through to chunk 3's own tween in the same tick
      expect(screen.queryByText(closeCallout)).not.toBeInTheDocument();

      now += transitionMs;
      raf.tick(now); // chunk 3's own transition completes -- pauses on the genuine multi-trade chunk

      const summaryCallout = "Aug 20, 2025: 2 trades, $30.00 -> $32.40.";
      expect(screen.getByRole("status", { name: "Whole-range replay status" })).toHaveTextContent(
        summaryCallout,
      );
      const summaryLine = screen.getByText(summaryCallout, { selector: "p[aria-hidden]" });
      expect(summaryLine).toBeInTheDocument();
      // Unlike the single-trade voice above, a multi-trade chunk summary
      // has no single marker to anchor a chart-side speech bubble to --
      // no `.marker-landing-bubble` should exist while it's showing.
      expect(document.querySelector(".marker-landing-bubble")).toBeNull();
    });

    it("Skip to end works during chunk-mode playback, landing on the exact same final state as a non-animated load", async () => {
      createRafPump();
      const user = userEvent.setup();
      render(<WholeRangeReplay {...CHUNK_PROPS} />);

      await user.click(screen.getByRole("button", { name: "Watch it happen" }));
      await user.click(screen.getByRole("button", { name: "Skip to end" }));

      expect(screen.getByRole("button", { name: "Replay" })).toBeInTheDocument();
      // finalBalance from BASE_PROPS is $40.00 (unrelated to CHUNK_POINTS'
      // own $32.40 -- ResultsPanel.tsx always passes the real chained
      // wholeRangeFinalBalance separately from `points`, so this
      // component never derives the announced figure from `points`
      // itself; see WholeRangeReplayProps' own `finalBalance` doc
      // comment).
      expect(screen.getByRole("status", { name: "Whole-range replay status" })).toHaveTextContent(
        "Replay finished. Ending balance $40.00.",
      );
    });
  });
});
