"use client";

import { formatHeroCurrency } from "@/lib/format-currency";
import { useCountUp } from "@/lib/use-count-up";

interface HeroStatProps {
  startingCapital: number;
  endingBalance: number;
}

// Long enough to read as a deliberate count rather than a flicker, short
// enough not to make people wait for the number they came for.
const COUNT_UP_DURATION_MS = 1200;

/**
 * The "$20 -> $X" headline figure. Exactly one per view, per the dataviz
 * skill's hero-figure spec: >=48px, the same sans as the rest of the
 * page, proportional (not tabular) figures.
 *
 * The ending balance counts up from `startingCapital` on mount (see
 * useCountUp) -- ResultsPanel remounts this component fresh for every
 * new result (loading and success render different subtrees), so "on
 * mount" lines up with "on reveal," including on every range switch.
 *
 * Accessibility (issue #35): the animated digits are `aria-hidden` and
 * a separate, static `sr-only` span always holds the final value. This
 * sidesteps the usual naive-`aria-live` trap (a region wired straight
 * to a per-frame value spams assistive tech with every intermediate
 * number) without depending on aria-live announcement timing at all.
 */
export function HeroStat({ startingCapital, endingBalance }: HeroStatProps) {
  const animatedEndingBalance = useCountUp(startingCapital, endingBalance, COUNT_UP_DURATION_MS);

  return (
    <div className="flex flex-col items-start gap-1">
      <p className="text-sm font-medium text-[var(--text-secondary)]">Starting from</p>
      <p className="flex flex-wrap items-baseline gap-3 text-[clamp(2.5rem,6vw,4rem)] font-semibold leading-none tracking-tight text-[var(--text-primary)]">
        <span>{formatHeroCurrency(startingCapital)}</span>
        <span aria-hidden="true" className="text-[var(--text-muted)]">
          →
        </span>
        <span aria-hidden="true">{formatHeroCurrency(animatedEndingBalance)}</span>
        <span className="sr-only">{formatHeroCurrency(endingBalance)}</span>
      </p>
    </div>
  );
}
