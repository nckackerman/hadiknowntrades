import type { BenchmarkResult } from "@hadiknowntrades/core";

import { formatDate } from "@/lib/format-date";
import { formatHeroCurrency } from "@/lib/format-currency";
import { rescaleFromStartingCapital } from "@/lib/rescale-starting-capital";

interface BenchmarkStatProps {
  /** SPY buy-and-hold comparison over the same window (issue #12) -- null when no benchmark data was available this run (see BenchmarkResult in @hadiknowntrades/core). */
  benchmark: BenchmarkResult | null;
  /** The precomputed result's own startingCapital -- what benchmark.endingBalance was computed relative to. */
  startingCapital: number;
  /** The user's chosen display capital (issue #15) -- defaults to startingCapital, a no-op rescale, same convention as HeroStat's own displayStartingCapital prop. */
  displayStartingCapital?: number;
  /**
   * Disambiguates that this comparison spans the *whole* range, not just
   * whatever's currently on screen -- pass e.g. "the past month" from
   * ResultsPanel's intraday-daily branch, where everything else visible
   * (HeroStat, the chart, the trade list) is scoped to a single selected
   * day, so without this the benchmark figure could easily be misread as
   * day-scoped too. Omit for the window model, where the whole view is
   * already range-scoped and the methodology paragraph right above
   * already names the range -- no disambiguation needed there.
   */
  rangeLabel?: string;
}

/**
 * A single prose line contrasting the optimizer's result with simply
 * buying and holding SPY over the same window (issue #12) -- sits
 * directly below the methodology paragraph in both of ResultsPanel's
 * render branches (window and intraday-daily), textual and
 * secondary-sized (`text-sm`, matching that paragraph's own weight) so it
 * reads as context rather than competing with HeroStat/WorstCaseStat for
 * attention. Same reasoning this app's prose trade narration (issue #32)
 * already established: a single contextual dollar figure reads fine as a
 * sentence, no second stat tile needed.
 *
 * Shown for all 5 ranges, not just the window model's 5Y/MAX -- this is a
 * single well-defined whole-window figure (SPY's own start price to end
 * price over the range) regardless of which trading model a given range
 * uses, so there's no reason to omit it for 1M/3M/1Y. For the
 * intraday-daily model specifically, this is a real, deliberate
 * juxtaposition: the benchmark is scoped to the *whole range*, not the
 * single day HeroStat/the chart/trade list below it are scoped to --
 * spelled out explicitly in the copy ("over the full {range}") rather
 * than left ambiguous.
 *
 * `null` renders nothing at all (not an error message, not a
 * placeholder) -- consistent with this app's general silent-graceful-
 * degrade posture elsewhere (e.g. the OG card route's model-based 404).
 *
 * No gain/loss coloring, unlike HeroStat's multiplier badge or
 * TradeRow's per-trade return badge -- deliberate simplicity: this is a
 * comparison figure, not itself a "did the optimizer win" signal.
 */
export function BenchmarkStat({
  benchmark,
  startingCapital,
  displayStartingCapital = startingCapital,
  rangeLabel,
}: BenchmarkStatProps) {
  if (!benchmark) return null;

  const displayedEndingBalance = rescaleFromStartingCapital(
    benchmark.endingBalance,
    startingCapital,
    displayStartingCapital,
  );

  return (
    <p className="text-sm text-[var(--text-secondary)]">
      Buying and holding {benchmark.ticker}
      {rangeLabel ? ` over ${rangeLabel}` : ""} instead
      {benchmark.truncated
        ? ` (since its earliest available data, ${formatDate(benchmark.startDate)})`
        : ""}{" "}
      would have turned {formatHeroCurrency(displayStartingCapital)} into{" "}
      <span className="font-medium text-[var(--text-primary)]">
        {formatHeroCurrency(displayedEndingBalance)}
      </span>
      .
    </p>
  );
}
