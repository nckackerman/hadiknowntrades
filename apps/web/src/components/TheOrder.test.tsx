import { RESULTS_SCHEMA_VERSION, type TheOrderPuzzle } from "@hadiknowntrades/core";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { bestToWorstTickers } from "@/lib/order-scoring";
import { getOrderStreakHistory, saveOrderDayState, type OrderDayState } from "@/lib/order-storage";
import { TheOrder } from "./TheOrder";

const DATE = "2026-08-26";

// Worst-to-best, exactly as the server always emits it.
const PUZZLE: TheOrderPuzzle = {
  schemaVersion: RESULTS_SCHEMA_VERSION,
  generatedAt: "2026-08-27T06:00:00.000Z",
  date: DATE,
  tickers: [
    { ticker: "TSLA", companyName: "Tesla, Inc.", pctReturn: -3.1 },
    { ticker: "AAPL", companyName: "Apple Inc.", pctReturn: -0.42 },
    { ticker: "MSFT", companyName: "Microsoft", pctReturn: 0.55 },
    { ticker: "META", companyName: "Meta Platforms", pctReturn: 1.85 },
    { ticker: "NVDA", companyName: "Nvidia", pctReturn: 3.2 },
  ],
};

// Best-to-worst -- what the game actually shows/grades against
// (NVDA the best mover, at the top; TSLA the worst, at the bottom).
const ANSWER = bestToWorstTickers(PUZZLE.tickers).map((t) => t.ticker);

function stubPuzzleFetch(puzzle: TheOrderPuzzle | null = PUZZLE): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      puzzle === null
        ? new Promise(() => {}) // never resolves
        : Promise.resolve(new Response(JSON.stringify(puzzle), { status: 200 })),
    ),
  );
}

function freshState(overrides: Partial<OrderDayState> = {}): OrderDayState {
  return {
    guess: [...ANSWER],
    feedback: null,
    attempts: 0,
    done: false,
    won: false,
    ...overrides,
  };
}

async function expandBoard() {
  render(<TheOrder />);
  const summary = await screen.findByTestId("the-order-summary");
  fireEvent.click(summary);
  return within(await screen.findByTestId("the-order-panel"));
}

afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

beforeEach(() => {
  stubPuzzleFetch();
});

