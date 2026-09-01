import { RESULTS_SCHEMA_VERSION } from "@hadiknowntrades/core";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { beatTheBenchKey } from "@/lib/beat-the-bench-storage";
import { BULLET_TIME_DECISION_WINDOW_MS } from "@/lib/bullet-time";
import { stubPrefersReducedMotion } from "@/lib/stub-prefers-reduced-motion.test-util";
import { SPY_SESSION_BARS } from "@/test-fixtures/spy-session-bars";
import { SPY_DOWN_SESSION_BARS } from "@/test-fixtures/spy-trending-session-bars";
import { BeatTheBench } from "./BeatTheBench";

// The real 2026-08-26 SPY session, in the exact envelope
// /api/beat-the-bench serves (packages/core's TodaysCloseSession).
const SESSION = {
  schemaVersion: RESULTS_SCHEMA_VERSION,
  generatedAt: "2026-08-27T00:52:58.157Z",
  ticker: "SPY",
  barIntervalMinutes: 5,
  date: "2026-08-26",
  bars: SPY_SESSION_BARS,
};

const BAR_COUNT = SPY_SESSION_BARS.length; // 79
const TICKS_TO_CLOSE = BAR_COUNT - 1; // the opening bar is already on screen
const STORAGE_KEY = beatTheBenchKey(SESSION.date, "todays-close");

function stubSessionFetch(body: unknown = SESSION, status = 200): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(new Response(JSON.stringify(body), { status }))),
  );
}

/**
 * This section renders collapsed by default (issue #163) -- a compact
 * "Can you do better?" tile, not the mode chooser -- so every test that
 * needs the chooser/game itself has to click through it first. Split out
 * as its own helper rather than folded into `renderChooser`/
 * `renderReducedMotionChooser` below since a couple of call sites need
 * the click without either of those helpers' own extra waits.
 *
 * The tile is a genuine toggle (the header-consistency fix that made it
 * match The Call Board's own always-clickable `<summary>`): calling this
 * a second time collapses again, exactly like clicking the same tile a
 * real user would.
 */
function clickCompactCard(): void {
  fireEvent.click(screen.getByRole("button", { name: /can you do better\?/i }));
}

/**
 * Renders, expands the compact card, waits for the real fetch state
 * machine to resolve, then switches to fake timers so every tick below
 * is measured rather than waited out.
 *
 * Clicks go through `fireEvent`, not `userEvent`, in this file only:
 * userEvent's own internal delay is itself a timer, so under
 * `vi.useFakeTimers()` every click has to be pumped by the same clock
 * whose exact readings these tests are asserting on -- which is both
 * circular and (verified: every timing test hung) fragile. These
 * interactions are plain clicks on plain buttons, so the extra fidelity
 * userEvent buys isn't in play.
 */
async function renderChooser(): Promise<void> {
  render(<BeatTheBench />);
  clickCompactCard();
  await screen.findByText(/79 bars/);
  vi.useFakeTimers();
}

/**
 * The reduced-motion variant. The preference is read *after* mount (see
 * use-reduced-motion-after-mount.ts -- this section renders during SSR,
 * so it can't be read during render), which leaves a microtask-wide
 * window in which the chooser is already on screen but the preference
 * hasn't landed. Real people can't click inside a microtask; a test
 * absolutely can, and did -- these tests passed alone and failed under a
 * loaded full-suite run before this wait existed. So wait for the
 * preference to be visibly acknowledged before pressing play.
 */
async function renderReducedMotionChooser(): Promise<void> {
  render(<BeatTheBench />);
  clickCompactCard();
  await screen.findByText(/79 bars/);
  await screen.findByText(/You prefer reduced motion/);
  vi.useFakeTimers();
}

function click(name: string | RegExp): void {
  fireEvent.click(screen.getByRole("button", { name }));
}

