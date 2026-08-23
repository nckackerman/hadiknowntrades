import { RESULTS_SCHEMA_VERSION } from "@hadiknowntrades/core";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

  // CustomRangeSelector/ModeToggle each render twice (issue #63) -- once
  // in a `sm:flex` div visible at desktop widths, once inside a `sm:hidden`
  // <details> "More options" disclosure for narrow viewports -- see
  // ResultsPage.tsx's own doc comment on why this is two real instances
  // rather than one CSS-toggled instance. jsdom loads no stylesheet in
  // this test file, so both instances report as equally "visible" to
  // Testing Library queries; scope to the desktop copy (arbitrary but
  // consistent -- both instances share the same props/handlers, so which
  // one a test interacts with doesn't affect what it's actually proving).
  function desktopControls() {
    return within(screen.getByTestId("controls-more-desktop"));
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

  it("defaults to 1Y when the URL has no range param", () => {
    render(<ResultsPage />);

    expect(screen.getByRole("button", { name: "1Y" })).toHaveAttribute("aria-pressed", "true");
    expect(fetch).toHaveBeenCalledWith("/api/results?range=1Y");
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

    expect(screen.getByRole("button", { name: "1Y" })).toHaveAttribute("aria-pressed", "true");
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

      expect(desktopControls().getByRole("button", { name: "Long only" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
    });

    it("reads the initial mode from the URL, case-insensitively", () => {
      search = "mode=LONG-SHORT";
      render(<ResultsPage />);

      expect(desktopControls().getByRole("button", { name: "Long + short" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
    });

    it("falls back to the default mode for an unrecognized URL param", () => {
      search = "mode=bogus";
      render(<ResultsPage />);

      expect(desktopControls().getByRole("button", { name: "Long only" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
    });

    it("writes the selected mode to the URL via router.replace when the toggle is clicked", async () => {
      const user = userEvent.setup();
      render(<ResultsPage />);

      await user.click(desktopControls().getByRole("button", { name: "Long + short" }));

      expect(replace).toHaveBeenCalledWith("/?mode=long-short", { scroll: false });
    });

    it("preserves the current range when only the mode changes", async () => {
      search = "range=5Y";
      const user = userEvent.setup();
      render(<ResultsPage />);

      await user.click(desktopControls().getByRole("button", { name: "Long + short" }));

      expect(replace).toHaveBeenCalledWith("/?range=5Y&mode=long-short", { scroll: false });
    });
  });

  describe("custom start-date anchor mode (issue #11, day-granularity since issue #75)", () => {
    it("fetches the anchor-specific endpoint and marks no preset pill as selected when ?anchor= is present", () => {
      const anchor = TEST_ANCHORS[0]!;
      search = `anchor=${anchor}`;
      render(<ResultsPage />);

      expect(fetch).toHaveBeenCalledWith(`/api/results?anchor=${anchor}`);
      for (const name of ["1M", "3M", "1Y", "5Y", "Max"]) {
        expect(screen.getByRole("button", { name })).toHaveAttribute("aria-pressed", "false");
      }
    });

    it("does not also fetch a preset range while in anchor mode", () => {
      const anchor = TEST_ANCHORS[0]!;
      search = `anchor=${anchor}`;
      render(<ResultsPage />);

      expect(fetch).not.toHaveBeenCalledWith(expect.stringContaining("range="));
    });

    it("falls back to range mode for a malformed ?anchor= value", () => {
      search = "anchor=not-a-date";
      render(<ResultsPage />);

      expect(screen.getByRole("button", { name: "1Y" })).toHaveAttribute("aria-pressed", "true");
      expect(fetch).toHaveBeenCalledWith("/api/results?range=1Y");
    });

    it("writes the selected anchor to the URL, clearing ?range=, when a start date is chosen", async () => {
      const user = userEvent.setup();
      const anchor = TEST_ANCHORS[2]!;
      search = "range=5Y";
      render(<ResultsPage />);

      await selectAnchorViaCalendar(user, desktopControls(), anchor);

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
      expect(desktopControls().getByRole("button", { name: "Long + short" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
    });

    it("preserves the current anchor when only the mode changes", async () => {
      const anchor = TEST_ANCHORS[0]!;
      search = `anchor=${anchor}`;
      const user = userEvent.setup();
      render(<ResultsPage />);

      await user.click(desktopControls().getByRole("button", { name: "Long + short" }));

      expect(replace).toHaveBeenCalledWith(`/?anchor=${anchor}&mode=long-short`, {
        scroll: false,
      });
    });

    it("preserves the current mode when the anchor changes", async () => {
      const anchor = TEST_ANCHORS[2]!;
      search = "range=5Y&mode=long-short";
      const user = userEvent.setup();
      render(<ResultsPage />);

      await selectAnchorViaCalendar(user, desktopControls(), anchor);

      expect(replace).toHaveBeenCalledWith(`/?mode=long-short&anchor=${anchor}`, {
        scroll: false,
      });
    });
  });

  describe('mobile "More options" disclosure (issue #63)', () => {
    // The mobile-only copy (data-testid="controls-more-mobile", inside a
    // sm:hidden <details>) has identical props/handlers to the desktop
    // copy every other describe block above exercises via
    // desktopControls() -- every prior test here only proves the desktop
    // instance is wired correctly, never this one. Without a dedicated
    // check here, a future bug isolated to just the <details> copy (a
    // typo in its own onSelect prop, the <details>/summary structure
    // getting mangled) would pass the full suite untouched (`high` code
    // review finding on this issue's own PR, fixed).
    function mobileControls() {
      return within(screen.getByTestId("controls-more-mobile"));
    }

    it("writes the selected mode to the URL when the toggle inside the mobile disclosure is clicked", async () => {
      const user = userEvent.setup();
      render(<ResultsPage />);

      await user.click(mobileControls().getByRole("button", { name: "Long + short" }));

      expect(replace).toHaveBeenCalledWith("/?mode=long-short", { scroll: false });
    });

    it("writes the selected anchor to the URL when a start date is chosen inside the mobile disclosure", async () => {
      const user = userEvent.setup();
      const anchor = TEST_ANCHORS[2]!;
      search = "range=5Y";
      render(<ResultsPage />);

      await selectAnchorViaCalendar(user, mobileControls(), anchor);

      expect(replace).toHaveBeenCalledWith(`/?anchor=${anchor}`, { scroll: false });
    });
  });
});
