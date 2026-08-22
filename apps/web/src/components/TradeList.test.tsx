import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { Trade } from "@hadiknowntrades/core";

import { TradeList } from "./TradeList";

function trade(overrides: Partial<Trade> = {}): Trade {
  return {
    ticker: "AAPL",
    direction: "long",
    openDate: "2025-03-12",
    openPrice: 100,
    closeDate: "2025-03-19",
    closePrice: 125,
    ...overrides,
  };
}

/**
 * The prose is one <ol> whose per-trade <li>s (styled `display: inline`
 * so they flow as one visual paragraph, see globals.css's
 * `.trade-narration-item`) hold several sibling <span>s each (see
 * TradeList.tsx) -- Testing Library's getByText only matches an
 * element's *own* direct-child text nodes, not a recursive textContent,
 * so it can't reliably hand back "the whole sentence" when a ticker name
 * or colored percent sits in a nested span partway through it. Reading
 * the container's <ol>.textContent directly (a native, always-recursive
 * DOM property) sidesteps that entirely.
 */
function proseText(container: HTMLElement): string {
  return container.querySelector("ol")?.textContent ?? "";
}

describe("TradeList", () => {
  it("renders a brief fallback instead of a silently blank box for an empty trades array (defensive -- ResultsPanel owns the primary empty-state copy today)", () => {
    render(<TradeList trades={[]} startingCapital={20} />);

    expect(screen.getByText("No trades to show.")).toBeInTheDocument();
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
  });

  it("renders as a real <ol>/<li> list -- one listitem per trade -- so assistive tech gets list semantics and per-item navigation, not just visually-flowing spans", () => {
    render(
      <TradeList
        trades={[
          trade({ ticker: "AAPL" }),
          trade({ ticker: "MSFT", openPrice: 50, closePrice: 55 }),
          trade({ ticker: "TSLA", openPrice: 200, closePrice: 180 }),
        ]}
        startingCapital={20}
      />,
    );

    expect(screen.getByRole("list")).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
  });

  it("narrates a single trade as one prose sentence with the 'Had you known' opener", () => {
    const { container } = render(<TradeList trades={[trade()]} startingCapital={20} />);

    const text = proseText(container);
    expect(text).toMatch(/Had you known, you'd have bought AAPL on .* at \$100\.00/);
    expect(text).toMatch(/sold on .* at \$125\.00/);
    expect(text).toMatch(/turning your \$20\.00 into \$25\.00/);
    expect(text).toMatch(/\(\+25\.0%\)/);
  });

  it("narrates a 2-trade sequence with a 'Finally' second (and last) leg, referring back to the running balance instead of restating the starting capital", () => {
    const { container } = render(
      <TradeList
        trades={[
          trade({ ticker: "AAPL" }),
          trade({ ticker: "MSFT", openPrice: 50, closePrice: 50 }),
        ]}
        startingCapital={20}
      />,
    );

    const text = proseText(container);
    expect(text).toMatch(/Had you known.*AAPL/);
    expect(text).toMatch(/Finally, you'd have bought MSFT/);
    // The second leg refers to the running balance as "that", not a
    // second "your $..." restating the starting capital.
    expect(text).toMatch(/turning that into/);
    expect(text.match(/your \$/g)).toHaveLength(1);
  });

  it("narrates a 3-trade sequence with 'Had you known' / 'Then' / 'Finally' in order", () => {
    const { container } = render(
      <TradeList
        trades={[
          trade({ ticker: "AAPL" }),
          trade({ ticker: "MSFT", openPrice: 50, closePrice: 55 }),
          trade({ ticker: "TSLA", openPrice: 200, closePrice: 180 }),
        ]}
        startingCapital={20}
      />,
    );

    const text = proseText(container);
    const hadIndex = text.indexOf("Had you known");
    const thenIndex = text.indexOf("Then you'd have bought MSFT");
    const finallyIndex = text.indexOf("Finally, you'd have bought TSLA");
    expect(hadIndex).toBeGreaterThanOrEqual(0);
    expect(thenIndex).toBeGreaterThan(hadIndex);
    expect(finallyIndex).toBeGreaterThan(thenIndex);
  });

  it("reads sensibly (negative percent, colored critical, no crash) for a losing leg -- generic even though today's optimizer never produces one", () => {
    const { container } = render(
      <TradeList trades={[trade({ openPrice: 200, closePrice: 150 })]} startingCapital={20} />,
    );

    expect(proseText(container)).toMatch(/\(-25\.0%\)/);
    expect(screen.getByText("(-25.0%)")).toHaveStyle({ color: "var(--status-critical)" });
  });

  it("colors a gaining leg's return with the established good-status color", () => {
    render(<TradeList trades={[trade()]} startingCapital={20} />);

    expect(screen.getByText("(+25.0%)")).toHaveStyle({ color: "var(--status-good)" });
  });

  it("reads sensibly at Max-range-scale magnitudes: the running balance compacts instead of rendering a wall of digits", () => {
    const { container } = render(
      <TradeList
        trades={[
          trade({ ticker: "A", openPrice: 1, closePrice: 300 }),
          trade({ ticker: "B", openPrice: 1, closePrice: 400 }),
          trade({ ticker: "C", openPrice: 1, closePrice: 300 }),
        ]}
        startingCapital={20}
      />,
    );

    const text = proseText(container);
    // Final running balance is 20 * 300 * 400 * 300 = 720,000,000 --
    // formatHeroCurrency compacts this to "$720M", not 9 raw digits.
    expect(text).toMatch(/\$720M/);
    expect(text).not.toMatch(/\$720,000,000/);
  });

  it("narrates a short trade with 'shorted'/'covered' verbs and the reciprocal-price return (issue #13)", () => {
    const { container } = render(
      <TradeList
        trades={[trade({ direction: "short", openPrice: 100, closePrice: 80 })]}
        startingCapital={20}
      />,
    );

    const text = proseText(container);
    expect(text).toMatch(/Had you known, you'd have shorted AAPL on .* at \$100\.00/);
    expect(text).toMatch(/covered on .* at \$80\.00/);
    // Payoff 100/80 = 1.25 -- a gain, price fell.
    expect(text).toMatch(/turning your \$20\.00 into \$25\.00/);
    expect(text).toMatch(/\(\+25\.0%\)/);
    expect(screen.getByText("(+25.0%)")).toHaveStyle({ color: "var(--status-good)" });
  });
});