describe("TheOrder", () => {
  it("renders the collapsed tile before the puzzle fetch resolves, with no crash", () => {
    stubPuzzleFetch(null); // never resolves
    render(<TheOrder />);
    expect(screen.getByRole("heading", { name: "The Order", level: 2 })).toBeInTheDocument();
    // Still just the pending placeholder -- no error message yet, and it's
    // aria-hidden (there's nothing here for assistive tech to read while
    // genuinely pending).
    expect(screen.queryByTestId("the-order-error")).not.toBeInTheDocument();
  });

  it("renders a distinguishable, visible error state for a genuine fetch failure -- not the same aria-hidden placeholder a pending fetch shows", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response("Internal Server Error", { status: 500 }))),
    );
    render(<TheOrder />);

    const errorState = await screen.findByTestId("the-order-error");
    expect(errorState).not.toHaveAttribute("aria-hidden");
    expect(screen.getByText(/couldn't load today's puzzle/i)).toBeInTheDocument();
    // Only one top-level tile-shaped element renders -- the pending
    // placeholder and the error state are mutually exclusive, not layered.
    expect(screen.queryByTestId("the-order-summary")).not.toBeInTheDocument();
  });

  it("also treats a 200 response with a malformed puzzle body as a genuine failure, not an eternal pending state", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(new Response(JSON.stringify({ not: "a real puzzle" }), { status: 200 })),
      ),
    );
    render(<TheOrder />);

    expect(await screen.findByTestId("the-order-error")).toBeInTheDocument();
  });

  it("expands to show all 5 real tickers with their real company names and real % moves, always visible", async () => {
    const panel = await expandBoard();
    for (const { ticker, companyName } of PUZZLE.tickers) {
      expect(panel.getByText(ticker)).toBeInTheDocument();
      expect(panel.getByText(companyName)).toBeInTheDocument();
    }
    // Every real return is on screen before any guess is submitted --
    // the whole point of the redesign.
    expect(panel.getByText("-3.10%")).toBeInTheDocument();
    expect(panel.getByText("+3.20%")).toBeInTheDocument();
    // No leftover copy from either prior mechanic (the original
    // attempt-limited Mastermind game, or the first redesign's one-shot
    // "that's it" framing -- this is neither any more).
    expect(panel.queryByText(/attempt/i)).not.toBeInTheDocument();
    expect(panel.queryByText(/that's it/i)).not.toBeInTheDocument();
  });

  it("the best mover sits in the top slot and the worst in the bottom slot, both explicitly tagged", async () => {
    const panel = await expandBoard();
    const rows = panel.getAllByRole("listitem");
    expect(within(rows[0]!).getByText("+3.20%")).toBeInTheDocument(); // NVDA, best mover
    expect(within(rows[0]!).getByText("Best")).toBeInTheDocument();
    expect(within(rows[rows.length - 1]!).getByText("-3.10%")).toBeInTheDocument(); // TSLA, worst
    expect(within(rows[rows.length - 1]!).getByText("Worst")).toBeInTheDocument();
  });

  it("submitting the real (best-to-worst) answer wins outright in one attempt and records a streak of 1", async () => {
    saveOrderDayState(DATE, freshState());
    const panel = await expandBoard();

    fireEvent.click(panel.getByRole("button", { name: "Submit guess" }));

    // Two matches expected: the sr-only aria-live announcement and the
    // visible reveal banner both say this.
    expect(await panel.findAllByText(/every stock matched/i)).toHaveLength(2);
    expect(panel.getAllByText("Correct")).toHaveLength(5);
    const currentStreakLabel = panel.getByText("Current streak");
    expect(currentStreakLabel.previousElementSibling).toHaveTextContent("1");
  });

  it("a partial-correct submit locks the correct slots (a star badge, no move buttons) and leaves the day in progress", async () => {
    // Swap the top two slots (NVDA/META) -- both wrong, the rest correct.
    const guess = [...ANSWER];
    [guess[0], guess[1]] = [guess[1]!, guess[0]!];
    saveOrderDayState(DATE, freshState({ guess }));
    const panel = await expandBoard();

    fireEvent.click(panel.getByRole("button", { name: "Submit guess" }));

    // Not done -- the day stays in progress, unlike either prior mechanic.
    expect(await panel.findByText(/3 of 5 locked/i)).toBeInTheDocument();
    expect(panel.queryByText(/every stock matched/i)).not.toBeInTheDocument();
    // The three locked (correct) rows show a real star badge; the two
    // still-open (incorrect) rows show no text badge at all while the
    // day is in progress -- just move buttons, with the row's own
    // border/background color as the only "you got this one wrong"
    // signal until it's eventually re-submitted correctly.
    expect(panel.getAllByText("Correct")).toHaveLength(3);
    expect(panel.queryByText("Incorrect")).not.toBeInTheDocument();
    // The three locked (correct) rows show no move buttons at all.
    expect(panel.queryAllByRole("button", { name: /toward best|toward worst/ })).toHaveLength(4); // only the two still-open slots' buttons
    // Submit/shuffle/reveal are all still available -- the day is not over.
    expect(panel.getByRole("button", { name: "Submit guess" })).toBeInTheDocument();
    expect(panel.getByRole("button", { name: "Shuffle" })).toBeInTheDocument();
    expect(panel.getByRole("button", { name: "Reveal answer" })).toBeInTheDocument();
  });

  it("resubmission only rearranges the still-open slots -- a locked slot can never move or be moved into", async () => {
    // Swap the top two slots (NVDA/META) -- both wrong, the rest correct.
    const guess = [...ANSWER];
    [guess[0], guess[1]] = [guess[1]!, guess[0]!];
    saveOrderDayState(DATE, freshState({ guess }));
    const panel = await expandBoard();

    fireEvent.click(panel.getByRole("button", { name: "Submit guess" }));
    await panel.findByText(/3 of 5 locked/i);

    // Move the ticker in the still-open top slot ("Move META toward
    // worst") -- it must hop over the locked slot below it (nothing to
    // hop here, slot 1 is the other open slot) and land in the other
    // open slot.
    fireEvent.click(panel.getByRole("button", { name: "Move META toward worst" }));

    const rows = panel.getAllByRole("listitem");
    expect(within(rows[0]!).getByText("NVDA")).toBeInTheDocument();
    expect(within(rows[1]!).getByText("META")).toBeInTheDocument();
    // The three locked slots are completely untouched.
    expect(within(rows[2]!).getByText("MSFT")).toBeInTheDocument();
    expect(within(rows[3]!).getByText("AAPL")).toBeInTheDocument();
    expect(within(rows[4]!).getByText("TSLA")).toBeInTheDocument();

    // Resubmitting now wins the day outright.
    fireEvent.click(panel.getByRole("button", { name: "Submit guess" }));
    expect(await panel.findAllByText(/every stock matched/i)).toHaveLength(2);
    expect(panel.getAllByText("Correct")).toHaveLength(5);
  });

  it("eventually solves across several submissions with no attempt cap, and the streak still counts a win", async () => {
    const guess = [...ANSWER];
    [guess[0], guess[1]] = [guess[1]!, guess[0]!];
    saveOrderDayState(DATE, freshState({ guess }));
    const panel = await expandBoard();

    // Attempt 1: partial correct.
    fireEvent.click(panel.getByRole("button", { name: "Submit guess" }));
    await panel.findByText(/3 of 5 locked -- attempt 1/i);

    // Attempt 2: a no-op resubmit (nothing rearranged) -- still not won,
    // and the attempt count still advances (no cap on submissions).
    fireEvent.click(panel.getByRole("button", { name: "Submit guess" }));
    await panel.findByText(/3 of 5 locked -- attempt 2/i);

    // Fix the one remaining swap, then win on the third attempt.
    fireEvent.click(panel.getByRole("button", { name: "Move META toward worst" }));
    fireEvent.click(panel.getByRole("button", { name: "Submit guess" }));

    expect(await panel.findAllByText(/every stock matched/i)).toHaveLength(2);
    const currentStreakLabel = panel.getByText("Current streak");
    // A win counts on eventual full solve regardless of how many
    // attempts it took (this redesign's own confirmed streak-counting
    // call -- see order-storage.ts's own top-of-file note).
    expect(currentStreakLabel.previousElementSibling).toHaveTextContent("1");
  });

  it("the top slot's 'toward best' button and the bottom slot's 'toward worst' button are disabled at the edge", async () => {
    // Seeded to the exact real answer so which ticker sits at each edge
    // slot is deterministic -- the default fresh state is a *random*
    // shuffle (initialOrderGuess), which could land any ticker at either
    // edge and make this assertion flaky.
    saveOrderDayState(DATE, freshState());
    const panel = await expandBoard();
    expect(panel.getByRole("button", { name: `Move ${ANSWER[0]} toward best` })).toBeDisabled();
    expect(
      panel.getByRole("button", { name: `Move ${ANSWER[ANSWER.length - 1]} toward worst` }),
    ).toBeDisabled();
  });

  it("a bail-out reveal ends the day without grading any slot, and still counts as a loss for the streak", async () => {
    window.localStorage.setItem(
      "hikt:the-order:streak-history",
      JSON.stringify({ days: [{ date: "2026-08-20", won: true }] }),
    );
    saveOrderDayState(DATE, freshState());
    const panel = await expandBoard();

    fireEvent.click(panel.getByRole("button", { name: "Reveal answer" }));

    expect(await panel.findAllByText(/revealed/i)).toHaveLength(2);
    // Revealing (not submitting) grades nothing -- no per-slot badges.
    expect(panel.queryByText("Correct")).not.toBeInTheDocument();
    expect(panel.queryByText("Incorrect")).not.toBeInTheDocument();
    expect(getOrderStreakHistory()).toEqual([
      { date: "2026-08-20", won: true },
      { date: DATE, won: false },
    ]);
  });

  it("a bail-out reveal actually shows the real ticker at every slot, not the player's own last (possibly wrong) arrangement", async () => {
    // Start from a deliberately wrong arrangement -- the reversed answer.
    saveOrderDayState(DATE, freshState({ guess: [...ANSWER].reverse() }));
    const panel = await expandBoard();

    fireEvent.click(panel.getByRole("button", { name: "Reveal answer" }));
    await panel.findAllByText(/revealed/i);

    const rows = panel.getAllByRole("listitem");
    // Every row now shows the real, best-to-worst ticker order -- not the
    // reversed guess the player left it on.
    ANSWER.forEach((ticker, index) => {
      expect(within(rows[index]!).getByText(ticker)).toBeInTheDocument();
    });
  });

  it("a bail-out reveal is still available mid-game, after a partial-correct submission", async () => {
    const guess = [...ANSWER];
    [guess[0], guess[1]] = [guess[1]!, guess[0]!];
    saveOrderDayState(DATE, freshState({ guess }));
    const panel = await expandBoard();

    fireEvent.click(panel.getByRole("button", { name: "Submit guess" }));
    await panel.findByText(/3 of 5 locked/i);

    fireEvent.click(panel.getByRole("button", { name: "Reveal answer" }));

    expect(await panel.findAllByText(/revealed/i)).toHaveLength(2);
  });

  it("persists progress across a fresh mount (a reload)", async () => {
    const guess = [...ANSWER].reverse();
    saveOrderDayState(DATE, freshState({ guess }));
    // Scoped to the expanded panel specifically -- the collapsed tile's
    // own summary status line (issue #195's own connector-panel markup)
    // also reads "In progress" once expanded, so an unscoped query
    // against the whole screen matches both.
    const { unmount } = render(<TheOrder />);
    fireEvent.click(await screen.findByTestId("the-order-summary"));
    const panel = within(await screen.findByTestId("the-order-panel"));
    const rowsBefore = panel.getAllByRole("listitem");
    expect(within(rowsBefore[0]!).getByText(guess[0]!)).toBeInTheDocument();
    unmount();

    render(<TheOrder />);
    fireEvent.click(await screen.findByTestId("the-order-summary"));
    const panelAfter = within(await screen.findByTestId("the-order-panel"));
    const rowsAfter = panelAfter.getAllByRole("listitem");
    expect(within(rowsAfter[0]!).getByText(guess[0]!)).toBeInTheDocument();
  });

  it("persists a locked, in-progress attempt across a fresh mount", async () => {
    const guess = [...ANSWER];
    [guess[0], guess[1]] = [guess[1]!, guess[0]!];
    saveOrderDayState(DATE, freshState({ guess }));
    const { unmount } = render(<TheOrder />);
    fireEvent.click(await screen.findByTestId("the-order-summary"));
    const panel = within(await screen.findByTestId("the-order-panel"));
    fireEvent.click(panel.getByRole("button", { name: "Submit guess" }));
    await panel.findByText(/3 of 5 locked -- attempt 1/i);
    unmount();

    render(<TheOrder />);
    fireEvent.click(await screen.findByTestId("the-order-summary"));
    const panelAfter = within(await screen.findByTestId("the-order-panel"));
    expect(await panelAfter.findByText(/3 of 5 locked -- attempt 1/i)).toBeInTheDocument();
    expect(panelAfter.getAllByText("Correct")).toHaveLength(3);
  });

  it("the collapsed tile's own status line reflects the stored state without expanding", async () => {
    saveOrderDayState(
      DATE,
      freshState({
        attempts: 1,
        done: true,
        won: true,
        feedback: ["correct", "correct", "correct", "correct", "correct"],
      }),
    );
    render(<TheOrder />);
    await waitFor(() => {
      expect(screen.getByTestId("the-order-summary")).toHaveTextContent(
        /solved -- every stock matched/i,
      );
    });
  });

  it("the collapsed tile's status line shows an in-progress locked count before the day is done", async () => {
    saveOrderDayState(
      DATE,
      freshState({
        attempts: 2,
        feedback: ["correct", "incorrect", "correct", "incorrect", "correct"],
      }),
    );
    render(<TheOrder />);
    await waitFor(() => {
      expect(screen.getByTestId("the-order-summary")).toHaveTextContent(
        /3 of 5 locked -- attempt 2/i,
      );
    });
  });

  it("the collapsed tile's status line shows a partial score for a finished-but-not-won (revealed) day", async () => {
    saveOrderDayState(
      DATE,
      freshState({
        attempts: 2,
        done: true,
        won: false,
        feedback: null,
      }),
    );
    render(<TheOrder />);
    await waitFor(() => {
      expect(screen.getByTestId("the-order-summary")).toHaveTextContent(/revealed/i);
    });
  });
});
