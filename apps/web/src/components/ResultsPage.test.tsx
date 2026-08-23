import { customRangeAnchors } from "@hadiknowntrades/core";
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

describe("ResultsPage", () => {
  beforeEach(() => {
    replace.mockClear();
    search = "";
    // Never resolves -- these tests only care about range/URL wiring,
    // not the fetched data, so leaving the panel in "loading" is fine.
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => {})),
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

  describe("custom start-date anchor mode (issue #11)", () => {
    it("fetches the anchor-specific endpoint and marks no preset pill as selected when ?anchor= is present", () => {
      const anchor = customRangeAnchors(new Date())[0]!;
      search = `anchor=${anchor}`;
      render(<ResultsPage />);

      expect(fetch).toHaveBeenCalledWith(`/api/results?anchor=${anchor}`);
      for (const name of ["1M", "3M", "1Y", "5Y", "Max"]) {
        expect(screen.getByRole("button", { name })).toHaveAttribute("aria-pressed", "false");
      }
    });

    it("does not also fetch a preset range while in anchor mode", () => {
      const anchor = customRangeAnchors(new Date())[0]!;
      search = `anchor=${anchor}`;
      render(<ResultsPage />);

      expect(fetch).not.toHaveBeenCalledWith(expect.stringContaining("range="));
    });

    it("falls back to range mode for a malformed ?anchor= value", () => {
      search = "anchor=not-a-month";
      render(<ResultsPage />);

      expect(screen.getByRole("button", { name: "1Y" })).toHaveAttribute("aria-pressed", "true");
      expect(fetch).toHaveBeenCalledWith("/api/results?range=1Y");
    });

    it("writes the selected anchor to the URL, clearing ?range=, when a start month is chosen", async () => {
      const user = userEvent.setup();
      const anchor = customRangeAnchors(new Date())[2]!;
      search = "range=5Y";
      render(<ResultsPage />);

      await user.selectOptions(desktopControls().getByRole("combobox"), anchor);

      expect(replace).toHaveBeenCalledWith(`/?anchor=${anchor}`, { scroll: false });
    });

    it("clears ?anchor= when a preset range button is clicked while in anchor mode", async () => {
      const user = userEvent.setup();
      const anchor = customRangeAnchors(new Date())[0]!;
      search = `anchor=${anchor}`;
      render(<ResultsPage />);

      await user.click(screen.getByRole("button", { name: "5Y" }));

      expect(replace).toHaveBeenCalledWith("/?range=5Y", { scroll: false });
    });
  });

  describe("anchor and mode combined (issue #11/#13 integration)", () => {
    it("fetches the anchor-specific endpoint and reads mode from the URL when both ?anchor= and ?mode= are set", () => {
      const anchor = customRangeAnchors(new Date())[0]!;
      search = `anchor=${anchor}&mode=long-short`;
      render(<ResultsPage />);

      expect(fetch).toHaveBeenCalledWith(`/api/results?anchor=${anchor}`);
      expect(desktopControls().getByRole("button", { name: "Long + short" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
    });

    it("preserves the current anchor when only the mode changes", async () => {
      const anchor = customRangeAnchors(new Date())[0]!;
      search = `anchor=${anchor}`;
      const user = userEvent.setup();
      render(<ResultsPage />);

      await user.click(desktopControls().getByRole("button", { name: "Long + short" }));

      expect(replace).toHaveBeenCalledWith(`/?anchor=${anchor}&mode=long-short`, {
        scroll: false,
      });
    });

    it("preserves the current mode when the anchor changes", async () => {
      const anchor = customRangeAnchors(new Date())[2]!;
      search = "range=5Y&mode=long-short";
      const user = userEvent.setup();
      render(<ResultsPage />);

      await user.selectOptions(desktopControls().getByRole("combobox"), anchor);

      expect(replace).toHaveBeenCalledWith(`/?mode=long-short&anchor=${anchor}`, {
        scroll: false,
      });
    });
  });
});
