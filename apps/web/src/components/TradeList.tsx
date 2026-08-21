import type { Trade } from "@hadiknowntrades/core";

import { formatDate } from "@/lib/format-date";
import { TradeRow } from "@/components/TradeRow";

interface TradeListProps {
  /** Non-empty -- the caller (ResultsPanel) owns the empty ("no trade beat cash") state, since it has the range context needed for good copy there; this component only renders an actual trade sequence. */
  trades: readonly Trade[];
}

/** "Buy TICKER on DATE at $price -> Sell on DATE at $price (+X%)" for each trade in the window model's whole-window sequence. See IntradayTradeList for issue #28's per-day intraday trades, labeled by time instead of date. */
export function TradeList({ trades }: TradeListProps) {
  return (
    <ol className="flex flex-col gap-3">
      {trades.map((trade, index) => (
        <TradeRow
          key={`${trade.ticker}-${trade.buyDate}`}
          index={index}
          ticker={trade.ticker}
          preposition="on"
          buyLabel={formatDate(trade.buyDate)}
          buyPrice={trade.buyPrice}
          sellLabel={formatDate(trade.sellDate)}
          sellPrice={trade.sellPrice}
        />
      ))}
    </ol>
  );
}
