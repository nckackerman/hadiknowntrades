import { RESULTS_SCHEMA_VERSION, type WindowResult } from "@hadiknowntrades/core";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { stubMatchMedia } from "@/lib/stub-match-media.test-util";
import { DAILY_CHALLENGE_RANGE } from "@/lib/use-daily-challenge";
import { CALL_BOARD_SERIES_RANGE } from "@/lib/use-call-board";

const replace = vi.fn();
let search = "";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
  useSearchParams: () => new URLSearchParams(search),
}));

// Imported after the mock above so ResultsPage picks up the mocked
// next/navigation instead of the real hooks, which require a full
// Next.js app router context this unit test doesn't set up.
const { ResultsPage } = await import("./ResultsPage");

// Fixed set of test anchors (issue #75's day-granularity picker), all
// within the same month so tests below never need to navigate the
// calendar to a different month view -- CustomRangeSelector's own
// default-viewed-month is the newest anchor's month (see
// defaultViewedMonth in CustomRangeSelector.tsx) when nothing is
// selected, which is 2024-01 here.
const TEST_ANCHORS = ["2024-01-05", "2024-01-10", "2024-01-20"];

/**
 * A minimal 5Y window result, for issue #133's page-order and ritual
 * tests -- the only ones in this file that need /api/results to actually
 * resolve. The window model is deliberate: it has no guess-then-reveal
 * gate (issue #91 scoped that to intraday-daily), so its headline figure
 * is on screen the moment the fetch lands, which is exactly the "hero
 * reveal" these tests anchor the page order on.
 */
const WINDOW_RESULT: WindowResult = {
  schemaVersion: RESULTS_SCHEMA_VERSION,
  model: "window",
  range: "5Y",
  generatedAt: "2026-08-26T19:50:21.468Z",
  dataAsOf: "2026-08-26",
  startDate: "2021-08-26",
  endDate: "2026-08-26",
  maxTrades: 3,
  startingCapital: 20,
  endingBalance: 1100,
  trades: [
    {
      ticker: "AAPL",
      direction: "long",
      openDate: "2021-08-26",
      openPrice: 10,
      closeDate: "2026-08-26",
      closePrice: 550,
    },
  ],
  worstCase: {
    endingBalance: 4,
    trades: [
      {
        ticker: "GOOG",
        direction: "long",
        openDate: "2021-08-26",
        openPrice: 100,
        closeDate: "2026-08-26",
        closePrice: 20,
      },
    ],
  },
  longShort: {
    endingBalance: 2200,
    trades: [
      {
        ticker: "COIN",
        direction: "short",
        openDate: "2021-08-26",
        openPrice: 100,
        closeDate: "2026-08-26",
        closePrice: 10,
      },
    ],
    worstCase: {
      endingBalance: 2,
      trades: [
        {
          ticker: "TSLA",
          direction: "short",
          openDate: "2021-08-26",
          openPrice: 10,
          closeDate: "2026-08-26",
          closePrice: 100,
        },
      ],
    },
  },
  benchmark: null,
  benchmarkSeries: null,
  universeSize: 503,
  skippedTickers: [],
};

/**
 * A two-bar Today's Close session -- the shortest thing `isPlayableSession`
 * accepts, so the ritual integration test below can play a *real* session
 * to a *real* settlement in one "Step" instead of 78. The zero-move
 * settlement it produces ("Along for the ride") is the mechanic's own exact
 * tie, not a rounding coincidence -- see lib/beat-the-bench.ts.
 */
const SESSION = {
  schemaVersion: RESULTS_SCHEMA_VERSION,
  generatedAt: "2026-08-27T00:52:58.157Z",
  ticker: "SPY",
  barIntervalMinutes: 5,
  date: "2026-08-26",
  bars: [
    { time: "09:30:00", close: 100 },
    { time: "09:35:00", close: 101 },
  ],
};

