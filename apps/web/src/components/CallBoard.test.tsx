import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { saveResolvedCalls } from "@/lib/call-board-storage";
import { getCallBoardPick } from "@/lib/call-board-storage";
import type { ResolvedCall } from "@/lib/call-board-scoring";

import { CallBoard, callOutcomeFor } from "./CallBoard";

// A Wednesday at 9:00 AM New York time -- before that day's own 9:30
// open, so 2026-08-26 itself leads the lookahead. See market-calendar.ts.
const WEDNESDAY_BEFORE_OPEN = new Date("2026-08-26T13:00:00Z");
const SATURDAY = new Date("2026-08-29T13:00:00Z");
// Labor Day 2026 (first Monday of September), a scheduled market holiday.
const LABOR_DAY = new Date("2026-09-07T13:00:00Z");

/** Only `Date` is faked -- the board's hydration correction rides on the real microtask queue. */
function freezeClock(at: Date): void {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(at);
}

/**
 * The board fetches its own SPY close series (issue #122: it takes no
 * PrecomputedResult prop). Every test here drives the board from
 * localStorage instead, so the fetch is stubbed to fail -- which is also
 * a real state worth exercising, since the board must stay fully playable
 * with /api/results unreachable.
 */
function stubOfflineResults(): void {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
}

function resolvedCall(overrides: Partial<ResolvedCall> & Pick<ResolvedCall, "date">): ResolvedCall {
  return {
    pick: "up",
    actual: "up",
    moveFraction: 0.008,
    score: 2,
    ...overrides,
  };
}

/** The four buckets of the slot for `dateLabel` (e.g. "Aug 27, 2026"). */
function slotButtons(dateLabel: string): HTMLElement[] {
  return within(screen.getByRole("group", { name: `Your call for ${dateLabel}` })).getAllByRole(
    "button",
  );
}

async function renderBoard(): Promise<ReturnType<typeof userEvent.setup>> {
  // userEvent.setup() must come before any global stubbing it depends on;
  // it also needs its own timer wiring since Date is faked here.
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  render(<CallBoard />);
  // Wait past the mount-time correction: the first render deliberately
  // shows inert placeholder slots with no dates at all (see
  // UNHYDRATED_VIEW in lib/use-call-board.ts).
  await waitFor(() => {
    expect(screen.getAllByRole("group", { name: /^Your call for/ })).toHaveLength(3);
  });
  return user;
}

