import type { BenchmarkResult } from "@hadiknowntrades/core";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { BenchmarkStat } from "./BenchmarkStat";

function fixtureBenchmark(overrides: Partial<BenchmarkResult> = {}): BenchmarkResult {
  return {
    ticker: "SPY",
    startDate: "2025-08-21",
    startPrice: 400,
    endDate: "2026-08-21",
    endPrice: 460,
    endingBalance: 23,
    truncated: false,
    ...overrides,
  };
}

/**
 * The rendered sentence is one <p> whose interpolated dollar figures and
 * ticker sit in separate sibling text nodes/spans (see BenchmarkStat.tsx)
 * -- Testing Library's getByText only matches an element's *own*
 * direct-child text nodes, not a recursive textContent, so it can't hand
 * back "the whole sentence" once a value is split across nodes like that
 * (same reasoning TradeList.test.tsx's own proseText helper documents).
 * Reading the <p>'s textContent directly (a native, always-recursive DOM
 * property) sidesteps that entirely.
 */
function proseText(container: HTMLElement): string {
  return container.querySelector("p")?.textContent ?? "";
}

describe("BenchmarkStat", () => {
  it("renders nothing when benchmark is null", () => {
    const { container } = render(<BenchmarkStat benchmark={null} startingCapital={20} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders the buy-and-hold comparison sentence with the ticker and both dollar figures", () => {
    const { container } = render(
      <BenchmarkStat benchmark={fixtureBenchmark()} startingCapital={20} />,
    );

    const text = proseText(container);
    expect(text).toContain("Buying and holding SPY instead");
    expect(text).toContain("$20.00");
    expect(text).toContain("$23.00");
  });

  it("does not render the truncated caveat when truncated is false", () => {
    const { container } = render(
      <BenchmarkStat benchmark={fixtureBenchmark({ truncated: false })} startingCapital={20} />,
    );

    expect(proseText(container)).not.toMatch(/earliest available data/);
  });

  it("renders the truncated caveat, with the benchmark's own startDate, only when truncated is true", () => {
    const { container } = render(
      <BenchmarkStat
        benchmark={fixtureBenchmark({ truncated: true, startDate: "1993-01-29" })}
        startingCapital={20}
      />,
    );

    expect(proseText(container)).toContain("since its earliest available data, Jan 29, 1993");
  });

  it("rescales both displayed dollar figures via displayStartingCapital (issue #15)", () => {
    const { container } = render(
      <BenchmarkStat
        benchmark={fixtureBenchmark({ endingBalance: 40 })}
        startingCapital={20}
        displayStartingCapital={100}
      />,
    );

    // 100 is 5x the underlying startingCapital (20), so both figures scale
    // by the same 5x ratio: 100 -> displayStartingCapital itself, 40 -> 200.
    const text = proseText(container);
    expect(text).toContain("$100.00");
    expect(text).toContain("$200.00");
  });

  it("defaults displayStartingCapital to startingCapital (a no-op rescale) when omitted", () => {
    const { container } = render(
      <BenchmarkStat benchmark={fixtureBenchmark({ endingBalance: 40 })} startingCapital={20} />,
    );

    const text = proseText(container);
    expect(text).toContain("$20.00");
    expect(text).toContain("$40.00");
  });

  it("omits any range disambiguation when rangeLabel isn't passed (the window model)", () => {
    const { container } = render(
      <BenchmarkStat benchmark={fixtureBenchmark()} startingCapital={20} />,
    );

    const text = proseText(container);
    expect(text).toContain("Buying and holding SPY instead");
    expect(text).not.toContain("over the");
  });

  it("includes the range disambiguation when rangeLabel is passed (the intraday-daily model's whole-range-vs-single-day juxtaposition, issue #12)", () => {
    const { container } = render(
      <BenchmarkStat
        benchmark={fixtureBenchmark()}
        startingCapital={20}
        rangeLabel="the past month"
      />,
    );

    expect(proseText(container)).toContain("Buying and holding SPY over the past month instead");
  });

  it("does not apply any gain/loss coloring to the figures -- a deliberate simplicity decision, this is a comparison figure, not a win/loss signal", () => {
    render(<BenchmarkStat benchmark={fixtureBenchmark()} startingCapital={20} />);

    const p = screen.getByText(/Buying and holding SPY instead/);
    expect(p).toHaveClass("text-[var(--text-secondary)]");
    expect(p.querySelector("span")).not.toHaveStyle({ color: "var(--status-good)" });
  });
});
