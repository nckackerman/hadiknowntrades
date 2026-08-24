import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { stubMatchMedia } from "@/lib/stub-match-media.test-util";
import { DayOverview, type DayOverviewRow } from "./DayOverview";

const ROWS: DayOverviewRow[] = [
  { date: "2026-08-19", tradeCount: 2, endingBalance: null },
  { date: "2026-08-20", tradeCount: 3, endingBalance: null },
  { date: "2026-08-21", tradeCount: 1, endingBalance: 40 },
];

afterEach(() => {
  vi.unstubAllGlobals();
  // Undo any per-test stub of scrollIntoView (jsdom has no default
  // implementation at all -- see this component's own doc comment --
  // so a test that adds one must remove it afterward or it'd leak into
  // the next test file's own jsdom environment).
  delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
});

describe("DayOverview", () => {
  it("renders every row's date and trade count, and only the guessed row's dollar figure", () => {
    render(
      <DayOverview rows={ROWS} selected="2026-08-21" onSelect={vi.fn()} maxTradesPerDay={3} />,
    );

    expect(screen.getByRole("button", { name: /Aug 19, 2026.*2 trades/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Aug 20, 2026.*3 trades/ })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Aug 21, 2026.*1 trade\b.*\$40\.00/ }),
    ).toBeInTheDocument();
    expect(screen.getAllByText("Guess to reveal")).toHaveLength(2);
  });

  it("intro copy reflects chaining, not independent per-day resets (issue #84)", () => {
    render(
      <DayOverview rows={ROWS} selected="2026-08-21" onSelect={vi.fn()} maxTradesPerDay={3} />,
    );

    expect(screen.getByText(/starting from the previous day's real result/i)).toBeInTheDocument();
    expect(screen.queryByText(/independently-computed/i)).not.toBeInTheDocument();
  });

  it("marks every row but the range's own first day with a non-numeric 'carried over from {date}' note (issue #84) -- communicates chaining without leaking any dollar amount", () => {
    render(
      <DayOverview rows={ROWS} selected="2026-08-21" onSelect={vi.fn()} maxTradesPerDay={3} />,
    );

    // The range's own first day (2026-08-19) has no previous day to name,
    // so only 2 of the 3 rows get a note.
    const notes = screen.getAllByText(/carried over from/i);
    expect(notes).toHaveLength(2); // one for Aug 20 (carried from Aug 19), one for Aug 21 (from Aug 20)
    expect(notes[0]).toHaveTextContent("carried over from Aug 19, 2026");
    expect(notes[1]).toHaveTextContent("carried over from Aug 20, 2026");
    // No dollar amount anywhere in either note -- the whole point of this
    // note is communicating *that* chaining happened, never *how much*.
    for (const note of notes) {
      expect(note).not.toHaveTextContent(/\$/);
    }
  });

  it("calls onSelect with the clicked row's date", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <DayOverview rows={ROWS} selected="2026-08-21" onSelect={onSelect} maxTradesPerDay={3} />,
    );

    await user.click(screen.getByRole("button", { name: /Aug 19, 2026/ }));

    expect(onSelect).toHaveBeenCalledWith("2026-08-19");
  });

  it("marks only the selected row with aria-current", () => {
    render(
      <DayOverview rows={ROWS} selected="2026-08-20" onSelect={vi.fn()} maxTradesPerDay={3} />,
    );

    expect(screen.getByRole("button", { name: /Aug 20, 2026/ })).toHaveAttribute(
      "aria-current",
      "true",
    );
    expect(screen.getByRole("button", { name: /Aug 19, 2026/ })).not.toHaveAttribute(
      "aria-current",
    );
  });

  describe("scrolling the selected row into view (issue #80, found in high code review)", () => {
    it("scrolls the selected row into view on mount, not an unselected one", () => {
      const scrollIntoView = vi.fn();
      Element.prototype.scrollIntoView = scrollIntoView;

      render(
        <DayOverview rows={ROWS} selected="2026-08-21" onSelect={vi.fn()} maxTradesPerDay={3} />,
      );

      expect(scrollIntoView).toHaveBeenCalledTimes(1);
      // Called on the selected (2026-08-21) row's own button -- `this`
      // inside a plain (non-arrow) mock reflects the call's receiver.
      expect(scrollIntoView.mock.instances[0]).toBe(
        screen.getByRole("button", { name: /Aug 21, 2026/ }),
      );
    });

    it("scrolls the newly-selected row into view again when `selected` changes", () => {
      const scrollIntoView = vi.fn();
      Element.prototype.scrollIntoView = scrollIntoView;

      const { rerender } = render(
        <DayOverview rows={ROWS} selected="2026-08-21" onSelect={vi.fn()} maxTradesPerDay={3} />,
      );
      scrollIntoView.mockClear();

      rerender(
        <DayOverview rows={ROWS} selected="2026-08-19" onSelect={vi.fn()} maxTradesPerDay={3} />,
      );

      expect(scrollIntoView).toHaveBeenCalledTimes(1);
      expect(scrollIntoView.mock.instances[0]).toBe(
        screen.getByRole("button", { name: /Aug 19, 2026/ }),
      );
    });

    it("does not re-scroll on a render that leaves `selected` unchanged", () => {
      const scrollIntoView = vi.fn();
      Element.prototype.scrollIntoView = scrollIntoView;

      const { rerender } = render(
        <DayOverview rows={ROWS} selected="2026-08-21" onSelect={vi.fn()} maxTradesPerDay={3} />,
      );
      scrollIntoView.mockClear();

      // A new rows array (fresh object identity, same content) with the
      // same `selected` -- the kind of re-render ResultsPanel.tsx's own
      // memoized dayOverviewRows is specifically meant to reduce, but
      // even an unmemoized caller shouldn't cause a redundant scroll.
      rerender(
        <DayOverview
          rows={[...ROWS]}
          selected="2026-08-21"
          onSelect={vi.fn()}
          maxTradesPerDay={3}
        />,
      );

      expect(scrollIntoView).not.toHaveBeenCalled();
    });

    it("uses smooth scrolling when motion isn't reduced", () => {
      const scrollIntoView = vi.fn();
      Element.prototype.scrollIntoView = scrollIntoView;
      stubMatchMedia({ "(prefers-reduced-motion: reduce)": false });

      render(
        <DayOverview rows={ROWS} selected="2026-08-21" onSelect={vi.fn()} maxTradesPerDay={3} />,
      );

      expect(scrollIntoView).toHaveBeenCalledWith(
        expect.objectContaining({ behavior: "smooth", block: "nearest" }),
      );
    });

    it("uses instant (non-animated) scrolling under prefers-reduced-motion", () => {
      const scrollIntoView = vi.fn();
      Element.prototype.scrollIntoView = scrollIntoView;
      stubMatchMedia({ "(prefers-reduced-motion: reduce)": true });

      render(
        <DayOverview rows={ROWS} selected="2026-08-21" onSelect={vi.fn()} maxTradesPerDay={3} />,
      );

      expect(scrollIntoView).toHaveBeenCalledWith(
        expect.objectContaining({ behavior: "auto", block: "nearest" }),
      );
    });

    it("never throws when scrollIntoView isn't implemented at all (jsdom's real default -- no stub in this test)", () => {
      expect(typeof Element.prototype.scrollIntoView).toBe("undefined");

      expect(() =>
        render(
          <DayOverview rows={ROWS} selected="2026-08-21" onSelect={vi.fn()} maxTradesPerDay={3} />,
        ),
      ).not.toThrow();
    });
  });
});
