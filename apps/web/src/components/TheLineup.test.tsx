import { RESULTS_SCHEMA_VERSION } from "@hadiknowntrades/core";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getLineupPlayedResult, saveLineupPlayedResult } from "@/lib/lineup-storage";
import { LINEUP_MAX_ATTEMPTS } from "@/lib/lineup-game";

import { TheLineup } from "./TheLineup";

// Real, mixed-length (3/4/3/4/3) S&P 500 tickers -- the mock's own sample
// day, reused here since it exercises the hidden-length mechanic
// directly and every one of these is a genuine LINEUP_TICKER_POOL member
// (no mocking of that pool needed).
const ANSWERS = ["IBM", "TSLA", "DIS", "MSFT", "CAT"];
const LINEUP = {
  schemaVersion: RESULTS_SCHEMA_VERSION,
  generatedAt: "2026-08-27T00:52:58.157Z",
  date: "2026-08-26",
  tickers: ANSWERS,
};

function stubLineupFetch(body: unknown = LINEUP, status = 200): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(new Response(JSON.stringify(body), { status }))),
  );
}

async function renderAndExpand(): Promise<void> {
  render(<TheLineup />);
  await waitFor(() => {
    expect(screen.getByTestId("the-lineup-summary")).toBeInTheDocument();
  });
  fireEvent.click(screen.getByTestId("the-lineup-summary"));
}

function columnInput(index: number): HTMLInputElement {
  return screen.getByRole("textbox", { name: `Column ${index + 1} guess` }) as HTMLInputElement;
}

function submit(): void {
  fireEvent.click(screen.getByRole("button", { name: "Submit guess" }));
}

async function typeGuesses(guesses: readonly string[]): Promise<void> {
  guesses.forEach((guess, i) => {
    const input = columnInput(i);
    if (input.disabled) return;
    fireEvent.change(input, { target: { value: guess } });
  });
}

beforeEach(() => {
  localStorage.clear();
  stubLineupFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("TheLineup: compact card", () => {
  it("renders an inert placeholder before the fetch resolves", () => {
    const { container } = render(<TheLineup />);
    expect(screen.queryByText("Not played yet today")).not.toBeInTheDocument();
    expect(container.querySelector('[aria-hidden="true"]')).toBeInTheDocument();
  });

  it("shows 'Not played yet today' once loaded, unplayed", async () => {
    render(<TheLineup />);
    await waitFor(() => expect(screen.getByText("Not played yet today")).toBeInTheDocument());
  });

  it("is closed by default", async () => {
    render(<TheLineup />);
    await waitFor(() => screen.getByTestId("the-lineup-summary"));
    const details = screen.getByTestId("the-lineup-summary").closest("details");
    expect(details).not.toHaveAttribute("open");
  });
});

describe("TheLineup: a genuine fetch failure renders a distinguishable error state, not an eternal placeholder", () => {
  it("renders LineupErrorState (not the aria-hidden placeholder) on a real HTTP error", async () => {
    stubLineupFetch({ error: "not_found", message: "no lineup yet" }, 502);
    render(<TheLineup />);

    await waitFor(() => expect(screen.getByTestId("the-lineup-error")).toBeInTheDocument());
    // Not the same, aria-hidden, indefinitely-pending shell a genuinely
    // in-flight fetch shows -- it must never render alongside the error.
    expect(screen.queryByTestId("the-lineup-summary")).not.toBeInTheDocument();
    const errorState = screen.getByTestId("the-lineup-error");
    expect(errorState).not.toHaveAttribute("aria-hidden");
    expect(errorState).toHaveTextContent("Couldn't load today's lineup.");
  });

  it("renders LineupErrorState (and logs a console.error) on a 200 whose tickers field is the wrong length", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    stubLineupFetch({ ...LINEUP, tickers: ["IBM", "TSLA", "DIS"] }); // 3, not LINEUP_COLUMNS (5)
    render(<TheLineup />);

    await waitFor(() => expect(screen.getByTestId("the-lineup-error")).toBeInTheDocument());
    expect(screen.queryByTestId("the-lineup-summary")).not.toBeInTheDocument();
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("malformed tickers field"));
    consoleError.mockRestore();
  });
});

