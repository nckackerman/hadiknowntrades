import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { DailyGuessForm } from "./DailyGuessForm";

describe("DailyGuessForm", () => {
  it("prompts with the day and starting capital", () => {
    render(
      <DailyGuessForm
        date="2026-08-20"
        startingCapital={20}
        previousDate={null}
        onSubmit={vi.fn()}
      />,
    );

    expect(screen.getByText(/Aug 20, 2026/)).toBeInTheDocument();
    expect(screen.getByText(/\$20\.00/)).toBeInTheDocument();
  });

  it("omits the 'carried over' clause for a range's own first day (previousDate: null)", () => {
    render(
      <DailyGuessForm
        date="2026-08-20"
        startingCapital={20}
        previousDate={null}
        onSubmit={vi.fn()}
      />,
    );

    expect(screen.queryByText(/carried over/i)).not.toBeInTheDocument();
  });

  it("adds an honest, non-numeric 'carried over' clause when a previous day exists (issue #84) -- names the previous day's date, leaks no dollar amount", () => {
    render(
      <DailyGuessForm
        date="2026-08-20"
        startingCapital={20}
        previousDate="2026-08-19"
        onSubmit={vi.fn()}
      />,
    );

    const clause = screen.getByText(/carried over from/i);
    expect(clause).toHaveTextContent(/Aug 19, 2026/);
    // The clause itself carries no dollar figure -- only the date.
    expect(clause).not.toHaveTextContent(/\$/);
  });

  it("disables submit until a valid guess is entered", async () => {
    const user = userEvent.setup();
    render(
      <DailyGuessForm
        date="2026-08-20"
        startingCapital={20}
        previousDate={null}
        onSubmit={vi.fn()}
      />,
    );

    const submit = screen.getByRole("button", { name: /reveal/i });
    expect(submit).toBeDisabled();

    await user.type(screen.getByLabelText(/what do you think/i), "50");

    expect(submit).toBeEnabled();
  });

  it("calls onSubmit with the parsed numeric guess", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <DailyGuessForm
        date="2026-08-20"
        startingCapital={20}
        previousDate={null}
        onSubmit={onSubmit}
      />,
    );

    await user.type(screen.getByLabelText(/what do you think/i), "123.45");
    await user.click(screen.getByRole("button", { name: /reveal/i }));

    expect(onSubmit).toHaveBeenCalledWith(123.45);
  });

  it("accepts a guess of exactly 0 (e.g. 'it went to zero')", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <DailyGuessForm
        date="2026-08-20"
        startingCapital={20}
        previousDate={null}
        onSubmit={onSubmit}
      />,
    );

    await user.type(screen.getByLabelText(/what do you think/i), "0");
    const submit = screen.getByRole("button", { name: /reveal/i });

    expect(submit).toBeEnabled();
    await user.click(submit);

    expect(onSubmit).toHaveBeenCalledWith(0);
  });

  it("rejects a negative guess", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <DailyGuessForm
        date="2026-08-20"
        startingCapital={20}
        previousDate={null}
        onSubmit={onSubmit}
      />,
    );

    await user.type(screen.getByLabelText(/what do you think/i), "-5");

    expect(screen.getByRole("button", { name: /reveal/i })).toBeDisabled();
  });
});
