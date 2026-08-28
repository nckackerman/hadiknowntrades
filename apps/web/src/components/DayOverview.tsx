"use client";

import { memo, useEffect, useMemo, useRef } from "react";
import type { PresetRange } from "@hadiknowntrades/core";

import { formatDate, formatDayOfMonth, formatShortWeekday } from "@/lib/format-date";
import { formatHeroCurrency } from "@/lib/format-currency";
import { prefersReducedMotion } from "@/lib/prefers-reduced-motion";
import { heroMultiplierColor } from "@/components/HeroStat";

export type DayOverviewLayout = "strip" | "list";

/**
 * Which layout each preset range gets (issue #193) -- a lookup table, not
 * an inline ternary at the one call site, matching this app's own
 * established convention for per-range config (`lib/range-copy.ts`'s
 * `RANGE_COPY`). Colocated with the component that owns the `layout`
 * concept itself, not `range-copy.ts` (a generic-phrase module with no
 * notion of layout), so a future range gaining its own distinct layout
 * (1Y's own ~252-day case, tracked as issue #140) is a one-line edit here.
 */
// `PresetRange` also covers 5Y/MAX, which never reach this component at
// all (they're the window model, not intraday-daily -- see
// ResultsPanel.tsx's own model branch) -- included here only because
// `Record<PresetRange, ...>` must be exhaustive; their value is never
// actually read.
export const DAY_OVERVIEW_LAYOUT_BY_RANGE: Record<PresetRange, DayOverviewLayout> = {
  "1W": "strip",
  "1M": "strip",
  "3M": "strip",
  "1Y": "list",
  "5Y": "strip",
  MAX: "strip",
};

/** "1 trade" / "2 trades" -- the one pluralization rule this component
 * needs, shared by both layouts (the list's own visible text and the
 * strip's chip aria-label) rather than each re-deriving the same ternary. */
function tradeCountLabel(tradeCount: number): string {
  return `${tradeCount} trade${tradeCount === 1 ? "" : "s"}`;
}

export interface DayOverviewRow {
  /** YYYY-MM-DD. */
  date: string;
  /**
   * This day's own trade count under whichever variant (long-only or
   * long+short, issue #13) is currently selected -- always shown,
   * unlike `endingBalance` below. A trade count alone doesn't reveal a
   * day's dollar outcome (the guessing game's actual "answer"), so
   * there's nothing to spoil by always showing it -- see this
   * component's own doc comment for the full reasoning.
   */
  tradeCount: number;
  /**
   * This day's ending balance, already display-rescaled to the user's
   * chosen starting capital (issue #15). Shown unconditionally -- issue
   * #91 removed per-day guessing entirely; the only remaining
   * guess-then-reveal gate on this page is WholeRangeBalance's own,
   * scoped to the whole range, not any individual day.
   */
  endingBalance: number;
  /**
   * This row's own display-rescaled starting capital (issue #193) --
   * identical across every row today (ResultsPanel rescales every row to
   * the same effectiveStartingCapital before building this array), but
   * carried per-row rather than as a single top-level prop so a row is a
   * self-contained unit: the strip layout's color bar (below) needs a
   * gain/loss direction for *this* row, and rescaling preserves that
   * ratio regardless of which starting capital it was computed against
   * (see apps/web/CLAUDE.md's "rescaleFromStartingCapital's per-day
   * pattern..." section for why the ratio survives the rescale even
   * though the absolute dollar amount doesn't mean "this day's real
   * chained balance").
   */
  startingCapital: number;
}

interface DayOverviewProps {
  /** Every trading day in the currently-viewed range, ascending by date -- ResultsPanel builds one row per `IntradayResult.days[]` entry. */
  rows: readonly DayOverviewRow[];
  /** The day currently drilled into below this list (ResultsPanel's `activeDay.date`). */
  selected: string;
  onSelect: (day: string) => void;
  /** IntradayResult.maxTradesPerDay -- read into this component's own caption rather than a hardcoded number, same "don't hardcode a schema constant" discipline the rest of ResultsPanel's copy already follows. */
  maxTradesPerDay: number;
  /**
   * "list" (unchanged, full-width row buttons -- 1Y, whose own ~252-day
   * case needs a different design tracked separately as issue #140) or
   * "strip" (a horizontally-scrollable row of compact day chips --
   * 1W/1M/3M, issue #193, every day short enough to fit on screen at
   * once). `ResultsPanel` computes this via this file's own
   * `DAY_OVERVIEW_LAYOUT_BY_RANGE` lookup table.
   */
  layout: DayOverviewLayout;
}

