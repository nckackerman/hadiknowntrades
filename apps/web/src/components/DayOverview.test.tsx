import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { stubMatchMedia } from "@/lib/stub-match-media.test-util";
import { DayOverview, type DayOverviewRow } from "./DayOverview";

const ROWS: DayOverviewRow[] = [
  { date: "2026-08-19", tradeCount: 2, endingBalance: 25, startingCapital: 20 },
  { date: "2026-08-20", tradeCount: 3, endingBalance: 30, startingCapital: 20 },
  { date: "2026-08-21", tradeCount: 1, endingBalance: 40, startingCapital: 20 },
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
  describe("list layout (1Y, issue #80 -- unchanged, pure conditional split, issue #193)", () => {
    it("renders every row's date, trade count, and dollar figure unconditionally (issue #91 -- no per-day guess gate)", () => {
      render(
        <DayOverview
          rows={ROWS}
          selected="2026-08-21"
          onSelect={vi.fn()}
          maxTradesPerDay={3}
          layout="list"
        />,
      );

      expect(
        screen.getByRole("button", { name: /Aug 19, 2026.*2 trades.*\$25\.00/ }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: /Aug 20, 2026.*3 trades.*\$30\.00/ }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: /Aug 21, 2026.*1 trade\b.*\$40\.00/ }),
      ).toBeInTheDocument();
      expect(screen.queryByText("Guess to reveal")).not.toBeInTheDocument();
    });

    it("intro copy reflects chaining, not independent per-day resets (issue #84)", () => {
      render(
        <DayOverview
          rows={ROWS}
          selected="2026-08-21"
          onSelect={vi.fn()}
          maxTradesPerDay={3}
          layout="list"
        />,
      );

      expect(screen.getByText(/starting from the previous day's real result/i)).toBeInTheDocument();
      expect(screen.queryByText(/independently-computed/i)).not.toBeInTheDocument();
    });

    it("marks every row but the range's own first day with a non-numeric 'carried over from {date}' note (issue #84) -- communicates chaining without leaking any dollar amount", () => {
      render(
        <DayOverview
          rows={ROWS}
          selected="2026-08-21"
          onSelect={vi.fn()}
          maxTradesPerDay={3}
          layout="list"
        />,
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
        <DayOverview
          rows={ROWS}
          selected="2026-08-21"
          onSelect={onSelect}
          maxTradesPerDay={3}
          layout="list"
        />,
      );

      await user.click(screen.getByRole("button", { name: /Aug 19, 2026/ }));

      expect(onSelect).toHaveBeenCalledWith("2026-08-19");
    });

    it("marks only the selected row with aria-current", () => {
      render(
        <DayOverview
          rows={ROWS}
          selected="2026-08-20"
          onSelect={vi.fn()}
          maxTradesPerDay={3}
          layout="list"
        />,
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
          <DayOverview
            rows={ROWS}
            selected="2026-08-21"
            onSelect={vi.fn()}
            maxTradesPerDay={3}
            layout="list"
          />,
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
          <DayOverview
            rows={ROWS}
            selected="2026-08-21"
            onSelect={vi.fn()}
            maxTradesPerDay={3}
            layout="list"
          />,
        );
        scrollIntoView.mockClear();

        rerender(
          <DayOverview
            rows={ROWS}
            selected="2026-08-19"
            onSelect={vi.fn()}
            maxTradesPerDay={3}
            layout="list"
          />,
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
          <DayOverview
            rows={ROWS}
            selected="2026-08-21"
            onSelect={vi.fn()}
            maxTradesPerDay={3}
            layout="list"
          />,
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
            layout="list"
          />,
        );

        expect(scrollIntoView).not.toHaveBeenCalled();
      });

      it("uses smooth scrolling, aligned on the vertical axis (block: nearest), when motion isn't reduced", () => {
        const scrollIntoView = vi.fn();
        Element.prototype.scrollIntoView = scrollIntoView;
        stubMatchMedia({ "(prefers-reduced-motion: reduce)": false });

        render(
          <DayOverview
            rows={ROWS}
            selected="2026-08-21"
            onSelect={vi.fn()}
            maxTradesPerDay={3}
            layout="list"
          />,
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
          <DayOverview
            rows={ROWS}
            selected="2026-08-21"
            onSelect={vi.fn()}
            maxTradesPerDay={3}
            layout="list"
          />,
        );

        expect(scrollIntoView).toHaveBeenCalledWith(
          expect.objectContaining({ behavior: "auto", block: "nearest" }),
        );
      });

      it("never throws when scrollIntoView isn't implemented at all (jsdom's real default -- no stub in this test)", () => {
        expect(typeof Element.prototype.scrollIntoView).toBe("undefined");

        expect(() =>
          render(
            <DayOverview
              rows={ROWS}
              selected="2026-08-21"
              onSelect={vi.fn()}
              maxTradesPerDay={3}
              layout="list"
            />,
          ),
        ).not.toThrow();
      });
    });
  });

  describe("strip layout (1W/1M/3M, issue #193)", () => {
    it("renders one chip per row, with the exact date/trade-count/dollar-figure information available via aria-label", () => {
      render(
        <DayOverview
          rows={ROWS}
          selected="2026-08-21"
          onSelect={vi.fn()}
          maxTradesPerDay={3}
          layout="strip"
        />,
      );

      expect(
        screen.getByRole("button", { name: "Aug 19, 2026, 2 trades, $20.00 to $25.00" }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Aug 20, 2026, 3 trades, $20.00 to $30.00" }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Aug 21, 2026, 1 trade, $20.00 to $40.00" }),
      ).toBeInTheDocument();
    });

    it("shows only a short weekday abbreviation and the day-of-month number on the chip's own visible face -- no dollar figure or trade count text", () => {
      render(
        <DayOverview
          rows={ROWS}
          selected="2026-08-21"
          onSelect={vi.fn()}
          maxTradesPerDay={3}
          layout="strip"
        />,
      );

      const chip = screen.getByRole("button", { name: /Aug 21, 2026/ });
      expect(chip).toHaveTextContent("Fri");
      expect(chip).toHaveTextContent("21");
      expect(chip.textContent).not.toMatch(/\$/);
      expect(chip.textContent).not.toMatch(/trade/i);
    });

    it("marks only the selected chip with aria-current", () => {
      render(
        <DayOverview
          rows={ROWS}
          selected="2026-08-20"
          onSelect={vi.fn()}
          maxTradesPerDay={3}
          layout="strip"
        />,
      );

      expect(screen.getByRole("button", { name: /Aug 20, 2026/ })).toHaveAttribute(
        "aria-current",
        "true",
      );
      expect(screen.getByRole("button", { name: /Aug 19, 2026/ })).not.toHaveAttribute(
        "aria-current",
      );
    });

    it("calls onSelect with the clicked chip's date", async () => {
      const user = userEvent.setup();
      const onSelect = vi.fn();
      render(
        <DayOverview
          rows={ROWS}
          selected="2026-08-21"
          onSelect={onSelect}
          maxTradesPerDay={3}
          layout="strip"
        />,
      );

      await user.click(screen.getByRole("button", { name: /Aug 19, 2026/ }));

      expect(onSelect).toHaveBeenCalledWith("2026-08-19");
    });

    it("colors the gain/loss bar per row's own endingBalance vs. startingCapital (>= is good, the same convention TradeRow/HeroStat use)", () => {
      const rows: DayOverviewRow[] = [
        { date: "2026-08-19", tradeCount: 1, endingBalance: 25, startingCapital: 20 }, // gain
        { date: "2026-08-20", tradeCount: 1, endingBalance: 15, startingCapital: 20 }, // loss
      ];
      render(
        <DayOverview
          rows={rows}
          selected="2026-08-19"
          onSelect={vi.fn()}
          maxTradesPerDay={3}
          layout="strip"
        />,
      );

      const gainChip = screen.getByRole("button", { name: /Aug 19, 2026/ });
      const lossChip = screen.getByRole("button", { name: /Aug 20, 2026/ });
      // The color bar is a bare <span>, no accessible role of its own --
      // it's the chip's own last child element.
      const gainBar = gainChip.lastElementChild;
      const lossBar = lossChip.lastElementChild;
      expect(gainBar?.className).toContain("--status-good");
      expect(lossBar?.className).toContain("--status-critical");
    });

    it("marks every chip but the range's own first day with an aria-hidden '↩' corner glyph, communicating chaining without adding any text to the accessible name (issue #84/#193)", () => {
      render(
        <DayOverview
          rows={ROWS}
          selected="2026-08-21"
          onSelect={vi.fn()}
          maxTradesPerDay={3}
          layout="strip"
        />,
      );

      const glyphs = screen.getAllByText("↩");
      expect(glyphs).toHaveLength(2); // Aug 20 (from Aug 19) and Aug 21 (from Aug 20)
      for (const glyph of glyphs) {
        expect(glyph).toHaveAttribute("aria-hidden", "true");
      }
      // The corner glyph never leaks into a chip's own accessible name --
      // unlike the list layout's text note (also aria-hidden, for the
      // identical accessible-name-collision reason), the strip's chips
      // have no room for the note's own text at all, so it never appears
      // in the aria-label either.
      expect(
        screen.getByRole("button", { name: "Aug 21, 2026, 1 trade, $20.00 to $40.00" }),
      ).toBeInTheDocument();
    });

    describe("scrolling the selected chip into view, horizontally (issue #80/#193)", () => {
      it("scrolls the selected chip into view on mount, aligned on the horizontal axis (inline: nearest)", () => {
        const scrollIntoView = vi.fn();
        Element.prototype.scrollIntoView = scrollIntoView;

        render(
          <DayOverview
            rows={ROWS}
            selected="2026-08-21"
            onSelect={vi.fn()}
            maxTradesPerDay={3}
            layout="strip"
          />,
        );

        expect(scrollIntoView).toHaveBeenCalledTimes(1);
        expect(scrollIntoView.mock.instances[0]).toBe(
          screen.getByRole("button", { name: /Aug 21, 2026/ }),
        );
        expect(scrollIntoView).toHaveBeenCalledWith(expect.objectContaining({ inline: "nearest" }));
        // Not the list layout's vertical-axis option.
        expect(scrollIntoView.mock.calls[0]?.[0]).not.toHaveProperty("block");
      });

      it("scrolls the newly-selected chip into view again when `selected` changes", () => {
        const scrollIntoView = vi.fn();
        Element.prototype.scrollIntoView = scrollIntoView;

        const { rerender } = render(
          <DayOverview
            rows={ROWS}
            selected="2026-08-21"
            onSelect={vi.fn()}
            maxTradesPerDay={3}
            layout="strip"
          />,
        );
        scrollIntoView.mockClear();

        rerender(
          <DayOverview
            rows={ROWS}
            selected="2026-08-19"
            onSelect={vi.fn()}
            maxTradesPerDay={3}
            layout="strip"
          />,
        );

        expect(scrollIntoView).toHaveBeenCalledTimes(1);
        expect(scrollIntoView.mock.instances[0]).toBe(
          screen.getByRole("button", { name: /Aug 19, 2026/ }),
        );
      });

      it("never throws when scrollIntoView isn't implemented at all (jsdom's real default -- no stub in this test)", () => {
        expect(typeof Element.prototype.scrollIntoView).toBe("undefined");

        expect(() =>
          render(
            <DayOverview
              rows={ROWS}
              selected="2026-08-21"
              onSelect={vi.fn()}
              maxTradesPerDay={3}
              layout="strip"
            />,
          ),
        ).not.toThrow();
      });
    });
  });
});
