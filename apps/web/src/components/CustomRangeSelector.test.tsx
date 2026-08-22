import { CUSTOM_RANGE_ANCHOR_YEARS_BACK, customRangeAnchors } from "@hadiknowntrades/core";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { CustomRangeSelector } from "./CustomRangeSelector";

describe("CustomRangeSelector", () => {
  it("renders a disabled placeholder option plus every available anchor", () => {
    render(<CustomRangeSelector selected={null} onSelect={() => {}} />);

    const options = screen.getAllByRole("option") as HTMLOptionElement[];
    expect(options).toHaveLength(CUSTOM_RANGE_ANCHOR_YEARS_BACK * 12 + 1);
    expect(options[0]).toBeDisabled();
    expect(options[0]!.value).toBe("");
  });

  it("shows no selection (the placeholder) when selected is null", () => {
    render(<CustomRangeSelector selected={null} onSelect={() => {}} />);

    expect(screen.getByRole("combobox")).toHaveValue("");
  });

  it("selects the matching option when selected is a real anchor", () => {
    const anchor = customRangeAnchors(new Date())[0]!;
    render(<CustomRangeSelector selected={anchor} onSelect={() => {}} />);

    expect(screen.getByRole("combobox")).toHaveValue(anchor);
  });

  it("calls onSelect with the chosen anchor", async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    const anchor = customRangeAnchors(new Date())[3]!;
    render(<CustomRangeSelector selected={null} onSelect={onSelect} />);

    await user.selectOptions(screen.getByRole("combobox"), anchor);

    expect(onSelect).toHaveBeenCalledWith(anchor);
  });

  it("formats each option's label as a full month + year", () => {
    render(<CustomRangeSelector selected={null} onSelect={() => {}} />);

    const anchor = customRangeAnchors(new Date())[0]!;
    const [year, month] = anchor.split("-").map(Number);
    const expectedLabel = new Date(Date.UTC(year!, month! - 1, 1)).toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      timeZone: "UTC",
    });

    expect(screen.getByRole("option", { name: expectedLabel })).toBeInTheDocument();
  });
});
