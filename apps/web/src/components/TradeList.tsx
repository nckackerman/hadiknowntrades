import type { Trade } from "@hadiknowntrades/core";

import { formatDate } from "@/lib/format-date";
import { formatHeroCurrency, formatPercent } from "@/lib/format-currency";
import { narrateTrades } from "@/lib/narrate-trades";

interface TradeListProps {
  /** Expected non-empty -- the caller (ResultsPanel) owns the empty ("no trade beat cash") state today, since it has the range context needed for good copy there. TradeList still defends against an empty array itself (a brief generic fallback, see the component body) rather than rendering a silently blank box, since narrateTrades itself is documented to tolerate `[]` and a future caller (e.g. IntradayTradeList reusing this narration path) might not carry the same guard ResultsPanel does today. */
  trades: readonly Trade[];
  /** The window's starting balance -- the base the first trade's "turning your $X into $Y" narrates from (see narrate-trades.ts). */
  startingCapital: number;
}

/**
 * Narrates the window model's whole-window trade sequence as flowing
 * prose (issue #32), e.g. "Had you known, you'd have bought AAPL on Mar
 * 12, 2025 at $142.00 and sold on Mar 19, 2025 at $178.00, turning your
 * $20.00 into $25.06 (+25.4%). Then you'd have bought..." -- one <p>,
 * not a list of row cards, reusing the same per-trade dollar/percent
 * computations TradeRow.tsx made (buy/sell price, returnFraction,
 * isGain) but folded into sentences instead of table-like cells.
 *
 * Design choice (issue #32): **replaces** the previous TradeRow-based
 * table entirely for this component, rather than showing prose
 * alongside it -- see apps/web/CLAUDE.md's "Prose trade narration"
 * section for the full rationale. TradeRow.tsx itself is untouched and
 * still backs IntradayTradeList (issue #28's per-day, time-labeled
 * trades), which keeps its table rendering for now -- see that same
 * CLAUDE.md section for why.
 *
 * Handles 1, 2, and 3-trade sequences without per-count branching (see
 * narrate-trades.ts's leadInFor) and reads sensibly at both near-$20 and
 * Max-range (astronomically large, see packages/core/CLAUDE.md) result
 * magnitudes, since every dollar figure here goes through
 * formatHeroCurrency's existing compact/scientific ladder rather than a
 * bare template-literal `$`.
 */
export function TradeList({ trades, startingCapital }: TradeListProps) {
  const narrations = narrateTrades(
    trades.map((trade) => ({
      ticker: trade.ticker,
      direction: trade.direction,
      buyLabel: formatDate(trade.openDate),
      buyPrice: trade.openPrice,
      sellLabel: formatDate(trade.closeDate),
      sellPrice: trade.closePrice,
    })),
    startingCapital,
  );

  // Defensive fallback, not the primary empty-state path: ResultsPanel
  // already guards against calling TradeList with an empty `trades`
  // array today (see the prop doc comment above), but this keeps the
  // component itself from ever rendering a silently blank bordered box
  // if that guard is ever missing for a future caller.
  if (narrations.length === 0) {
    return (
      <div className="rounded-lg border border-[var(--gridline)] bg-[var(--surface-1)] px-4 py-6 text-center text-sm text-[var(--text-secondary)]">
        No trades to show.
      </div>
    );
  }

  return (
    <ol className="rounded-lg border border-[var(--gridline)] bg-[var(--surface-1)] px-4 py-3 text-sm leading-relaxed text-[var(--text-primary)]">
      {narrations.map((narration, index) => {
        // Built as plain JS template-literal strings (not raw JSX text)
        // so the exact wording/spacing is deterministic -- JSX's own
        // whitespace-collapsing rules for multi-line literal text are
        // easy to get subtly wrong (an extra or missing space around a
        // nested <span>), and this sentence needs to interleave plain
        // text with a bolded ticker and a colored percent inline.
        const startPhrase =
          index === 0 ? `your ${formatHeroCurrency(narration.startBalance)}` : "that";
        const before = `${index > 0 ? " " : ""}${narration.leadIn} ${narration.openVerb} `;
        const middle =
          ` on ${narration.buyLabel} at ${formatHeroCurrency(narration.buyPrice)} and ${narration.closeVerb} on ` +
          `${narration.sellLabel} at ${formatHeroCurrency(narration.sellPrice)}, turning ` +
          `${startPhrase} into ${formatHeroCurrency(narration.endBalance)} `;

        // Each trade is an <li>, not a <span>: a screen reader gets
        // "list, 3 items" and per-item navigation (getByRole("list") /
        // getAllByRole("listitem") in TradeList.test.tsx) even though
        // `display: inline` (see globals.css's `.trade-narration-item`)
        // makes it flow as one visual paragraph with no bullets/line
        // breaks -- restoring the semantic list structure the original
        // TradeRow-based <ol>/<li> rendering had, underneath the new
        // prose styling, rather than trading it away for the prose look.
        return (
          <li key={narration.key} className="trade-narration-item">
            {before}
            <span className="font-semibold">{narration.ticker}</span>
            {middle}
            <span
              className="font-semibold"
              style={{ color: narration.isGain ? "var(--status-good)" : "var(--status-critical)" }}
            >
              ({formatPercent(narration.returnFraction)})
            </span>
            {"."}
          </li>
        );
      })}
    </ol>
  );
}
