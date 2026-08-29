import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { TheLineup } from "./PlaceholderGameTile";

// The Order's own placeholder used to be tested here too, until issue
// #207 replaced it with a real, playable game -- see TheOrder.test.tsx.

describe("TheLineup", () => {
  it("renders its name and a one-line description", () => {
    render(<TheLineup />);
    expect(screen.getByText("The Lineup")).toBeInTheDocument();
    expect(screen.getByText(/guess 5 mystery 3-letter tickers, wordle-style/i)).toBeInTheDocument();
  });

  it("renders a clearly-disabled 'Coming soon' state", () => {
    render(<TheLineup />);
    expect(screen.getByText("Coming soon")).toBeInTheDocument();
  });

  it("is reachable by an accessible-name/role query, and is marked aria-disabled", () => {
    render(<TheLineup />);
    const group = screen.getByRole("group", { name: "The Lineup - coming soon" });
    expect(group).toHaveAttribute("aria-disabled", "true");
  });

  it("is not interactive: no button, link, details/summary, or focusable element", () => {
    const { container } = render(<TheLineup />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(container.querySelector("details")).toBeNull();
    expect(container.querySelector("summary")).toBeNull();
    expect(container.querySelector("button")).toBeNull();
    expect(container.querySelector("a")).toBeNull();
    expect(container.querySelector("[tabindex]")).toBeNull();
  });
});
