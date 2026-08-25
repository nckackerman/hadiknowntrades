import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { AboutSection } from "./AboutSection";

const VIEW_DETAILS = "Best possible outcome over the past year, with at most 3 sequential trades.";

describe("AboutSection", () => {
  it("collapses the disclaimer behind a single, clearly-labeled affordance (issue #104)", () => {
    render(<AboutSection viewDetails={VIEW_DETAILS} />);
    const outer = screen.getByText("Disclaimer & methodology").closest("details");
    expect(outer).not.toHaveAttribute("open");
    // Nothing disclaimer-related renders as an alert region any more --
    // issue #10's original always-visible role="alert" box is gone.
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("reveals the disclaimer, the view-specific detail, and the methodology assumptions once opened", () => {
    render(<AboutSection viewDetails={VIEW_DETAILS} />);
    expect(screen.getByText("Not investment advice")).toBeInTheDocument();
    expect(screen.getByText(/says nothing about what will happen next/)).toBeInTheDocument();
    expect(screen.getByText(VIEW_DETAILS)).toBeInTheDocument();
  });

  it("documents every v1 assumption from issue #10's scope", () => {
    render(<AboutSection viewDetails={VIEW_DETAILS} />);
    expect(screen.getByText(/End-of-day only/)).toBeInTheDocument();
    expect(screen.getByText(/Current constituents, applied retroactively/)).toBeInTheDocument();
    expect(screen.getByText(/Split- and dividend-adjusted closes/)).toBeInTheDocument();
    expect(screen.getByText(/No fees, slippage, taxes, or fractional shares/)).toBeInTheDocument();
  });

  it("keeps the methodology assumptions behind their own nested, still-collapsed summary", () => {
    render(<AboutSection viewDetails={VIEW_DETAILS} />);
    const nested = screen.getByText("Methodology & assumptions").closest("details");
    expect(nested).not.toHaveAttribute("open");
  });
});
