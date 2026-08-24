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

  describe("revealedCount / interactive (issue #96 follow-up round 3)", () => {
    // A big jump between the two points so the y-domain a partial reveal
    // would compute on its own (min/max of just the revealed prefix)
    // differs dramatically from the full series' own domain -- a
    // deliberately extreme fixture so a domain-rescale regression would
    // be obvious, not just off by a rounding hair.
    const seriesPoints: PortfolioPoint[] = [
      { date: "2024-01-01", value: 20, event: null },
      {
        date: "2024-01-02",
        value: 20,
        event: { type: "open", direction: "long", ticker: "AAPL", price: 10 },
      },
      { date: "2024-01-05", value: 20, event: null },
      {
        date: "2024-01-05",
        value: 4000,
        event: { type: "close", direction: "long", ticker: "AAPL", price: 2000 },
      },
    ];

    function gridlineYs(container: HTMLElement) {
      return Array.from(container.querySelectorAll('line[stroke="var(--gridline)"]')).map((l) =>
        l.getAttribute("y1"),
      );
    }

    it("keeps the y-axis gridlines fixed to the FULL series' domain regardless of revealedCount, not rescaled to whatever's currently revealed (real bug, fixed)", () => {
      const { container: partial } = render(
        <PortfolioChart points={seriesPoints} revealedCount={2} />,
      );
      const { container: full } = render(<PortfolioChart points={seriesPoints} />);

      expect(gridlineYs(partial)).toEqual(gridlineYs(full));
    });

    it("keeps the x-axis end label pinned to the series' real final date regardless of revealedCount (a fixed frame, not a growing one)", () => {
      const { container: partial } = render(
        <PortfolioChart points={seriesPoints} revealedCount={2} />,
      );

      expect(within(partial).getByText("Jan 5, 2024")).toBeInTheDocument();
    });

    it("places a revealed marker at the same x position it would have in the full/final render -- the axis frame doesn't stretch to fit fewer revealed points", () => {
      const { container: partial } = render(
        <PortfolioChart points={seriesPoints} revealedCount={2} />,
      );
      const { container: full } = render(<PortfolioChart points={seriesPoints} />);

      // Both renders draw the same open marker (index 1) as their only
      // (partial) or first (full) circle -- its cx must match: fixed to
      // the full-series domain either way, not stretched to fill the
      // plot width because only 2 of 4 points are currently revealed.
      const partialCx = partial.querySelector("circle")!.getAttribute("cx");
      const fullCx = full.querySelector("circle")!.getAttribute("cx");
      expect(partialCx).toBe(fullCx);
    });

    it("only draws the revealed prefix -- fewer markers/table rows than the full series", () => {
      const { container } = render(<PortfolioChart points={seriesPoints} revealedCount={2} />);

      // Only the open marker (index 1) is revealed -- the close marker
      // (index 3, value jumping to 4000) isn't drawn yet.
      expect(container.querySelectorAll("circle")).toHaveLength(1);
      expect(screen.getAllByRole("row")).toHaveLength(3); // header + 2 revealed points
    });

    it("clears a stale hoverIndex when `interactive` flips off, so it can't pop back into view once revealedCount grows past it (real bug, fixed)", () => {
      const { container, rerender } = render(<PortfolioChart points={seriesPoints} />);
      const svg = getChartSvg();
      stubChartRect(svg);

      // Hover the last point while still live/interactive.
      fireEvent.pointerMove(svg, { clientX: 860 });
      expect(getReadout(container).queryByText(PLACEHOLDER_TEXT)).not.toBeInTheDocument();

      // Stands in for TradeReplay.tsx starting playback with the pointer
      // never having left the SVG bounds -- same `points` reference,
      // `interactive` flips false, `revealedCount` starts low.
      rerender(<PortfolioChart points={seriesPoints} revealedCount={1} interactive={false} />);
      expect(getReadout(container).getByText(PLACEHOLDER_TEXT)).toBeInTheDocument();

      // Growing revealedCount back past the stale hoverIndex must not
      // pop the tooltip/crosshair back into view.
      rerender(<PortfolioChart points={seriesPoints} revealedCount={3} interactive={false} />);
      expect(getReadout(container).getByText(PLACEHOLDER_TEXT)).toBeInTheDocument();
    });

    it("applies inert/aria-hidden to its own root when interactive is false, and neither when true (default)", () => {
      const { container, rerender } = render(<PortfolioChart points={seriesPoints} />);
      const root = () => container.firstElementChild!;

      expect(root().hasAttribute("inert")).toBe(false);
      expect(root().hasAttribute("aria-hidden")).toBe(false);

      rerender(<PortfolioChart points={seriesPoints} interactive={false} />);

      expect(root().hasAttribute("inert")).toBe(true);
      expect(root().getAttribute("aria-hidden")).toBe("true");
    });
  });

  describe("x-axis scale by series shape (issue #93)", () => {
    /** The <circle> markers for whichever points carry an event, in point order (open before close). */
    function getMarkerCircles() {
      return getChartSvg().querySelectorAll("circle");
    }

    it("buckets a chained multi-day intraday series by calendar day, not by point count", () => {
      // Three trading days chained together: day 1 and day 3 each have a
      // single trade (4 points apiece: a leading flat point, open,
      // sell-label duplicate, close); day 2 has three trades (10 points:
      // a leading flat point plus open/sell-label/close per trade). A
      // per-point ordinal scale (an earlier, wrong version of this fix)
      // would give day 2 roughly 10/18 of the chart's width purely
      // because it has more plotted points; day-bucketing must instead
      // keep every day to the same 1/3 share (PLOT_WIDTH = 880 - 76 - 16
      // = 788, so each day's slot is ~262.67 wide) regardless of how many
      // trades happened that day.
      const eventPoints: PortfolioPoint[] = [
        // Day 1 (2024-01-05): one trade.
        { date: "2024-01-05T09:30:00", value: 20, event: null },
        {
          date: "2024-01-05T10:00:00",
          value: 20,
          event: { type: "open", direction: "long", ticker: "AAPL", price: 10 },
        },
        { date: "2024-01-05T15:00:00", value: 20, event: null },
        {
          date: "2024-01-05T15:00:00",
          value: 24,
          event: { type: "close", direction: "long", ticker: "AAPL", price: 12 },
        },
        // Day 2 (2024-01-08): three trades, DEFAULT_MAX_TRADES_PER_DAY.
        { date: "2024-01-08T09:30:00", value: 24, event: null },
        {
          date: "2024-01-08T10:00:00",
          value: 24,
          event: { type: "open", direction: "long", ticker: "MSFT", price: 100 },
        },
        { date: "2024-01-08T11:00:00", value: 24, event: null },
        {
          date: "2024-01-08T11:00:00",
          value: 26.4,
          event: { type: "close", direction: "long", ticker: "MSFT", price: 110 },
        },
        {
          date: "2024-01-08T12:00:00",
          value: 26.4,
          event: { type: "open", direction: "long", ticker: "MSFT", price: 110 },
        },
        { date: "2024-01-08T13:00:00", value: 26.4, event: null },
        {
          date: "2024-01-08T13:00:00",
          value: 25.2,
          event: { type: "close", direction: "long", ticker: "MSFT", price: 105 },
        },
        {
          date: "2024-01-08T14:00:00",
          value: 25.2,
          event: { type: "open", direction: "long", ticker: "MSFT", price: 105 },
        },
        { date: "2024-01-08T15:00:00", value: 25.2, event: null },
        {
          date: "2024-01-08T15:00:00",
          value: 28.8,
          event: { type: "close", direction: "long", ticker: "MSFT", price: 120 },
        },
        // Day 3 (2024-01-09): one trade.
        { date: "2024-01-09T09:30:00", value: 28.8, event: null },
        {
          date: "2024-01-09T10:00:00",
          value: 28.8,
          event: { type: "open", direction: "long", ticker: "GOOG", price: 50 },
        },
        { date: "2024-01-09T15:00:00", value: 28.8, event: null },
        {
          date: "2024-01-09T15:00:00",
          value: 31.68,
          event: { type: "close", direction: "long", ticker: "GOOG", price: 55 },
        },
      ];
      render(<PortfolioChart points={eventPoints} />);
      const circles = getMarkerCircles();
      expect(circles).toHaveLength(10); // 2 markers/trade * 5 trades

      const cx = (circle: Element) => Number(circle.getAttribute("cx"));
      const [day1Open, day1Close, ...rest] = Array.from(circles);
      const day2Markers = rest.slice(0, 6);
      const [day3Open, day3Close] = rest.slice(6);

      // Day 1's markers stay within day 1's own slot ([0, ~262.67]).
      expect(cx(day1Open!)).toBeLessThan(263);
      expect(cx(day1Close!)).toBeLessThan(263);
      // All 6 of day 2's markers -- despite being 3x as many trades as
      // day 1 or day 3 -- stay within day 2's own slot
      // (~[262.67, 525.33]), never spilling into a neighboring day's
      // share of the width the way per-point ordinal spacing would.
      for (const marker of day2Markers) {
        expect(cx(marker!)).toBeGreaterThanOrEqual(262);
        expect(cx(marker!)).toBeLessThanOrEqual(526);
      }
      // Day 3's markers stay within day 3's own slot (~[525.33, 788]).
      expect(cx(day3Open!)).toBeGreaterThan(525);
      expect(cx(day3Close!)).toBe(788); // also the series' very last point
    });

    it("keeps the window model on a real linear time scale, not day-bucketed spacing", () => {
      // The window model's equivalent shape: a trade opened one day
      // after the window's start, closed almost a year later. Day-bucketed
      // spacing would give a 3-day series' middle point 1/2 the width
      // (x=394, see the chained-intraday test above); a real linear time
      // scale instead places it close to the left edge, proportional to
      // how little of the whole window that one day actually was.
      const eventPoints: PortfolioPoint[] = [
        { date: "2024-01-01", value: 20, event: null },
        {
          date: "2024-01-02",
          value: 20,
          event: { type: "open", direction: "long", ticker: "AAPL", price: 10 },
        },
        {
          date: "2025-01-01",
          value: 40,
          event: { type: "close", direction: "long", ticker: "AAPL", price: 20 },
        },
      ];
      render(<PortfolioChart points={eventPoints} />);
      const [openCircle, closeCircle] = getMarkerCircles();

      const PLOT_WIDTH = 788;
      const span = Date.UTC(2025, 0, 1) - Date.UTC(2024, 0, 1);
      const expectedOpenCx = (PLOT_WIDTH * (Date.UTC(2024, 0, 2) - Date.UTC(2024, 0, 1))) / span;
      expect(Number(openCircle!.getAttribute("cx"))).toBeCloseTo(expectedOpenCx, 5);
      expect(Number(openCircle!.getAttribute("cx"))).toBeLessThan(50);
      expect(closeCircle).toHaveAttribute("cx", "788");
    });

    it("stays on the day-bucketed scale for a chained intraday series even with no trade events at all", () => {
      // A day with no trades still renders a single flat point (see
      // deriveWholeRangeIntradaySeries) -- confirm two such no-event days
      // chained together still resolve nearest-point correctly.
      const flatDays: PortfolioPoint[] = [
        { date: "2024-01-05T12:00:00", value: 20, event: null },
        { date: "2024-01-08T12:00:00", value: 20, event: null },
      ];
      const { container } = render(<PortfolioChart points={flatDays} />);
      const svg = getChartSvg();
      stubChartRect(svg);

      fireEvent.pointerMove(svg, { clientX: 860 });
      // With only 2 points (each its own single-point day), both the
      // first and last point pin to their range edges -- same as it
      // would under a linear scale for just two points, so this mainly
      // guards against a crash/NaN on a
      // no-event chained series rather than distinguishing the two scales.
      expect(getReadout(container).getByText("Jan 8, 12:00 PM")).toBeInTheDocument();
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
