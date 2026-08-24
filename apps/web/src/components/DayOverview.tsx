"use client";

import { useEffect, useRef } from "react";

import { formatDate } from "@/lib/format-date";
import { formatHeroCurrency } from "@/lib/format-currency";
import { prefersReducedMotion } from "@/lib/prefers-reduced-motion";

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
}

interface DayOverviewProps {
  /** Every trading day in the currently-viewed range, ascending by date -- ResultsPanel builds one row per `IntradayResult.days[]` entry. */
  rows: readonly DayOverviewRow[];
  /** The day currently drilled into below this list (ResultsPanel's `activeDay.date`). */
  selected: string;
  onSelect: (day: string) => void;
  /** IntradayResult.maxTradesPerDay -- read into this component's own caption rather than a hardcoded number, same "don't hardcode a schema constant" discipline the rest of ResultsPanel's copy already follows. */
  maxTradesPerDay: number;
}

/**
 * Makes the per-day breadth of an intraday-daily range's result visible
 * and browsable at a glance (issue #80) -- every trading day in the
 * window gets its own row (date, trade count, dollar outcome), not just
 * whichever single day happens to be selected below. Replaces
 * `DaySelector`'s bare `<select>` as the day-picking control entirely
 * (one mechanism, not two competing ones for the same job): clicking a
 * row both reveals what that day is and picks it, which a plain
 * `<option>` list could never do on its own.
 *
 * A scrollable list of full-width row buttons (`<ul>`/`<li>`, the same
 * "real list semantics, custom-styled" idiom `TradeRow`'s `<li>` rows and
 * the prose narration's `.trade-narration-item` already establish in this
 * codebase) rather than a `<table>` -- unlike `PortfolioChart`'s own
 * data-table fallback (a *read-only* disclosure), every row here is a
 * primary interactive control, and a `<button>` isn't a valid direct
 * child of `<tr>` per the HTML spec, so a table would need one more
 * layer of indirection (a `<td>` wrapping a button, with the rest of the
 * row inert) to get the same "whole row is one focusable, clickable
 * target" behavior this gets for free.
 *
 * **Shows every row's `endingBalance` unconditionally (issue #91)** --
 * before this issue, each row's dollar figure stayed masked behind a
 * "Guess to reveal" placeholder until that exact day was individually
 * guessed (issue #34). That per-day guessing is gone: the only
 * guess-then-reveal gate left on this page is `WholeRangeBalance`'s own,
 * scoped to the whole range's chained final figure -- a single day's own
 * ending balance was never that answer to begin with, just one
 * ingredient of it, so gating it here bought no real spoiler protection,
 * only tedium.
 *
 * **Scrolls the selected row into view on mount and on every selection
 * change (found in `high` code review, fixed)** -- the list is height-
 * capped (`max-h-72`) and scrolls independently, and the selected day
 * defaults to the *most recent* one (`ResultsPanel`'s own fallback), the
 * last entry in this ascending-date list. Without this, the list always
 * renders scrolled to the top on load for any range with more days than
 * fit in ~288px (1M/3M/1Y) -- the actually-active row sits below the
 * fold, defeating the "at a glance" point of this component. `selectedRef`
 * is attached only to the currently-selected row's `<button>` (never more
 * than one at a time), and the effect keyed on `selected` re-runs it
 * every time the active day changes, including the very first render.
 * `scrollIntoView` is guarded two ways, both matching this app's existing
 * conventions for a browser API jsdom doesn't fully implement (see
 * `prefers-reduced-motion.ts`'s own `matchMedia` guard): a
 * `typeof ... === "function"` check, since jsdom (this app's test
 * environment) has no `scrollIntoView` at all, not even as a no-op stub
 * (confirmed against the actual jsdom install, not assumed); and
 * `behavior: "auto"` instead of `"smooth"` under `prefersReducedMotion()`,
 * the same "still happens, just not animated" treatment
 * `use-chart-tap-hint.ts`'s own affordances give reduced-motion users
 * elsewhere in this app -- unlike a purely decorative animation, jumping
 * the list to the right row is functionally necessary, not itself motion
 * worth skipping.
 */
export function DayOverview({ rows, selected, onSelect, maxTradesPerDay }: DayOverviewProps) {
  const selectedRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const element = selectedRef.current;
    if (!element || typeof element.scrollIntoView !== "function") return;
    element.scrollIntoView({
      block: "nearest",
      behavior: prefersReducedMotion() ? "auto" : "smooth",
    });
  }, [selected]);

  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-sm text-[var(--text-secondary)]">
        {rows.length} trading day{rows.length === 1 ? "" : "s"} in this range, each with up to{" "}
        {maxTradesPerDay} of its own same-day trades, starting from the previous day&apos;s real
        result. Pick one below to see its result.
      </p>
      <ul className="flex max-h-72 flex-col gap-1 overflow-y-auto rounded-lg border border-[var(--gridline)] bg-[var(--surface-1)] p-1">
        {rows.map((row, i) => {
          const isSelected = row.date === selected;
          // "Carried over from {date}" (issue #84) -- a purely structural,
          // non-numeric note communicating that chaining happened, without
          // leaking any dollar amount: the previous row's own *date* is
          // already fully visible, ungated information (every row shows
          // its date regardless of guess status), so naming it here
          // reveals nothing new. Every row but the range's own first one
          // gets this note.
          const previousRow = i > 0 ? rows[i - 1] : null;
          return (
            <li key={row.date}>
              <button
                type="button"
                ref={isSelected ? selectedRef : undefined}
                aria-current={isSelected ? "true" : undefined}
                onClick={() => onSelect(row.date)}
                className={`grid w-full grid-cols-[1fr_auto_auto] items-center gap-x-3 rounded-md px-3 py-2 text-left text-sm transition-colors ${
                  isSelected
                    ? "bg-[var(--series-1)]/15 text-[var(--text-primary)]"
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
                <span className="text-[var(--text-muted)]">
                  {row.tradeCount} trade{row.tradeCount === 1 ? "" : "s"}
                </span>
                <span className="tabular-nums font-semibold">
                  {formatHeroCurrency(row.endingBalance)}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
