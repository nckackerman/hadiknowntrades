import { RESULTS_SCHEMA_VERSION, type Sp500PrefixResult } from "@hadiknowntrades/core";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  getCutGameHistory,
  recordCutCompletion,
  saveCutGameState,
  type CutGameState,
} from "@/lib/the-cut-storage";
import { TheCut } from "./TheCut";

const RANGE = "1Y";

// A small, hand-computed fixture: universeSize=5, bestN=3 ($30 from $20),
// the N=5 (whole-index) baseline at $22 -- matching the-cut-scoring.test.ts's
// own fixture so the numbers are easy to cross-check by hand.
const RESULT: Sp500PrefixResult = {
  schemaVersion: RESULTS_SCHEMA_VERSION,
  range: RANGE,
  generatedAt: "2026-09-10T00:00:00.000Z",
  dataAsOf: "2026-09-09",
  endDate: "2026-09-10",
  startDate: "2025-09-09",
  startingCapital: 20,
  universeSize: 5,
  truncated: false,
  bestN: 3,
  bestPortfolioReturn: 1.5,
  bestEndingBalance: 30,
  curve: [
    { n: 1, portfolioReturn: 1.2, endingBalance: 24, cumWeight: 0.5 },
    { n: 2, portfolioReturn: 1.3, endingBalance: 26, cumWeight: 0.7 },
    { n: 3, portfolioReturn: 1.5, endingBalance: 30, cumWeight: 0.85 },
    { n: 4, portfolioReturn: 1.4, endingBalance: 28, cumWeight: 0.95 },
    { n: 5, portfolioReturn: 1.1, endingBalance: 22, cumWeight: 1 },
  ],
  benchmark: null,
  n500VsSpyPctDiff: null,
};

function stubResultFetch(result: Sp500PrefixResult | null = RESULT, status = 200): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      result === null && status === 200
        ? new Promise(() => {}) // never resolves
        : Promise.resolve(new Response(JSON.stringify(result), { status })),
    ),
  );
}

function freshState(overrides: Partial<CutGameState> = {}): CutGameState {
  return { guesses: [], done: false, won: false, ...overrides };
}

async function expandBoard() {
  render(<TheCut />);
  const summary = await screen.findByTestId("the-cut-summary");
  fireEvent.click(summary);
  return within(await screen.findByTestId("the-cut-panel"));
}

function guessInput(panel: ReturnType<typeof within>) {
  return panel.getByRole("spinbutton", { name: "Your guess, as a number" });
}