/**
 * Makes the per-day breadth of an intraday-daily range's result visible
 * and browsable at a glance (issue #80) -- every trading day in the
 * window gets its own row/chip (date, trade count, dollar outcome), not
 * just whichever single day happens to be selected below. Replaces
 * `DaySelector`'s bare `<select>` as the day-picking control entirely
 * (one mechanism, not two competing ones for the same job): clicking a
 * row/chip both reveals what that day is and picks it, which a plain
 * `<option>` list could never do on its own.
 *
 * **Two layouts, one component (issue #193), not two component files** --
 * they share the same props/data and most of the same interaction logic
 * (selection, scroll-into-view, the accessible-name treatment), so a
 * plain conditional render branch is enough:
 *
 * - **`layout === "list"`** (1Y): unchanged from issue #80 -- a
 *   scrollable list of full-width row buttons (`<ul>`/`<li>`, the same
 *   "real list semantics, custom-styled" idiom `TradeRow`'s `<li>` rows
 *   and the prose narration's `.trade-narration-item` already establish
 *   in this codebase) rather than a `<table>` -- unlike `PortfolioChart`'s
 *   own data-table fallback (a *read-only* disclosure), every row here is
 *   a primary interactive control, and a `<button>` isn't a valid direct
 *   child of `<tr>` per the HTML spec, so a table would need one more
 *   layer of indirection (a `<td>` wrapping a button, with the rest of
 *   the row inert) to get the same "whole row is one focusable, clickable
 *   target" behavior this gets for free.
 * - **`layout === "strip"`** (1W/1M/3M): a single horizontally-scrollable
 *   row of fixed-width (`w-14`) day chips instead. There isn't room at
 *   that width for a trade count or a dollar figure on the chip's own
 *   visible face, so both move into the chip's own `aria-label` (e.g.
 *   "Aug 24, 2026, 2 trades, $20.00 to $26.84") -- every one of the
 *   day's own drill-down details is still immediately visible below in
 *   the existing per-day `HeroAndWorstCase`/trade-list once that chip is
 *   selected, so nothing is lost, only relocated one interaction earlier
 *   than before (a real, minor regression from the list layout, which
 *   showed the figure without needing to select the row first). A small
 *   `h-1 w-6 rounded-full` bar underneath, colored `--status-good`/
 *   `--status-critical` (the same `>= is good` convention
 *   `TradeRow.tsx`/`HeroStat.tsx` already use) based on this row's own
 *   `endingBalance` vs. `startingCapital`, gives the same "gain or loss"
 *   information the list layout's dollar figure already communicates
 *   unconditionally (issue #91), just re-styled as a glance-able bar
 *   instead of a dollar figure.
 *
 * **Shows every row's `endingBalance` unconditionally (issue #91)** --
 * before that issue, each row's dollar figure stayed masked behind a
 * "Guess to reveal" placeholder until that exact day was individually
 * guessed (issue #34). That per-day guessing is gone: the only
 * guess-then-reveal gate left on this page is `WholeRangeBalance`'s own,
 * scoped to the whole range's chained final figure -- a single day's own
 * ending balance was never that answer to begin with, just one
 * ingredient of it, so gating it here bought no real spoiler protection,
 * only tedium.
 *
 * **The "carried over from {date}" note (issue #84)**: a purely
 * structural, non-numeric note communicating that chaining happened,
 * without leaking any dollar amount -- the previous row's own *date* is
 * already fully visible, ungated information (every row shows its date
 * regardless of guess status), so naming it here reveals nothing new.
 * Every row but the range's own first one gets this note. In the list
 * layout it's a small text line, `aria-hidden` (see the inline comment
 * at its render site for the full accessible-name-collision reasoning).
 * In the strip layout there's no room for text at all -- it becomes a
 * small `aria-hidden` `↩` glyph in the chip's own top-right corner
 * instead, same `aria-hidden` reasoning, with its full meaning
 * (unchanged) still available in the drill-down section below once that
 * chip is selected.
 *
 * **Scrolls the selected row/chip into view on mount and on every
 * selection change (found in `high` code review, fixed, issue #80)** --
 * the list layout is height-capped (`max-h-72`) and scrolls
 * independently; the strip layout scrolls horizontally instead
 * (`overflow-x-auto`). Either way the selected day defaults to the
 * *most recent* one (`ResultsPanel`'s own fallback), the last entry in
 * this ascending-date list/strip. Without this, the list/strip always
 * renders scrolled to its start on load for any range with more
 * days/chips than fit on screen -- the actually-active row/chip sits out
 * of view, defeating the "at a glance" point of this component.
 * `selectedRef` is attached only to the currently-selected row/chip's
 * `<button>` (never more than one at a time), and the effect keyed on
 * `selected` re-runs it every time the active day changes, including the
 * very first render. `scrollIntoView` is guarded two ways, both matching
 * this app's existing conventions for a browser API jsdom doesn't fully
 * implement (see `prefers-reduced-motion.ts`'s own `matchMedia` guard):
 * a `typeof ... === "function"` check, since jsdom (this app's test
 * environment) has no `scrollIntoView` at all, not even as a no-op stub
 * (confirmed against the actual jsdom install, not assumed); and
 * `behavior: "auto"` instead of `"smooth"` under `prefersReducedMotion()`,
 * the same "still happens, just not animated" treatment
 * `use-chart-tap-hint.ts`'s own affordances give reduced-motion users
 * elsewhere in this app -- unlike a purely decorative animation, jumping
 * to the right row/chip is functionally necessary, not itself motion
 * worth skipping. The one thing that differs between layouts is which
 * scroll axis to align on (`block: "nearest"` for the vertical list,
 * `inline: "nearest"` for the horizontal strip) -- everything else about
 * the call is identical.
 */