beforeEach(() => {
  localStorage.clear();
  stubOfflineResults();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("CallBoard: the 3-slot board", () => {
  it("renders one slot per upcoming trading session, each with all four buckets", async () => {
    freezeClock(WEDNESDAY_BEFORE_OPEN);
    await renderBoard();

    for (const label of ["Aug 26, 2026", "Aug 27, 2026", "Aug 28, 2026"]) {
      expect(slotButtons(label).map((button) => button.textContent)).toEqual([
        "▲▲Up big",
        "▲Up",
        "▼Down",
        "▼▼Down big",
      ]);
    }
  });

  it("saves a pick on tap with no separate lock-in step, and marks it aria-pressed", async () => {
    freezeClock(WEDNESDAY_BEFORE_OPEN);
    const user = await renderBoard();

    const [upBig] = slotButtons("Aug 27, 2026");
    expect(upBig).toHaveAttribute("aria-pressed", "false");

    await user.click(upBig!);

    expect(getCallBoardPick("2026-08-27")).toBe("up-strong");
    await waitFor(() => {
      expect(slotButtons("Aug 27, 2026")[0]).toHaveAttribute("aria-pressed", "true");
    });
    // Exactly one bucket is pressed per slot, and only in that slot.
    const pressed = slotButtons("Aug 27, 2026").filter(
      (button) => button.getAttribute("aria-pressed") === "true",
    );
    expect(pressed).toHaveLength(1);
    expect(
      slotButtons("Aug 28, 2026").every(
        (button) => button.getAttribute("aria-pressed") === "false",
      ),
    ).toBe(true);
  });

  it("moves aria-pressed when the call is changed", async () => {
    freezeClock(WEDNESDAY_BEFORE_OPEN);
    const user = await renderBoard();

    await user.click(slotButtons("Aug 27, 2026")[0]!);
    await user.click(slotButtons("Aug 27, 2026")[3]!);

    await waitFor(() => {
      expect(slotButtons("Aug 27, 2026")[3]).toHaveAttribute("aria-pressed", "true");
    });
    expect(slotButtons("Aug 27, 2026")[0]).toHaveAttribute("aria-pressed", "false");
    expect(getCallBoardPick("2026-08-27")).toBe("down-strong");
  });

  it("announces a pick through an always-present polite live region", async () => {
    freezeClock(WEDNESDAY_BEFORE_OPEN);
    const user = await renderBoard();

    const status = screen.getByRole("status", { name: "Call Board status" });
    // Present and empty before anything happens -- an aria-live region has
    // to exist in the accessibility tree before the mutation it announces
    // (issue #67's own reasoning, mirrored here).
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status).toHaveTextContent("");

    await user.click(slotButtons("Aug 27, 2026")[1]!);

    await waitFor(() => {
      expect(status).toHaveTextContent("Called up for Aug 27, 2026.");
    });
  });

  it("gives every bucket button a >= 44px touch target", async () => {
    // jsdom computes no layout at all (no stylesheet is loaded in this
    // environment -- see vitest.config.mts), so this asserts the size
    // contract the markup actually commits to: Tailwind's spacing scale
    // is n * 0.25rem, and this app's root font size is the browser
    // default 16px, so `min-h-11` really is 44px. The rendered pixel
    // size was separately measured live at a 375px viewport under
    // headless Chromium -- see this issue's PR description.
    freezeClock(WEDNESDAY_BEFORE_OPEN);
    // A 375px-wide viewport: at this width the board stacks to one column
    // (grid-cols-1 sm:grid-cols-3), which is what leaves room for the
    // buttons to hit their floor.
    window.innerWidth = 375;
    await renderBoard();

    const pxPerStep = 4;
    const minimum = 44;
    for (const label of ["Aug 26, 2026", "Aug 27, 2026", "Aug 28, 2026"]) {
      for (const button of slotButtons(label)) {
        const height = /(?:^|\s)min-h-(\d+)(?:\s|$)/.exec(button.className);
        const width = /(?:^|\s)min-w-(\d+)(?:\s|$)/.exec(button.className);
        expect(height, `no min-h utility on ${button.textContent}`).not.toBeNull();
        expect(width, `no min-w utility on ${button.textContent}`).not.toBeNull();
        expect(Number(height![1]) * pxPerStep).toBeGreaterThanOrEqual(minimum);
        expect(Number(width![1]) * pxPerStep).toBeGreaterThanOrEqual(minimum);
      }
    }
  });

  it("stacks to one column at phone widths and to three across from sm up", async () => {
    freezeClock(WEDNESDAY_BEFORE_OPEN);
    await renderBoard();

    const list = screen.getByRole("group", { name: "Your call for Aug 26, 2026" }).closest("ul");
    expect(list).not.toBeNull();
    expect(list!.className).toContain("grid-cols-1");
    expect(list!.className).toContain("sm:grid-cols-3");
  });
});

describe("CallBoard: hydration safety", () => {
  it("renders nothing clock- or storage-derived on the very first render", () => {
    // CallBoard mounts at the ResultsPage level (issue #122), which really
    // does render on the server -- so the first render has to be
    // reproducible without a clock or localStorage, or a page load
    // straddling 9:30 AM Eastern mismatches on hydration. Verified live
    // too: faking only the client's clock reproduced React's hydration
    // error against an earlier version of this component and produces
    // none now.
    freezeClock(WEDNESDAY_BEFORE_OPEN);
    saveResolvedCalls([resolvedCall({ date: "2026-08-25" })]);

    render(<CallBoard />);

    expect(screen.queryAllByRole("group", { name: /^Your call for/ })).toHaveLength(0);
    expect(screen.queryByText(/Aug 2\d, 2026/)).toBeNull();
    expect(screen.queryByRole("list", { name: "Recently settled calls" })).toBeNull();
    // The placeholders hold the section's height so nothing shifts when
    // the real board lands, and none of them is focusable or announced.
    const placeholders = screen.getAllByRole("button", { hidden: true });
    expect(placeholders).toHaveLength(4 * 3);
    expect(placeholders.every((button) => (button as HTMLButtonElement).disabled)).toBe(true);
  });
});

describe("CallBoard: first-visit empty state", () => {
  it("shows three unset slots, zeroed stats and an explanatory empty history", async () => {
    freezeClock(WEDNESDAY_BEFORE_OPEN);
    await renderBoard();

    expect(screen.getAllByRole("group", { name: /^Your call for/ })).toHaveLength(3);
    expect(
      screen
        .getAllByRole("button")
        .every((button) => button.getAttribute("aria-pressed") === "false"),
    ).toBe(true);

    for (const [label, value] of [
      ["Calls resolved", "0"],
      ["Win rate", "0%"],
      ["Current streak", "0"],
      ["Best streak", "0"],
    ] as const) {
      expect(screen.getByText(label).previousElementSibling).toHaveTextContent(value);
    }

    expect(screen.queryByRole("list", { name: "Recently settled calls" })).toBeNull();
    expect(screen.getByText(/Nothing has settled yet/)).toBeInTheDocument();
  });
});

describe("CallBoard: weekend and holiday state", () => {
  it("skips the weekend, still shows three sessions, and says why", async () => {
    freezeClock(SATURDAY);
    await renderBoard();

    expect(screen.getByText(/Markets are closed today/)).toBeInTheDocument();
    expect(
      screen.getAllByRole("group", { name: /^Your call for/ }).map((group) => group.ariaLabel),
    ).toEqual([
      "Your call for Aug 31, 2026",
      "Your call for Sep 1, 2026",
      "Your call for Sep 2, 2026",
    ]);
  });

  it("skips a scheduled market holiday the same way", async () => {
    freezeClock(LABOR_DAY);
    await renderBoard();

    expect(screen.getByText(/Markets are closed today/)).toBeInTheDocument();
    expect(
      screen.getAllByRole("group", { name: /^Your call for/ }).map((group) => group.ariaLabel),
    ).toEqual([
      "Your call for Sep 8, 2026",
      "Your call for Sep 9, 2026",
      "Your call for Sep 10, 2026",
    ]);
  });

  it("says nothing about closures on an ordinary trading day", async () => {
    freezeClock(WEDNESDAY_BEFORE_OPEN);
    await renderBoard();

    expect(screen.queryByText(/Markets are closed today/)).toBeNull();
  });
});

describe("CallBoard: history strip", () => {
  /** Renders the strip against one settled call and returns its cell. */
  async function renderOneCall(call: ResolvedCall): Promise<HTMLElement> {
    saveResolvedCalls([call]);
    freezeClock(WEDNESDAY_BEFORE_OPEN);
    await renderBoard();
    await waitFor(() => {
      expect(screen.getByRole("list", { name: "Recently settled calls" })).toBeInTheDocument();
    });
    return within(screen.getByRole("list", { name: "Recently settled calls" })).getAllByRole(
      "listitem",
    )[0]!;
  }

  it("colors an exact match with the reward accent, and marks it with a star", async () => {
    const cell = await renderOneCall(
      resolvedCall({ date: "2026-08-25", pick: "up-strong", actual: "up-strong", score: 2 }),
    );

    expect(cell).toHaveAttribute("data-outcome", "exact");
    expect(cell.className).toContain("text-[var(--accent-reward)]");
    expect(cell).toHaveTextContent("★");
    expect(cell).toHaveTextContent(/Exact call\.$/);
  });

  it("colors a right-side/wrong-confidence call green, and marks it with a check", async () => {
    const cell = await renderOneCall(
      resolvedCall({
        date: "2026-08-25",
        pick: "up-strong",
        actual: "up",
        moveFraction: 0.002,
        score: 1,
      }),
    );

    expect(cell).toHaveAttribute("data-outcome", "right-direction");
    expect(cell.className).toContain("text-[var(--status-good)]");
    expect(cell).toHaveTextContent("✓");
    expect(cell).toHaveTextContent(/Right direction\.$/);
  });

  it("colors a wrong-side-but-adjacent call neutrally, and marks it with a tilde", async () => {
    const cell = await renderOneCall(
      resolvedCall({
        date: "2026-08-25",
        pick: "up",
        actual: "down",
        moveFraction: -0.002,
        score: 0,
      }),
    );

    expect(cell).toHaveAttribute("data-outcome", "near-miss");
    expect(cell.className).toContain("text-[var(--text-secondary)]");
    expect(cell).toHaveTextContent("~");
    expect(cell).toHaveTextContent(/Just missed\.$/);
  });

  it("colors a wrong-side-and-far call red, and marks it with a cross", async () => {
    const cell = await renderOneCall(
      resolvedCall({
        date: "2026-08-25",
        pick: "up-strong",
        actual: "down-strong",
        moveFraction: -0.02,
        score: 0,
      }),
    );

    expect(cell).toHaveAttribute("data-outcome", "far-miss");
    expect(cell.className).toContain("text-[var(--status-critical)]");
    expect(cell).toHaveTextContent("✕");
    expect(cell).toHaveTextContent(/Way off\.$/);
  });

  it("describes every cell in text, so the four states never rely on color alone", async () => {
    const cell = await renderOneCall(
      resolvedCall({
        date: "2026-08-25",
        pick: "up-strong",
        actual: "up",
        moveFraction: 0.002,
        score: 1,
      }),
    );

    expect(cell).toHaveTextContent(
      "Aug 25, 2026: called up big, closed +0.2% (up). Right direction.",
    );
    // The legend repeats each glyph next to its meaning.
    const legend = screen.getByRole("list", { name: "What each mark means" });
    for (const label of ["Exact call", "Right direction", "Just missed", "Way off"]) {
      expect(within(legend).getByText(label)).toBeInTheDocument();
    }
  });

  it("shows at most the ten most recent settled calls, newest last", async () => {
    const calls = Array.from({ length: 14 }, (_, index) =>
      resolvedCall({ date: `2026-07-${String(index + 1).padStart(2, "0")}` }),
    );
    saveResolvedCalls(calls);
    freezeClock(WEDNESDAY_BEFORE_OPEN);
    await renderBoard();

    await waitFor(() => {
      expect(
        within(screen.getByRole("list", { name: "Recently settled calls" })).getAllByRole(
          "listitem",
        ),
      ).toHaveLength(10);
    });
    const cells = within(screen.getByRole("list", { name: "Recently settled calls" })).getAllByRole(
      "listitem",
    );
    expect(cells[0]).toHaveTextContent("Jul 5, 2026");
    expect(cells[9]).toHaveTextContent("Jul 14, 2026");
  });
});

describe("CallBoard: stats row", () => {
  it("reports resolved calls, win rate and both streaks straight from the engine", async () => {
    // 5 calls: win, win, loss, win, win -> 4 wins (80%), current streak 2,
    // best streak 2.
    saveResolvedCalls([
      resolvedCall({ date: "2026-08-17", score: 2 }),
      resolvedCall({ date: "2026-08-18", pick: "up-strong", actual: "up", score: 1 }),
      resolvedCall({ date: "2026-08-19", pick: "up", actual: "down", score: 0 }),
      resolvedCall({ date: "2026-08-20", score: 2 }),
      resolvedCall({ date: "2026-08-21", score: 2 }),
    ]);
    freezeClock(WEDNESDAY_BEFORE_OPEN);
    await renderBoard();

    await waitFor(() => {
      expect(screen.getByText("Calls resolved").previousElementSibling).toHaveTextContent("5");
    });
    expect(screen.getByText("Win rate").previousElementSibling).toHaveTextContent("80%");
    expect(screen.getByText("Current streak").previousElementSibling).toHaveTextContent("2");
    expect(screen.getByText("Best streak").previousElementSibling).toHaveTextContent("2");
  });
});

describe("callOutcomeFor", () => {
  it("splits the engine's single zero score by how far apart the buckets sit", () => {
    expect(
      callOutcomeFor(resolvedCall({ date: "d", pick: "down", actual: "down", score: 2 })),
    ).toBe("exact");
    expect(
      callOutcomeFor(resolvedCall({ date: "d", pick: "down-strong", actual: "down", score: 1 })),
    ).toBe("right-direction");
    expect(callOutcomeFor(resolvedCall({ date: "d", pick: "down", actual: "up", score: 0 }))).toBe(
      "near-miss",
    );
    expect(
      callOutcomeFor(resolvedCall({ date: "d", pick: "down", actual: "up-strong", score: 0 })),
    ).toBe("far-miss");
  });
});
