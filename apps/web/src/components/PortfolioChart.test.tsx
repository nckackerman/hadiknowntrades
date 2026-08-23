import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PortfolioChart } from "./PortfolioChart";
import { boxesOverlap, labelBox, type LabelAnchor } from "@/lib/chart-label-layout";
import type { PortfolioPoint } from "@/lib/portfolio-series";
import { stubMatchMedia } from "@/lib/stub-match-media.test-util";

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

  describe("trade markers (issue #13: long/short direction labels)", () => {
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

    it("labels a long's open/close markers 'Buy'/'Sell'", () => {
      render(<PortfolioChart points={eventPoints} />);
      const svg = within(getChartSvg());

      expect(svg.getByText(/Buy AAPL/)).toBeInTheDocument();
      expect(svg.getByText(/Sell AAPL/)).toBeInTheDocument();
    });

    it("labels a short's open/close markers 'Short'/'Cover', not 'Buy'/'Sell'", () => {
      render(<PortfolioChart points={eventPoints} />);
      const svg = within(getChartSvg());

      expect(svg.getByText(/Short MSFT/)).toBeInTheDocument();
      expect(svg.getByText(/Cover MSFT/)).toBeInTheDocument();
      expect(svg.queryByText(/Buy MSFT/)).not.toBeInTheDocument();
      expect(svg.queryByText(/Sell MSFT/)).not.toBeInTheDocument();
    });

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

  describe("point-label collision avoidance (issue #68)", () => {
    /**
     * The real-world case the issue was filed from ("a sell a few days
     * after a buy"): AAPL's own open and close land only 4 days apart
     * (matching the issue's own acceptance criteria) within a much
     * longer overall window (~5 years, matching the originally-observed
     * 5Y-range screenshot), so the two dates land only a handful of
     * pixels apart on the x-axis -- and a moderate ~50% gain moves the
     * close point up the log-scaled y-axis just enough to put the
     * close's below-label in range of the open's above-label (see
     * chart-label-layout.test.ts's own equivalent fixture and comment
     * for why a moderate gain, not a huge one, is what actually
     * collides). MSFT's own trade, later in the window with a much
     * bigger gain, doubles as a second, differently-shaped pair.
     *
     * The window's own start value is deliberately lower (5) than
     * AAPL's own open value (20), not equal to it -- matching the
     * live-verification debug fixture (see apps/web/CLAUDE.md's own
     * "Chart point-label collision avoidance" section): pinning AAPL's
     * open at the domain's own minimum would put it right at the plot's
     * bottom edge, where resolveLabelOffsets' bounds (issue #68 code
     * review follow-up) correctly refuse to stack a label past the
     * visible canvas -- a *different*, out-of-scope collision (label vs.
     * plot edge) this fixture isn't meant to exercise.
     */
    const closeTogetherPoints: PortfolioPoint[] = [
      { date: "2020-01-01", value: 5, event: null },
      {
        date: "2022-06-01",
        value: 20,
        event: { type: "open", direction: "long", ticker: "AAPL", price: 10 },
      },
      {
        date: "2022-06-05",
        value: 30,
        event: { type: "close", direction: "long", ticker: "AAPL", price: 15 },
      },
      {
        date: "2023-01-10",
        value: 30,
        event: { type: "open", direction: "long", ticker: "MSFT", price: 310.55 },
      },
      {
        date: "2023-01-14",
        value: 300,
        event: { type: "close", direction: "long", ticker: "MSFT", price: 3105.5 },
      },
      { date: "2025-01-01", value: 300, event: null },
    ];

    /**
     * Reads each rendered marker's own two <text> lines straight out of
     * the DOM and rebuilds the bounding box chart-label-layout.ts itself
     * would compute for that exact content/position -- so this checks
     * the real wiring (component -> resolveLabelOffsets -> rendered
     * attributes), not just the pure layout function in isolation
     * (already covered by chart-label-layout.test.ts).
     */
    function renderedLabelBoxes() {
      const svg = getChartSvg();
      const markerGroups = within(svg)
        .getAllByText(/^(Buy|Sell) /)
        .map((el) => el.closest("g")!);

      return markerGroups.map((g) => {
        const [primaryEl, secondaryEl] = g.querySelectorAll("text");
        const x = Number(primaryEl!.getAttribute("x"));
        const y = Number(primaryEl!.getAttribute("y"));
        const anchor = primaryEl!.getAttribute("text-anchor") as LabelAnchor;
        return labelBox(
          {
            x,
            y,
            isAbove: true, // unused by labelBox itself, only by resolveLabelOffsets
            anchor,
            primaryText: primaryEl!.textContent ?? "",
            secondaryText: secondaryEl!.textContent ?? "",
          },
          y,
        );
      });
    }

    it("renders no two overlapping label bounding boxes for dates ~4 days apart", () => {
      render(<PortfolioChart points={closeTogetherPoints} />);

      const boxes = renderedLabelBoxes();
      expect(boxes).toHaveLength(4); // AAPL open/close + MSFT open/close

      for (let i = 0; i < boxes.length; i++) {
        for (let j = i + 1; j < boxes.length; j++) {
          expect(boxesOverlap(boxes[i]!, boxes[j]!)).toBe(false);
        }
      }
    });

    it("still renders every marker's own gain/loss-independent verb+ticker text (collision avoidance doesn't drop labels)", () => {
      render(<PortfolioChart points={closeTogetherPoints} />);
      const svg = within(getChartSvg());

      expect(svg.getByText("Buy AAPL")).toBeInTheDocument();
      expect(svg.getByText("Sell AAPL")).toBeInTheDocument();
      expect(svg.getByText("Buy MSFT")).toBeInTheDocument();
      expect(svg.getByText("Sell MSFT")).toBeInTheDocument();
    });

    /**
     * Code review finding, fixed: without a bound, stacking a heavily
     * crowded cluster of labels can push one past the outer <svg>'s own
     * viewBox and get silently clipped -- worse than the overlap this
     * issue exists to fix. Six "open" markers (the max this chart ever
     * renders -- one open+close pair per trade, up to 3 trades) all
     * within a single pixel of each other, near the very top of the
     * plot (where there's the least headroom above y=0 to begin with),
     * forces several stack levels for the later ones -- enough to go
     * out of bounds without the fix.
     */
    it("keeps every label's box within the visible SVG canvas even under a heavily crowded cluster near the plot's top edge", () => {
      const crowdedPoints: PortfolioPoint[] = [
        { date: "2020-01-01", value: 5, event: null },
        ...Array.from({ length: 6 }, (_, i) => ({
          date: `2024-01-0${i + 1}`,
          value: 990 + i, // clustered near the window's own max (1000) -- near the plot's top edge
          event: {
            type: "open" as const,
            direction: "long" as const,
            ticker: `TICK${i}`,
            price: 10 + i,
          },
        })),
        { date: "2025-01-01", value: 1000, event: null },
      ];

      render(<PortfolioChart points={crowdedPoints} />);
      const svg = within(getChartSvg());

      const boxes = Array.from({ length: 6 }, (_, i) => {
        const primaryEl = svg.getByText(`Buy TICK${i}`);
        const g = primaryEl.closest("g")!;
        const [, secondaryEl] = g.querySelectorAll("text");
        const y = Number(primaryEl.getAttribute("y"));
        return labelBox(
          {
            x: Number(primaryEl.getAttribute("x")),
            y,
            isAbove: true,
            anchor: primaryEl.getAttribute("text-anchor") as LabelAnchor,
            primaryText: primaryEl.textContent ?? "",
            secondaryText: secondaryEl!.textContent ?? "",
          },
          y,
        );
      });

      // Matches this component's own MARGIN.top -- content above this
      // local y is clipped by the outer <svg>'s viewBox.
      const MARGIN_TOP = 56;
      for (const box of boxes) {
        expect(box.top).toBeGreaterThanOrEqual(-MARGIN_TOP);
      }
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
