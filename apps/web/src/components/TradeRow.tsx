import type { TradeDirection } from "@hadiknowntrades/core";

import { formatHeroCurrency, formatPercent } from "@/lib/format-currency";
import { computeTradeReturn, tradeVerbs } from "@/lib/trade-math";

interface TradeRowProps {
  index: number;
  ticker: string;
  /** "long" or "short" (issue #13) -- determines the verb pair (Buy/Sell vs. Short/Cover). */
  direction: TradeDirection;
  /** "on" (TradeList's calendar dates) or "at" (IntradayTradeList's times-of-day) -- the grammatically correct preposition for whichever kind of label openLabel/closeLabel is, supplied by the caller since this component stays agnostic to which. */
  preposition: "on" | "at";
  /** Pre-formatted open label -- a calendar date (TradeList) or a time-of-day (IntradayTradeList). */
  openLabel: string;
  openPrice: number;
  /** Pre-formatted close label -- see openLabel. */
  closeLabel: string;
  closePrice: number;
}

/**
 * One "Buy TICKER on/at LABEL at $price -> Sell on/at LABEL at $price
 * (+X%)" row (or "Short .../Cover ..." for a short trade, issue #13) --
 * shared markup behind both TradeList (the window model's whole-window
 * trades, labeled by date) and IntradayTradeList (issue #28's per-day
 * intraday trades, labeled by time-of-day), which only differ in what
 * the open/close labels mean, how they're formatted, and which
 * preposition reads correctly in front of them.
 */
export function TradeRow({
  index,
  ticker,
  direction,
  preposition,
  openLabel,
  openPrice,
  closeLabel,
  closePrice,
}: TradeRowProps) {
  const { returnFraction, isGain } = computeTradeReturn(openPrice, closePrice, direction);
  const { openVerb, closeVerb } = tradeVerbs(direction);
  return (
    <li className="surface-card flex flex-wrap items-baseline gap-x-2 gap-y-1 rounded-lg border border-[var(--gridline)] bg-[var(--surface-1)] px-4 py-3 text-sm">
      <span className="font-medium text-[var(--text-muted)]">#{index + 1}</span>
      <span>
        {openVerb} <span className="font-semibold text-[var(--text-primary)]">{ticker}</span>{" "}
        {preposition} {openLabel} at {formatHeroCurrency(openPrice)}
      </span>
      <span aria-hidden="true" className="text-[var(--text-muted)]">
        →
      </span>
      <span>
        {closeVerb} {preposition} {closeLabel} at {formatHeroCurrency(closePrice)}
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
