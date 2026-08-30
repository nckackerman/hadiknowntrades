import { RESULTS_SCHEMA_VERSION, type WindowResult } from "@hadiknowntrades/core";
import { fireEvent, render, screen, within } from "@testing-library/react";
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

/**
 * The Lineup's own real, published shape (issue #208) -- real, mixed-
 * length S&P 500 tickers so `TheLineup` can build a genuine board
 * without any of these tests needing to play it.
 */
const LINEUP_RESULT = {
  schemaVersion: RESULTS_SCHEMA_VERSION,
  generatedAt: "2026-08-27T00:52:58.157Z",
  date: "2026-08-26",
  tickers: ["IBM", "TSLA", "DIS", "MSFT", "CAT"],
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
        // The Lineup resolves its own real fixture even in tests that
        // don't care about it, per this describe block's own comment
        // above -- unlike /api/results, leaving it unresolved would mean
        // TheLineup.tsx's own guard against a malformed payload keeps it
        // permanently on its placeholder, which is a real state worth
        // avoiding here since it's not what these tests are about.
        if (url.startsWith("/api/lineup")) {
          return Promise.resolve(new Response(JSON.stringify(LINEUP_RESULT), { status: 200 }));
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
      // Board (issue #129), the daily hero (issue #161), and the
      // header's own date chip (issue #187) all independently fetch a
      // preset range's result too, but for completely unrelated reasons
      // -- the Call Board reads only that result's range-independent
      // `benchmarkSeries` (issue #126); the daily hero and the header
      // chip each read only its `days` array for the most recently
      // completed trading day, via the same useDailyChallenge(mode) hook
      // (issue #161/#187) -- and all three always ask for the same fixed
      // range (1W) regardless of what the page is showing, so none of
      // them can be confused for the view's own result fetch.
      const requested = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.map(
        (call) => call[0] as string,
      );
      expect(requested.filter((url) => url.includes("range="))).toEqual([
        `/api/results?range=${CALL_BOARD_SERIES_RANGE}`,
        `/api/results?range=${DAILY_CHALLENGE_RANGE}`,
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

      // level: 2 (issue #195): The Call Board's own expanded panel now
      // has a second, visible heading with the identical accessible
      // name -- see sectionFor's own comment below for the full
      // reasoning. This test never expands the board, but the
      // constraint costs nothing and keeps this query's own contract
      // consistent with every other same-name query in this file.
      expect(screen.getByRole("heading", { name: "The Call Board", level: 2 })).toBeInTheDocument();
      // The board's own three slots land after its mount-time hydration
      // correction (see lib/use-call-board.ts), independently of the
      // results fetch this test never resolves.
      expect(await screen.findAllByRole("group", { name: /^Your call for/ })).toHaveLength(3);
    });

    it("mounts exactly one board, as a sibling of (not nested inside) ResultsPanel", () => {
      render(<ResultsPage />);

      // level: 2 (issue #195): see the comment on the test above.
      const board = screen
        .getByRole("heading", { name: "The Call Board", level: 2 })
        .closest("section");
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

    it("mounts exactly once, inside the 2-up grid (issue #178), ahead of The Call Board", () => {
      const { container } = render(<ResultsPage />);
      const column = container.firstElementChild!;
      const cards = screen.getAllByRole("button", { name: /can you do better\?/i });

      expect(cards).toHaveLength(1);
      const section = cards[0]!.closest("section")!;
      // Issue #178 wrapped both game cards in a two-column grid container
      // -- this section's own immediate parent is that grid, not the page
      // column directly any more, but the grid itself is still a direct
      // child of the column.
      const grid = section.parentElement!;
      expect(grid.parentElement).toBe(column);
      // level: 2 (issue #195): see the comment on the earlier test above.
      const board = screen
        .getByRole("heading", { name: "The Call Board", level: 2 })
        .closest("section")!;
      // Both game cards share the same grid parent -- confirming this is
      // genuinely the 2-up wrapper, not some other intervening element.
      expect(board.parentElement).toBe(grid);
      // Issue #163 moved this section ahead of the header/range explorer/
      // ResultsPanel entirely (directly after DailyHero) -- still ahead
      // of The Call Board either way.
      expect(
        section.compareDocumentPosition(board) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    });
  });

  describe("The Order (issue #207): a real game, positioned after Beat the Bench and The Call Board", () => {
    it("mounts as its own section in the 2x2 grid, ahead of The Lineup's own real tile", async () => {
      render(<ResultsPage />);

      const bench = screen.getByRole("button", { name: /can you do better\?/i });
      const board = screen
        .getByRole("heading", { name: "The Call Board", level: 2 })
        .closest("section")!;
      const order = screen
        .getByRole("heading", { name: "The Order", level: 2 })
        .closest("section")!;
      const lineupSummary = await screen.findByTestId("the-lineup-summary");

      // Same grid parent as the two real, playable tiles -- the full
      // 2x2 grid the daily-hub-condensed mockup was originally sketched
      // with, not a second, separate grid.
      const grid = bench.closest("section")!.parentElement!;
      expect(order.parentElement).toBe(grid);
      // The Lineup's own real tile shares that exact same grid parent
      // too -- a same-parent assertion, not just a document-order check.
      // Document order alone (below) would still pass even if The Lineup
      // were relocated outside the grid entirely, as long as it stayed
      // later in the DOM; this is the real guarantee that it's genuinely
      // the grid's 4th child, not just "somewhere further down the page."
      expect(lineupSummary.closest("section")!.parentElement).toBe(grid);

      // After both real, playable tiles -- per issue #207's own scope,
      // this game has no play state to rank by (see #196's own Out of
      // scope) and stays pinned in place. The Lineup's own real tile
      // stays pinned after it too.
      expect(bench.compareDocumentPosition(order) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(board.compareDocumentPosition(order) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it("renders the collapsed tile before the puzzle fetch resolves, with no crash", () => {
      // The default beforeEach stub never resolves /api/the-order, the
      // same "stuck in loading" treatment every other unmocked fetch in
      // this file gets -- the collapsed placeholder must still render.
      render(<ResultsPage />);
      expect(screen.getByRole("heading", { name: "The Order", level: 2 })).toBeInTheDocument();
    });
  });

  describe("The Lineup (issue #208)", () => {
    it("renders after The Order in the same 2x2 grid, and is a real, interactive tile", async () => {
      render(<ResultsPage />);

      const order = screen
        .getByRole("heading", { name: "The Order", level: 2 })
        .closest("section")!;
      const lineupSummary = await screen.findByTestId("the-lineup-summary");

      const grid = order.parentElement!;
      expect(lineupSummary.closest("section")!.parentElement).toBe(grid);
      expect(
        order.compareDocumentPosition(lineupSummary) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();

      // A real <details>/<summary> disclosure, not an inert placeholder
      // -- issue #208 replaced its own placeholder export with the
      // real, playable component.
      expect(lineupSummary.tagName).toBe("SUMMARY");
      expect(lineupSummary.closest("details")).not.toBeNull();
    });

    it("renders after Beat the Bench and The Call Board too, not just The Order -- a direct assertion, not just transitively via Order's own position", async () => {
      // The pre-issue-#208 combined placeholder test directly asserted
      // both siblings' positions relative to Beat the Bench and The Call
      // Board; the split above only asserts Lineup's position relative
      // to The Order, relying transitively on a separate test
      // ("The Order (issue #207)" describe block) for Order-after-
      // Bench/Board. Restoring a direct assertion here so a future
      // regression in Order's own placement can't silently mask a real
      // Lineup-placement regression that transitive coverage alone would
      // miss.
      render(<ResultsPage />);

      const bench = screen.getByRole("button", { name: /can you do better\?/i });
      const board = screen.getByRole("heading", { name: "The Call Board" }).closest("section")!;
      const lineupSummary = await screen.findByTestId("the-lineup-summary");

      expect(
        bench.compareDocumentPosition(lineupSummary) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      expect(
        board.compareDocumentPosition(lineupSummary) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    });
  });

  describe("Beat the Bench: collapsed by default, expands in place (issue #163)", () => {
    it("expands to the full mode-chooser experience on click, with no page navigation", async () => {
      render(<ResultsPage />);

      fireEvent.click(screen.getByRole("button", { name: /can you do better\?/i }));

      expect(
        await screen.findByRole("heading", { name: "Beat the Bench", level: 3 }),
      ).toBeInTheDocument();
      expect(screen.getByText(/already in the market/)).toBeInTheDocument();
      // The compact tile stays visible above the panel, unchanged --
      // clicking it again is what collapses the game back, mirroring The
      // Call Board's own always-visible <summary>.
      expect(screen.getByRole("button", { name: /can you do better\?/i })).toBeInTheDocument();
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
          const body = url.startsWith("/api/beat-the-bench")
            ? SESSION
            : url.startsWith("/api/lineup")
              ? LINEUP_RESULT
              : WINDOW_RESULT;
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
      fireEvent.click(await screen.findByRole("button", { name: /Play today's close/ }));
      fireEvent.click(screen.getByRole("button", { name: "Step forward one bar" }));
      await screen.findByRole("button", { name: "Play it again" });
      first.unmount();

      render(<ResultsPage />);
      expect(await screen.findByText("Level with the bench today")).toBeInTheDocument();
      window.localStorage.clear();
    });
  });

  describe("daily-hub game grid mounts ahead of the demoted range explorer (issue #133)", () => {
    // Unlike every other test in this file, this needs a *resolved*
    // result: the page order this checks starts at the hero reveal,
    // which only exists once /api/results has landed.
    beforeEach(() => {
      stubMatchMedia({ "(prefers-reduced-motion: reduce)": true });
      vi.stubGlobal(
        "fetch",
        vi.fn((input: RequestInfo | URL) => {
          const url = typeof input === "string" ? input : input.toString();
          const body = url.startsWith("/api/custom-anchors")
            ? { schemaVersion: RESULTS_SCHEMA_VERSION, anchors: TEST_ANCHORS }
            : url.startsWith("/api/lineup")
              ? LINEUP_RESULT
              : WINDOW_RESULT;
          return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
        }),
      );
    });

    /**
     * The `<section>` a top-level mechanic heading belongs to. Both Beat
     * the Bench and The Call Board carry a stable, sr-only level-2
     * landmark heading at every state (issue #195, extended to Beat the
     * Bench by the header-consistency fix), plus a *visible* level-3
     * heading inside their own expanded panel once opened, sharing the
     * exact same name -- disambiguating by level is what keeps this
     * helper correct regardless of whether a given mechanic happens to be
     * expanded when it's called.
     */
    function sectionFor(name: string): HTMLElement {
      return screen.getByRole("heading", { name, level: 2 }).closest("section")!;
    }

    function follows(first: Element, second: Element): boolean {
      return Boolean(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING);
    }

    it("renders Beat the Bench, then The Call Board, then the demoted range explorer's own hero reveal", async () => {
      search = "range=5Y";
      render(<ResultsPage />);

      const bench = sectionFor("Beat the Bench");
      const board = sectionFor("The Call Board");
      // The window model's hero reveal -- HeroStat's own "Starting from"
      // row -- lives inside the demoted "Explore other windows" section
      // (issue #165), which sits at the very bottom of the page. It's
      // still the first thing ResultsPanel renders on success, just
      // relocated along with the whole range explorer.
      const hero = await screen.findByText("Starting from");

      expect(follows(bench, board)).toBe(true);
      expect(follows(board, hero)).toBe(true);
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

  describe("micro-header has no dismissible onboarding banner (issue #165)", () => {
    it("renders the wordmark with no separate dismissible banner", () => {
      render(<ResultsPage />);

      expect(screen.getByRole("heading", { name: "Had I Known Trades" })).toBeInTheDocument();
      // OnboardingIntro.tsx (issue #64) is deleted outright, not just
      // hidden -- its own role="note" wrapper and dismiss button no
      // longer exist anywhere on the page.
      expect(screen.queryByRole("note")).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Dismiss intro" })).not.toBeInTheDocument();
    });
  });

  describe("date chip, tagline removal, and footer note (issue #187)", () => {
    it("removes the issue #165 tagline paragraph from under the page title", () => {
      render(<ResultsPage />);

      expect(
        screen.queryByText(/This is a hindsight toy: starting from \$20/),
      ).not.toBeInTheDocument();
    });

    it("renders no date chip next to the title while the header's own fetch is unresolved", () => {
      render(<ResultsPage />);

      // The default beforeEach stub never resolves /api/results?range=1W
      // (the header's own useDailyChallenge(mode) call, per issue #187) --
      // the chip degrades to rendering nothing rather than a broken/empty
      // pill while loading.
      expect(screen.queryByText(/Yesterday ·/)).not.toBeInTheDocument();
    });

    it("renders the date chip next to the title once the header's own fetch resolves to a real day", async () => {
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
          if (url.includes("range=")) {
            return Promise.resolve(
              new Response(
                JSON.stringify({
                  schemaVersion: RESULTS_SCHEMA_VERSION,
                  model: "intraday-daily",
                  range: "1W",
                  generatedAt: "2026-08-27T00:00:00.000Z",
                  dataAsOf: "2026-08-26",
                  startDate: "2026-08-20",
                  endDate: "2026-08-26",
                  maxTradesPerDay: 3,
                  startingCapital: 20,
                  days: [
                    {
                      date: "2026-08-26",
                      startingCapital: 20,
                      endingBalance: 21,
                      barIntervalMinutes: 60,
                      trades: [],
                      worstCase: { startingCapital: 20, endingBalance: 19, trades: [] },
                    },
                  ],
                  benchmark: null,
                  benchmarkSeries: null,
                  universeSize: 503,
                  skippedTickers: [],
                }),
                { status: 200 },
              ),
            );
          }
          return new Promise(() => {});
        }),
      );
      render(<ResultsPage />);

      const chip = await screen.findByText(/Yesterday · Aug 26, 2026/);
      // Next to the h1, inside the header itself -- not inside the daily
      // hero showcase box (see DailyHero.test.tsx's own coverage that no
      // date text remains there).
      const header = screen.getByRole("heading", { name: "Had I Known Trades" }).closest("header");
      expect(header).toContainElement(chip);
    });

    it('adds a footer note as the page\'s last element, pointing at "Explore other windows"', () => {
      const { container } = render(<ResultsPage />);

      const column = container.firstElementChild!;
      const footer = screen.getByText(/Hindsight only, from at most 3 trades/);
      expect(footer.tagName).toBe("FOOTER");
      // The very last element in the page's own top-level column -- after
      // the "Explore other windows" <details>, not before it.
      expect(column.lastElementChild).toBe(footer);
      const explorer = screen.getByText("Explore other windows").closest("details")!;
      expect(
        explorer.compareDocumentPosition(footer) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      expect(footer).toHaveTextContent(/Explore other windows/);
    });
  });
});