function advance(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

function barReadout(): string {
  return screen.getByText(/bar \d+ of 79/).textContent ?? "";
}

// --- Mystery Day (issue #132) ----------------------------------------

/** The real 2026-07-29 SPY session, in the envelope /api/beat-the-bench/mystery serves -- note it carries a slot id and no date, exactly as MysterySession is published. */
const MYSTERY_SESSION_ID = "s37";
const MYSTERY_REAL_DATE = "2026-07-29";
const POOL_GENERATED_AT = "2026-08-27T01:50:37.927Z";
const MYSTERY_BODY = {
  session: {
    schemaVersion: RESULTS_SCHEMA_VERSION,
    ticker: "SPY",
    barIntervalMinutes: 5,
    sessionId: MYSTERY_SESSION_ID,
    bars: SPY_DOWN_SESSION_BARS,
  },
  poolGeneratedAt: POOL_GENERATED_AT,
};

/**
 * Any date, in either shape this app renders one: the stored
 * `YYYY-MM-DD` and `formatDate`'s own "Mon D, YYYY". Used to assert the
 * *absence* of a date anywhere in the document, which is a stronger claim
 * than "the one date we happen to know about is absent".
 */
const DATE_SHAPED =
  /\d{4}-\d{2}-\d{2}|\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2},\s+\d{4}\b/;

function expectNoDateAnywhere(): void {
  // innerHTML, not textContent: an attribute-serialized value (a key, a
  // data-* prop, an aria-label) would leak just as effectively as visible
  // text, and only this catches it.
  expect(document.body.innerHTML).not.toMatch(DATE_SHAPED);
}

/**
 * A fetch stub that routes by URL and records every request made, so a
 * test can assert on what was *not* requested -- the whole point of this
 * mode's discipline.
 */
function stubRoutedFetch(options: { revealGeneratedAt?: string; revealStatus?: number } = {}) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: unknown) => {
      const url = String(input);
      calls.push(url);
      if (url.startsWith("/api/beat-the-bench/mystery/reveal")) {
        const status = options.revealStatus ?? 200;
        const body =
          status === 200
            ? {
                sessionId: MYSTERY_SESSION_ID,
                date: MYSTERY_REAL_DATE,
                generatedAt: options.revealGeneratedAt ?? POOL_GENERATED_AT,
              }
            : { error: "upstream_error", message: "nope" };
        return Promise.resolve(new Response(JSON.stringify(body), { status }));
      }
      if (url.startsWith("/api/beat-the-bench/mystery")) {
        return Promise.resolve(new Response(JSON.stringify(MYSTERY_BODY), { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify(SESSION), { status: 200 }));
    }),
  );
  return calls;
}

/** Renders, expands the compact card, picks Mystery Day, and waits for its (paused, under reduced motion) session to be on screen. */
async function enterMysterySession(): Promise<void> {
  render(<BeatTheBench />);
  clickCompactCard();
  await screen.findByText(/You prefer reduced motion/);
  click(/play a mystery day/i);
  await screen.findByText(/bar 1 of 78/);
}

/**
 * Steps a paused session all the way to its close, then lets the reveal
 * request settle. Driven by the button's own presence rather than a bar
 * count, so a caller that already stepped part-way (to assert something
 * mid-session) doesn't have to do its own arithmetic.
 */
async function stepToClose(): Promise<void> {
  for (let i = 0; i < SPY_DOWN_SESSION_BARS.length; i += 1) {
    const step = screen.queryByRole("button", { name: "Step forward one bar" });
    if (step === null) break;
    fireEvent.click(step);
  }
  expect(screen.queryByRole("button", { name: "Step forward one bar" })).toBeNull();
  await act(async () => {
    await Promise.resolve();
  });
}

