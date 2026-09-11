import { RESULTS_SCHEMA_VERSION, type Sp500PrefixResult } from "@hadiknowntrades/core";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  getCutGameHistory,
  recordCutCompletion,
  saveCutGameState,
  type CutGameState,
} from "@/lib/the-cut-storage";
import { stubPrefersReducedMotion } from "@/lib/stub-prefers-reduced-motion.test-util";
import { TheCut } from "./TheCut";

// The Cut's own default range as of issue #238 -- see THE_CUT_DEFAULT_RANGE.
const RANGE = "1D";

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

// A leading-anchored regex, not the exact string -- the Explore panel's
// own instance of each control carries a real, code-review-added
// "(Explore other windows)" accessible-name suffix (see TheCut.tsx's
// own CutBoardProps.accessibleNameSuffix doc comment) to disambiguate it
// from the main game's own identically-purposed controls when both are
// mounted at once. A prefix match keeps these two helpers working
// unchanged against either scope.
function guessInput(panel: ReturnType<typeof within>) {
  return panel.getByRole("spinbutton", { name: /^Your guess, as a number/ });
}

function submit(panel: ReturnType<typeof within>, value: number) {
  fireEvent.change(guessInput(panel), { target: { value: String(value) } });
  fireEvent.click(panel.getByRole("button", { name: /^Submit guess/ }));
}

/**
 * Opens "Explore other windows" and returns a query scope for just its
 * own nested `<details>` subtree -- the scoping is required, not just a
 * convenience: the main game's own guess input/"Submit guess" button
 * share the exact same accessible name as Explore's own (a second,
 * fully independent game), so an unscoped `panel.getByRole(...)` for
 * either throws a "multiple elements found" error the instant both are
 * on screen at once (the main game's own fresh, not-yet-done state
 * alongside Explore's own).
 *
 * **`userEvent.click`, not `fireEvent.click`, on the `<summary>`
 * itself.** A plain `fireEvent.click` does synchronously flip the
 * native `open` attribute (confirmed live -- jsdom's own default click
 * action for a `<summary>`), but React's `onToggle` handler (which is
 * what actually mounts `CutExplorePanel`, per `CutExploreOtherWindows`'s
 * own `opened` latch) listens for the DOM `toggle` event, which fires
 * queued rather than synchronously with the click -- an unawaited
 * `fireEvent.click` leaves that queued event unflushed, so a synchronous
 * assertion right after sees the `<details>` open but its own content
 * still empty. `TradeReplay.test.tsx`'s own identical lazy-disclosure
 * tests (issue #209's chart-open toggle) already establish `await
 * user.click(...)` as this app's precedent for exactly this gap.
 */
async function openExplore(panel: ReturnType<typeof within>) {
  const user = userEvent.setup();
  await user.click(panel.getByText("Explore other windows"));
  const details = panel.getByText("Explore other windows").closest("details");
  if (!details) throw new Error("Explore other windows <details> not found");
  return within(details);
}

/**
 * Never invoke the requestAnimationFrame callback -- the reveal panel's
 * count-up figures stay stuck at their starting values (issue #239). The
 * sr-only twin spans (CutReveal.tsx's own doc comment) already hold each
 * figure's real final value regardless of animation state, which is what
 * keeps every pre-#239 assertion in this file passing unmodified: a
 * `getByText` for a final value still resolves uniquely to the sr-only
 * span, since the visible (aria-hidden) figure is showing something else
 * (its own starting value) the whole time. Mirrors
 * HeroStat.test.tsx's own identical-purpose stub.
 */
function neverLandTheReveal() {
  vi.spyOn(window, "requestAnimationFrame").mockReturnValue(1);
}

