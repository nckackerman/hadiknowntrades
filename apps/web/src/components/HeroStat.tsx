"use client";

import type { CSSProperties } from "react";

import { formatHeroCurrency, formatMultiplier } from "@/lib/format-currency";
import { rescaleFromStartingCapital } from "@/lib/rescale-starting-capital";
import { shouldCelebrate } from "@/lib/should-celebrate";
import { useCountUp } from "@/lib/use-count-up";
import { useReducedMotionAtMount } from "@/lib/use-reduced-motion-at-mount";
import { CelebrationBurst } from "@/components/CelebrationBurst";

interface HeroStatProps {
  startingCapital: number;
  endingBalance: number;
  /**
   * The dollar amount to actually display everything scaled to (issue
   * #15) -- defaults to `startingCapital` when omitted, which is a
   * no-op rescale (ratio of 1) and keeps default rendering pixel-
   * identical to before this prop existed.
   *
   * Deliberately *not* fed into `startingCapital`/`endingBalance`
   * (or a remount) directly: those two still drive useCountUp's reveal
   * tween and shouldCelebrate's gain check exactly as before, so
   * changing this prop alone -- e.g. a user editing the starting-capital
   * input -- rescales every displayed figure instantly without
   * re-triggering the count-up animation or the celebration burst,
   * both of which should only ever fire once per actual new result, not
   * once per capital edit.
   */
  displayStartingCapital?: number;
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
 *
 * A plain "(345x)" multiplier badge (issue #45) sits alongside the
 * dollar figures, inside the same flex row -- deliberately *not* tied to
 * the count-up: it's computed straight from the final
 * `endingBalance`/`startingCapital` props, not `animatedEndingBalance`,
 * so it's correct from the very first render with no mid-tween
 * intermediate values to manage (no aria-hidden/sr-only pairing needed,
 * unlike the animated figure above). Colored the same way TradeRow.tsx
 * colors its own per-trade return badge (`--status-good`/
 * `--status-critical`), reusing that established convention rather than
 * inventing a new one -- including TradeRow's own `>= ` (not `>`)
 * threshold for what counts as "good", so a flat 1x result reads as
 * neutral/good rather than critical. That's deliberately a *different*
 * threshold than this component's own `isGain` below, which stays a
 * strict `>` because it gates the celebration burst, where "exactly
 * broke even" should never fire confetti.
 *
 * A subtle reveal accent (issue #77) -- a soft glow tied to the same
 * gain/loss color the multiplier badge above already uses, at that
 * badge's own `>= 1` "gain" threshold, not the stricter `isGain` that
 * gates the celebration burst -- renders on the visible (aria-hidden)
 * ending-balance span once `settled` goes true, for both a gain *and* a
 * loss (unlike CelebrationBurst, which only ever fires on a real gain).
 *
 * `useReducedMotionAtMount` (`lib/use-reduced-motion-at-mount.ts`) reads
 * `prefersReducedMotion()` exactly once per mount rather than as a plain
 * expression re-evaluated on every render -- **not** the same
 * short-circuit shape `shouldCelebrate`'s own `isGain && settled` uses
 * (found not to hold here in `/code-review`: unlike `isGain`, which stays
 * strictly `false` at mount even for a flat result, `settled` -- this
 * accent's own gate -- is trivially `true` at mount whenever
 * `startingCapital === endingBalance`, which would call
 * `prefersReducedMotion()` during the very first render for that case).
 * That hook is shared with `ResultsPanel.tsx`'s `FadeInWrapper`, which
 * hit the identical bug independently first (issue #65) -- see the
 * hook's own doc comment for the full mid-session-toggle and
 * hydration-safety argument, including the precondition (only ever
 * mounted from a client-only success branch) that makes it safe here.
 * The glow itself never touches the sr-only twin span, so it can't
 * disturb what assistive tech reads.
 */
export function HeroStat({
  startingCapital,
  endingBalance,
  displayStartingCapital = startingCapital,
}: HeroStatProps) {
  const animatedEndingBalance = useCountUp(startingCapital, endingBalance, COUNT_UP_DURATION_MS);
  const isGain = endingBalance > startingCapital;
  const settled = animatedEndingBalance === endingBalance;
  const celebrate = shouldCelebrate(isGain, settled);
  const multiplier = endingBalance / startingCapital;
  const isMultiplierGain = multiplier >= 1;
  // Reveal accent (issue #77) -- see this component's own doc comment
  // above for the full reasoning, including why `useReducedMotionAtMount`
  // latches once rather than reading live. `animateAccentReveal` decides
  // whether to play the glow's brief entrance animation at all; `settled`
  // alone (regardless of motion preference) decides whether the glow's
  // class is present, since the reduced-motion path still shows the
  // glow, just without animating in (see globals.css's own
  // `.hero-figure-accent` doc comment).
  const reducedMotionAtMount = useReducedMotionAtMount();
  const animateAccentReveal = settled && !reducedMotionAtMount;
  const accentGlowColor = isMultiplierGain ? "var(--status-good)" : "var(--status-critical)";
  // Rescale the two displayed dollar figures (the animating one and its
  // always-final sr-only twin) from the underlying precomputed
  // startingCapital to whatever the caller wants displayed -- see
  // rescale-starting-capital.ts and this prop's own doc comment above.
  const displayedAnimatedEndingBalance = rescaleFromStartingCapital(
    animatedEndingBalance,
    startingCapital,
    displayStartingCapital,
  );
  const displayedEndingBalance = rescaleFromStartingCapital(
    endingBalance,
    startingCapital,
    displayStartingCapital,
  );

  return (
    <div className="flex flex-col items-start gap-1">
      <p className="text-sm font-medium text-[var(--text-secondary)]">Starting from</p>
      {/* relative + the burst overlay are scoped to just this row (not
          the "Starting from" label above) so the confetti bursts from
          around the figure itself, not the caption. */}
      <div className="relative">
        <p className="flex flex-wrap items-baseline gap-3 text-[clamp(2.5rem,6vw,4rem)] font-semibold leading-none tracking-tight text-[var(--text-primary)]">
          <span>{formatHeroCurrency(displayStartingCapital)}</span>
          <span aria-hidden="true" className="text-[var(--text-muted)]">
            →
          </span>
          <span
            aria-hidden="true"
            className={
              settled
                ? `hero-figure-accent${animateAccentReveal ? " hero-figure-accent-animate" : ""}`
                : undefined
            }
            style={
              settled ? ({ "--hero-accent-glow": accentGlowColor } as CSSProperties) : undefined
            }
          >
            {formatHeroCurrency(displayedAnimatedEndingBalance)}
          </span>
          <span className="sr-only">{formatHeroCurrency(displayedEndingBalance)}</span>
          <span
            className="text-xl font-semibold sm:text-2xl"
            style={{ color: isMultiplierGain ? "var(--status-good)" : "var(--status-critical)" }}
          >
            ({formatMultiplier(multiplier)})
          </span>
        </p>
        <CelebrationBurst active={celebrate} />
      </div>
    </div>
  );
}
