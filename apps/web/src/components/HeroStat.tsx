"use client";

import { formatHeroCurrency } from "@/lib/format-currency";
import { shouldCelebrate } from "@/lib/should-celebrate";
import { useCountUp } from "@/lib/use-count-up";
import { CelebrationBurst } from "@/components/CelebrationBurst";

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
 *
 * A celebration burst (issue #36) fires once the count-up lands, but
 * only on an actual gain -- a live comparison against the props on
 * every render, not an assumption that every reveal is a win, so this
 * stays correct if a future loss/worst-case stat (issue #31) ever
 * reuses this component. `settled` compares the animated value against
 * the final one bit-for-bit, which is safe because useCountUp always
 * sets the exact target (not an approximation) once it lands.
 */
export function HeroStat({ startingCapital, endingBalance }: HeroStatProps) {
  const animatedEndingBalance = useCountUp(startingCapital, endingBalance, COUNT_UP_DURATION_MS);
  const isGain = endingBalance > startingCapital;
  const settled = animatedEndingBalance === endingBalance;
  const celebrate = shouldCelebrate(isGain, settled);

  return (
    <div className="flex flex-col items-start gap-1">
      <p className="text-sm font-medium text-[var(--text-secondary)]">Starting from</p>
      {/* relative + the burst overlay are scoped to just this row (not
          the "Starting from" label above) so the confetti bursts from
          around the figure itself, not the caption. */}
      <div className="relative">
        <p className="flex flex-wrap items-baseline gap-3 text-[clamp(2.5rem,6vw,4rem)] font-semibold leading-none tracking-tight text-[var(--text-primary)]">
          <span>{formatHeroCurrency(startingCapital)}</span>
          <span aria-hidden="true" className="text-[var(--text-muted)]">
            →
          </span>
          <span aria-hidden="true">{formatHeroCurrency(animatedEndingBalance)}</span>
          <span className="sr-only">{formatHeroCurrency(endingBalance)}</span>
        </p>
        <CelebrationBurst active={celebrate} />
      </div>
    </div>
  );
}
