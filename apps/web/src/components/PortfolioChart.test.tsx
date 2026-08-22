import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { PortfolioChart } from "./PortfolioChart";
import type { PortfolioPoint } from "@/lib/portfolio-series";

const points: PortfolioPoint[] = [
  { date: "2024-01-01", value: 20, event: null },
  { date: "2024-01-02", value: 30, event: null },
];

const PLACEHOLDER_TEXT = "Hover or focus the chart (use the arrow keys) to inspect a point.";

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
});