export const DayOverview = memo(function DayOverview({
  rows,
  selected,
  onSelect,
  maxTradesPerDay,
  layout,
}: DayOverviewProps) {
  const selectedRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const element = selectedRef.current;
    if (!element || typeof element.scrollIntoView !== "function") return;
    const behavior = prefersReducedMotion() ? "auto" : "smooth";
    element.scrollIntoView(
      layout === "strip" ? { inline: "nearest", behavior } : { block: "nearest", behavior },
    );
  }, [selected, layout]);

  // Per-row derivation (selection state, the "carried over from" previous
  // row, the shared pluralized trade-count label) computed once and shared
  // by both layout branches below, rather than each independently
  // re-deriving `isSelected`/`previousRow` off the same `rows`/`selected`
  // pair -- a real duplication risk (found in code review) now closed by
  // construction: there's only one place that logic can drift.
  const rowsMeta = useMemo(
    () =>
      rows.map((row, i) => ({
        row,
        isSelected: row.date === selected,
        // "Carried over from {date}" (issue #84) -- a purely structural,
        // non-numeric note communicating that chaining happened, without
        // leaking any dollar amount: the previous row's own *date* is
        // already fully visible, ungated information (every row shows
        // its date regardless of guess status), so naming it here
        // reveals nothing new. Every row but the range's own first one
        // gets this note.
        previousRow: i > 0 ? rows[i - 1] : null,
        tradeCountLabel: tradeCountLabel(row.tradeCount),
      })),
    [rows, selected],
  );

  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-sm text-[var(--text-secondary)]">
        {rows.length} trading day{rows.length === 1 ? "" : "s"} in this range, each with up to{" "}
        {maxTradesPerDay} of its own same-day trades, starting from the previous day&apos;s real
        result. Pick one below to see its result.
      </p>
      {layout === "list" ? (
        <ul className="flex max-h-72 flex-col gap-1 overflow-y-auto rounded-lg border border-[var(--gridline)] bg-[var(--surface-1)] p-1">
          {rowsMeta.map(({ row, isSelected, previousRow, tradeCountLabel }) => (
            <li key={row.date}>
              <button
                type="button"
                ref={isSelected ? selectedRef : undefined}
                aria-current={isSelected ? "true" : undefined}
                onClick={() => onSelect(row.date)}
                className={`grid w-full grid-cols-[1fr_auto_auto] items-center gap-x-3 rounded-md px-3 py-2 text-left text-sm transition-colors ${
                  isSelected
                    ? "bg-[var(--accent-selection)]/15 text-[var(--text-primary)]"
                    : "text-[var(--text-secondary)] hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)]"
                }`}
              >
                <span className="flex flex-col">
                  <span className="font-medium">{formatDate(row.date)}</span>
                  {previousRow && (
                    // aria-hidden: purely a visual affordance -- each
                    // row's own date is already independently accessible
                    // (read in DOM order), so a screen reader user
                    // tabbing through rows already hears the sequence of
                    // consecutive dates without this note; including it
                    // in this button's own accessible name would instead
                    // fold a *different* row's date into it, breaking
                    // exact-match accessible-name queries (this file's
                    // own DayOverview.test.tsx and ResultsPanel.test.tsx
                    // both rely on `getByRole("button", { name: ... })`
                    // uniquely identifying one row by its own date).
                    <span
                      aria-hidden="true"
                      className="text-xs font-normal text-[var(--text-muted)]"
                    >
                      carried over from {formatDate(previousRow.date)}
                    </span>
                  )}
                </span>
                <span className="text-[var(--text-muted)]">{tradeCountLabel}</span>
                <span className="tabular-nums font-semibold">
                  {formatHeroCurrency(row.endingBalance)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <ul className="flex gap-1.5 overflow-x-auto rounded-lg border border-[var(--gridline)] bg-[var(--surface-1)] p-1.5">
          {rowsMeta.map(({ row, isSelected, previousRow, tradeCountLabel }) => {
            // Reuses HeroStat's own `>= 1` gain/loss threshold rather than
            // re-deriving it a third time (found in code review) -- see
            // that function's own doc comment for why the two badges (and
            // now this bar) must never drift apart.
            const barColor = heroMultiplierColor(row.endingBalance / row.startingCapital);
            const ariaLabel = `${formatDate(row.date)}, ${tradeCountLabel}, ${formatHeroCurrency(row.startingCapital)} to ${formatHeroCurrency(row.endingBalance)}`;
            return (
              <li key={row.date} className="shrink-0">
                <button
                  type="button"
                  ref={isSelected ? selectedRef : undefined}
                  aria-current={isSelected ? "true" : undefined}
                  aria-label={ariaLabel}
                  onClick={() => onSelect(row.date)}
                  className={`relative flex w-14 shrink-0 flex-col items-center gap-1 rounded-md border px-1 py-2 transition-colors ${
                    isSelected
                      ? "border-[var(--accent-selection)] bg-[var(--accent-selection)]/15 text-[var(--text-primary)]"
                      : "border-transparent text-[var(--text-secondary)] hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)]"
                  }`}
                >
                  {previousRow && (
                    // aria-hidden: the same purely-visual affordance the
                    // list layout's "carried over from {date}" text note
                    // gives -- see this component's own doc comment above
                    // for the full reasoning. At this chip's width there's
                    // no room for the text form at all, so it's a small
                    // corner glyph instead; its full meaning is unchanged
                    // and still available in the drill-down section below
                    // once this chip is selected.
                    <span
                      aria-hidden="true"
                      className="absolute top-0.5 right-0.5 text-[10px] leading-none text-[var(--text-muted)]"
                    >
                      ↩
                    </span>
                  )}
                  <span className="text-xs font-medium">{formatShortWeekday(row.date)}</span>
                  <span className="text-sm font-semibold">{formatDayOfMonth(row.date)}</span>
                  <span className="h-1 w-6 rounded-full" style={{ backgroundColor: barColor }} />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
});
