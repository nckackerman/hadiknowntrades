import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { WholeRangeBalance } from "./WholeRangeBalance";

describe("WholeRangeBalance", () => {
  describe("unrevealed (guess === null)", () => {
    it("prompts with the range label and starting capital, not the answer", () => {
      render(
        <WholeRangeBalance
          rangeLabel="the past month"
          startingCapital={20}
          finalBalance={999999}
          guess={null}
          guessStartingCapital={null}
          onSubmitGuess={vi.fn()}
        />,
      );

      expect(screen.getByText(/the past month/)).toBeInTheDocument();
      expect(screen.getByText(/\$20\.00/)).toBeInTheDocument();
      expect(screen.queryByText(/999,999|999999/)).not.toBeInTheDocument();
    });

    it("disables submit until a valid guess is entered", async () => {
      const user = userEvent.setup();
      render(
        <WholeRangeBalance
          rangeLabel="the past month"
          startingCapital={20}
          finalBalance={100}
          guess={null}
          guessStartingCapital={null}
          onSubmitGuess={vi.fn()}
        />,
      );

      const submit = screen.getByRole("button", { name: /reveal/i });
      expect(submit).toBeDisabled();

      await user.type(screen.getByLabelText(/what do you think it became/i), "50");

      expect(submit).toBeEnabled();
    });

    it("calls onSubmitGuess with the parsed guess and the current starting capital", async () => {
      const user = userEvent.setup();
      const onSubmitGuess = vi.fn();
      render(
        <WholeRangeBalance
          rangeLabel="the past month"
          startingCapital={20}
          finalBalance={100}
          guess={null}
          guessStartingCapital={null}
          onSubmitGuess={onSubmitGuess}
        />,
      );

      await user.type(screen.getByLabelText(/what do you think it became/i), "123.45");
      await user.click(screen.getByRole("button", { name: /reveal/i }));

      expect(onSubmitGuess).toHaveBeenCalledWith(123.45, 20);
    });

    it("accepts a guess of exactly 0 (e.g. 'it went to zero')", async () => {
      const user = userEvent.setup();
      const onSubmitGuess = vi.fn();
      render(
        <WholeRangeBalance
          rangeLabel="the past month"
          startingCapital={20}
          finalBalance={100}
          guess={null}
          guessStartingCapital={null}
          onSubmitGuess={onSubmitGuess}
        />,
      );

      await user.type(screen.getByLabelText(/what do you think it became/i), "0");
      const submit = screen.getByRole("button", { name: /reveal/i });
      expect(submit).toBeEnabled();
      await user.click(submit);

      expect(onSubmitGuess).toHaveBeenCalledWith(0, 20);
    });

    it("rejects a negative guess", async () => {
      const user = userEvent.setup();
      render(
        <WholeRangeBalance
          rangeLabel="the past month"
          startingCapital={20}
          finalBalance={100}
          guess={null}
          guessStartingCapital={null}
          onSubmitGuess={vi.fn()}
        />,
      );

      await user.type(screen.getByLabelText(/what do you think it became/i), "-5");

      expect(screen.getByRole("button", { name: /reveal/i })).toBeDisabled();
    });
  });

  describe("revealed (guess !== null)", () => {
    it("shows the real start -> end figures, not a guess form", () => {
      render(
        <WholeRangeBalance
          rangeLabel="the past month"
          startingCapital={20}
          finalBalance={32.8}
          guess={40}
          guessStartingCapital={20}
          onSubmitGuess={vi.fn()}
        />,
      );

      expect(screen.getByText("$20.00")).toBeInTheDocument();
      expect(screen.getByText("$32.80")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /reveal/i })).not.toBeInTheDocument();
    });

    it("shows what the user guessed", () => {
      render(
        <WholeRangeBalance
          rangeLabel="the past month"
          startingCapital={20}
          finalBalance={32.8}
          guess={40}
          guessStartingCapital={20}
          onSubmitGuess={vi.fn()}
        />,
      );

      expect(screen.getByText(/you guessed/i)).toHaveTextContent("$40.00");
    });

    it("rescales the displayed guess if starting capital changed since the guess was made (issue #15)", () => {
      render(
        <WholeRangeBalance
          rangeLabel="the past month"
          startingCapital={40} // doubled since the guess was made
          finalBalance={65.6}
          guess={40}
          guessStartingCapital={20}
          onSubmitGuess={vi.fn()}
        />,
      );

      expect(screen.getByText(/you guessed/i)).toHaveTextContent("$80.00");
    });

    it("announces the reveal to screen readers via the live region", () => {
      render(
        <WholeRangeBalance
          rangeLabel="the past month"
          startingCapital={20}
          finalBalance={32.8}
          guess={40}
          guessStartingCapital={20}
          onSubmitGuess={vi.fn()}
        />,
      );

      expect(screen.getByRole("status", { name: "Whole-range reveal status" })).toHaveTextContent(
        /revealed.*\$20\.00 to \$32\.80/,
      );
    });
  });
});
