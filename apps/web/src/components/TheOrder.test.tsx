import { RESULTS_SCHEMA_VERSION, type TheOrderPuzzle } from "@hadiknowntrades/core";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getOrderStreakHistory, saveOrderDayState, type OrderDayState } from "@/lib/order-storage";
import { TheOrder } from "./TheOrder";

const DATE = "2026-08-26";

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

const ANSWER = PUZZLE.tickers.map((t) => t.ticker);

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
    attempt: 1,
    history: [],
    locked: [false, false, false, false, false],
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

  it("expands to show all 5 real tickers with their real company names, once the puzzle loads", async () => {
    const panel = await expandBoard();
    for (const { ticker, companyName } of PUZZLE.tickers) {
      expect(panel.getByText(ticker)).toBeInTheDocument();
      expect(panel.getByText(companyName)).toBeInTheDocument();
    }
    expect(panel.getByText(/attempt 1 of 4/i)).toBeInTheDocument();
  });

  it("submitting the real answer wins in 1 attempt, locks every slot, and reveals real returns", async () => {
    saveOrderDayState(DATE, freshState());
    const panel = await expandBoard();

    fireEvent.click(panel.getByRole("button", { name: "Submit guess" }));

    // Two matches expected: the sr-only aria-live announcement and the
    // visible reveal banner both say this, matching CallBoard.tsx's own
    // announcement+visible-text pairing.
    expect(await panel.findAllByText(/solved in 1 of 4/i)).toHaveLength(2);
    // Every slot's own "★ Locked" badge should now be present -- 5 of them.
    expect(panel.getAllByText("Locked")).toHaveLength(5);
    // The real returns are revealed, formatted with a sign and 2 decimals.
    expect(panel.getByText("-3.10%")).toBeInTheDocument();
    expect(panel.getByText("+3.20%")).toBeInTheDocument();
    // A first-ever win records a streak of 1 -- located via its own label's
    // sibling, since a bare "1" also matches the reveal ranking's #1 slot
    // and the row list's own index badges.
    const currentStreakLabel = panel.getByText("Current streak");
    expect(currentStreakLabel.previousElementSibling).toHaveTextContent("1");
  });

  it("locks only the exact slots on a mixed guess, and hops a move over a locked slot", async () => {
    // Swap TSLA/AAPL (both far off) but keep MSFT/META/NVDA exact.
    saveOrderDayState(DATE, freshState({ guess: ["AAPL", "TSLA", "MSFT", "META", "NVDA"] }));
    const panel = await expandBoard();

    fireEvent.click(panel.getByRole("button", { name: "Submit guess" }));
    await panel.findByText(/attempt 2 of 4/i);

    // MSFT, META, NVDA are now locked -- no move buttons remain for them,
    // replaced by the "★ Locked" badge -- while AAPL/TSLA still have theirs.
    expect(panel.getAllByText("Locked")).toHaveLength(3);
    expect(panel.queryByRole("button", { name: "Move MSFT toward worst" })).not.toBeInTheDocument();
    expect(panel.getByRole("button", { name: "Move AAPL toward worst" })).toBeInTheDocument();

    // AAPL (slot 0) moving "toward best" (dir=+1) must hop over the now-
    // locked MSFT (slot 2) and land on TSLA's own slot (1) -- the
    // hop-over-locked-slot mechanic, exercised through real clicks.
    fireEvent.click(panel.getByRole("button", { name: "Move AAPL toward best" }));
    const rows = panel.getAllByRole("listitem");
    // After the hop: TSLA first, then AAPL, then the three locked ones.
    expect(within(rows[0]!).getByText("TSLA")).toBeInTheDocument();
    expect(within(rows[1]!).getByText("AAPL")).toBeInTheDocument();
  });

  it("out-of-attempts reveals the answer without a win, and resets the streak", async () => {
    // Seed a real prior win, so this loss shows the reset take effect.
    window.localStorage.setItem(
      "hikt:the-order:streak-history",
      JSON.stringify({ days: [{ date: "2026-08-20", won: true }] }),
    );
    // Attempt 4 of 4, a fully reversed guess -- not a win (only the exact
    // middle slot happens to score exact by coincidence of the reversal;
    // the other 4 don't), so running out of attempts is what ends this day.
    saveOrderDayState(DATE, freshState({ attempt: 4, guess: [...ANSWER].reverse() }));
    const panel = await expandBoard();

    fireEvent.click(panel.getByRole("button", { name: "Submit guess" }));

    // Two matches expected -- see the "solved" test's own note above.
    expect(await panel.findAllByText(/out of guesses/i)).toHaveLength(2);
    // Two matches expected too: the still-rendered interactive row list
    // (its own slots never disappear, just get disabled) and the reveal
    // panel's own "yesterday, worst to best" ranking.
    expect(panel.getAllByText(ANSWER[0]!)).toHaveLength(2); // real order revealed
    expect(getOrderStreakHistory()).toEqual([
      { date: "2026-08-20", won: true },
      { date: DATE, won: false },
    ]);
  });

  it("a bail-out reveal ends the game without recording any submitted attempt", async () => {
    saveOrderDayState(DATE, freshState());
    const panel = await expandBoard();

    fireEvent.click(panel.getByRole("button", { name: "Reveal answer" }));

    expect(await panel.findAllByText(/out of guesses/i)).toHaveLength(2);
    // No history strip -- nothing was ever actually submitted.
    expect(panel.queryByText("Past guesses")).not.toBeInTheDocument();
  });

  it("every history glyph cell carries a real glyph and an sr-only description, not color alone", async () => {
    // Swap the two end slots (TSLA/NVDA): both land 4 positions from their
    // real slot -- a real "far" case for both -- while AAPL/MSFT/META stay
    // exact in the middle.
    saveOrderDayState(DATE, freshState({ guess: ["NVDA", "AAPL", "MSFT", "META", "TSLA"] }));
    const panel = await expandBoard();
    fireEvent.click(panel.getByRole("button", { name: "Submit guess" }));
    await panel.findByText("Past guesses");

    expect(panel.getByText("TSLA: far off.")).toBeInTheDocument();
    expect(panel.getByText("NVDA: far off.")).toBeInTheDocument();
    expect(panel.getByText("MSFT: exact position.")).toBeInTheDocument();
  });

  it("persists progress across a fresh mount (a reload)", async () => {
    saveOrderDayState(
      DATE,
      freshState({
        attempt: 2,
        history: [{ guess: [...ANSWER], feedback: ["exact", "exact", "exact", "exact", "exact"] }],
      }),
    );
    // Scoped to the expanded panel specifically -- the collapsed tile's
    // own summary status line (issue #195's own connector-panel markup)
    // also reads "Attempt 2 of 4" once expanded, so an unscoped query
    // against the whole screen matches both.
    const { unmount } = render(<TheOrder />);
    fireEvent.click(await screen.findByTestId("the-order-summary"));
    await within(await screen.findByTestId("the-order-panel")).findByText(/attempt 2 of 4/i);
    unmount();

    render(<TheOrder />);
    fireEvent.click(await screen.findByTestId("the-order-summary"));
    expect(
      await within(await screen.findByTestId("the-order-panel")).findByText(/attempt 2 of 4/i),
    ).toBeInTheDocument();
  });

  it("the collapsed tile's own status line reflects the stored state without expanding", async () => {
    saveOrderDayState(
      DATE,
      freshState({
        done: true,
        won: true,
        history: [{ guess: [...ANSWER], feedback: ["exact", "exact", "exact", "exact", "exact"] }],
      }),
    );
    render(<TheOrder />);
    await waitFor(() => {
      expect(screen.getByTestId("the-order-summary")).toHaveTextContent(/solved in 1 of 4/i);
    });
  });
});
