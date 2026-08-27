import { RESULTS_SCHEMA_VERSION } from "@hadiknowntrades/core";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { savePlayedSession, type PlayedSession } from "@/lib/beat-the-bench-storage";
import { saveCallBoardPick } from "@/lib/call-board-storage";
import { upcomingCallDays } from "@/lib/call-board-scoring";
import type { HeadlineFigure } from "@/lib/headline-figure";
import { saveRangeGuess } from "@/lib/range-guess-storage";
import { DailyRitual } from "./DailyRitual";

const SESSION_DATE = "2026-08-26";

// A deliberately tiny stand-in for /api/beat-the-bench's real payload:
// nothing here plays the session, it only needs a real `date` to key the
// stored record off (see beat-the-bench-storage.ts). The full 79-bar
// fixture is exercised in BeatTheBench.test.tsx and in the ResultsPage
// integration test, where a session actually gets played.
const SESSION = {
  schemaVersion: RESULTS_SCHEMA_VERSION,
  generatedAt: "2026-08-27T00:52:58.157Z",
  ticker: "SPY",
  barIntervalMinutes: 5,
  date: SESSION_DATE,
  bars: [
    { time: "09:30:00", close: 100 },
    { time: "09:35:00", close: 101 },
  ],
};

const WINDOW_HEADLINE: HeadlineFigure = {
  model: "window",
  rangePhrase: "over the past 5 years",
  startingCapital: 20,
  endingBalance: 1100,
};

const INTRADAY_HEADLINE: HeadlineFigure = {
  model: "intraday-daily",
  rangePhrase: "over the past week",
  startingCapital: 20,
  endingBalance: 2431.19,
};

const PLAYED: PlayedSession = {
  played: true,
  outcome: "win",
  playerBalance: 20.03,
  benchmarkBalance: 20.01,
  moves: 2,
};

function stubSessionFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(new Response(JSON.stringify(SESSION), { status: 200 }))),
  );
}

function stubClipboard(writeText: unknown): void {
  Object.defineProperty(navigator, "clipboard", {
    value: writeText === undefined ? undefined : { writeText },
    configurable: true,
  });
}

/**
 * `fireEvent`, not `userEvent`, for the copy button specifically.
 * `userEvent.setup()` installs its **own** `navigator.clipboard` stub, which
 * silently replaces the one these tests install and makes every copy
 * "succeed" -- so the failure path could never be exercised, and the success
 * path would assert against userEvent's stub rather than this module's real
 * call. (Both happened, before this switch.)
 */
function clickCopy(): void {
  fireEvent.click(screen.getByRole("button", { name: "Copy recap" }));
}

function recapText(): string {
  return screen.getByTestId("daily-recap-text").textContent ?? "";
}

/** The rail row for `label`, as its whole `<li>`. */
function railItem(label: string): HTMLElement {
  return screen.getByText(label).closest("li")!;
}

function renderRitual(headline: HeadlineFigure | null = WINDOW_HEADLINE) {
  return render(<DailyRitual range="5Y" mode="long" headline={headline} />);
}

