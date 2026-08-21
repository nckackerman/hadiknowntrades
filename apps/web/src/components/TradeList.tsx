import type { Trade } from "@hadiknowntrades/core";

import { formatHeroCurrency, formatPercent } from "@/lib/format-currency";

interface TradeListProps {
  trades: readonly Trade[];
}

function formatDate(isoDate: string): string {
  // Parsed as UTC (not the browser's local zone) since these are plain
  // calendar dates from the pipeline, not timestamps -- parsing
  // "2025-08-21" as local time can roll it back a day in zones west of
  // UTC.
  return new Date(`${isoDate}T00:00:00Z`).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/** "Buy TICKER on DATE at $price -> Sell on DATE at $price (+X%)" for each trade in the sequence. */
export function TradeList({ trades }: TradeListProps) {
  if (trades.length === 0) {
    return (
      <p className="text-sm text-[var(--text-secondary)]">
        No profitable trade was found in this window -- the best outcome was to hold cash.
      </p>
    );
  }

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
