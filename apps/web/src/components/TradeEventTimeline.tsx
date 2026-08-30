import type { Trade } from "@hadiknowntrades/core";

import { formatDate } from "@/lib/format-date";
import { formatHeroCurrency, formatPercent } from "@/lib/format-currency";
import { computeTradeReturn } from "@/lib/trade-math";

/**
 * The window-model result page's new primary at-a-glance visual (issue
 * #209, resolving #200's "demote the chart, lead with a timeline"
 * direction): a dense, tile-styled chip per trade -- ticker, direction,
 * open/close dates, and signed return -- replacing `PortfolioChart` as
 * the thing rendered first in `TradeReplay.tsx`. The literal chart stays
 * available, unchanged, one click deeper (see that component's own doc
 * comment for the disclosure mechanics).
 *
 * **Reads `packages/core`'s own `Trade[]` directly, not
 * `portfolio-series.ts`'s `PortfolioEvent`** -- per this issue's own
 * Background section, `WindowResultBody` already computes exactly this
 * array for `TradeList` below; reconstructing open/close pairs from the
 * chart's own flattened point series would just be re-deriving what
 * `use-trade-replay.ts`'s own internal segment builders already do,
 * a second time, for no reason.
 *
 * **Tile language, not a fourth gradient tile.** The issue's own Scope
 * asks for "this app's bold NYT-Games tile treatment (gradients/
 * icon-plate language per BeatTheBench.tsx/CallBoard.tsx)" -- read here
 * as *the icon-plate device specifically* (a small circular glyph badge,
 * WCAG-1.4.1-compliant per CallBoard.tsx's own `OUTCOME_STYLES`), not a
 * full saturated gradient background. This app's gradients are already a
 * meaningful signal elsewhere ("which of the four daily-hub *games* is
 * this") -- painting three-or-fewer trade chips the same way would
 * imply they're a fifth/sixth/seventh distinct mechanic, not sequential
 * entries in one list. The chips are still bold: `rounded-2xl`,
 * `surface-card` elevation, large numerals, an icon-plate per trade --
 * just built from this app's existing neutral surface + status-color
 * tokens rather than a new per-trade gradient. A real, considered
 * deviation from the issue's own literal wording, called out explicitly
 * per that issue's own instruction to do so rather than silently drift.
 */
interface TradeEventTimelineProps {
  trades: readonly Trade[];
}

interface OutcomeStyle {
  glyph: string;
  label: string;
  plateBackground: string;
  textColor: string;
}

const GAIN_STYLE: OutcomeStyle = {
  glyph: "▲",
  label: "Gain",
  // The same rgba wash TheLineup.tsx's own tile treatment already
  // established as this app's de facto --status-good-wash (no such
  // token exists in globals.css yet -- see that file's own identical
  // fallback value) -- reused rather than inventing a second one.
  plateBackground: "rgba(74, 184, 111, 0.14)",
  textColor: "var(--status-good)",
};

const LOSS_STYLE: OutcomeStyle = {
  glyph: "▼",
  label: "Loss",
  plateBackground: "rgba(228, 107, 100, 0.14)",
  textColor: "var(--status-critical)",
};

function TradeChip({ trade, index }: { trade: Trade; index: number }) {
  const { returnFraction, isGain } = computeTradeReturn(
    trade.openPrice,
    trade.closePrice,
    trade.direction,
  );
  const style = isGain ? GAIN_STYLE : LOSS_STYLE;
  const percentLabel = formatPercent(returnFraction);

  return (
    <li className="surface-card flex min-w-[13rem] flex-1 items-center gap-3 rounded-2xl border border-[var(--gridline)] bg-[var(--surface-1)] px-4 py-3">
      <span
        aria-hidden="true"
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-base font-bold"
        style={{ backgroundColor: style.plateBackground, color: style.textColor }}
      >
        {style.glyph}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex items-baseline gap-1.5">
          <span className="font-numeric text-xs font-medium text-[var(--text-muted)]">
            #{index + 1}
          </span>
          <span className="font-display truncate font-semibold text-[var(--text-primary)]">
            {trade.ticker}
          </span>
          {trade.direction === "short" && (
            <span className="rounded-full bg-[var(--surface-2)] px-1.5 py-0.5 text-[0.6875rem] font-medium text-[var(--text-secondary)]">
              short
            </span>
          )}
        </div>
        <p className="font-numeric text-xs text-[var(--text-muted)]">
          {formatDate(trade.openDate)}
          {" → "}
          {formatDate(trade.closeDate)}
        </p>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-0.5">
        <span className="font-numeric text-sm font-bold" style={{ color: style.textColor }}>
          {percentLabel}
        </span>
        {/* aria-hidden -- the sr-only sentence below already states this
            same fact in words; WCAG 1.4.1 is satisfied by the glyph +
            sr-only text, not by this pixel-value pair on its own. */}
        <span aria-hidden="true" className="font-numeric text-[0.6875rem] text-[var(--text-muted)]">
          {formatHeroCurrency(trade.openPrice)} → {formatHeroCurrency(trade.closePrice)}
        </span>
      </div>
      <span className="sr-only">
        Trade {index + 1}: {trade.direction === "short" ? "shorted" : "bought"} {trade.ticker} on{" "}
        {formatDate(trade.openDate)}, {trade.direction === "short" ? "covered" : "sold"} on{" "}
        {formatDate(trade.closeDate)}. {style.label}, {percentLabel}.
      </span>
    </li>
  );
}

export function TradeEventTimeline({ trades }: TradeEventTimelineProps) {
  return (
    <ol aria-label="Trade sequence" className="flex flex-wrap gap-3">
      {trades.map((trade, index) => (
        <TradeChip key={`${trade.ticker}-${trade.openDate}-${index}`} trade={trade} index={index} />
      ))}
    </ol>
  );
}
