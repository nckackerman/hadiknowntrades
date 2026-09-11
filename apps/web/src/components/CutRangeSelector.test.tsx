import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CUT_RANGES } from "@hadiknowntrades/core";
import { describe, expect, it, vi } from "vitest";

import { CutRangeSelector } from "./CutRangeSelector";

describe("CutRangeSelector (issue #238)", () => {
  it("has its own distinct aria-label, not RangeSelector's own 'Preset date range' (code review finding)", () => {
    render(<CutRangeSelector selected="1D" onSelect={() => {}} />);

    expect(screen.getByRole("group", { name: "The Cut date range" })).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Preset date range" })).not.toBeInTheDocument();
  });

  it("renders a button for every CUT_RANGES entry, including 1D", () => {
    render(<CutRangeSelector selected="1D" onSelect={() => {}} />);

    for (const range of CUT_RANGES) {
      expect(
        screen.getByRole("button", { name: range === "MAX" ? "Max" : range }),
      ).toBeInTheDocument();
    }
  });

  it("marks only the selected range as pressed", () => {
    render(<CutRangeSelector selected="1D" onSelect={() => {}} />);

    expect(screen.getByRole("button", { name: "1D" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "1W" })).toHaveAttribute("aria-pressed", "false");
  });

  it("calls onSelect with the clicked range", async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(<CutRangeSelector selected="1D" onSelect={onSelect} />);

    await user.click(screen.getByRole("button", { name: "Max" }));

    expect(onSelect).toHaveBeenCalledWith("MAX");
  });

  it("renders pills in CUT_RANGES order, with 1D positioned before every PresetRange", () => {
    render(<CutRangeSelector selected="1D" onSelect={() => {}} />);

    const renderedOrder = screen.getAllByRole("button").map((button) => button.textContent);
    const expectedOrder = CUT_RANGES.map((range) => (range === "MAX" ? "Max" : range));
    expect(renderedOrder).toEqual(expectedOrder);
    expect(renderedOrder[0]).toBe("1D");
  });

  describe("duration-coded indicator", () => {
    it("renders one bar per pill whose width strictly increases in CUT_RANGES order", () => {
      render(<CutRangeSelector selected="1D" onSelect={() => {}} />);

      const bars = screen.getAllByTestId("range-duration-bar");
      expect(bars.map((bar) => bar.dataset.range)).toEqual([...CUT_RANGES]);

      const widths = bars.map((bar) => Number.parseFloat(bar.style.width));
      expect(widths.every((width) => Number.isFinite(width) && width > 0)).toBe(true);
      for (let i = 1; i < widths.length; i += 1) {
        expect(widths[i]).toBeGreaterThan(widths[i - 1]!);
      }
    });

    it("hides every bar from assistive tech, leaving the pill's accessible name as its visible label alone", () => {
      render(<CutRangeSelector selected="1D" onSelect={() => {}} />);

      for (const bar of screen.getAllByTestId("range-duration-bar")) {
        expect(bar).toHaveAttribute("aria-hidden", "true");
        expect(bar).toHaveTextContent("");
      }
    });
  });
});
