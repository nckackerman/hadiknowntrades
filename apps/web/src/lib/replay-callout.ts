import { formatHeroCurrency, formatPercent } from "@/lib/format-currency";
import { formatDateTime } from "@/lib/format-date";
import { tradeVerbsPastCapitalized } from "@/lib/trade-math";
import type { ReplayEvent } from "@/lib/use-trade-replay";

/**
 * Past-tense narration for one trade-replay pause, matching TradeList's
 * established voice ("bought AAPL on Mar 12, 2025 at $142.00") rather
 * than inventing new copy. Always retrospective, never present/future
 * tense: this app's premise is hindsight, not a live trading terminal.
 * Verb pair comes from trade-math.ts's `tradeVerbsPastCapitalized`.
 *
 * Extracted out of TradeReplay.tsx (issue #96/#108) into its own module
 * for issue #105's own `WholeRangeReplay.tsx`, which needs the identical
 * narration for the whole-range 1W replay -- rather than the private,
 * unexported function TradeReplay.tsx used to keep to itself, this is
 * now the one shared implementation both callers use, matching this
 * codebase's own established "compute once, reuse" convention (see e.g.
 * trade-math.ts's own header comment on the same class of duplication
 * this file avoids).
 */
export function calloutText(replayEvent: ReplayEvent, includeDate: boolean): string {
  const { point, event, tradeReturn } = replayEvent;
  const verb = tradeVerbsPastCapitalized(event.direction)[
    event.type === "open" ? "openVerb" : "closeVerb"
  ];
  const sentence = `${verb} ${event.ticker} on ${formatDateTime(point.date, includeDate)} at ${formatHeroCurrency(event.price)}`;
  if (event.type === "close" && tradeReturn) {
    return `${sentence} (${formatPercent(tradeReturn.returnFraction)}).`;
  }
  return `${sentence}.`;
}