describe("ResultsPage", () => {
  beforeEach(() => {
    replace.mockClear();
    search = "";
    // /api/custom-anchors resolves immediately with a fixed manifest so
    // CustomRangeSelector's calendar grid is interactive in every test
    // below; every other request (/api/results?...) never resolves --
    // these tests only care about range/URL wiring, not the fetched
    // result data, so leaving the panel in "loading" is fine.
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.startsWith("/api/custom-anchors")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({ schemaVersion: RESULTS_SCHEMA_VERSION, anchors: TEST_ANCHORS }),
              { status: 200 },
            ),
          );
        }
        return new Promise(() => {});
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // CustomRangeSelector/ModeToggle render exactly once, inside a single
  // "More options" <details> disclosure that collapses this group at
  // every viewport width (issue #103) -- see ResultsPage.tsx's own doc
  // comment. jsdom loads no stylesheet in this test file, so the
  // disclosure's content reports as "visible" to Testing Library queries
  // regardless of its native open/closed state.
  function moreOptions() {
    return within(screen.getByTestId("controls-more"));
  }

  /**
   * Opens CustomRangeSelector's own calendar popover (a native
   * <details>/<summary>, distinct from the outer "More options"
   * disclosure -- see CustomRangeSelector.tsx's own doc comment) within
   * `scope`, then clicks the day cell for `anchor` (must be one of
   * TEST_ANCHORS, and in the calendar's currently-viewed month -- see
   * this file's own TEST_ANCHORS comment for why that's always true
   * here without any month navigation).
   */
  async function selectAnchorViaCalendar(
    user: ReturnType<typeof userEvent.setup>,
    scope: ReturnType<typeof within>,
    anchor: string,
  ) {
    await user.click(await scope.findByTestId("custom-range-trigger"));
    const day = String(Number(anchor.slice(8, 10)));
    await user.click(scope.getByRole("button", { name: day }));
  }

  it("defaults to 1W when the URL has no range param", () => {
    render(<ResultsPage />);

    expect(screen.getByRole("button", { name: "1W" })).toHaveAttribute("aria-pressed", "true");
    expect(fetch).toHaveBeenCalledWith("/api/results?range=1W");
  });

  it("fetches the custom-anchors manifest exactly once", async () => {
    render(<ResultsPage />);

    // ResultsPage fetches the manifest exactly once itself and threads it
    // into CustomRangeSelector as a prop, rather than CustomRangeSelector
    // calling useCustomAnchors() itself -- confirm the control actually
    // renders as interactive (not stuck on "Loading start dates…") before
    // counting calls, so a regression that broke the sharing and left it
    // perpetually loading wouldn't slip past a naive call count check for
    // the wrong reason. (Before issue #103 collapsed the desktop/mobile
    // duplication from issue #63 into one instance, this asserted the
    // fetch was still deduplicated across two mounted copies -- now
    // there's only ever one copy to begin with.)
    await screen.findAllByTestId("custom-range-trigger");

    const customAnchorsCalls = vi
      .mocked(fetch)
      .mock.calls.filter(([input]) => String(input).startsWith("/api/custom-anchors"));
    expect(customAnchorsCalls).toHaveLength(1);
  });

  it("reads the initial range from the URL, case-insensitively", () => {
    search = "range=max";
    render(<ResultsPage />);

    expect(screen.getByRole("button", { name: "Max" })).toHaveAttribute("aria-pressed", "true");
    expect(fetch).toHaveBeenCalledWith("/api/results?range=MAX");
  });

  it("falls back to the default range for an unrecognized URL param", () => {
    search = "range=bogus";
    render(<ResultsPage />);

    expect(screen.getByRole("button", { name: "1W" })).toHaveAttribute("aria-pressed", "true");
  });

  it("writes the selected range to the URL via router.replace when a range button is clicked", async () => {
    const user = userEvent.setup();
    render(<ResultsPage />);

    await user.click(screen.getByRole("button", { name: "5Y" }));

    expect(replace).toHaveBeenCalledWith("/?range=5Y", { scroll: false });
  });

  describe("mode (issue #13)", () => {
    it("defaults to long-only when the URL has no mode param", () => {
      render(<ResultsPage />);

      expect(moreOptions().getByRole("button", { name: "Long only" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
    });

    it("reads the initial mode from the URL, case-insensitively", () => {
      search = "mode=LONG-SHORT";
      render(<ResultsPage />);

      expect(moreOptions().getByRole("button", { name: "Long + short" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
    });

    it("falls back to the default mode for an unrecognized URL param", () => {
      search = "mode=bogus";
      render(<ResultsPage />);

      expect(moreOptions().getByRole("button", { name: "Long only" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
    });

    it("writes the selected mode to the URL via router.replace when the toggle is clicked", async () => {
      const user = userEvent.setup();
      render(<ResultsPage />);

      await user.click(moreOptions().getByRole("button", { name: "Long + short" }));

      expect(replace).toHaveBeenCalledWith("/?mode=long-short", { scroll: false });
    });

    it("preserves the current range when only the mode changes", async () => {
      search = "range=5Y";
      const user = userEvent.setup();
      render(<ResultsPage />);

      await user.click(moreOptions().getByRole("button", { name: "Long + short" }));

      expect(replace).toHaveBeenCalledWith("/?range=5Y&mode=long-short", { scroll: false });
    });
  });

  describe("custom start-date anchor mode (issue #11, day-granularity since issue #75)", () => {
    it("fetches the anchor-specific endpoint and marks no preset pill as selected when ?anchor= is present", () => {
      const anchor = TEST_ANCHORS[0]!;
      search = `anchor=${anchor}`;
      render(<ResultsPage />);

      expect(fetch).toHaveBeenCalledWith(`/api/results?anchor=${anchor}`);
      for (const name of ["1W", "1M", "3M", "1Y", "5Y", "Max"]) {
        expect(screen.getByRole("button", { name })).toHaveAttribute("aria-pressed", "false");
      }
    });

    it("does not also fetch a preset range's own result while in anchor mode", () => {
      const anchor = TEST_ANCHORS[0]!;
      search = `anchor=${anchor}`;
      render(<ResultsPage />);

      // The view's own result comes from exactly one of useResults /
      // useCustomResults -- never both (see ResultsPage.tsx). The Call
      // Board (issue #129) and the daily hero (issue #161) both
      // independently fetch a preset range's result too, but for
      // completely unrelated reasons -- the Call Board reads only that
      // result's range-independent `benchmarkSeries` (issue #126); the
      // daily hero reads only its `days` array for the most recently
      // completed trading day (issue #161) -- and both always ask for
      // the same fixed range (1W) regardless of what the page is
      // showing, so neither can be confused for the view's own result
      // fetch.
      const requested = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.map(
        (call) => call[0] as string,
      );
      expect(requested.filter((url) => url.includes("range="))).toEqual([
        `/api/results?range=${CALL_BOARD_SERIES_RANGE}`,
        `/api/results?range=${DAILY_CHALLENGE_RANGE}`,
      ]);
    });

    it("falls back to range mode for a malformed ?anchor= value", () => {
      search = "anchor=not-a-date";
      render(<ResultsPage />);

      expect(screen.getByRole("button", { name: "1W" })).toHaveAttribute("aria-pressed", "true");
      expect(fetch).toHaveBeenCalledWith("/api/results?range=1W");
    });

    it("writes the selected anchor to the URL, clearing ?range=, when a start date is chosen", async () => {
      const user = userEvent.setup();
      const anchor = TEST_ANCHORS[2]!;
      search = "range=5Y";
      render(<ResultsPage />);

      await selectAnchorViaCalendar(user, moreOptions(), anchor);

      expect(replace).toHaveBeenCalledWith(`/?anchor=${anchor}`, { scroll: false });
    });

    it("clears ?anchor= when a preset range button is clicked while in anchor mode", async () => {
      const user = userEvent.setup();
      const anchor = TEST_ANCHORS[0]!;
      search = `anchor=${anchor}`;
      render(<ResultsPage />);

      await user.click(screen.getByRole("button", { name: "5Y" }));

      expect(replace).toHaveBeenCalledWith("/?range=5Y", { scroll: false });
    });
  });

  describe("anchor and mode combined (issue #11/#13 integration)", () => {
    it("fetches the anchor-specific endpoint and reads mode from the URL when both ?anchor= and ?mode= are set", () => {
      const anchor = TEST_ANCHORS[0]!;
      search = `anchor=${anchor}&mode=long-short`;
      render(<ResultsPage />);

      expect(fetch).toHaveBeenCalledWith(`/api/results?anchor=${anchor}`);
      expect(moreOptions().getByRole("button", { name: "Long + short" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
    });

    it("preserves the current anchor when only the mode changes", async () => {
      const anchor = TEST_ANCHORS[0]!;
      search = `anchor=${anchor}`;
      const user = userEvent.setup();
      render(<ResultsPage />);

      await user.click(moreOptions().getByRole("button", { name: "Long + short" }));

      expect(replace).toHaveBeenCalledWith(`/?anchor=${anchor}&mode=long-short`, {
        scroll: false,
      });
    });

    it("preserves the current mode when the anchor changes", async () => {
      const anchor = TEST_ANCHORS[2]!;
      search = "range=5Y&mode=long-short";
      const user = userEvent.setup();
      render(<ResultsPage />);

      await selectAnchorViaCalendar(user, moreOptions(), anchor);

      expect(replace).toHaveBeenCalledWith(`/?mode=long-short&anchor=${anchor}`, {
        scroll: false,
      });
    });
  });

  describe('single "More options" disclosure at every viewport width (issue #103)', () => {
    // Issue #103 collapsed the old desktop-always-visible/mobile-<details>
    // duplication (issue #63) into one instance rendered unconditionally,
    // not gated by any sm: breakpoint -- so there's exactly one
    // "controls-more" node, and it lives inside a <details> whose summary
    // reads "More options", at any screen size.
    it("renders RangeSelector unconditionally and CustomRangeSelector/ModeToggle only inside a single More options disclosure", () => {
      render(<ResultsPage />);

      expect(screen.getByRole("group", { name: "Preset date range" })).toBeInTheDocument();
      expect(screen.getAllByTestId("controls-more")).toHaveLength(1);
      const summary = screen.getByText("More options");
      expect(summary.closest("details")).toContainElement(screen.getByTestId("controls-more"));
    });
  });

  describe("The Call Board placement (issues #122/#129)", () => {
    // Every /api/results request in this file never resolves (see the
    // beforeEach stub), so ResultsPanel is stuck in its loading skeleton
    // throughout -- which is exactly the state issue #122's decision is
    // about: a mechanic section mounted at the page level stays playable
    // when the hindsight result is slow or failing, and one mounted
    // inside ResultsPanel's model branches would not.
    it("renders the board even while the results fetch has not resolved", async () => {
      render(<ResultsPage />);

      expect(screen.getByRole("heading", { name: "The Call Board" })).toBeInTheDocument();
      // The board's own three slots land after its mount-time hydration
      // correction (see lib/use-call-board.ts), independently of the
      // results fetch this test never resolves.
      expect(await screen.findAllByRole("group", { name: /^Your call for/ })).toHaveLength(3);
    });

    it("mounts exactly one board, as a sibling of (not nested inside) ResultsPanel", () => {
      render(<ResultsPage />);

      const board = screen.getByRole("heading", { name: "The Call Board" }).closest("section");
      const skeleton = screen.getByText("Loading results…");
      expect(board).not.toBeNull();
      expect(board).not.toContainElement(skeleton);
      // Issue #165 demoted ResultsPanel (still stuck in its loading
      // skeleton throughout this describe block) into the collapsed
      // "Explore other windows" section at the very bottom of the page --
      // so the skeleton now *follows* the board in document order, the
      // reverse of the pre-#165 layout, while the "not nested inside"
      // half of this test's own name still holds unchanged.
      expect(
        board!.compareDocumentPosition(skeleton) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    });
  });

  describe("Beat the Bench is a section, not a branch of the result panel (issues #122/#131/#163)", () => {
    // Same reasoning as the Call Board block directly above, for the
    // other mechanic mounted at this level: /api/results never resolves
    // in this file, and the daily ritual still has to be there.
    //
    // It renders collapsed by default since issue #163 -- a compact
    // "Can you do better?" card, not the full "Beat the Bench" heading
    // and mode chooser, which only exist once that card is clicked (see
    // the "Beat the Bench: collapsed by default" describe block below).
    it("renders even while the hindsight result is still loading", () => {
      render(<ResultsPage />);

      expect(screen.getByRole("button", { name: /can you do better\?/i })).toBeInTheDocument();
      expect(
        screen.getByText("Play today's real session against the market, live."),
      ).toBeInTheDocument();
    });

    it("mounts exactly once, as a direct child of the page column, ahead of The Call Board", () => {
      const { container } = render(<ResultsPage />);
      const column = container.firstElementChild!;
      const cards = screen.getAllByRole("button", { name: /can you do better\?/i });

      expect(cards).toHaveLength(1);
      const section = cards[0]!.closest("section")!;
      expect(section.parentElement).toBe(column);
      // Issue #163 moved this section ahead of the header/range explorer/
      // ResultsPanel entirely (directly after DailyHero) -- still ahead
      // of The Call Board either way.
      const board = screen.getByRole("heading", { name: "The Call Board" }).closest("section")!;
      expect(
        section.compareDocumentPosition(board) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    });
  });

  describe("Beat the Bench: collapsed by default, expands in place (issue #163)", () => {
    it("expands to the full mode-chooser experience on click, with no page navigation", async () => {
      render(<ResultsPage />);

      fireEvent.click(screen.getByRole("button", { name: /can you do better\?/i }));

      expect(await screen.findByRole("heading", { name: "Beat the Bench" })).toBeInTheDocument();
      expect(screen.getByText(/already in the market/)).toBeInTheDocument();
      // The compact card itself is gone, not left behind alongside the
      // expanded game.
      expect(
        screen.queryByRole("button", { name: /can you do better\?/i }),
      ).not.toBeInTheDocument();
    });

    it("shows a played-today status line on the compact card, reusing the stored record", async () => {
      window.localStorage.clear();
      vi.stubGlobal(
        "fetch",
        vi.fn((input: RequestInfo | URL) => {
          const url = typeof input === "string" ? input : input.toString();
          if (url.startsWith("/api/custom-anchors")) {
            return Promise.resolve(
              new Response(
                JSON.stringify({ schemaVersion: RESULTS_SCHEMA_VERSION, anchors: TEST_ANCHORS }),
                { status: 200 },
              ),
            );
          }
          const body = url.startsWith("/api/beat-the-bench") ? SESSION : WINDOW_RESULT;
          return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
        }),
      );
      const first = render(<ResultsPage />);

      expect(await screen.findByText("Not played yet today")).toBeInTheDocument();

      // Play the session to settlement through the real UI, then unmount
      // and mount a fresh instance of the page -- the same "a fresh visit
      // reads the stored record back" contract BeatTheBench.test.tsx
      // already covers for the mode-chooser's own recap paragraph.
      fireEvent.click(screen.getByRole("button", { name: /can you do better\?/i }));
      fireEvent.click(await screen.findByRole("button", { name: /Play today's/ }));
      fireEvent.click(screen.getByRole("button", { name: "Step forward one bar" }));
      await screen.findByRole("button", { name: "Play it again" });
      first.unmount();

      render(<ResultsPage />);
      expect(await screen.findByText("Level with the bench today")).toBeInTheDocument();
      window.localStorage.clear();
    });
  });

  describe("The Daily Ritual (issue #133)", () => {
    // Unlike every other test in this file, these need a *resolved*
    // result: the page order this issue is about starts at the hero
    // reveal, which only exists once /api/results has landed.
    beforeEach(() => {
      // These are the only tests in this file that write to localStorage
      // (a played session, real Call Board picks), and the rail reads it
      // back -- so each one has to start from a genuinely empty day.
      window.localStorage.clear();
      stubMatchMedia({ "(prefers-reduced-motion: reduce)": true });
      vi.stubGlobal(
        "fetch",
        vi.fn((input: RequestInfo | URL) => {
          const url = typeof input === "string" ? input : input.toString();
          const body = url.startsWith("/api/beat-the-bench")
            ? SESSION
            : url.startsWith("/api/custom-anchors")
              ? { schemaVersion: RESULTS_SCHEMA_VERSION, anchors: TEST_ANCHORS }
              : WINDOW_RESULT;
          return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
        }),
      );
    });

    /** The `<section>` a top-level mechanic heading belongs to. */
    function sectionFor(name: string): HTMLElement {
      return screen.getByRole("heading", { name }).closest("section")!;
    }

    /**
     * Beat the Bench's own `<section>` -- unlike `sectionFor`, this has to
     * work before its "Beat the Bench" heading even exists: the section
     * renders collapsed by default (issue #163), as a compact "Can you do
     * better?" card with no heading role of its own, and only gains the
     * real "Beat the Bench" heading once that card is clicked and the
     * whole subtree remounts as the full mode-chooser experience.
     */
    function benchSection(): HTMLElement {
      const collapsed = screen.queryByRole("button", { name: /can you do better\?/i });
      if (collapsed !== null) return collapsed.closest("section")!;
      return screen.getByRole("heading", { name: "Beat the Bench" }).closest("section")!;
    }

    function follows(first: Element, second: Element): boolean {
      return Boolean(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING);
    }

    it("renders Beat the Bench, then The Call Board, then the ritual, then the demoted range explorer's own hero reveal", async () => {
      search = "range=5Y";
      render(<ResultsPage />);

      const bench = benchSection();
      const board = sectionFor("The Call Board");
      const ritual = sectionFor("Today, so far");
      // The window model's hero reveal -- HeroStat's own "Starting from"
      // row -- now lives inside the demoted "Explore other windows"
      // section (issue #165), which sits at the very bottom of the page,
      // below the ritual. It's still the first thing ResultsPanel renders
      // on success, just relocated along with the whole range explorer.
      const hero = await screen.findByText("Starting from");

      expect(follows(bench, board)).toBe(true);
      expect(follows(board, ritual)).toBe(true);
      expect(follows(ritual, hero)).toBe(true);
    });

    it("reflects a really-played session and really-made calls, not three independent toggles", async () => {
      search = "range=5Y";
      render(<ResultsPage />);
      await screen.findByText("Starting from");

      const ritual = sectionFor("Today, so far");
      // Before anything is played: one endowed step, nothing else.
      await waitFor(() => expect(within(ritual).getByText("1 of 3 done")).toBeInTheDocument());

      // Expand Beat the Bench, then play it for real through its own UI,
      // to a real settlement -- the two-bar session settles on one Step.
      fireEvent.click(screen.getByRole("button", { name: /can you do better\?/i }));
      await screen.findByRole("heading", { name: "Beat the Bench" });
      const bench = benchSection();
      fireEvent.click(await within(bench).findByRole("button", { name: /Play today's/ }));
      fireEvent.click(within(bench).getByRole("button", { name: "Step forward one bar" }));
      // "Play it again" only exists on the settlement card, so this is
      // "the session really finished", not "some text mentioning it".
      expect(
        await within(bench).findByRole("button", { name: "Play it again" }),
      ).toBeInTheDocument();

      // ...and make a real Call Board pick, through its own UI.
      const [firstSlot] = await screen.findAllByRole("group", { name: /^Your call for/ });
      fireEvent.click(within(firstSlot!).getByRole("button", { name: "Up" }));

      // The rail now reports what those two mechanics actually stored.
      // Scoped to the rail's own <ol> so these can't be satisfied by the
      // same sentences appearing inside the recap textarea below it.
      const rail = within(ritual).getByRole("list");
      await waitFor(() =>
        expect(within(rail).getByText(/you rode it out, level with the bench/)).toBeInTheDocument(),
      );
      expect(within(rail).getByText(/1 of 3 upcoming sessions called/)).toBeInTheDocument();
      expect(within(ritual).getByText("2 of 3 done")).toBeInTheDocument();

      // And the recap, unlocked by that play, quotes the page's own
      // headline figure alongside both.
      const recap = within(ritual).getByTestId("daily-recap-text");
      expect(recap.textContent).toContain(
        "Hindsight over the past 5 years: $20.00 became $1.1K (55x)",
      );
      expect(recap.textContent).toContain("Beat the Bench: you rode it out");
      expect(recap.textContent).toContain("The Call Board: 1 of 3 upcoming sessions called");
    });

    it("regenerates the recap when a Call Board pick changes after it unlocked", async () => {
      search = "range=5Y";
      render(<ResultsPage />);
      await screen.findByText("Starting from");

      fireEvent.click(screen.getByRole("button", { name: /can you do better\?/i }));
      await screen.findByRole("heading", { name: "Beat the Bench" });
      const bench = benchSection();
      fireEvent.click(await within(bench).findByRole("button", { name: /Play today's/ }));
      fireEvent.click(within(bench).getByRole("button", { name: "Step forward one bar" }));

      const ritual = sectionFor("Today, so far");
      const recap = await within(ritual).findByTestId("daily-recap-text");
      await waitFor(() =>
        expect(recap.textContent).toContain("The Call Board: 0 of 3 upcoming sessions called"),
      );

      const slots = await screen.findAllByRole("group", { name: /^Your call for/ });
      fireEvent.click(within(slots[0]!).getByRole("button", { name: "Up" }));
      fireEvent.click(within(slots[1]!).getByRole("button", { name: "Down" }));

      await waitFor(() =>
        expect(recap.textContent).toContain("The Call Board: 2 of 3 upcoming sessions called"),
      );
    });
  });

  describe('demoted "Explore other windows" section (issue #165)', () => {
    it("collapses RangeSelector, the More options disclosure, and the results panel behind one closed-by-default disclosure", () => {
      render(<ResultsPage />);

      const summary = screen.getByText("Explore other windows");
      const explorer = summary.closest("details");
      expect(explorer).not.toBeNull();
      // Closed by default -- unlike jsdom's own indifference to CSS
      // visibility (see the "single More options disclosure" describe
      // block's own comment above), a native <details>'s `open` property
      // is a real, directly-assertable DOM property.
      expect(explorer).toHaveProperty("open", false);
      // The mockup's own "1W · 1M · 3M · 1Y · 5Y · Max" summary copy,
      // derived from PRESET_RANGES rather than asserted against a
      // hardcoded string here too.
      expect(explorer).toHaveTextContent("1W");
      expect(explorer).toHaveTextContent("Max");

      // Everything the pre-#165 header/ResultsPanel used to render
      // top-level now lives inside this one disclosure, unchanged.
      expect(explorer).toContainElement(screen.getByRole("group", { name: "Preset date range" }));
      expect(explorer).toContainElement(screen.getByTestId("controls-more"));
      expect(explorer).toContainElement(screen.getByText("Loading results…"));
    });
  });

  describe("micro-header caption replaces the standalone onboarding banner (issue #165)", () => {
    it("folds the onboarding sentence into the header caption, with no separate dismissible banner", () => {
      render(<ResultsPage />);

      expect(screen.getByRole("heading", { name: "Had I Known Trades" })).toBeInTheDocument();
      expect(screen.getByText(/This is a hindsight toy: starting from \$20/)).toBeInTheDocument();
      // OnboardingIntro.tsx (issue #64) is deleted outright, not just
      // hidden -- its own role="note" wrapper and dismiss button no
      // longer exist anywhere on the page.
      expect(screen.queryByRole("note")).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Dismiss intro" })).not.toBeInTheDocument();
    });
  });
});