describe("TheLineup: playing a fresh board", () => {
  it("expanding reveals the 5x4 mystery grid, explainer, and legend", async () => {
    await renderAndExpand();

    expect(screen.getByText(/each column hides a real ticker/i)).toBeInTheDocument();
    // 5 columns x 4 rows = 20 mystery tiles, each showing "?"
    expect(screen.getAllByText("?")).toHaveLength(20);
    expect(screen.getByText("Right ticker, right spot")).toBeInTheDocument();
    expect(screen.getByText("Not in today's lineup")).toBeInTheDocument();
  });

  it("rejects an invalid guess (not a real ticker) without advancing the attempt count", async () => {
    await renderAndExpand();
    await typeGuesses(["ZZZ", "TSLA", "DIS", "MSFT", "CAT"]);

    submit();

    await waitFor(() => {
      expect(screen.getByText(/Attempt/).textContent).toContain("1");
    });
  });

  it("classifies a valid wrong guess and deducts an attempt", async () => {
    await renderAndExpand();
    // AMZN is a real 4-letter ticker, guessed against IBM's own 3-letter column.
    await typeGuesses(["AMZN", "TSLA", "DIS", "MSFT", "CAT"]);
    submit();

    await waitFor(() => {
      // 4 of 5 columns locked this round -- column 0 stays open.
      expect(columnInput(0)).not.toBeDisabled();
      expect(columnInput(1)).toBeDisabled();
    });
  });

  it("wins the instant every column's guess is exactly correct", async () => {
    await renderAndExpand();
    await typeGuesses(ANSWERS);
    submit();

    await waitFor(() => {
      expect(screen.getAllByText(/Solved all 5 in 1 of 7 rounds\./).length).toBeGreaterThan(0);
    });
    // The form itself is gone once done, not merely disabled -- see
    // TheLineup.tsx's own header comment on why a finished game (live or
    // reconstructed) drops the form entirely.
    expect(screen.queryByRole("button", { name: "Submit guess" })).not.toBeInTheDocument();
    expect(screen.getAllByText("I")[0]).toBeInTheDocument(); // IBM's own real letters, now shown

    const stored = getLineupPlayedResult("2026-08-26");
    expect(stored?.outcome).toBe("won");
    expect(stored?.guessesUsed).toBe(1);
    expect(stored?.lockedColumns).toEqual([true, true, true, true, true]);
  });

  it("loses when the budget runs out, revealing every unsolved column", async () => {
    await renderAndExpand();

    for (let round = 1; round <= LINEUP_MAX_ATTEMPTS; round++) {
      await typeGuesses(["AMZN", "AAPL", "AAPL", "AAPL", "AAPL"]);
      submit();
    }

    await waitFor(() => {
      expect(screen.getAllByText(/Out of guesses - 0 of 5 solved\./).length).toBeGreaterThan(0);
    });

    const stored = getLineupPlayedResult("2026-08-26");
    expect(stored?.outcome).toBe("lost");
    expect(stored?.columnsSolved).toBe(0);
    expect(stored?.guessesUsed).toBe(LINEUP_MAX_ATTEMPTS);
  });

  it("shows today's own just-finished win in the streak stats immediately, not just after a reload", async () => {
    // A 1-day streak already exists from yesterday -- today's win should
    // extend it to 2 *live*, not merely once storage is later re-read
    // (loaded.streak is set once at mount, before today's outcome is
    // decided -- a stale value here would still show "1" after a win
    // that just extended the streak to 2).
    saveLineupPlayedResult({
      date: "2026-08-25",
      outcome: "won",
      guessesUsed: 3,
      columnsSolved: 5,
      tilesFilled: 17,
      totalTiles: 17,
      lockedColumns: [true, true, true, true, true],
    });

    await renderAndExpand();
    await typeGuesses(ANSWERS);
    submit();

    await waitFor(() => {
      expect(screen.getAllByText(/Solved all 5 in 1 of 7 rounds\./).length).toBeGreaterThan(0);
    });
    // Two spans render "2" (current + best streak, both 2 after this win) --
    // asserting via the labeled stat blocks, not a bare text match.
    const currentStreakLabel = screen.getByText("Current streak");
    expect(currentStreakLabel.previousElementSibling?.textContent).toBe("2");
    const bestStreakLabel = screen.getByText("Best streak");
    expect(bestStreakLabel.previousElementSibling?.textContent).toBe("2");
  });

  it("shows today's own just-finished loss breaking the streak to 0 immediately, not just after a reload", async () => {
    // A real streak exists from the last two days -- today's loss should
    // reset the *live* current-streak stat to 0 right away, not keep
    // showing "2" (the stale pre-game value) on the very screen that's
    // simultaneously telling the player they just ran out of guesses.
    saveLineupPlayedResult({
      date: "2026-08-24",
      outcome: "won",
      guessesUsed: 3,
      columnsSolved: 5,
      tilesFilled: 17,
      totalTiles: 17,
      lockedColumns: [true, true, true, true, true],
    });
    saveLineupPlayedResult({
      date: "2026-08-25",
      outcome: "won",
      guessesUsed: 3,
      columnsSolved: 5,
      tilesFilled: 17,
      totalTiles: 17,
      lockedColumns: [true, true, true, true, true],
    });

    await renderAndExpand();
    for (let round = 1; round <= LINEUP_MAX_ATTEMPTS; round++) {
      await typeGuesses(["AMZN", "AAPL", "AAPL", "AAPL", "AAPL"]);
      submit();
    }

    await waitFor(() => {
      expect(screen.getAllByText(/Out of guesses - 0 of 5 solved\./).length).toBeGreaterThan(0);
    });
    const currentStreakLabel = screen.getByText("Current streak");
    expect(currentStreakLabel.previousElementSibling?.textContent).toBe("0");
    // Best streak (the historical max) is untouched by today's loss.
    const bestStreakLabel = screen.getByText("Best streak");
    expect(bestStreakLabel.previousElementSibling?.textContent).toBe("2");
  });

  it("shows a live 'letters tried' tracker and updates it after a round", async () => {
    await renderAndExpand();
    await typeGuesses(["AMZN", "TSLA", "DIS", "MSFT", "CAT"]);
    submit();

    await waitFor(() => {
      expect(screen.getByRole("img", { name: /Letter T, best result so far/ })).toBeInTheDocument();
    });
  });

  it("every tile carries a real sr-only description, not color alone (WCAG 1.4.1)", async () => {
    await renderAndExpand();
    const grid = screen.getAllByText("?")[0]!.closest("div")!.parentElement!;
    expect(within(grid).getByText(/Column 1, slot 1: not yet guessed\./)).toBeInTheDocument();
  });
});

