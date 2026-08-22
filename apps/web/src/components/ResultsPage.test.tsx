import { customRangeAnchors } from "@hadiknowntrades/core";
import { render, screen } from "@testing-library/react";
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

      await user.selectOptions(screen.getByRole("combobox"), anchor);

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
});
