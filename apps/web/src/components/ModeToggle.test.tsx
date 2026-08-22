import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ModeToggle } from "./ModeToggle";

describe("ModeToggle", () => {
  it("renders a button for both modes", () => {
    render(<ModeToggle selected="long" onSelect={() => {}} />);

    expect(screen.getByRole("button", { name: "Long only" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Long + short" })).toBeInTheDocument();
  });

  it("marks only the selected mode as pressed", () => {
    render(<ModeToggle selected="long-short" onSelect={() => {}} />);

    expect(screen.getByRole("button", { name: "Long + short" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "Long only" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("calls onSelect with the clicked mode", async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(<ModeToggle selected="long" onSelect={onSelect} />);

    await user.click(screen.getByRole("button", { name: "Long + short" }));

    expect(onSelect).toHaveBeenCalledWith("long-short");
  });
});