describe("TheLineup: per-column past-guess history", () => {
  it("shows nothing before a first round is submitted", async () => {
    await renderAndExpand();
    expect(screen.queryByLabelText(/Column 1 past guesses/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Past guesses appear below each column/)).not.toBeInTheDocument();
  });

  it("shows a past guess, letter by letter, still colored by its own real classification -- the user's own worked example", async () => {
    await renderAndExpand();
    // QCOM (a real 4-letter ticker) against TSLA (column 1): every letter
    // is genuinely absent (see lineup-game.test.ts's own
    // columnGuessHistory tests for why). The other 4 columns are guessed
    // correctly (locking immediately) -- only their own real tickers, not
    // "ZZZ", are legal guesses at all.
    await typeGuesses(["IBM", "QCOM", "DIS", "MSFT", "CAT"]);
    submit();

    await waitFor(() => {
      expect(screen.getByLabelText("Column 2 past guesses")).toBeInTheDocument();
    });
    const history = screen.getByLabelText("Column 2 past guesses");
    // Every one of QCOM's own letters shows up, each with its own
    // sr-only "not in today's lineup" verdict -- not just a bare count.
    for (const letter of ["Q", "C", "O", "M"]) {
      expect(within(history).getAllByText(letter).length).toBeGreaterThan(0);
    }
    expect(
      within(history).getByText(/Attempt 1, column 2, letter 1: letter Q, not in today's lineup\./),
    ).toBeInTheDocument();
  });

  it("keeps a solved column's own past wrong guesses visible after it locks", async () => {
    await renderAndExpand();
    // Round 1: a wrong guess for column 0 (IBM).
    await typeGuesses(["AMZN", "TSLA", "DIS", "MSFT", "CAT"]);
    submit();
    await waitFor(() => expect(columnInput(1)).toBeDisabled());

    // Round 2: solve column 0 for real.
    await typeGuesses(["IBM", "IBM", "IBM", "IBM", "IBM"]);
    submit();

    await waitFor(() => {
      const history = screen.getByLabelText("Column 1 past guesses");
      // Both the earlier wrong guess and the solving guess are retained.
      expect(within(history).getByText("A")).toBeInTheDocument(); // AMZN's own first letter
    });
  });

  it("stops accumulating a column's own history once it locks -- no repeated echoed-answer rows", async () => {
    await renderAndExpand();
    // Round 1: solve column 0; leave the rest open.
    await typeGuesses(["IBM", "AAPL", "AAPL", "AAPL", "AAPL"]);
    submit();
    await waitFor(() => expect(columnInput(0)).toBeDisabled());

    // Round 2: column 0 is locked -- its own history shouldn't grow.
    await typeGuesses(["QQQ", "AAPL", "AAPL", "AAPL", "AAPL"]);
    submit();

    await waitFor(() => {
      const history = screen.getByLabelText("Column 1 past guesses");
      expect(within(history).getAllByRole("listitem")).toHaveLength(1);
    });
  });

  it("labels each past round with its own always-visible attempt number, most-recent row first (readability redesign)", async () => {
    await renderAndExpand();
    // Two rounds, column 1 (IBM) left unsolved both times so its own
    // history strip accumulates two rows to check ordering/labeling on.
    await typeGuesses(["AMZN", "TSLA", "DIS", "MSFT", "CAT"]);
    submit();
    await waitFor(() => expect(columnInput(1)).toBeDisabled());
    await typeGuesses(["DIS", "TSLA", "DIS", "MSFT", "CAT"]);
    submit();

    await waitFor(() => {
      expect(screen.getByLabelText("Column 1 past guesses")).toBeInTheDocument();
    });
    const history = screen.getByLabelText("Column 1 past guesses");
    const rows = within(history).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    // Most-recent-first: round 2's own row comes before round 1's.
    expect(rows[0]!.textContent).toMatch(/^2/);
    expect(rows[1]!.textContent).toMatch(/^1/);
    // The visible label is a sighted-only convenience -- the sr-only
    // per-tile text still carries the same attempt number for assistive
    // tech, so this doesn't introduce a second, differently-worded
    // announcement.
    expect(within(rows[0]!).getByText(/Attempt 2, column 1, letter 1:/)).toBeInTheDocument();
  });

  it("does not render any per-column history on the reconstructed cold-reload view (no persisted log to replay)", async () => {
    saveLineupPlayedResult({
      date: "2026-08-26",
      outcome: "won",
      guessesUsed: 3,
      columnsSolved: 5,
      tilesFilled: 17,
      totalTiles: 17,
      lockedColumns: [true, true, true, true, true],
    });

    await renderAndExpand();
    await waitFor(() => {
      expect(screen.getAllByText(/Solved all 5 in 3 of 7 rounds\./).length).toBeGreaterThan(0);
    });
    expect(screen.queryByLabelText(/Column 1 past guesses/)).not.toBeInTheDocument();
  });
});

describe("TheLineup: return visit (already played today)", () => {
  it("reconstructs the finished grid from storage without a form, keyboard tracker, or log", async () => {
    saveLineupPlayedResult({
      date: "2026-08-26",
      outcome: "won",
      guessesUsed: 3,
      columnsSolved: 5,
      tilesFilled: 17,
      totalTiles: 17,
      lockedColumns: [true, true, true, true, true],
    });

    await renderAndExpand();

    await waitFor(() => {
      expect(screen.getAllByText(/Solved all 5 in 3 of 7 rounds\./).length).toBeGreaterThan(0);
    });
    expect(screen.queryByRole("button", { name: "Submit guess" })).not.toBeInTheDocument();
    expect(screen.queryByText(/Letters tried/)).not.toBeInTheDocument();
    // The real answers are shown, since the day is over -- IBM's own real letters, for example.
    expect(screen.getAllByText("I").length).toBeGreaterThan(0);
  });

  it("shows the correct compact-card status line for a partial loss", async () => {
    saveLineupPlayedResult({
      date: "2026-08-26",
      outcome: "lost",
      guessesUsed: 7,
      columnsSolved: 2,
      tilesFilled: 7,
      totalTiles: 17,
      lockedColumns: [true, false, true, false, false],
    });

    render(<TheLineup />);
    await waitFor(() => {
      expect(screen.getByText("2 of 5 solved")).toBeInTheDocument();
    });
  });

  it("shows a gold streak chip once a real streak exists", async () => {
    saveLineupPlayedResult({
      date: "2026-08-24",
      outcome: "won",
      guessesUsed: 4,
      columnsSolved: 5,
      tilesFilled: 17,
      totalTiles: 17,
      lockedColumns: [true, true, true, true, true],
    });
    saveLineupPlayedResult({
      date: "2026-08-25",
      outcome: "won",
      guessesUsed: 4,
      columnsSolved: 5,
      tilesFilled: 17,
      totalTiles: 17,
      lockedColumns: [true, true, true, true, true],
    });

    render(<TheLineup />);
    await waitFor(() => {
      expect(screen.getByLabelText("Current streak: 2")).toBeInTheDocument();
    });
  });
});
