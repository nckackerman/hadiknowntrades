import { formatHeroCurrency, formatPercent } from "@/lib/format-currency";
import { formatDate, formatDateTime } from "@/lib/format-date";
import { tradeVerbsPastCapitalized } from "@/lib/trade-math";
import type { ChunkSummary, ReplayEvent, ReplayPhase } from "@/lib/use-trade-replay";
import type { ChartLanding } from "@/components/PortfolioChart";

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

/**
 * What "just landed" for `PortfolioChart`'s own marker-pulse/shake/
 * speech-bubble effects (issue #108) -- `null` except during the exact
 * pause window after a real open/close event is reached while actually
 * `"playing"`. Shared between `TradeReplay.tsx` and
 * `WholeRangeReplay.tsx` (issue #105 code review finding) -- both used
 * to independently re-derive this identical three-condition check from
 * their own `phase`/`frame.activeEvent`/`activeCallout` locals; a future
 * change to when a landing should be considered active (a new phase, a
 * new `ChartLanding` field) now only has one place to make it.
 */
export function chartLandingFor(
  phase: ReplayPhase,
  activeEvent: ReplayEvent | null,
  activeCallout: string | null,
): ChartLanding | null {
  if (phase !== "playing" || !activeEvent || !activeCallout) return null;
  return { event: activeEvent.event, calloutText: activeCallout };
}

/**
 * Summary narration for a genuine multi-trade day/chunk pause (issue
 * #118, 1M/3M/1Y's chunked whole-range replay) -- a distinct,
 * deliberately less granular register than `calloutText`'s own
 * single-trade voice above: a chunk can span up to `chunkDayCount *
 * maxTradesPerDay` trades, and narrating each individually inside one
 * pause would be an unreadable blur, not "watch it happen." The
 * one-day/one-trade degenerate chunk never reaches this function --
 * `use-trade-replay.ts`'s own chunk segment-builder falls through to
 * `calloutText` above for that case instead (see that module's
 * `buildChunkLanding` doc comment).
 *
 * `startDate`/`endDate` are always plain calendar dates ("YYYY-MM-DD",
 * from `calendarDayOf`), never datetime-labeled -- no `includeDate`
 * parameter needed the way `calloutText` takes one for its own
 * point-level date.
 */
export function chunkSummaryText(summary: ChunkSummary): string {
  const { startDate, endDate, tradeCount, startValue, endValue } = summary;
  const dateRange =
    startDate === endDate
      ? formatDate(startDate)
      : `${formatDate(startDate)} - ${formatDate(endDate)}`;
  const tradeWord = tradeCount === 1 ? "trade" : "trades";
  return `${dateRange}: ${tradeCount} ${tradeWord}, ${formatHeroCurrency(startValue)} -> ${formatHeroCurrency(endValue)}.`;
}
