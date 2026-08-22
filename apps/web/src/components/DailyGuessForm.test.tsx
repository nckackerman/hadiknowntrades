import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { DailyGuessForm } from "./DailyGuessForm";

describe("DailyGuessForm", () => {
  it("prompts with the day and starting capital", () => {
    render(<DailyGuessForm date="2026-08-20" startingCapital={20} onSubmit={vi.fn()} />);

    expect(screen.getByText(/Aug 20, 2026/)).toBeInTheDocument();
    expect(screen.getByText(/\$20\.00/)).toBeInTheDocument();
  });

  it("disables submit until a valid guess is entered", async () => {
    const user = userEvent.setup();
    render(<DailyGuessForm date="2026-08-20" startingCapital={20} onSubmit={vi.fn()} />);

    const submit = screen.getByRole("button", { name: /reveal/i });
    expect(submit).toBeDisabled();

    await user.type(screen.getByLabelText(/what do you think/i), "50");

    expect(submit).toBeEnabled();
  });

  it("calls onSubmit with the parsed numeric guess", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<DailyGuessForm date="2026-08-20" startingCapital={20} onSubmit={onSubmit} />);

    await user.type(screen.getByLabelText(/what do you think/i), "123.45");
    await user.click(screen.getByRole("button", { name: /reveal/i }));

    expect(onSubmit).toHaveBeenCalledWith(123.45);
  });

  it("accepts a guess of exactly 0 (e.g. 'it went to zero')", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<DailyGuessForm date="2026-08-20" startingCapital={20} onSubmit={onSubmit} />);

    await user.type(screen.getByLabelText(/what do you think/i), "0");
    const submit = screen.getByRole("button", { name: /reveal/i });

    expect(submit).toBeEnabled();
    await user.click(submit);

    expect(onSubmit).toHaveBeenCalledWith(0);
  });

  it("rejects a negative guess", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<DailyGuessForm date="2026-08-20" startingCapital={20} onSubmit={onSubmit} />);

    await user.type(screen.getByLabelText(/what do you think/i), "-5");

    expect(screen.getByRole("button", { name: /reveal/i })).toBeDisabled();
  });
});
