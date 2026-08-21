import type { IntradayTrade } from "@hadiknowntrades/core";

import { formatTime } from "@/lib/format-date";
import { TradeRow } from "@/components/TradeRow";

interface IntradayTradeListProps {
  /** Non-empty -- the caller (ResultsPanel) owns the empty ("no trade beat cash this day") state; this component only renders an actual trade sequence. */
  trades: readonly IntradayTrade[];
}

/**
 * "Buy TICKER at TIME at $price -> Sell at TIME at $price (+X%)" for
 * each same-day trade in one intraday day's result (issue #28) --
 * labeled by time-of-day rather than date, since every trade in a day's
 * result already shares that same date (the selected day, shown
 * elsewhere in the view). See TradeList for the window model's
 * whole-window trades, labeled by date instead.
 */
export function IntradayTradeList({ trades }: IntradayTradeListProps) {
  return (
    <ol className="flex flex-col gap-3">
      {trades.map((trade, index) => (
        <TradeRow
          key={`${trade.ticker}-${trade.buyTime}`}
          index={index}
          ticker={trade.ticker}
          buyLabel={formatTime(trade.buyTime)}
          buyPrice={trade.buyPrice}
          sellLabel={formatTime(trade.sellTime)}
          sellPrice={trade.sellPrice}
        />
      ))}
    </ol>
  );
}
