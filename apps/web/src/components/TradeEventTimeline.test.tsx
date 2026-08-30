import type { Trade } from "@hadiknowntrades/core";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { TradeEventTimeline } from "./TradeEventTimeline";

function trade(overrides: Partial<Trade> = {}): Trade {
  return {
    ticker: "AAPL",
    direction: "long",
    openDate: "2024-01-02",
    openPrice: 100,
    closeDate: "2024-01-05",
    closePrice: 200,
    ...overrides,
  };
}

describe("TradeEventTimeline (issue #209)", () => {
  it("renders one chip per trade, as a real list", () => {
    render(
      <TradeEventTimeline
        trades={[
          trade({ ticker: "AAPL" }),
          trade({ ticker: "MSFT", openDate: "2024-02-01", closeDate: "2024-02-05" }),
        ]}
      />,
    );

    expect(screen.getByRole("list", { name: "Trade sequence" })).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByText("AAPL")).toBeInTheDocument();
    expect(screen.getByText("MSFT")).toBeInTheDocument();
  });

  it("shows a gain leg's real, signed return", () => {
    render(<TradeEventTimeline trades={[trade({ openPrice: 100, closePrice: 200 })]} />);

    expect(screen.getByText("+100.0%")).toBeInTheDocument();
  });

  it("shows a loss leg's real, signed return", () => {
    render(<TradeEventTimeline trades={[trade({ openPrice: 100, closePrice: 80 })]} />);

    expect(screen.getByText("-20.0%")).toBeInTheDocument();
  });

  it("labels a short trade explicitly -- a long trade gets no direction badge at all", () => {
    render(
      <TradeEventTimeline
        trades={[trade({ ticker: "SHORTCO", direction: "short", openPrice: 100, closePrice: 80 })]}
      />,
    );

    // A short's return mirrors optimizer.ts's own reciprocal-price
    // payoff (openPrice/closePrice - 1) -- a price *drop* is the gain
    // here, matching trade-math.ts's own computeTradeReturn contract.
    expect(screen.getByText("short")).toBeInTheDocument();
    expect(screen.getByText("+25.0%")).toBeInTheDocument();
  });

  it("carries a WCAG 1.4.1-compliant sr-only sentence per chip, not color alone -- including the prices the adjacent aria-hidden span shows", () => {
    render(<TradeEventTimeline trades={[trade({ ticker: "AAPL" })]} />);

    expect(
      screen.getByText(
        "Trade 1: bought AAPL on Jan 2, 2024 at $100.00, sold on Jan 5, 2024 at $200.00. Gain, +100.0%.",
      ),
    ).toBeInTheDocument();
  });

  it("uses shorted/covered for a short trade's sr-only sentence too, not just its visible badge", () => {
    render(
      <TradeEventTimeline
        trades={[trade({ ticker: "SHORTCO", direction: "short", openPrice: 100, closePrice: 80 })]}
      />,
    );

    expect(
      screen.getByText(
        "Trade 1: shorted SHORTCO on Jan 2, 2024 at $100.00, covered on Jan 5, 2024 at $80.00. Gain, +25.0%.",
      ),
    ).toBeInTheDocument();
  });

  it("renders nothing for an empty trade list", () => {
    const { container } = render(<TradeEventTimeline trades={[]} />);

    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
    // Still a real (empty) list, not a null render -- ResultsPanel/
    // TradeReplay guard the zero-trade case themselves (see
    // TradeReplay.tsx's own `trades` prop doc comment), not this
    // component.
    expect(container.querySelector("ol")).toBeInTheDocument();
  });
});
