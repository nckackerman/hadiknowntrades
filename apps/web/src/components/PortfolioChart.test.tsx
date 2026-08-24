import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PortfolioChart } from "./PortfolioChart";
import type { PortfolioPoint } from "@/lib/portfolio-series";
import { stubMatchMedia } from "@/lib/stub-match-media.test-util";
import { stubPrefersReducedMotion } from "@/lib/stub-prefers-reduced-motion.test-util";

const points: PortfolioPoint[] = [
  { date: "2024-01-01", value: 20, event: null },
  { date: "2024-01-02", value: 30, event: null },
];

const PLACEHOLDER_TEXT = "Tap, hover, or focus the chart (use the arrow keys) to inspect a point.";

/**
 * jsdom's SVG elements report a zero-size getBoundingClientRect by
 * default -- PortfolioChart's pointer handlers divide by rect.width to
 * map a client coordinate into the chart's internal viewBox coordinate
 * space, so without this stub every synthetic pointer event resolves to
 * NaN/Infinity regardless of clientX. Values below match the component's
 * own WIDTH/HEIGHT constants so scaleX comes out to 1.
 */
function stubChartRect(svg: Element) {
  vi.spyOn(svg, "getBoundingClientRect").mockReturnValue({
    left: 0,
    top: 0,
    width: 880,
    height: 400,
    right: 880,
    bottom: 400,
    x: 0,
    y: 0,
    toJSON() {
      return {};
    },
  });
}

function getChartSvg() {
  return screen.getByRole("img", { name: /portfolio value over time/i });
}

/**
 * The tooltip readout's `aria-live` region, queried separately from the
 * always-rendered `<details>` data table below it -- that table repeats
 * the same dates/values in its rows, so an unscoped text query would
 * match both and fail as ambiguous.
 */
function getReadout(container: HTMLElement) {
  return within(container.querySelector("[aria-live]")!);
}