/** Lands the count-up in a single frame -- mirrors HeroStat.test.tsx's own `landTheReveal` helper. */
function landTheReveal() {
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb: FrameRequestCallback) => {
    cb(performance.now() + 100_000);
    return 1;
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
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

  it("idle: shows the ticker strip and no guess feedback yet, with no visible range picker in the main flow", async () => {
    const panel = await expandBoard();

    expect(panel.getByText("NVDA")).toBeInTheDocument(); // real rank #1 by weight
    // No range picker in the main play experience any more (a direct
    // user request, not a filed issue) -- every CUT_RANGES entry except
    // "1D" now lives behind "Explore other windows" instead, closed by
    // default.
    expect(panel.queryByRole("group", { name: "The Cut date range" })).not.toBeInTheDocument();
    expect(panel.getByText("Explore other windows")).toBeInTheDocument();
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
    neverLandTheReveal();
    const panel = await expandBoard();

    submit(panel, 3); // bestN

    expect(await panel.findAllByText(/correct/i)).not.toHaveLength(0);
    // No more guess controls once done.
    expect(panel.queryByRole("button", { name: "Submit guess" })).not.toBeInTheDocument();
    expect(panel.getByText("100%")).toBeInTheDocument(); // edge captured
    // Ranks off isn't animated, unlike the two streak figures right next
    // to it (issue #239) -- both of which also read "0" here, stuck at
    // their own starting value since the tween never lands in this test
    // (neverLandTheReveal). Scoped to the one span with no aria-hidden
    // (the animated ones both carry it) to disambiguate.
    expect(panel.getByText("0", { selector: "span:not([aria-hidden])" })).toBeInTheDocument();
    const currentStreakLabel = panel.getByText("Current streak");
    expect(currentStreakLabel.previousElementSibling).toHaveTextContent("1");
    expect(getCutGameHistory()).toEqual([{ range: RANGE, won: true, edgeCapturedPct: 100 }]);

    // The main game's own default reveal is the animated ticker strip
    // (a direct user request, not a filed issue) -- not the chart, which
    // moved to "Explore other windows" (see the describe block below).
    expect(panel.queryByRole("img")).not.toBeInTheDocument();
    expect(panel.getByTestId("cut-reveal-strip")).toBeInTheDocument();
    expect(panel.getByTestId("cut-reveal-cutline")).toBeInTheDocument();
    // "Play again" is offered.
    expect(panel.getByRole("button", { name: "Play again" })).toBeInTheDocument();
  });

  it("lose: running out of attempts without an exact guess ends the game as a loss", async () => {
    saveCutGameState(RANGE, freshState());
    neverLandTheReveal();
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
    neverLandTheReveal();
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
    // CutBoard/CutReveal render regardless of whether the <details> is
    // open (see TheCut.tsx's own "hasOpenedPanel" doc comment) -- the
    // reveal's count-up figures mount here too, even though this test
    // never clicks the summary.
    neverLandTheReveal();
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
    neverLandTheReveal();
    const panel = await expandBoard();

    submit(panel, 3); // wins the 1Y game -- a real, first streak entry for 1Y

    const currentStreakLabel = panel.getByText("Current streak");
    // Would read "3" (2 stray 5Y wins + this 1Y win) without the fix.
    expect(currentStreakLabel.previousElementSibling).toHaveTextContent("1");
    const bestStreakLabel = panel.getByText("Best streak");
    expect(bestStreakLabel.previousElementSibling).toHaveTextContent("1");
  });

  it("keeps the outer tile mounted and open across a range switch inside 'Explore other windows', even while the new range's data is still loading (regression)", async () => {
    let releaseThirdFetch!: (value: Response) => void;
    let fetchCallCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        fetchCallCount += 1;
        // Call 1: the main game's own fixed-range fetch. Call 2:
        // Explore's own default-range fetch, fired once it's opened.
        // Both resolve immediately -- only the *third* (a range switch
        // made from inside Explore) stays pending, so the assertion
        // below runs while useSp500Prefix is genuinely mid-"loading"
        // for that new range.
        if (fetchCallCount <= 2) {
          return Promise.resolve(new Response(JSON.stringify(RESULT), { status: 200 }));
        }
        return new Promise<Response>((resolve) => {
          releaseThirdFetch = resolve;
        });
      }),
    );

    const panel = await expandBoard();
    expect(screen.getByTestId("the-cut-panel")).toBeInTheDocument();

    await openExplore(panel);
    expect(panel.getByRole("group", { name: "The Cut date range" })).toBeInTheDocument();

    fireEvent.click(panel.getByRole("button", { name: "5Y" }));

    // The outer tile (and its own <details> shell) must still be mounted
    // and open -- not swapped out for the collapsed placeholder -- and
    // the still-open Explore disclosure must still show its own picker,
    // while the new range's fetch is still pending.
    expect(screen.getByTestId("the-cut-summary")).toBeInTheDocument();
    expect(screen.getByTestId("the-cut-panel")).toBeInTheDocument();
    expect(panel.getByRole("group", { name: "The Cut date range" })).toBeInTheDocument();
    expect(screen.queryByTestId("the-cut-error")).not.toBeInTheDocument();

    releaseThirdFetch(new Response(JSON.stringify(RESULT), { status: 200 }));
    await waitFor(() => {
      expect(panel.getByRole("button", { name: "5Y" })).toHaveAttribute("aria-pressed", "true");
    });
    // Still the same open tile and open Explore panel afterward -- no
    // collapse-then-reopen-closed cycle for either.
    expect(screen.getByTestId("the-cut-summary")).toBeInTheDocument();
    expect(panel.getByRole("group", { name: "The Cut date range" })).toBeInTheDocument();
  });

  // Issue #239: the reveal panel's count-up + celebration burst, mirroring
  // HeroStat.test.tsx's own equivalent describe blocks ("burst magnitude
  // scaling", "reveal accent") as closely as this game's own shape allows.
  describe("count-up + celebration (issue #239)", () => {
    it("starts the visible score at 0%, not the final value, before the tween lands", async () => {
      saveCutGameState(RANGE, freshState());
      neverLandTheReveal();
      const panel = await expandBoard();

      submit(panel, 3); // exact win -> 100% edge captured

      // The sr-only twin already reads the real final value; the visible
      // (aria-hidden) figure is still stuck at its starting value (0%) --
      // mirrors HeroStat.test.tsx's own "starts the visible... figure at
      // the starting capital, not the final value" test.
      expect(panel.getByText("0%")).toBeInTheDocument();
      expect(panel.getByText("100%", { selector: ".sr-only" })).toBeInTheDocument();
    });

    it("shows the final score and streak figures, doubled up (visible + sr-only), once the tween lands", async () => {
      saveCutGameState(RANGE, freshState());
      landTheReveal();
      const panel = await expandBoard();

      submit(panel, 3);

      // Visible + sr-only both now read the same landed value.
      expect(panel.getAllByText("100%")).toHaveLength(2);
      const currentStreakLabel = panel.getByText("Current streak");
      expect(currentStreakLabel.previousElementSibling).toHaveTextContent("1");
      expect(currentStreakLabel.previousElementSibling?.previousElementSibling).toHaveTextContent(
        "1",
      );
    });

    it("fires the full-tier celebration burst on an exact win (100% edge captured)", async () => {
      saveCutGameState(RANGE, freshState());
      landTheReveal();
      const panel = await expandBoard();

      submit(panel, 3);

      expect(panel.getByTestId("celebration-burst").children.length).toBe(24);
    });

    it("does not fire the celebration burst under reduced motion, even on an exact win", async () => {
      saveCutGameState(RANGE, freshState());
      stubPrefersReducedMotion(true);
      landTheReveal();
      const panel = await expandBoard();

      submit(panel, 3);

      expect(panel.queryByTestId("celebration-burst")).not.toBeInTheDocument();
    });

    it("has not fired yet mid-count, before the reveal lands, even on an exact win", async () => {
      saveCutGameState(RANGE, freshState());
      neverLandTheReveal();
      const panel = await expandBoard();

      submit(panel, 3);

      expect(panel.queryByTestId("celebration-burst")).not.toBeInTheDocument();
    });

    it("does not fire the celebration burst when the final guess captured none of the available edge", async () => {
      saveCutGameState(RANGE, freshState());
      landTheReveal();
      const panel = await expandBoard();

      // Six guesses of "5" (bestN=3) -- never exact, and n5's own ending
      // balance equals the n500 baseline, so the final guess captures 0%
      // of the available edge (see the-cut-scoring.test.ts's own
      // identical fixture-based assertion).
      for (let i = 0; i < 6; i++) {
        submit(panel, 5);
      }

      expect(panel.queryByTestId("celebration-burst")).not.toBeInTheDocument();
    });

    it("fires a smaller-than-full burst for a non-exact result that still captured most of the available edge (modest tier)", async () => {
      saveCutGameState(RANGE, freshState());
      landTheReveal();
      const panel = await expandBoard();

      // Five wasted guesses, then a final (6th) guess of 4 -- not exact,
      // but (28-22)/(30-22) = 75% of the available edge: inside the
      // modest tier (60-84%, the-cut-scoring.ts's own
      // cutCelebrationIntensity), not suppressed and not the full tier.
      for (let i = 0; i < 5; i++) {
        submit(panel, 1);
      }
      submit(panel, 4);

      const burst = panel.getByTestId("celebration-burst");
      expect(burst.children.length).toBeGreaterThan(0);
      expect(burst.children.length).toBeLessThan(24);
    });
  });

  // A direct user request, not a filed issue: the main game's own
  // default reveal replaces TheCutChart with an animated "slide to the
  // cut line" ticker strip.
  describe("slide-to-the-cut-line reveal strip (main game default)", () => {
    it("marks companies #1..bestN as held and the rest as excluded", async () => {
      saveCutGameState(RANGE, freshState());
      neverLandTheReveal();
      const panel = await expandBoard();

      submit(panel, 3); // bestN=3, universeSize=5

      const chips = panel.getAllByTestId("cut-reveal-chip");
      expect(chips).toHaveLength(5);
      expect(chips.map((chip) => chip.dataset.held)).toEqual([
        "true",
        "true",
        "true",
        "false",
        "false",
      ]);
      // The cut-line divider itself is present, right at the boundary.
      expect(panel.getByTestId("cut-reveal-cutline")).toBeInTheDocument();
    });

    it("marks the player's own final guess distinctly from the cut line, when they differ", async () => {
      saveCutGameState(RANGE, freshState());
      neverLandTheReveal();
      const panel = await expandBoard();

      submit(panel, 5); // too high
      submit(panel, 5);
      submit(panel, 5);
      submit(panel, 5);
      submit(panel, 5);
      submit(panel, 4); // final (6th) guess -- not bestN=3

      const chips = panel.getAllByTestId("cut-reveal-chip");
      const guessed = chips.find((chip) => chip.dataset.guess === "true");
      expect(guessed).toHaveTextContent("AMZN"); // rank #4 in the fixture
    });

    it("under normal motion, adds the bounce+glow flourish only once the slide's own settle delay elapses", async () => {
      saveCutGameState(RANGE, freshState());
      neverLandTheReveal();
      const panel = await expandBoard();
      // Enabled only after expandBoard's own async findBy* calls have
      // already resolved -- testing-library's async queries poll via a
      // real setTimeout internally, which would otherwise hang forever
      // against a faked clock nothing ever advances.
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

      submit(panel, 3); // exact win

      const cutline = panel.getByTestId("cut-reveal-cutline");
      expect(cutline.className).not.toContain("cut-line-glow");
      expect(cutline.className).not.toContain("cut-line-settle");

      act(() => {
        vi.advanceTimersByTime(650);
      });

      expect(cutline.className).toContain("cut-line-glow");
      expect(cutline.className).toContain("cut-line-settle");
    });

    it("under reduced motion, lands on the cut line immediately -- no slide, no delay", async () => {
      saveCutGameState(RANGE, freshState());
      stubPrefersReducedMotion(true);
      neverLandTheReveal();
      const panel = await expandBoard();

      submit(panel, 3);

      const cutline = panel.getByTestId("cut-reveal-cutline");
      expect(cutline.className).toContain("cut-line-glow");
      expect(cutline.className).toContain("cut-line-settle");
    });
  });

  // A direct user request, not a filed issue: every CUT_RANGES entry
  // except "1D" moved behind this nested disclosure, still playing the
  // exact same guess-then-reveal CutBoard mechanic, with its own reveal
  // keeping the original TheCutChart.
  describe('"Explore other windows"', () => {
    it("is closed by default and does not fetch its own range until opened", async () => {
      const fetchMock = vi.fn(() =>
        Promise.resolve(new Response(JSON.stringify(RESULT), { status: 200 })),
      );
      vi.stubGlobal("fetch", fetchMock);

      const panel = await expandBoard();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith(`/api/sp500-prefix?range=${RANGE}`);
      expect(panel.queryByRole("group", { name: "The Cut date range" })).not.toBeInTheDocument();

      const explore = await openExplore(panel);

      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
      expect(fetchMock).toHaveBeenCalledWith("/api/sp500-prefix?range=1W"); // its own default range
      expect(explore.getByRole("group", { name: "The Cut date range" })).toBeInTheDocument();
    });

    // Code-review finding: Tailwind's default (unnamed) `.group`/
    // `group-open:` variant has no nearest-ancestor scoping -- it's
    // satisfied by ANY ancestor `.group[open]`, not just the nearest
    // one. Since this nested disclosure only ever renders while the
    // OUTER "The Cut" tile is already open, an unnamed `group-open:` on
    // its own chevron would react to the outer tile's open state
    // instead of its own, permanently rendering rotated. jsdom applies
    // no stylesheet (this repo's own established test-environment
    // limitation, documented repeatedly elsewhere in this file), so this
    // can only assert the className strings carry the fix's own named
    // group/variant pair, not that the wrong element visually rotates --
    // see the PR description for the live-browser confirmation.
    it("scopes its own chevron to a named group, not the outer tile's own unnamed one (regression)", async () => {
      const panel = await expandBoard();
      const details = panel.getByText("Explore other windows").closest("details");
      expect(details).toHaveClass("group/explore");
      expect(details?.className).not.toMatch(/(?:^|\s)group(?:\s|$)/);

      const chevron = within(details!).getByText("▸");
      expect(chevron).toHaveClass("group-open/explore:rotate-90");
      expect(chevron.className).not.toMatch(/(?:^|\s)group-open:rotate-90(?:\s|$)/);
    });

    it("offers every CUT_RANGES entry except '1D', which the main game already owns", async () => {
      const panel = await expandBoard();
      const explore = await openExplore(panel);

      const group = within(explore.getByRole("group", { name: "The Cut date range" }));
      expect(group.queryByRole("button", { name: "1D" })).not.toBeInTheDocument();
      for (const label of ["1W", "1M", "3M", "1Y", "5Y", "Max"]) {
        expect(group.getByRole("button", { name: label })).toBeInTheDocument();
      }
      expect(group.getByRole("button", { name: "1W" })).toHaveAttribute("aria-pressed", "true");
    });

    it("plays its own independent game, revealing with the original chart rather than the slide strip", async () => {
      neverLandTheReveal();
      const panel = await expandBoard();
      const explore = await openExplore(panel);

      // Same guess-then-reveal mechanic as the main game -- guess/submit
      // controls exist for its own range too, once its own fetch
      // resolves. Scoped to `explore`, not `panel`: the main game's own
      // fresh, not-yet-done guess input shares the identical accessible
      // name.
      await explore.findByRole("spinbutton", { name: /^Your guess, as a number/ });
      submit(explore, 3); // its own default range's bestN, from the shared RESULT fixture

      expect(await explore.findAllByText(/correct/i)).not.toHaveLength(0);
      // The chart, not the new strip -- exploring the full historical
      // curve is where the chart still lives.
      expect(explore.getByRole("img")).toBeInTheDocument();
      expect(explore.queryByTestId("cut-reveal-strip")).not.toBeInTheDocument();
    });

    it("does not affect the main game's own state (independent per-range storage)", async () => {
      saveCutGameState(RANGE, freshState({ guesses: [5], done: false }));
      const panel = await expandBoard();
      expect(await panel.findByText(/too high/i)).toBeInTheDocument();

      const explore = await openExplore(panel);

      // The main game's own "too high" feedback is still there,
      // unaffected by Explore having mounted alongside it.
      expect(panel.getByText(/too high/i)).toBeInTheDocument();
      expect(explore.getByRole("button", { name: "1W" })).toHaveAttribute("aria-pressed", "true");
    });

    // Code-review finding: the main game's own guess input/submit
    // button and Explore's own instance used to share the exact same
    // accessible name, which threw a "multiple elements found" error
    // the instant both were on screen and not-yet-done at once.
    it("gives its own guess input and submit button a distinct accessible name from the main game's", async () => {
      const panel = await expandBoard();
      const explore = await openExplore(panel);
      await explore.findByRole("spinbutton", { name: /^Your guess, as a number/ });

      // Unscoped queries against the whole document must not throw --
      // each control's own accessible name is unique across both games.
      expect(
        screen.getByRole("spinbutton", { name: "Your guess, as a number" }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("spinbutton", { name: "Your guess, as a number (Explore other windows)" }),
      ).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Submit guess" })).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Submit guess (Explore other windows)" }),
      ).toBeInTheDocument();
      // The visible text of Explore's own button is still plain "Submit
      // guess" -- only its accessible name carries the suffix.
      expect(
        screen.getByRole("button", { name: "Submit guess (Explore other windows)" }),
      ).toHaveTextContent("Submit guess");
    });
  });
});
