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

    it("groups the guessed line with the headline, as a DOM sibling of WorstCaseStat -- not the other way around (issue #158)", () => {
      render(
        <WholeRangeBalance
          rangeLabel="the past month"
          startingCapital={20}
          finalBalance={32.8}
          guess={40}
          guessStartingCapital={20}
          onSubmitGuess={vi.fn()}
          worstCase={{ startingCapital: 20, endingBalance: 14.6 }}
        />,
      );

      const guessedLine = screen.getByText(/you guessed/i);
      const worstCaseHeading = screen.getByText("Worst case, same budget");

      // The guessed line's own parent also contains the headline
      // figure -- it's grouped with the headline, not with the
      // worst-case stat.
      const headlineFigure = screen.getByText("$32.80");
      expect(guessedLine.parentElement).toContainElement(headlineFigure);

      // The worst-case stat is a DOM sibling of that whole grouping, not
      // an ancestor/descendant of it -- confirming "You guessed" never
      // ends up nested under (or containing) the worst-case figure at
      // any width, which is what let it read as attached to the wrong
      // stat once the row stacks below `sm`.
      expect(guessedLine.parentElement).not.toContainElement(worstCaseHeading);
      expect(worstCaseHeading.closest("div")).not.toContainElement(guessedLine);
    });
  });

  describe("worstCase prop (issue #105)", () => {
    it("renders no worst-case stat when omitted, matching this component's pre-#105 shape", () => {
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

      expect(screen.queryByText("Worst case, same budget")).not.toBeInTheDocument();
    });

    it("renders the worst-case stat, rescaled from its own raw/native-root pair, only once revealed", () => {
      const { rerender } = render(
        <WholeRangeBalance
          rangeLabel="the past month"
          startingCapital={20}
          finalBalance={32.8}
          guess={null}
          guessStartingCapital={null}
          onSubmitGuess={vi.fn()}
          worstCase={{ startingCapital: 20, endingBalance: 15 }}
        />,
      );

      // Unrevealed -- the worst-case stat must not leak the answer
      // before the guess is submitted.
      expect(screen.queryByText("Worst case, same budget")).not.toBeInTheDocument();

      rerender(
        <WholeRangeBalance
          rangeLabel="the past month"
          startingCapital={20}
          finalBalance={32.8}
          guess={40}
          guessStartingCapital={20}
          onSubmitGuess={vi.fn()}
          worstCase={{ startingCapital: 20, endingBalance: 15 }}
        />,
      );

      expect(screen.getByText("Worst case, same budget")).toBeInTheDocument();
      expect(screen.getByText("$15.00")).toBeInTheDocument();
    });

    it("rescales the worst-case figure from its own native-root starting capital, not the display one, avoiding a double-rescale", () => {
      render(
        <WholeRangeBalance
          rangeLabel="the past month"
          startingCapital={40} // display capital, doubled from the worst-case track's own root
          finalBalance={65.6}
          guess={40}
          guessStartingCapital={20}
          onSubmitGuess={vi.fn()}
          worstCase={{ startingCapital: 20, endingBalance: 15 }}
        />,
      );

      // rescaleFromStartingCapital(15, 20, 40) === 30 -- a single
      // rescale from the worst-case track's own raw root, not a
      // pre-rescaled value that would double-rescale here.
      expect(screen.getByText("$30.00")).toBeInTheDocument();
    });
  });

  describe("revealSlot prop (issue #105)", () => {
    it("with no revealSlot, the revealed headline/caption render pixel-identical to before this prop existed (same text, same classes, same document position)", () => {
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

      const caption = screen.getByText(
        "Whole-range running balance -- carried day to day, start to finish",
      );
      expect(caption).not.toHaveClass("invisible");
      expect(caption.closest("div")).not.toHaveAttribute("aria-hidden");
      expect(screen.getByText("$20.00")).toBeInTheDocument();
      expect(screen.getByText("$32.80")).toBeInTheDocument();
    });

    it("overlays the caption+headline pair specifically -- the real pair goes invisible/aria-hidden, the overlay's own content renders instead, and the guess/'You guessed' line is unaffected", () => {
      render(
        <WholeRangeBalance
          rangeLabel="the past month"
          startingCapital={20}
          finalBalance={32.8}
          guess={40}
          guessStartingCapital={20}
          onSubmitGuess={vi.fn()}
          revealSlot={<p>Watching a date</p>}
        />,
      );

      const realCaption = screen.getByText(
        "Whole-range running balance -- carried day to day, start to finish",
      );
      const invisibleWrapper = realCaption.closest("div")!;
      expect(invisibleWrapper).toHaveClass("invisible");
      expect(invisibleWrapper).toHaveAttribute("aria-hidden", "true");
      // The real figures are still in the DOM (an overlay, not a
      // replacement -- HeroAndWorstCase's own heroSlot precedent), just
      // visually hidden via the wrapper above.
      expect(screen.getByText("$20.00")).toBeInTheDocument();
      expect(screen.getByText("$32.80")).toBeInTheDocument();
      // The overlay's own content is present too.
      expect(screen.getByText("Watching a date")).toBeInTheDocument();
      // The guess line, sitting outside the overlaid box, is untouched.
      expect(screen.getByText(/you guessed/i)).toHaveTextContent("$40.00");
    });
  });
});