describe("DailyRitual", () => {
  beforeEach(() => {
    window.localStorage.clear();
    stubSessionFetch();
  });

  afterEach(() => {
    window.localStorage.clear();
    Reflect.deleteProperty(navigator, "clipboard");
    vi.unstubAllGlobals();
  });

  describe("the status rail", () => {
    it("starts the day at 1 of 3, with the reveal already behind you", async () => {
      renderRitual();

      // Endowed progress, on purpose (see DailyRitualSnapshot.heroSeen) --
      // this must never read "0 of 3".
      expect(await screen.findByText("1 of 3 done")).toBeInTheDocument();
      expect(railItem("The reveal").querySelector("[data-step-state]")).toHaveAttribute(
        "data-step-state",
        "done",
      );
    });

    it("reports a played session and its result, read from the real stored record", async () => {
      savePlayedSession(SESSION_DATE, "todays-close", PLAYED);
      renderRitual();

      const bench = await waitFor(() => railItem("Beat the Bench"));
      await waitFor(() => expect(bench).toHaveTextContent(/you beat the bench by 0\.10%/));
      expect(bench.querySelector("[data-step-state]")).toHaveAttribute("data-step-state", "done");
    });

    it("counts the board's real filled slots, and marks the step partial until they're all called", async () => {
      const [first] = upcomingCallDays(new Date());
      saveCallBoardPick(first!, "up", new Date());
      renderRitual();

      const calls = await waitFor(() => railItem("The Call Board"));
      await waitFor(() => expect(calls).toHaveTextContent(/1 of 3 upcoming sessions called/));
      expect(calls.querySelector("[data-step-state]")).toHaveAttribute(
        "data-step-state",
        "partial",
      );
    });

    it("gives every state a glyph as well as a colour", async () => {
      savePlayedSession(SESSION_DATE, "todays-close", PLAYED);
      renderRitual();

      await waitFor(() =>
        expect(railItem("Beat the Bench").querySelector("[data-step-state]")).toHaveTextContent(
          "✓",
        ),
      );
      expect(railItem("The Call Board").querySelector("[data-step-state]")).toHaveTextContent("○");
    });
  });

  describe("the recap's lock", () => {
    it("ships the real locked copy until Beat the Bench has been played", async () => {
      renderRitual();

      expect(
        await screen.findByText("Play Beat the Bench above, and the day has a recap."),
      ).toBeInTheDocument();
      expect(screen.queryByTestId("daily-recap-text")).not.toBeInTheDocument();
    });

    it("unlocks once a session has been played, regardless of the board", async () => {
      savePlayedSession(SESSION_DATE, "todays-close", PLAYED);
      renderRitual();

      expect(await screen.findByTestId("daily-recap-text")).toBeInTheDocument();
      expect(
        screen.queryByText("Play Beat the Bench above, and the day has a recap."),
      ).not.toBeInTheDocument();
    });
  });

  describe("the recap's content", () => {
    it("quotes the window model's headline figure", async () => {
      savePlayedSession(SESSION_DATE, "todays-close", PLAYED);
      renderRitual();

      await screen.findByTestId("daily-recap-text");
      expect(recapText()).toContain("Hindsight over the past 5 years: $20.00 became $1.1K (55x)");
    });

    // The one spoiler gate this app has (issue #91) covers the recap the
    // same way it covers the share-card link: the intraday-daily headline
    // is exactly the number the whole-range guess hides.
    it("withholds the intraday-daily figure until the whole-range guess has been made", async () => {
      savePlayedSession(SESSION_DATE, "todays-close", PLAYED);
      render(<DailyRitual range="1W" mode="long" headline={INTRADAY_HEADLINE} />);

      await screen.findByTestId("daily-recap-text");
      expect(recapText()).not.toContain("Hindsight over the past week");
      expect(recapText()).toContain("Beat the Bench: you beat the bench");
    });

    it("includes the intraday-daily figure once that guess has been made", async () => {
      savePlayedSession(SESSION_DATE, "todays-close", PLAYED);
      saveRangeGuess("1W", "long", 500, 20);
      render(<DailyRitual range="1W" mode="long" headline={INTRADAY_HEADLINE} />);

      await screen.findByTestId("daily-recap-text");
      await waitFor(() =>
        expect(recapText()).toContain("Hindsight over the past week: $20.00 became $2.4K (122x)"),
      );
    });

    it("still produces a coherent recap when the results fetch never landed", async () => {
      savePlayedSession(SESSION_DATE, "todays-close", PLAYED);
      renderRitual(null);

      await screen.findByTestId("daily-recap-text");
      expect(recapText()).not.toContain("Hindsight over");
      expect(recapText()).toContain("Beat the Bench: you beat the bench by 0.10%");
    });
  });

  describe("copying", () => {
    it("writes the recap to the clipboard and confirms it visibly", async () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      stubClipboard(writeText);
      savePlayedSession(SESSION_DATE, "todays-close", PLAYED);
      renderRitual();

      await screen.findByTestId("daily-recap-text");
      const expected = recapText();
      clickCopy();

      expect(writeText).toHaveBeenCalledWith(expected);
      expect(await screen.findByText("Copied to your clipboard.")).toBeInTheDocument();
    });

    it("falls back to a manual select when the clipboard is unavailable", async () => {
      // No navigator.clipboard at all -- jsdom's real state, and a real
      // browser's in any non-secure context.
      savePlayedSession(SESSION_DATE, "todays-close", PLAYED);
      renderRitual();

      await screen.findByTestId("daily-recap-text");
      clickCopy();

      expect(await screen.findByText(/select the text above and copy it yourself/)).toBeVisible();
      // The fallback isn't a new affordance that appears on failure: the
      // recap is already on screen and selectable in one click.
      expect(screen.getByTestId("daily-recap-text")).toHaveClass("select-all");
    });

    it("drops a stale confirmation when the recap regenerates under it", async () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      stubClipboard(writeText);
      savePlayedSession(SESSION_DATE, "todays-close", PLAYED);
      renderRitual();

      await screen.findByTestId("daily-recap-text");
      clickCopy();
      await screen.findByText("Copied to your clipboard.");

      // A Call Board pick made after the copy -- the recap on screen is no
      // longer the one on the clipboard, so the stamp must go.
      const [first] = upcomingCallDays(new Date());
      saveCallBoardPick(first!, "down", new Date());

      await waitFor(() => expect(recapText()).toContain("1 of 3 upcoming sessions called"));
      expect(screen.queryByText("Copied to your clipboard.")).not.toBeInTheDocument();
    });
  });
});
