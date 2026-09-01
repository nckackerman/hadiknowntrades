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

// Best-to-worst -- what the redesigned game actually shows/grades against
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
    done: false,
    won: false,
    feedback: null,
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
    // No attempt-limit copy left from the original Mastermind mechanic.
    expect(panel.queryByText(/attempt/i)).not.toBeInTheDocument();
  });

  it("the best mover sits in the top slot and the worst in the bottom slot, both explicitly tagged", async () => {
    const panel = await expandBoard();
    const rows = panel.getAllByRole("listitem");
    expect(within(rows[0]!).getByText("+3.20%")).toBeInTheDocument(); // NVDA, best mover
    expect(within(rows[0]!).getByText("Best")).toBeInTheDocument();
    expect(within(rows[rows.length - 1]!).getByText("-3.10%")).toBeInTheDocument(); // TSLA, worst
    expect(within(rows[rows.length - 1]!).getByText("Worst")).toBeInTheDocument();
  });

  it("submitting the real (best-to-worst) answer wins outright and records a streak of 1", async () => {
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

  it("grades a mixed guess per slot, shows the real answer for each miss, and does not win", async () => {
    // Swap the top two slots (NVDA/META) -- both wrong, the rest correct.
    const guess = [...ANSWER];
    [guess[0], guess[1]] = [guess[1]!, guess[0]!];
    saveOrderDayState(DATE, freshState({ guess }));
    const panel = await expandBoard();

    fireEvent.click(panel.getByRole("button", { name: "Submit guess" }));

    expect(await panel.findAllByText(/3 of 5 correct/i)).toHaveLength(2);
    expect(panel.getAllByText("Correct")).toHaveLength(3);
    expect(panel.getAllByText("Incorrect")).toHaveLength(2);
    // The two missed slots each name the ticker that actually belongs there.
    expect(panel.getByText("Actually NVDA")).toBeInTheDocument();
    expect(panel.getByText("Actually META")).toBeInTheDocument();
  });

  it("moving a ticker up swaps it toward the best-mover end, and moving down swaps it toward the worst", async () => {
    // Start with the two top slots swapped.
    const guess = [...ANSWER];
    [guess[0], guess[1]] = [guess[1]!, guess[0]!];
    saveOrderDayState(DATE, freshState({ guess })); // META, NVDA, MSFT, AAPL, TSLA
    const panel = await expandBoard();

    fireEvent.click(panel.getByRole("button", { name: "Move NVDA toward best" }));

    const rows = panel.getAllByRole("listitem");
    expect(within(rows[0]!).getByText("NVDA")).toBeInTheDocument();
    expect(within(rows[1]!).getByText("META")).toBeInTheDocument();
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

  it("the collapsed tile's own status line reflects the stored state without expanding", async () => {
    saveOrderDayState(
      DATE,
      freshState({
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

  it("the collapsed tile's status line shows a partial score for a finished-but-not-won day", async () => {
    saveOrderDayState(
      DATE,
      freshState({
        done: true,
        won: false,
        feedback: ["correct", "incorrect", "correct", "incorrect", "correct"],
      }),
    );
    render(<TheOrder />);
    await waitFor(() => {
      expect(screen.getByTestId("the-order-summary")).toHaveTextContent(/3 of 5 correct/i);
    });
  });
});
