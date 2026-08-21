import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PRESET_RANGES } from "@hadiknowntrades/core";
import { describe, expect, it, vi } from "vitest";

import { RangeSelector } from "./RangeSelector";

describe("RangeSelector", () => {
  it("renders a button for every preset range", () => {
    render(<RangeSelector selected="1Y" onSelect={() => {}} />);

    for (const range of PRESET_RANGES) {
      expect(
        screen.getByRole("button", { name: range === "MAX" ? "Max" : range }),
      ).toBeInTheDocument();
    }
  });

  it("marks only the selected range as pressed", () => {
    render(<RangeSelector selected="5Y" onSelect={() => {}} />);

    expect(screen.getByRole("button", { name: "5Y" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "1Y" })).toHaveAttribute("aria-pressed", "false");
  });

  it("calls onSelect with the clicked range", async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(<RangeSelector selected="1Y" onSelect={onSelect} />);

    await user.click(screen.getByRole("button", { name: "Max" }));

    expect(onSelect).toHaveBeenCalledWith("MAX");
  });
});