describe("BeatTheBench", () => {
  beforeEach(() => {
    window.localStorage.clear();
    stubPrefersReducedMotion(false);
    stubSessionFetch();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    window.localStorage.clear();
  });

  it("renders a compact 'Can you do better?' card by default, not the full game (issue #163)", async () => {
    render(<BeatTheBench />);

    expect(screen.getByRole("button", { name: /can you do better\?/i })).toBeInTheDocument();
    expect(
      screen.getByText("Play today's real session against the market, live."),
    ).toBeInTheDocument();
    expect(screen.getByText("Not played yet today")).toBeInTheDocument();
    // None of the full game's own content is rendered yet. The section's
    // own sr-only landmark heading (mirroring CallBoard's identical
    // always-present `<h2 id="call-board-heading">`) is present at every
    // state; the panel's own *visible* `<h3>` heading is what actually
    // signals expansion, so this checks that one specifically.
    expect(
      screen.queryByRole("heading", { name: "Beat the Bench", level: 3 }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/already in the market/)).not.toBeInTheDocument();

    // Let the always-on-mount session fetch (see this file's own
    // Judgment-calls section) settle before the test ends, rather than
    // resolving after RTL's cleanup unmounts the tree.
    await act(async () => {
      await Promise.resolve();
    });
  });

  it("carries no data-bench-expanded marker while collapsed, and gains one once expanded (issue #178)", async () => {
    render(<BeatTheBench />);

    // The 2-up grid wrapping this card and The Call Board (ResultsPage.tsx,
    // issue #178) collapses itself to one column via a `:has()` selector
    // keyed on this exact attribute -- see BeatTheBenchFrame's own doc
    // comment for why it's a data attribute here rather than a native
    // disclosure element the grid could key off directly.
    expect(screen.queryByTestId("beat-the-bench-panel")).not.toBeInTheDocument();

    clickCompactCard();

    const panel = await screen.findByTestId("beat-the-bench-panel");
    expect(panel).toHaveAttribute("data-bench-expanded", "true");
  });

  it("renders the compact card as a solid amber tile, not the old bordered-card treatment (issue #176)", async () => {
    render(<BeatTheBench />);

    const tile = screen.getByRole("button", { name: /can you do better\?/i });
    // The amber gradient fill/dark text are the tile's whole visual
    // identity (issue #176) -- asserted via the real inline style, not a
    // class-name string, since the gradient is set that way specifically
    // for reliability (see CompactCard's own doc comment). jsdom
    // normalizes hex colors in inline styles to rgb(), so these assert
    // against that normalized form (#f0b658/#e8a33d/#d88f28 respectively),
    // not the literal hex string this component's own source writes.
    expect(tile.style.backgroundImage).toContain("linear-gradient");
    expect(tile.style.backgroundImage).toContain("rgb(240, 182, 88)");
    expect(tile.style.backgroundImage).toContain("rgb(232, 163, 61)");
    expect(tile.style.backgroundImage).toContain("rgb(216, 143, 40)");
    expect(tile.style.color).toBe("rgb(36, 26, 8)"); // #241a08
    // The old thin-left-border-accent card is gone, not just relabeled.
    expect(tile.className).not.toContain("border-l");
    expect(tile.className).not.toContain("surface-card");
    // The large icon from the mockup's tile design.
    expect(screen.getByText("🎯")).toBeInTheDocument();

    await act(async () => {
      await Promise.resolve();
    });
  });

  describe("status badge (issue #186)", () => {
    it("shows no badge before today's session has been played", async () => {
      render(<BeatTheBench />);

      const tile = screen.getByRole("button", { name: /can you do better\?/i });
      expect(within(tile).queryByText("✓")).not.toBeInTheDocument();

      await act(async () => {
        await Promise.resolve();
      });
    });

    it("shows a real, gold done badge once today's session has actually been played", async () => {
      await renderChooser();
      click(/play today's close/i);
      click(/^4x$/);
      advance(TICKS_TO_CLOSE * 75);
      expect(screen.getByText("Along for the ride")).toBeInTheDocument();

      // A fresh mount reads the real stored record back -- the same
      // contract "remembers a played session and offers it again" above
      // already covers for the status line; this is the identical claim
      // for the badge sitting right next to it. Waited on via the status
      // line itself (not just the tile's own presence, which renders
      // immediately regardless of whether the deferred storage read has
      // landed yet) so the badge assertion below isn't racing that read.
      //
      // `cleanup()` first: the tile stays mounted across expand/collapse
      // now (issue: header-consistency fix), so leaving the earlier
      // render's tree in place would leave two "Can you do better?"
      // buttons in the document once this second `render()` mounts a
      // genuinely fresh one, making the query below ambiguous.
      vi.useRealTimers();
      cleanup();
      render(<BeatTheBench />);
      await screen.findByText("Level with the bench today");
      const tile = screen.getByRole("button", { name: /can you do better\?/i });
      const badge = within(tile).getByText("✓");
      expect(badge).toHaveAttribute("aria-hidden", "true");
      expect(badge.className).toContain("bg-[var(--accent-reward)]");
    });
  });

  it("expands to the full game in a panel below the tile once the tile is clicked", async () => {
    render(<BeatTheBench />);
    clickCompactCard();

    expect(screen.getByRole("heading", { name: "Beat the Bench", level: 3 })).toBeInTheDocument();
    // "Already in the market" is the fact that makes the zero-trade tie
    // work, so it's stated plainly rather than left to be inferred.
    expect(screen.getByText(/already in the market/)).toBeInTheDocument();
    expect(screen.getByText(/\$20\.00/)).toBeInTheDocument();
    // 78 ticks x 300ms = 23.4s -> "about 23 seconds", the stated target.
    expect(await screen.findByText(/about 23 seconds at normal speed/)).toBeInTheDocument();
    expect(screen.getByText(/Aug 26, 2026/)).toBeInTheDocument();
    // The tile stays visible above the panel, unchanged -- the same tile
    // you clicked, not swapped out for a different header (the whole
    // point of the header-consistency fix: matching The Call Board's own
    // always-visible <summary>).
    expect(screen.getByRole("button", { name: /can you do better\?/i })).toBeInTheDocument();
  });

  it("connects the expanded panel back to the tile that opened it (issue #195)", async () => {
    render(<BeatTheBench />);

    // Before expanding: aria-expanded is false, and aria-controls already
    // names the panel's id even though that element isn't mounted yet --
    // the same "controls a not-yet-rendered region" shape a native
    // <details>/<summary> gets from the browser for free.
    const tileBeforeExpand = screen.getByRole("button", { name: /can you do better\?/i });
    expect(tileBeforeExpand).toHaveAttribute("aria-expanded", "false");
    const panelId = tileBeforeExpand.getAttribute("aria-controls");
    expect(panelId).toBeTruthy();

    clickCompactCard();

    const panel = await screen.findByTestId("beat-the-bench-panel");
    // The real programmatic tile-controls-panel relationship a screen
    // reader can follow -- not just a visual/positional connection.
    expect(panel).toHaveAttribute("id", panelId);
    expect(screen.getByRole("button", { name: /can you do better\?/i })).toHaveAttribute(
      "aria-expanded",
      "true",
    );

    // A 4px top border colored with the tile's own darkest gradient
    // stop (#d88f28), plus the other three sides keeping their original
    // border color/width (mirroring CallBoard's identical review
    // finding #5) -- jsdom normalizes the hex to rgb().
    expect(panel.className).toContain("border-t-4");
    expect(panel.className).toContain("border-x");
    expect(panel.className).toContain("border-b");
    expect(panel.style.borderTopColor).toBe("rgb(216, 143, 40)"); // #d88f28

    // The panel's own icon+heading row, matching CallBoard's identical
    // treatment.
    expect(screen.getByRole("heading", { name: "Beat the Bench", level: 3 })).toBeInTheDocument();

    // Flush against the tile above it, not a separate floating card --
    // the tile's own bottom corners square off and its hover-lift is
    // suppressed while the panel is open (the direct-boolean equivalent
    // of CallBoard's own `group-open:` treatment), and the panel itself
    // drops its own top rounding to meet it.
    const tile = screen.getByRole("button", { name: /can you do better\?/i });
    expect(tile.className).toContain("rounded-b-none");
    expect(tile.className).not.toContain("hover:-translate-y-0.5");
    expect(panel.className).toContain("rounded-t-none");
  });

  it("collapses back to the compact tile, and resets mode so a re-expand starts at the chooser", async () => {
    render(<BeatTheBench />);
    clickCompactCard();

    expect(screen.getByRole("heading", { name: "Beat the Bench", level: 3 })).toBeInTheDocument();
    await screen.findByText(/79 bars/); // the chooser's own session detail line
    click(/play today's close/i);
    expect(barReadout()).toMatch(/bar 1 of 79/); // now genuinely mid-game

    // The tile itself is the toggle in both directions now, exactly like
    // The Call Board's own always-clickable <summary> -- no separate
    // "Collapse" control.
    clickCompactCard();

    // Back to the compact tile alone, not left showing the game
    // mid-collapse.
    expect(screen.getByRole("button", { name: /can you do better\?/i })).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Beat the Bench", level: 3 }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/bar \d+ of 79/)).not.toBeInTheDocument();

    // Clickable and collapsible either direction, like The Call Board's
    // own <summary> -- re-expanding lands back on the mode chooser, not
    // resumed mid-game state.
    clickCompactCard();
    expect(screen.getByRole("heading", { name: "Beat the Bench", level: 3 })).toBeInTheDocument();
    await screen.findByText(/79 bars/);
    expect(screen.queryByText(/bar \d+ of 79/)).not.toBeInTheDocument();

    await act(async () => {
      await Promise.resolve();
    });
  });

  it("says so, without alarm, when no session has been published", async () => {
    stubSessionFetch({ error: "not_found", message: "nope" }, 404);
    render(<BeatTheBench />);
    clickCompactCard();

    expect(await screen.findByText(/There's no session to play right now/)).toBeInTheDocument();
  });

  it("advances exactly one bar per 1x tick interval", async () => {
    await renderChooser();
    click(/play today's close/i);

    expect(barReadout()).toMatch(/bar 1 of 79/);

    advance(299);
    expect(barReadout()).toMatch(/bar 1 of 79/);

    advance(1);
    expect(barReadout()).toMatch(/bar 2 of 79/);

    advance(300 * 3);
    expect(barReadout()).toMatch(/bar 5 of 79/);
  });

  // Issue #131's acceptance criterion asks for the real timings, not
  // merely that the five multipliers differ -- so each speed is measured
  // by holding the clock one millisecond short of its own interval.
  it.each([
    [/^0\.1x$/, 3000],
    [/^0\.5x$/, 600],
    [/^1x$/, 300],
    [/^2x$/, 150],
    [/^4x$/, 75],
  ])("holds a bar on screen for its own interval at %s", async (label, intervalMs) => {
    await renderChooser();
    click(/play today's close/i);
    click(label);

    const before = barReadout();
    advance(intervalMs - 1);
    expect(barReadout()).toBe(before);

    advance(1);
    expect(barReadout()).not.toBe(before);
  });

  it("plays a whole session at 4x in the time the engine says it should", async () => {
    await renderChooser();
    click(/play today's close/i);
    click(/^4x$/);

    advance(TICKS_TO_CLOSE * 75 - 1);
    expect(barReadout()).toMatch(/bar 78 of 79/);

    advance(1);
    expect(screen.getByText("Along for the ride")).toBeInTheDocument();
  });

  it("settles a zero-move session dead level with the bench, and says why", async () => {
    await renderChooser();
    click(/play today's close/i);
    click(/^4x$/);
    advance(TICKS_TO_CLOSE * 75);

    expect(screen.getByText("Along for the ride")).toBeInTheDocument();
    expect(screen.getByText("Level with the bench, exactly.")).toBeInTheDocument();
    expect(screen.getByText(/You never moved/)).toBeInTheDocument();

    // Both sides land on the same figure because they are the same
    // computation -- see beat-the-bench.ts's own zero-trade invariant.
    const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY)!) as {
      played: boolean;
      outcome: string;
      moves: number;
      playerBalance: number;
      benchmarkBalance: number;
    };
    expect(stored.played).toBe(true);
    expect(stored.outcome).toBe("tie");
    expect(stored.moves).toBe(0);
    expect(stored.playerBalance).toBe(stored.benchmarkBalance);
  });

  it("flips one toggle button between selling and buying back in", async () => {
    await renderChooser();
    click(/play today's close/i);

    // Exactly one trade control exists at a time -- not a pair with one
    // of them permanently dead.
    expect(screen.getByRole("button", { name: "Sell, go to cash" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Buy back in" })).not.toBeInTheDocument();

    click("Sell, go to cash");

    expect(screen.getByRole("button", { name: "Buy back in" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sell, go to cash" })).not.toBeInTheDocument();
    expect(screen.getByText("You (in cash)")).toBeInTheDocument();

    click(/^4x$/);
    advance(TICKS_TO_CLOSE * 75);
    expect(screen.getByText(/You moved once/)).toBeInTheDocument();
  });

  it("pauses and resumes without losing the player's place", async () => {
    await renderChooser();
    click(/play today's close/i);
    advance(300 * 4);
    expect(barReadout()).toMatch(/bar 5 of 79/);

    click("Pause");
    advance(300 * 20);
    expect(barReadout()).toMatch(/bar 5 of 79/);

    click("Play");
    advance(300);
    expect(barReadout()).toMatch(/bar 6 of 79/);
  });

  it("remembers a played session and offers it again", async () => {
    await renderChooser();
    click(/play today's close/i);
    click(/^4x$/);
    advance(TICKS_TO_CLOSE * 75);
    click("Play it again");

    expect(barReadout()).toMatch(/bar 1 of 79/);

    // A fresh visit reads the stored record back through the same
    // defensive path -- both in the compact card's own status line
    // (issue #163) and, once expanded, the mode chooser's own recap
    // paragraph. `cleanup()` first, same reasoning as the identical
    // pattern above in "shows a real, gold done badge...".
    vi.useRealTimers();
    cleanup();
    render(<BeatTheBench />);
    expect(await screen.findByText("Level with the bench today")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /can you do better\?/i }));
    expect(await screen.findAllByText(/You've played today's close/)).not.toHaveLength(0);
  });

  it("still plays through when browser storage is unavailable", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });

    await renderChooser();
    click(/play today's close/i);
    click(/^4x$/);
    advance(TICKS_TO_CLOSE * 75);

    // The game finishes and settles; only the remembering is lost.
    expect(screen.getByText("Along for the ride")).toBeInTheDocument();
  });

  describe("with reduced motion", () => {
    beforeEach(() => {
      stubPrefersReducedMotion(true);
    });

    // Every other animated affordance in this app is simply removed
    // under reduced motion. That can't be the answer here -- the ticking
    // chart *is* the mechanic -- so playback starts paused and "Step
    // forward one bar" is a complete way to play the whole session.
    it("starts paused, and never moves a bar on its own", async () => {
      await renderReducedMotionChooser();
      click(/play today's close/i);

      expect(screen.getByRole("button", { name: "Play" })).toBeInTheDocument();
      expect(screen.getByText(/Paused for reduced motion/)).toBeInTheDocument();

      advance(60_000);
      expect(barReadout()).toMatch(/bar 1 of 79/);
    });

    it("plays the whole session start to finish on the step button alone", async () => {
      await renderReducedMotionChooser();
      click(/play today's close/i);

      for (let i = 0; i < TICKS_TO_CLOSE - 1; i += 1) {
        click("Step forward one bar");
      }
      expect(barReadout()).toMatch(/bar 78 of 79/);

      // Trades work identically while stepping -- this isn't a
      // read-only fallback view.
      click("Sell, go to cash");
      click("Step forward one bar");

      expect(
        screen.getByText(/^(You beat the bench|The bench stayed ahead|Dead even with the bench)$/),
      ).toBeInTheDocument();
      expect(screen.getByText(/You moved once/)).toBeInTheDocument();
      expect(JSON.parse(window.localStorage.getItem(STORAGE_KEY)!).played).toBe(true);
    });

    it("still lets a reduced-motion player press play if they want to", async () => {
      await renderReducedMotionChooser();
      click(/play today's close/i);
      click("Play");

      advance(300);
      expect(barReadout()).toMatch(/bar 2 of 79/);
    });
  });

  // Issue #132. The acceptance criterion this block exists for is not
  // "the date isn't displayed" but "the date is not *in the client*", so
  // every assertion below is against the real rendered document
  // (innerHTML, so an attribute-serialized leak counts too) and against
  // the real recorded network log -- never against "no obviously-named
  // prop exists".
  describe("Mystery Day", () => {
    beforeEach(() => {
      // Playback starts paused under reduced motion, which makes stepping
      // the deterministic way to walk a session without racing a real
      // 300ms interval. The mode's own behaviour is identical either way.
      stubPrefersReducedMotion(true);
    });

    it("never asks for the id -> date index, and shows no date at all, until the session settles", async () => {
      const calls = stubRoutedFetch();
      await enterMysterySession();

      // Mid-session: not just "the real date is absent" but "no date in
      // any shape is present anywhere in the rendered document."
      click("Step forward one bar");
      click("Step forward one bar");
      expectNoDateAnywhere();
      expect(document.body.innerHTML).not.toContain(MYSTERY_REAL_DATE);
      expect(document.body.innerHTML).not.toContain("Jul 29, 2026");
      expect(calls.filter((url) => url.includes("reveal"))).toHaveLength(0);

      await stepToClose();

      // Only now does the one request that can resolve a date happen.
      expect(calls.filter((url) => url.includes("reveal"))).toHaveLength(1);
      expect(await screen.findByText(/Jul 29, 2026/)).toBeInTheDocument();
    });

    it("plays through the same engine and settles the same way as Today's Close", async () => {
      stubRoutedFetch();
      await enterMysterySession();
      await stepToClose();

      expect(screen.getByText("Along for the ride")).toBeInTheDocument();
      expect(screen.getByText("Level with the bench, exactly.")).toBeInTheDocument();
    });

    it("records the played session under its real date once revealed, not under the opaque slot id", async () => {
      stubRoutedFetch();
      await enterMysterySession();
      await stepToClose();
      await screen.findByText(/Jul 29, 2026/);

      const stored = window.localStorage.getItem(beatTheBenchKey(MYSTERY_REAL_DATE, "mystery"));
      expect(stored).not.toBeNull();
      expect(JSON.parse(stored!).played).toBe(true);
      // The slot id means a different day after the next pipeline run, so
      // it must never become a storage key.
      expect(
        window.localStorage.getItem(beatTheBenchKey(MYSTERY_SESSION_ID, "mystery")),
      ).toBeNull();
    });

    // Slots are re-permuted every pipeline run, so an id picked before a
    // rotation resolves to a *different* day afterwards. Saying so beats
    // confidently naming the wrong day.
    it("declines to name a day when the pool rotated mid-play, rather than naming the wrong one", async () => {
      stubRoutedFetch({ revealGeneratedAt: "2026-08-28T01:50:37.927Z" });
      await enterMysterySession();
      await stepToClose();

      expect(await screen.findByText(/pool rotated while you were playing/)).toBeInTheDocument();
      expectNoDateAnywhere();
      expect(window.localStorage.getItem(beatTheBenchKey(MYSTERY_REAL_DATE, "mystery"))).toBeNull();
    });

    it("settles normally when the reveal can't be looked up at all", async () => {
      stubRoutedFetch({ revealStatus: 502 });
      await enterMysterySession();
      await stepToClose();

      expect(await screen.findByText(/couldn't be looked up just now/)).toBeInTheDocument();
      expect(screen.getByText("Along for the ride")).toBeInTheDocument();
      expectNoDateAnywhere();
    });

    it("reports the session's biggest runs and where the player was standing, with the approximation stated", async () => {
      stubRoutedFetch();
      await enterMysterySession();
      await stepToClose();

      expect(screen.getByText("The session's biggest runs")).toBeInTheDocument();
      // A zero-move player rode every one of them.
      expect(
        screen.getByText(/in the market for every one of the session's biggest runs/),
      ).toBeInTheDocument();
      expect(screen.getByText(/Those dollar figures are an approximation/)).toBeInTheDocument();
      expect(
        screen.getByText(/not a replay of your own session with one decision changed/),
      ).toBeInTheDocument();
    });

    // Found live rather than by reading the code: before this, the only
    // way back to the chooser appeared *after* a 78-bar session settled,
    // so starting one by mistake meant reloading the page.
    it("lets a player leave a session in progress without finishing it", async () => {
      stubRoutedFetch();
      await enterMysterySession();
      click("Step forward one bar");

      click("Pick a different mode");

      expect(
        await screen.findByRole("button", { name: /play a mystery day/i }),
      ).toBeInTheDocument();
      expect(screen.queryByText(/bar \d+ of 78/)).not.toBeInTheDocument();
    });

    it("ranks the player against a simulated field of random togglers", async () => {
      stubRoutedFetch();
      await enterMysterySession();
      await stepToClose();

      expect(
        screen.getByText(/traders who moved at random through the same session/),
      ).toBeVisible();
      expect(screen.getByText(/a control group for timing, not a model/)).toBeInTheDocument();
    });
  });

  // SPY_DOWN_SESSION_BARS schedules two real events under the real
  // constants (confirmed against the live implementation, not assumed):
  // a down-swing at bars 27->32, and a second down-swing at bars 64->77
  // -- the session's own last bar. That second event's own toIndex
  // landing exactly on the session's last bar is what makes this fixture
  // useful beyond Mystery Day's own existing use of it: it's the exact
  // "resolves within the settlement badge's own linger window" case
  // issue #224's code review flagged (a code-review finding, fixed --
  // see `SessionGame`'s own `recentlyResolvedEvent` doc comment).
  describe("Bullet Time (issue #224)", () => {
    /**
     * Renders, picks Mystery Day (which serves `SPY_DOWN_SESSION_BARS`),
     * pauses immediately, and switches to fake timers -- a local sibling
     * of `enterMysterySession` rather than that same helper, since this
     * describe block deliberately runs under normal (not reduced)
     * motion: only `Step forward one bar` is clicked below, never
     * `advance()`, so the real tick interval is irrelevant either way,
     * but pausing first keeps a stray real `setInterval` callback from
     * firing between clicks.
     */
    async function enterMysteryUnderNormalMotion(): Promise<void> {
      stubRoutedFetch();
      render(<BeatTheBench />);
      clickCompactCard();
      click(/play a mystery day/i);
      await screen.findByText(/bar 1 of 78/);
      click("Pause");
      vi.useFakeTimers();
    }

    it("never shows the live 'Called it'/'Not this time' badge once the session has settled, even when the last event resolves on the session's own final bar", async () => {
      await enterMysteryUnderNormalMotion();
      // Never clicks Ride it out/Step aside for either event -- both
      // resolve via the honest "no decision locks to whatever you're
      // already holding" no-op (Step, clicked here, behaves identically
      // to letting the countdown run out). The player starts holding and
      // never moves, so both down-swing calls resolve "incorrect."
      await stepToClose();

      expect(screen.queryByText(/Not this time/)).not.toBeInTheDocument();
      expect(screen.queryByText(/Called it/)).not.toBeInTheDocument();
      // The settlement's own tally line is unaffected by that gate --
      // it's a separate computation (resolvedBulletTimeCalls), not the
      // live-lingering badge.
      expect(screen.getByText("Bullet Time calls: 0 of 2 correct.")).toBeInTheDocument();
    });

    it("shows the decision panel and a live resolution badge mid-session, then the settlement's own tally line once settled", async () => {
      await enterMysteryUnderNormalMotion();

      // Step to the first event's own deciding bar (fromIndex 27).
      for (let i = 0; i < 27; i += 1) click("Step forward one bar");
      expect(screen.getByText("Big swing incoming")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Ride it out" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Step aside" })).toBeInTheDocument();

      // A down-swing: "Step aside" (ending up in cash) is the correct call.
      click("Step aside");
      // Step through the rest of the swing to its own resolution bar (32).
      for (let i = 0; i < 5; i += 1) click("Step forward one bar");

      // Two matches, deliberately: the visible badge and the sr-only
      // aria-live announcement share the identical sentence (computed
      // once, per this issue's own code-review fix -- see
      // `recentlyResolvedSentence`'s own doc comment).
      expect(screen.getAllByText(/Called it/).length).toBeGreaterThan(0);

      // Never explicitly chosen again for the second event -- the
      // player is still in cash from the first call, and staying there
      // (the honest no-op) happens to be correct again, since the
      // second event is also a down-swing.
      await stepToClose();
      expect(screen.getByText("Bullet Time calls: 2 of 2 correct.")).toBeInTheDocument();
    });

    // A real bug, found by an independent code review: the decision
    // auto-lock timer's own guard used to check only `deciding`/
    // `reducedMotion`, not the player's own `paused` state -- a player
    // who paused, then used "Step forward one bar" (always available) to
    // step into a trigger bar, would have a real wall-clock timer
    // silently counting down while the game visibly looked paused to
    // them. `enterMysteryUnderNormalMotion` already leaves the session
    // paused (it clicks "Pause" once, up front), so stepping straight
    // into the deciding bar reproduces the exact scenario -- no extra
    // pause click needed here.
    it("does not auto-lock the decision window while the player is paused, and resumes counting down once they unpause", async () => {
      await enterMysteryUnderNormalMotion();

      // 27 steps from the opening bar (barIndex 0) lands on barIndex 27
      // -- the first event's own fromIndex, displayed as "bar 28".
      for (let i = 0; i < 27; i += 1) click("Step forward one bar");
      expect(screen.getByText("Big swing incoming")).toBeInTheDocument();
      expect(screen.getByText(/bar 28 of 78/)).toBeInTheDocument();

      // Well past the real decision window -- if the timer were still
      // running despite `paused`, it would have fired by now.
      advance(BULLET_TIME_DECISION_WINDOW_MS + 1000);
      expect(screen.getByText("Big swing incoming")).toBeInTheDocument();
      expect(screen.getByText(/bar 28 of 78/)).toBeInTheDocument();

      // Unpausing restarts the effect with a fresh window (not a resumed
      // partial one, per this fix's own doc comment) -- advancing by
      // exactly that window now lets the real auto-lock fire.
      click("Play");
      advance(BULLET_TIME_DECISION_WINDOW_MS);
      expect(screen.queryByText("Big swing incoming")).not.toBeInTheDocument();
      expect(screen.getByText(/bar 29 of 78/)).toBeInTheDocument();
    });
  });

  describe("touch targets", () => {
    // Measured for real at 375px in a browser during live verification;
    // asserted here as the class contract that produces it, since jsdom
    // loads no stylesheet and reports every box as 0x0.
    it("gives every playback control a >= 44px target", async () => {
      await renderChooser();
      click(/play today's close/i);

      const controls = [
        screen.getByRole("button", { name: "Pause" }),
        screen.getByRole("button", { name: "Step forward one bar" }),
        ...["0.1x", "0.5x", "1x", "2x", "4x"].map((label) =>
          screen.getByRole("button", { name: label }),
        ),
      ];

      for (const control of controls) {
        expect(control.className).toContain("min-h-11");
        expect(control.className).toContain("min-w-11");
      }
      // The row wraps rather than shrinking anything below that.
      expect(screen.getByRole("group", { name: "Speed" }).className).toContain("flex-wrap");
    });
  });
});
