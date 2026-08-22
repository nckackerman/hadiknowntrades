import { formatHeroCurrency, formatMultiplier } from "@/lib/format-currency";

interface WorstCaseStatProps {
  startingCapital: number;
  /** The worst achievable <=maxTrades outcome over the same window/day (issue #31) -- see WorstCaseResult/IntradayWorstCaseResult in @hadiknowntrades/core. */
  endingBalance: number;
}

/**
 * A small, deliberately de-emphasized contrast stat (issue #31) sitting
 * next to HeroStat: "how badly could this same <=N-trade budget have
 * gone, with every choice wrong?" -- a secondary figure, not meant to
 * compete for attention with the hero number.
 *
 * Unlike HeroStat, this renders with:
 *   - No count-up animation and no celebration burst -- those exist
 *     specifically to make the *optimal* figure feel like a reveal/
 *     payoff; reusing them here would work against "not competing for
 *     attention," and a celebration burst on a worst-case figure makes
 *     no sense even in the rare edge case where the worst case is still
 *     a net gain (see optimizeWorstTrades's own doc comment).
 *   - A fixed muted tone, not dynamic gain/loss coloring (a deliberate
 *     product decision, not an oversight) -- this is a contrast/
 *     de-emphasis stat, not a second thing to color-code, and a fixed
 *     tone sidesteps that same rare "still a gain" edge case ever
 *     rendering in celebratory green.
 *   - Visually smaller than HeroStat's clamp(2.5rem,6vw,4rem) headline
 *     size.
 *
 * Deliberately renders only the ending balance (and its multiplier) --
 * not the worst-case trades list, which the schema stores for
 * completeness/possible future use but isn't part of this stat's scope.
 */
export function WorstCaseStat({ startingCapital, endingBalance }: WorstCaseStatProps) {
  const multiplier = endingBalance / startingCapital;

  return (
    <div className="flex flex-col items-start gap-1">
      <p className="text-sm font-medium text-[var(--text-muted)]">Worst case, same budget</p>
      <p className="flex flex-wrap items-baseline gap-2 text-xl font-semibold leading-none tracking-tight text-[var(--text-muted)] sm:text-2xl">
        <span>{formatHeroCurrency(endingBalance)}</span>
        <span className="text-sm font-semibold sm:text-base">({formatMultiplier(multiplier)})</span>
      </p>
    </div>
  );
}
