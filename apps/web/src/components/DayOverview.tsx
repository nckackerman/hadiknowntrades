"use client";

import { formatDate } from "@/lib/format-date";
import { formatHeroCurrency } from "@/lib/format-currency";

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
   * chosen starting capital -- or `null` when the user hasn't guessed
   * *this specific* (range, date, mode) triple yet (issue #34's
   * guess-then-reveal gate, see daily-guess-storage.ts). `null` renders
   * a locked placeholder instead of the figure.
   */
  endingBalance: number | null;
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
 * **Deliberately does not gate `tradeCount` behind the guess-then-reveal
 * condition (issue #34) the way `endingBalance` is gated** -- a real
 * product decision, not an oversight (see issue #80's own Scope section,
 * which calls this out explicitly as something to document). A trade
 * *count* (e.g. "3 trades") carries none of the dollar-outcome
 * information the guessing game is actually testing -- "what did $20
 * turn into" -- so showing it for every day, guessed or not, is what
 * makes the range's breadth ("62 independently-computed days") visible
 * at a glance without spoiling a single answer. `endingBalance` stays
 * `null` (a "Guess to reveal" placeholder) until the caller confirms a
 * stored guess exists for that exact (range, date, mode) triple, so the
 * one thing the guessing game actually protects -- the dollar figure --
 * is never leaked through this list ahead of a real guess.
 */
export function DayOverview({ rows, selected, onSelect, maxTradesPerDay }: DayOverviewProps) {
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-sm text-[var(--text-secondary)]">
        {rows.length} independently-computed trading day{rows.length === 1 ? "" : "s"} in this
        range, each with up to {maxTradesPerDay} of its own same-day trades. Pick one below to see
        its result.
      </p>
      <ul className="flex max-h-72 flex-col gap-1 overflow-y-auto rounded-lg border border-[var(--gridline)] bg-[var(--surface-1)] p-1">
        {rows.map((row) => {
          const isSelected = row.date === selected;
          return (
            <li key={row.date}>
              <button
                type="button"
                aria-current={isSelected ? "true" : undefined}
                onClick={() => onSelect(row.date)}
                className={`grid w-full grid-cols-[1fr_auto_auto] items-center gap-x-3 rounded-md px-3 py-2 text-left text-sm transition-colors ${
                  isSelected
                    ? "bg-[var(--series-1)]/15 text-[var(--text-primary)]"
                    : "text-[var(--text-secondary)] hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)]"
                }`}
              >
                <span className="font-medium">{formatDate(row.date)}</span>
                <span className="text-[var(--text-muted)]">
                  {row.tradeCount} trade{row.tradeCount === 1 ? "" : "s"}
                </span>
                <span
                  className={`tabular-nums ${
                    row.endingBalance !== null ? "font-semibold" : "text-[var(--text-muted)]"
                  }`}
                >
                  {row.endingBalance !== null
                    ? formatHeroCurrency(row.endingBalance)
                    : "Guess to reveal"}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
