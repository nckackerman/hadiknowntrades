import type { Trade } from "@hadiknowntrades/core";

import { formatDate } from "@/lib/format-date";
import { formatHeroCurrency, formatPercent } from "@/lib/format-currency";

interface TradeListProps {
  /** Non-empty -- the caller (ResultsPanel) owns the empty ("no trade beat cash") state, since it has the range context needed for good copy there; this component only renders an actual trade sequence. */
  trades: readonly Trade[];
}

/** "Buy TICKER on DATE at $price -> Sell on DATE at $price (+X%)" for each trade in the sequence. */
export function TradeList({ trades }: TradeListProps) {
  return (
    <ol className="flex flex-col gap-3">
      {trades.map((trade, index) => {
        const returnFraction = trade.sellPrice / trade.buyPrice - 1;
        const isGain = returnFraction >= 0;
        return (
          <li
            key={`${trade.ticker}-${trade.buyDate}`}
            className="flex flex-wrap items-baseline gap-x-2 gap-y-1 rounded-lg border border-[var(--gridline)] bg-[var(--surface-1)] px-4 py-3 text-sm"
          >
            <span className="font-medium text-[var(--text-muted)]">#{index + 1}</span>
            <span>
              Buy <span className="font-semibold text-[var(--text-primary)]">{trade.ticker}</span>{" "}
              on {formatDate(trade.buyDate)} at {formatHeroCurrency(trade.buyPrice)}
            </span>
            <span aria-hidden="true" className="text-[var(--text-muted)]">
              →
            </span>
            <span>
              Sell on {formatDate(trade.sellDate)} at {formatHeroCurrency(trade.sellPrice)}
            </span>
            <span
              className="font-semibold"
              style={{ color: isGain ? "var(--status-good)" : "var(--status-critical)" }}
            >
              ({formatPercent(returnFraction)})
            </span>
          </li>
        );
      })}
    </ol>
  );
}