describe("PortfolioChart", () => {
  it("shows the placeholder readout before any interaction", () => {
    const { container } = render(<PortfolioChart points={points} />);

    expect(getReadout(container).getByText(PLACEHOLDER_TEXT)).toBeInTheDocument();
  });

  it("reveals the tooltip on a single tap (pointerdown), with no drag", () => {
    const { container } = render(<PortfolioChart points={points} />);
    const svg = getChartSvg();
    stubChartRect(svg);

    // Tap near the plot's right edge -- nearest to the second point.
    fireEvent.pointerDown(svg, { clientX: 860 });

    const readout = getReadout(container);
    expect(readout.getByText("Jan 2, 2024")).toBeInTheDocument();
    expect(readout.getByText("$30.00")).toBeInTheDocument();
    expect(readout.queryByText(PLACEHOLDER_TEXT)).not.toBeInTheDocument();
  });

  it("still reveals the tooltip on pointermove (desktop hover unchanged)", () => {
    const { container } = render(<PortfolioChart points={points} />);
    const svg = getChartSvg();
    stubChartRect(svg);

    // Move near the plot's left edge -- nearest to the first point.
    fireEvent.pointerMove(svg, { clientX: 100 });

    const readout = getReadout(container);
    expect(readout.getByText("Jan 1, 2024")).toBeInTheDocument();
    expect(readout.getByText("$20.00")).toBeInTheDocument();
  });

  it("clears the tooltip on pointerleave, same as before tap support", () => {
    const { container } = render(<PortfolioChart points={points} />);
    const svg = getChartSvg();
    stubChartRect(svg);
    const readout = getReadout(container);

    fireEvent.pointerDown(svg, { clientX: 860 });
    expect(readout.getByText("Jan 2, 2024")).toBeInTheDocument();

    fireEvent.pointerLeave(svg);

    expect(readout.getByText(PLACEHOLDER_TEXT)).toBeInTheDocument();
  });

  it("clears the tooltip on pointercancel (e.g. the browser taking over a touch-scroll gesture)", () => {
    const { container } = render(<PortfolioChart points={points} />);
    const svg = getChartSvg();
    stubChartRect(svg);
    const readout = getReadout(container);

    fireEvent.pointerDown(svg, { clientX: 860 });
    expect(readout.getByText("Jan 2, 2024")).toBeInTheDocument();

    // No pointerup, no pointerleave -- a real touch-scroll gesture fires
    // pointercancel instead, and per the Pointer Events spec,
    // pointerleave "may not be dispatched" following a cancel.
    fireEvent.pointerCancel(svg);

    expect(readout.getByText(PLACEHOLDER_TEXT)).toBeInTheDocument();
  });

  describe("trade markers (issue #13: long/short direction verbs)", () => {
    const eventPoints: PortfolioPoint[] = [
      { date: "2024-01-01", value: 20, event: null },
      {
        date: "2024-01-02",
        value: 20,
        event: { type: "open", direction: "long", ticker: "AAPL", price: 10 },
      },
      {
        date: "2024-01-03",
        value: 40,
        event: { type: "close", direction: "long", ticker: "AAPL", price: 20 },
      },
      {
        date: "2024-01-04",
        value: 40,
        event: { type: "open", direction: "short", ticker: "MSFT", price: 100 },
      },
      {
        date: "2024-01-05",
        value: 80,
        event: { type: "close", direction: "short", ticker: "MSFT", price: 50 },
      },
    ];

    it("uses 'shorted'/'covered' verbs in the hover tooltip for a short event, not 'bought'/'sold'", () => {
      const { container } = render(<PortfolioChart points={eventPoints} />);
      const svg = getChartSvg();
      stubChartRect(svg);

      // eventPoints[3] (index 3) is MSFT's short-open point, at x fraction
      // 3/4 of the plot width.
      fireEvent.pointerMove(svg, { clientX: 660 });
      expect(getReadout(container).getByText(/shorted MSFT/)).toBeInTheDocument();

      // eventPoints[4] is MSFT's short-close (cover) point.
      fireEvent.pointerMove(svg, { clientX: 860 });
      expect(getReadout(container).getByText(/covered MSFT/)).toBeInTheDocument();
    });

    it("uses 'bought'/'sold' verbs in the hover tooltip for a long event", () => {
      const { container } = render(<PortfolioChart points={eventPoints} />);
      const svg = getChartSvg();
      stubChartRect(svg);

      fireEvent.pointerMove(svg, { clientX: 220 }); // AAPL's open point
      expect(getReadout(container).getByText(/bought AAPL/)).toBeInTheDocument();
    });

    it("labels the accessible data table's short rows 'Short'/'Cover', not 'Buy'/'Sell'", () => {
      render(<PortfolioChart points={eventPoints} />);

      const table = screen.getByRole("table");
      expect(within(table).getByText(/Short MSFT @/)).toBeInTheDocument();
      expect(within(table).getByText(/Cover MSFT @/)).toBeInTheDocument();
      expect(within(table).queryByText(/Buy MSFT/)).not.toBeInTheDocument();
    });
  });

  describe("gain/loss coloring (issue #85)", () => {
    /** The line path is the second of the two <path>s inside the chart's plot group -- the area-fill path (fill=url(#gradient), stroke="none") renders first, the stroked line path second. */
    function getLinePath() {
      return getChartSvg().querySelectorAll("path")[1]!;
    }

    it("colors the line as a gain (--status-good) when the series ends at or above where it started", () => {
      // Top-level `points` fixture: 20 -> 30, a real gain.
      render(<PortfolioChart points={points} />);

      expect(getLinePath()).toHaveAttribute("stroke", "var(--status-good)");
    });

    it("colors the line as a loss (--status-critical) when the series ends below where it started", () => {
      const lossPoints: PortfolioPoint[] = [
        { date: "2024-01-01", value: 30, event: null },
        { date: "2024-01-02", value: 20, event: null },
      ];
      render(<PortfolioChart points={lossPoints} />);

      expect(getLinePath()).toHaveAttribute("stroke", "var(--status-critical)");
    });

    it("treats a flat/zero-trade window (start === end) as a gain, the same '>= is good' convention TradeRow/HeroStat already use", () => {
      const flatPoints: PortfolioPoint[] = [
        { date: "2024-01-01", value: 20, event: null },
        { date: "2024-01-02", value: 20, event: null },
      ];
      render(<PortfolioChart points={flatPoints} />);

      expect(getLinePath()).toHaveAttribute("stroke", "var(--status-good)");
    });

    it("colors an open/close marker to match the same gain/loss color as the line", () => {
      const eventPoints: PortfolioPoint[] = [
        { date: "2024-01-01", value: 20, event: null },
        {
          date: "2024-01-02",
          value: 20,
          event: { type: "open", direction: "long", ticker: "AAPL", price: 10 },
        },
        {
          date: "2024-01-03",
          value: 10,
          event: { type: "close", direction: "long", ticker: "AAPL", price: 5 },
        },
      ];
      render(<PortfolioChart points={eventPoints} />);
      const svg = getChartSvg();

      // Open marker: hollow ring, stroked in the series color (see
      // "marker shape" below for the shape assertion itself).
      const [openCircle, closeCircle] = svg.querySelectorAll("circle");
      expect(openCircle).toHaveAttribute("stroke", "var(--status-critical)");
      expect(closeCircle).toHaveAttribute("fill", "var(--status-critical)");
    });
  });

  describe("marker shape (issue #85)", () => {
    const eventPoints: PortfolioPoint[] = [
      { date: "2024-01-01", value: 20, event: null },
      {
        date: "2024-01-02",
        value: 20,
        event: { type: "open", direction: "long", ticker: "AAPL", price: 10 },
      },
      {
        date: "2024-01-03",
        value: 40,
        event: { type: "close", direction: "long", ticker: "AAPL", price: 20 },
      },
    ];

    it("renders an open marker as a hollow ring (fill=none, stroked) and a close marker as a filled dot", () => {
      render(<PortfolioChart points={eventPoints} />);
      const [openCircle, closeCircle] = getChartSvg().querySelectorAll("circle");

      expect(openCircle).toHaveAttribute("fill", "none");
      expect(openCircle).toHaveAttribute("stroke", "var(--status-good)");
      expect(closeCircle).toHaveAttribute("fill", "var(--status-good)");
    });

    it("renders no on-chart text labels for a marker any more (issue #85 -- removed in favor of the tooltip/data table)", () => {
      render(<PortfolioChart points={eventPoints} />);
      const svg = within(getChartSvg());

      expect(svg.queryByText(/Buy AAPL/)).not.toBeInTheDocument();
      expect(svg.queryByText(/Sell AAPL/)).not.toBeInTheDocument();
    });
  });

  describe("reveal animation on mount (issue #85)", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    /** The <g> wrapping the area fill + line + markers -- identified as the parent of the line path (the plot group's second <path>), not the gridlines/axis group above it. */
    function getRevealGroup() {
      return getChartSvg().querySelectorAll("path")[1]!.parentElement!;
    }

    it("plays the reveal animation on mount when motion is allowed", () => {
      stubPrefersReducedMotion(false);

      render(<PortfolioChart points={points} />);

      expect(getRevealGroup()).toHaveClass("portfolio-chart-reveal");
    });

    it("skips the reveal animation class when the user prefers reduced motion", () => {
      stubPrefersReducedMotion(true);

      render(<PortfolioChart points={points} />);

      expect(getRevealGroup()).not.toHaveClass("portfolio-chart-reveal");
    });

    // Regression guard for the same class of bug HeroStat's own reveal
    // accent test suite guards against: the reduced-motion read must be
    // latched once at mount (useReducedMotionAtMount), not re-evaluated
    // live on every render, or an OS-level toggle mid-session could flip
    // the class on an already-mounted, already-revealed chart.
    it("keeps the reveal class fixed across a re-render of an already-mounted chart, even if the OS motion preference changes mid-session", () => {
      stubPrefersReducedMotion(false);

      const { rerender } = render(<PortfolioChart points={points} />);
      expect(getRevealGroup()).toHaveClass("portfolio-chart-reveal");

      stubPrefersReducedMotion(true);
      rerender(<PortfolioChart points={points} />);

      expect(getRevealGroup()).toHaveClass("portfolio-chart-reveal");
    });
  });

  describe("touch tap hint (issue #66)", () => {
    const eventPoints: PortfolioPoint[] = [
      { date: "2024-01-01", value: 20, event: null },
      {
        date: "2024-01-02",
        value: 20,
        event: { type: "open", direction: "long", ticker: "AAPL", price: 10 },
      },
      {
        date: "2024-01-03",
        value: 40,
        event: { type: "close", direction: "long", ticker: "AAPL", price: 20 },
      },
    ];

    afterEach(() => {
      window.localStorage.clear();
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    });

    function getTapHintPulse(container: HTMLElement) {
      return container.querySelector(".chart-tap-hint-pulse");
    }

    it("shows a pulsing hint on the most recent marker on a touch-primary device with nothing stored", () => {
      stubMatchMedia({ "(pointer: coarse)": true, "(prefers-reduced-motion: reduce)": false });

      const { container } = render(<PortfolioChart points={eventPoints} />);

      expect(getTapHintPulse(container)).not.toBeNull();
    });

    it("does not show the hint on a mouse/trackpad device", () => {
      stubMatchMedia({ "(pointer: coarse)": false, "(prefers-reduced-motion: reduce)": false });

      const { container } = render(<PortfolioChart points={eventPoints} />);

      expect(getTapHintPulse(container)).toBeNull();
    });

    it("does not show the hint when the user prefers reduced motion, even on a touch device", () => {
      stubMatchMedia({ "(pointer: coarse)": true, "(prefers-reduced-motion: reduce)": true });

      const { container } = render(<PortfolioChart points={eventPoints} />);

      expect(getTapHintPulse(container)).toBeNull();
    });

    it("does not show the hint when there are no trade markers to point at", () => {
      stubMatchMedia({ "(pointer: coarse)": true, "(prefers-reduced-motion: reduce)": false });

      // The top-level `points` fixture has no trade events at all.
      const { container } = render(<PortfolioChart points={points} />);

      expect(getTapHintPulse(container)).toBeNull();
    });

    it("hides the pulse on the first tap (the dismissal itself was already persisted at mount)", () => {
      stubMatchMedia({ "(pointer: coarse)": true, "(prefers-reduced-motion: reduce)": false });

      const { container } = render(<PortfolioChart points={eventPoints} />);
      expect(getTapHintPulse(container)).not.toBeNull();
      // Persisted as soon as it was shown, not deferred until this tap --
      // see use-chart-tap-hint.test.ts's own regression test for why.
      expect(window.localStorage.getItem("hikt:chart-tap-hint-dismissed")).not.toBeNull();

      const svg = getChartSvg();
      stubChartRect(svg);
      fireEvent.pointerDown(svg, { clientX: 860 });

      expect(getTapHintPulse(container)).toBeNull();
    });

    it("never shows the hint on a later mount once it was already dismissed", () => {
      stubMatchMedia({ "(pointer: coarse)": true, "(prefers-reduced-motion: reduce)": false });
      window.localStorage.setItem("hikt:chart-tap-hint-dismissed", "1");

      const { container } = render(<PortfolioChart points={eventPoints} />);

      expect(getTapHintPulse(container)).toBeNull();
    });

    /**
     * Regression test for a real bug found in code review: the hint's
     * dismissal used to persist only from an actual tap or the pulse
     * animation's own completion, so a chart that unmounted before
     * either happened -- e.g. `ResultsPanel`'s `DayOverview` (issue #80;
     * `DaySelector` before it) switching to a different intraday day
     * mid-pulse -- left the "shown" flag
     * unset, and the very next `PortfolioChart` mount (a fresh instance,
     * the same way switching days remounts one) showed the pulse again.
     * Unmounting here with no tap at all mirrors exactly that scenario.
     */
    it("stays dismissed on a fresh mount (e.g. after switching days) even if the previous chart was never tapped", () => {
      stubMatchMedia({ "(pointer: coarse)": true, "(prefers-reduced-motion: reduce)": false });

      const first = render(<PortfolioChart points={eventPoints} />);
      expect(getTapHintPulse(first.container)).not.toBeNull();
      first.unmount();

      const second = render(<PortfolioChart points={eventPoints} />);

      expect(getTapHintPulse(second.container)).toBeNull();
    });
  });
});
