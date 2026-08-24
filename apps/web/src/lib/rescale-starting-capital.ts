// Rescales a precomputed dollar figure to what it would have been had
// the run started from a different starting capital (issue #15).
//
// This is a pure linear scale, not a re-derivation: every dollar figure
// this app produces is `startingCapital * someMultiplier`, and the
// multiplier itself is entirely independent of startingCapital -- see
// packages/core/src/optimizer.ts's `optimizeTrades`, where
// `endingBalance = startingCapital * finalMultiplier` and
// `finalMultiplier` is computed purely from price ratios via the DP,
// never touching `startingCapital`. So any dollar figure derived from a
// precomputed result (an ending balance, a portfolio-chart point) can be
// rescaled to a different starting capital by just multiplying by the
// ratio of the two capitals -- no need to re-run the optimizer, and no
// need for packages/core or apps/pipeline to change at all.
//
// Used directly by HeroStat, which already has a "from precomputed
// startingCapital" figure (the count-up's animated/final ending
// balance) to rescale for display. The portfolio chart doesn't need a
// separate call to this function at all: derivePortfolioSeries and
// deriveWholeRangeIntradaySeries (portfolio-series.ts) are already pure
// linear scalings of whatever startingCapital they're handed, so
// ResultsPanel gets the same rescaling for free by simply passing the
// user's chosen starting capital into those functions directly instead
// of the precomputed one -- see portfolio-series.test.ts's own
// "rescaling" tests for that equivalence spelled out explicitly.

/**
 * Rescales `value` (a dollar figure computed from a run that started at
 * `fromStartingCapital`) to what it would be if that same run had
 * started at `toStartingCapital` instead.
 */
export function rescaleFromStartingCapital(
  value: number,
  fromStartingCapital: number,
  toStartingCapital: number,
): number {
  return value * (toStartingCapital / fromStartingCapital);
}