function submit(panel: ReturnType<typeof within>, value: number) {
  fireEvent.change(guessInput(panel), { target: { value: String(value) } });
  fireEvent.click(panel.getByRole("button", { name: "Submit guess" }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

beforeEach(() => {
  stubResultFetch();
});

describe("TheCut", () => {
  it("renders the collapsed tile before the fetch resolves, with no crash", () => {
    stubResultFetch(null); // never resolves
    render(<TheCut />);
    expect(screen.getByRole("heading", { name: "The Cut", level: 2 })).toBeInTheDocument();
    expect(screen.queryByTestId("the-cut-error")).not.toBeInTheDocument();
  });

  it("renders a distinguishable, visible error state for a genuine fetch failure", async () => {
    stubResultFetch(null, 500);
    render(<TheCut />);

    const errorState = await screen.findByTestId("the-cut-error");
    expect(errorState).not.toHaveAttribute("aria-hidden");
    expect(screen.getByText(/couldn't load the cut/i)).toBeInTheDocument();
    expect(screen.queryByTestId("the-cut-summary")).not.toBeInTheDocument();
  });

  it("also treats a 200 response with a malformed body as a genuine failure", async () => {
    stubResultFetch({ not: "a real result" } as unknown as Sp500PrefixResult);
    render(<TheCut />);

    expect(await screen.findByTestId("the-cut-error")).toBeInTheDocument();
  });

  it("idle: shows the ticker strip, the range picker, and no guess feedback yet", async () => {
    const panel = await expandBoard();

    expect(panel.getByText("NVDA")).toBeInTheDocument(); // real rank #1 by weight
    expect(panel.getByRole("group", { name: "Preset date range" })).toBeInTheDocument();
    expect(panel.queryByText(/too high|too low/i)).not.toBeInTheDocument();
    expect(panel.getByText(/6 guesses left/i)).toBeInTheDocument(); // CUT_MAX_ATTEMPTS, no guesses yet
  });

  it("in-progress: grades a too-high guess with direction and closeness, and counts the attempt down", async () => {
    saveCutGameState(RANGE, freshState());
    const panel = await expandBoard();

    submit(panel, 5); // bestN=3 -> too high, |5-3|=2, 2/5=0.4 -> ice-cold

    expect(await panel.findByText(/too high/i)).toBeInTheDocument();
    expect(panel.getByText("Ice cold")).toBeInTheDocument();
    expect(panel.getByText(/5 guesses left/i)).toBeInTheDocument();
    // The game isn't over -- the guess controls are still there.
    expect(panel.getByRole("button", { name: "Submit guess" })).toBeInTheDocument();
  });

  it("in-progress: grades a too-low guess with direction and closeness", async () => {
    saveCutGameState(RANGE, freshState());
    const panel = await expandBoard();

    submit(panel, 2); // bestN=3 -> too low, |2-3|=1, 1/5=0.2 -> cold

    expect(await panel.findByText(/too low/i)).toBeInTheDocument();
    expect(panel.getByText("Cold")).toBeInTheDocument();
  });

  it("win: an exact guess ends the game immediately, shows 100% edge captured, and records a streak of 1", async () => {
    saveCutGameState(RANGE, freshState());
    const panel = await expandBoard();

    submit(panel, 3); // bestN

    expect(await panel.findAllByText(/correct/i)).not.toHaveLength(0);
    // No more guess controls once done.
    expect(panel.queryByRole("button", { name: "Submit guess" })).not.toBeInTheDocument();
    expect(panel.getByText("100%")).toBeInTheDocument(); // edge captured
    expect(panel.getByText("0")).toBeInTheDocument(); // ranks off
    const currentStreakLabel = panel.getByText("Current streak");
    expect(currentStreakLabel.previousElementSibling).toHaveTextContent("1");
    expect(getCutGameHistory()).toEqual([{ range: RANGE, won: true, edgeCapturedPct: 100 }]);

    // The reveal chart renders (a real SVG, not a placeholder).
    expect(panel.getByRole("img")).toBeInTheDocument();
    // "Play again" is offered.
    expect(panel.getByRole("button", { name: "Play again" })).toBeInTheDocument();
  });

  it("lose: running out of attempts without an exact guess ends the game as a loss", async () => {
    saveCutGameState(RANGE, freshState());
    const panel = await expandBoard();

    // Six guesses of "5", never the real bestN (3).
    for (let i = 0; i < 6; i++) {
      submit(panel, 5);
    }

    // Two matches expected: the sr-only aria-live announcement and the
    // visible reveal banner both say this (mirroring TheOrder.test.tsx's
    // own identical pattern for its own two-copy result sentence).
    expect(await panel.findAllByText(/out of attempts/i)).toHaveLength(2);
    expect(panel.queryByRole("button", { name: "Submit guess" })).not.toBeInTheDocument();
    expect(getCutGameHistory()).toEqual([{ range: RANGE, won: false, edgeCapturedPct: 0 }]);
  });

  it("play again resets the range's own game state", async () => {
    saveCutGameState(RANGE, freshState({ guesses: [3], done: true, won: true }));
    const panel = await expandBoard();

    fireEvent.click(panel.getByRole("button", { name: "Play again" }));

    expect(await panel.findByRole("button", { name: "Submit guess" })).toBeInTheDocument();
    expect(panel.queryByText(/correct!/i)).not.toBeInTheDocument();
  });

  it("persists progress across a fresh mount (a reload)", async () => {
    saveCutGameState(RANGE, freshState({ guesses: [5] }));
    const { unmount } = render(<TheCut />);
    fireEvent.click(await screen.findByTestId("the-cut-summary"));
    let panel = within(await screen.findByTestId("the-cut-panel"));
    expect(await panel.findByText(/too high/i)).toBeInTheDocument();
    unmount();

    render(<TheCut />);
    fireEvent.click(await screen.findByTestId("the-cut-summary"));
    panel = within(await screen.findByTestId("the-cut-panel"));
    expect(await panel.findByText(/too high/i)).toBeInTheDocument();
  });

  it("the collapsed tile's own status line reflects the stored state without expanding", async () => {
    saveCutGameState(RANGE, freshState({ guesses: [3], done: true, won: true }));
    render(<TheCut />);
    await waitFor(() => {
      expect(screen.getByTestId("the-cut-summary")).toHaveTextContent(/solved/i);
    });
  });

  it("the collapsed tile shows the current attempt number while in progress", async () => {
    saveCutGameState(RANGE, freshState({ guesses: [5, 4] }));
    render(<TheCut />);
    await waitFor(() => {
      expect(screen.getByTestId("the-cut-summary")).toHaveTextContent(/attempt 3 of 6/i);
    });
  });

  it("scopes the current/best streak to the currently-viewed range, not every range's combined history (regression)", async () => {
    // Two wins recorded under a different range (5Y) must never inflate
    // 1Y's own displayed streak -- computeCutStreak must be scoped per
    // range, not run over the whole cross-range history unfiltered.
    recordCutCompletion("5Y", true, 100);
    recordCutCompletion("5Y", true, 100);
    saveCutGameState(RANGE, freshState());
    const panel = await expandBoard();

    submit(panel, 3); // wins the 1Y game -- a real, first streak entry for 1Y

    const currentStreakLabel = panel.getByText("Current streak");
    // Would read "3" (2 stray 5Y wins + this 1Y win) without the fix.
    expect(currentStreakLabel.previousElementSibling).toHaveTextContent("1");
    const bestStreakLabel = panel.getByText("Best streak");
    expect(bestStreakLabel.previousElementSibling).toHaveTextContent("1");
  });

  it("keeps the expanded panel open across a mid-panel range switch, even while the new range's data is still loading (regression)", async () => {
    let releaseSecondFetch!: (value: Response) => void;
    let fetchCallCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        fetchCallCount += 1;
        if (fetchCallCount === 1) {
          return Promise.resolve(new Response(JSON.stringify(RESULT), { status: 200 }));
        }
        // The second (range-switch) fetch stays pending until the test
        // explicitly resolves it, so the assertion below runs while
        // useSp500Prefix is genuinely mid-"loading" for the new range.
        return new Promise<Response>((resolve) => {
          releaseSecondFetch = resolve;
        });
      }),
    );

    const panel = await expandBoard();
    expect(screen.getByTestId("the-cut-panel")).toBeInTheDocument();

    fireEvent.click(panel.getByRole("button", { name: "5Y" }));

    // The panel (and its <details> shell) must still be mounted and
    // open -- not swapped out for the collapsed placeholder -- while
    // the new range's fetch is still pending.
    expect(screen.getByTestId("the-cut-summary")).toBeInTheDocument();
    expect(screen.getByTestId("the-cut-panel")).toBeInTheDocument();
    expect(screen.queryByTestId("the-cut-error")).not.toBeInTheDocument();

    releaseSecondFetch(new Response(JSON.stringify(RESULT), { status: 200 }));
    await waitFor(() => {
      expect(screen.getByTestId("the-cut-panel")).toBeInTheDocument();
    });
    // Still the same open panel afterward -- no collapse-then-reopen-closed cycle.
    expect(screen.getByTestId("the-cut-summary")).toBeInTheDocument();
  });
});
