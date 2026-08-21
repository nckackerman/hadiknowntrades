import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { AboutSection } from "./AboutSection";

describe("AboutSection", () => {
  it("shows the disclaimer without requiring a click, as an alert region", () => {
    render(<AboutSection />);
    expect(screen.getByText("Not investment advice")).toBeVisible();
    expect(screen.getByText(/says nothing about what will happen next/)).toBeVisible();
    expect(screen.getByRole("alert")).toContainElement(screen.getByText("Not investment advice"));
  });

  it("documents every v1 assumption from issue #10's scope", () => {
    render(<AboutSection />);
    expect(screen.getByText(/End-of-day only/)).toBeInTheDocument();
    expect(screen.getByText(/Current constituents, applied retroactively/)).toBeInTheDocument();
    expect(screen.getByText(/Split- and dividend-adjusted closes/)).toBeInTheDocument();
    expect(screen.getByText(/No fees, slippage, taxes, or fractional shares/)).toBeInTheDocument();
  });

  it("puts the methodology detail behind a summary, not forced open", () => {
    render(<AboutSection />);
    const details = screen.getByText("Methodology & assumptions").closest("details");
    expect(details).not.toHaveAttribute("open");
  });
});
