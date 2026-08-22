import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { WorstCaseStat } from "./WorstCaseStat";

describe("WorstCaseStat", () => {
  it("renders the worst-case ending balance and its multiplier", () => {
    render(<WorstCaseStat startingCapital={20} endingBalance={10} />);

    expect(screen.getByText("$10.00")).toBeInTheDocument();
    expect(screen.getByText("(0.5x)")).toBeInTheDocument();
  });

  it("renders a large worst-case figure through the same compact formatting HeroStat uses", () => {
    render(<WorstCaseStat startingCapital={20} endingBalance={6_900} />);

    expect(screen.getByText("$6.9K")).toBeInTheDocument();
  });

  it("renders in a fixed muted tone regardless of whether the figure is a loss or a gain (a deliberate product decision, not dynamic gain/loss coloring)", () => {
    const { container: lossContainer } = render(
      <WorstCaseStat startingCapital={20} endingBalance={10} />,
    );
    const lossFigure = screen.getByText("$10.00").closest("p");
    expect(lossFigure).toHaveClass("text-[var(--text-muted)]");
    lossContainer.remove();

    render(<WorstCaseStat startingCapital={20} endingBalance={25} />);
    const gainFigure = screen.getByText("$25.00").closest("p");
    expect(gainFigure).toHaveClass("text-[var(--text-muted)]");
  });

  it("does not render a trades list -- this stat is scoped to the ending balance/multiplier only", () => {
    render(<WorstCaseStat startingCapital={20} endingBalance={10} />);

    expect(screen.queryByRole("list")).not.toBeInTheDocument();
  });
});
