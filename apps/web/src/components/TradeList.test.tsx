import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { Trade } from "@hadiknowntrades/core";

import { TradeList } from "./TradeList";

function trade(overrides: Partial<Trade> = {}): Trade {
  return {
    ticker: "AAPL",
    buyDate: "2025-03-12",
    buyPrice: 100,
    sellDate: "2025-03-19",
    sellPrice: 125,
    ...overrides,
  };
}

/**
 * The prose is one <p> whose sentences are split across several sibling
 * <span>s (see TradeList.tsx) -- Testing Library's getByText only
 * matches an element's *own* direct-child text nodes, not a recursive
 * textContent, so it can't reliably hand back "the whole sentence" when
 * a ticker name or colored percent sits in a nested span partway
 * through it. Reading the container's <p>.textContent directly (a
 * native, always-recursive DOM property) sidesteps that entirely.
 */
function proseText(container: HTMLElement): string {
  return container.querySelector("p")?.textContent ?? "";
}

describe("TradeList", () => {
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
        trades={[trade({ ticker: "AAPL" }), trade({ ticker: "MSFT", buyPrice: 50, sellPrice: 50 })]}
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
          trade({ ticker: "MSFT", buyPrice: 50, sellPrice: 55 }),
          trade({ ticker: "TSLA", buyPrice: 200, sellPrice: 180 }),
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
      <TradeList trades={[trade({ buyPrice: 200, sellPrice: 150 })]} startingCapital={20} />,
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
          trade({ ticker: "A", buyPrice: 1, sellPrice: 300 }),
          trade({ ticker: "B", buyPrice: 1, sellPrice: 400 }),
          trade({ ticker: "C", buyPrice: 1, sellPrice: 300 }),
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
});
