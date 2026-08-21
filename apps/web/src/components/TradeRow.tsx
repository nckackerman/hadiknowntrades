import { formatHeroCurrency, formatPercent } from "@/lib/format-currency";

interface TradeRowProps {
  index: number;
  ticker: string;
  /** Pre-formatted buy label -- a calendar date (TradeList) or a time-of-day (IntradayTradeList), so this component stays agnostic to which. */
  buyLabel: string;
  buyPrice: number;
  /** Pre-formatted sell label -- see buyLabel. */
  sellLabel: string;
  sellPrice: number;
}

/**
 * One "Buy TICKER on/at LABEL at $price -> Sell on/at LABEL at $price
 * (+X%)" row -- shared markup behind both TradeList (the window model's
 * whole-window trades, labeled by date) and IntradayTradeList (issue
 * #28's per-day intraday trades, labeled by time-of-day), which only
 * differ in what the buy/sell labels mean and how they're formatted.
 */
export function TradeRow({
  index,
  ticker,
  buyLabel,
  buyPrice,
  sellLabel,
  sellPrice,
}: TradeRowProps) {
  const returnFraction = sellPrice / buyPrice - 1;
  const isGain = returnFraction >= 0;
  return (
    <li className="flex flex-wrap items-baseline gap-x-2 gap-y-1 rounded-lg border border-[var(--gridline)] bg-[var(--surface-1)] px-4 py-3 text-sm">
      <span className="font-medium text-[var(--text-muted)]">#{index + 1}</span>
      <span>
        Buy <span className="font-semibold text-[var(--text-primary)]">{ticker}</span> on {buyLabel}{" "}
        at {formatHeroCurrency(buyPrice)}
      </span>
      <span aria-hidden="true" className="text-[var(--text-muted)]">
        →
      </span>
      <span>
        Sell on {sellLabel} at {formatHeroCurrency(sellPrice)}
      </span>
      <span
        className="font-semibold"
        style={{ color: isGain ? "var(--status-good)" : "var(--status-critical)" }}
      >
        ({formatPercent(returnFraction)})
      </span>
    </li>
  );
}
