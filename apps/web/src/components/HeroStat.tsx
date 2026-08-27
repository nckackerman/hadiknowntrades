"use client";

import type { CSSProperties } from "react";

import { celebrationIntensityFor, FULL_CELEBRATION_INTENSITY } from "@/lib/celebration-magnitude";
import { formatHeroCurrency, formatMultiplier } from "@/lib/format-currency";
import { rescaleFromStartingCapital } from "@/lib/rescale-starting-capital";
import { shouldCelebrate } from "@/lib/should-celebrate";
import { useCountUp } from "@/lib/use-count-up";
import { useReducedMotionAtMount } from "@/lib/use-reduced-motion-at-mount";
import { AnimatedFigure } from "@/components/AnimatedFigure";
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
  /**
   * Scale the celebration burst to how large this result's own
   * multiplier actually is (issue #125) -- a marginal win gets a small
   * burst or none, a many-decade win gets the full one. Defaults to
   * `false`, i.e. the pre-#125 fixed 24-piece burst for every gain.
   *
   * **Opt-in per call site on purpose, rather than always-on.** Issue
   * #125 is explicitly scoped to the window model (5Y/MAX and
   * custom-date anchors), where this figure is genuinely the page's
   * headline -- `TradeReplay.tsx` (window/custom-window only, by
   * construction) passes `true`; `ResultsPanel.tsx`'s intraday-daily
   * per-day drill-down, whose modest single-day multipliers would all
   * land in the suppressed/modest tiers, deliberately doesn't, so that
   * model's behavior is unchanged by this issue. Flipping it on there
   * is a real product change worth its own issue, not a side effect of
   * this one.
   *
   * Never widens the celebration: `shouldCelebrate` still solely decides
   * whether a burst is allowed at all, and this only ever scales an
   * already-approved one down. See `lib/celebration-magnitude.ts`.
   */
  scaleCelebrationToMagnitude?: boolean;
}

// Long enough to read as a deliberate count rather than a flicker, short
// enough not to make people wait for the number they came for.
const COUNT_UP_DURATION_MS = 1200;

/**
 * The "$20 -> $X" headline figure. Exactly one per view, per the dataviz
 * skill's hero-figure spec: >=48px, the same weight/scale as the rest of
 * the page.
 *
 * **The figures are tabular, not proportional -- a deliberate reversal
 * of that spec's "proportional (not tabular) figures" line, made in
 * issue #147.** The spec's advice is written for a *static* hero number,
 * where proportional figures genuinely read better; this one animates.
 * Issue #124 measured what that costs on the real app: Geist Sans' "1"
 * is 25.4px against its "0"'s 42.4px at 64px/600, so the animated
 * figure's box changed width on essentially every frame of the 1.2s
 * count-up (a 61px sweep across 30 distinct widths on a plain
 * `$20.00 -> $21.43` result), which re-wrapped the `flex flex-wrap` row
 * it lives in and moved everything below the hero by up to 76px while
 * the number counted. A hero figure that shoves the page around as it
 * reveals is worse than one whose digits aren't optically spaced.
 *
 * So the value row renders in `--font-numeric` (Geist Mono), the role
 * issue #121 declared for exactly this -- "anything tabular or animated
 * digit by digit, where a proportional face makes the number jitter as
 * it changes -- useCountUp's reveal" -- plus `tabular-nums`, as that
 * token's own note asks for wherever digits change in place.
 *
 * **Geist Sans' own `tabular-nums` was tried first and measured
 * insufficient, so don't "simplify" back to it.** Issue #124 reported
 * that Geist's tabular figures all measure 38.406px, but that was
 * sampled on `$XX.XX` strings built from 0/1/2/9 only. Measured across
 * all ten digits in a real browser on this app's own hero row (64px/600,
 * `font-variant-numeric: tabular-nums`, letter-spacing zeroed): eight
 * digits advance 40.0px, but **"4" advances 41.0px and "7" advances
 * 39.0px** -- Geist's `tnum` table is not actually uniform. Real strings
 * hit that: `$999.99` measures 256px and `$444.44` measures 261px, and
 * the plain `$20.00 -> $21.43` day (a "4" appearing and disappearing as
 * the number counts) still swept three distinct widths under
 * `tabular-nums` alone. The same measurement on Geist Mono returns
 * exactly 38.0px for every digit *and* for "$", ".", "K" and "M", which
 * is what makes the reservation below exact rather than approximate.
 *
 * Static figures elsewhere in the app (`WorstCaseStat`, `BenchmarkStat`,
 * the trade narration) are untouched and stay proportional: none of them
 * animate, so none of them pay this cost. See `heroValueRowClassName`
 * below for why the treatment lives on the shared row class rather than
 * on this component's own span, and `components/AnimatedFigure.tsx` for
 * the second half of the fix -- the ladder-crossing width reservation,
 * which no choice of figures does anything about.
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
 * *How much* confetti that burst throws is a separate axis, opt-in per
 * call site via `scaleCelebrationToMagnitude` (issue #125) -- see that
 * prop's own doc comment for which call sites opt in and why, and
 * `lib/celebration-magnitude.ts` for the tier table. It only ever
 * scales an approved burst down (possibly to nothing); `shouldCelebrate`
 * above is still the only thing that can turn one on.
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
// Shared with TradeReplay.tsx's own animated "$X -> $Y" figure (issue
// #96, via HeroAndWorstCase's `heroSlot` prop) -- exported (code review,
// issue #96 follow-up round four) so that figure's "Starting from"
// caption and big-number row reuse these classes instead of hand-copying
// them as literal strings, a real byte-for-byte duplication risk the
// review flagged: `heroSlot` overlays a purely visual, differently-driven
// figure (a live RAF tween, not useCountUp) that still needs to read as
// "the same hero figure, mid-transition" -- matching typography, not
// matching markup structure or behavior, which is why this shares only
// the two className strings rather than a bigger chunk of JSX/logic.
export const heroLabelClassName = "text-sm font-medium text-[var(--text-secondary)]";
// `font-numeric tabular-nums` (issue #147) is deliberately on the *row*,
// not on the animated span alone, for two reasons. First, it is what
// makes the fix impossible to apply to only one side of an overlay: the
// `heroSlot` overlay (HeroAndWorstCase.tsx) is sized by the real,
// invisible HeroStat behind it, so the two must wrap identically or the
// overlay overflows its box -- a bug issue #107 hit twice, both times by
// changing one side's metrics without the other's. Anything that reaches
// this string reaches both sides at once. Second, one mono figure beside
// a proportional sibling figure and a proportional "(Nx)" badge reads as
// a mistake, not a design: the row is all numeric data, so it all gets
// the numeric face. Nothing here changes behavior -- the starting figure
// and the badge are static either way, they just paint in Geist Mono
// now; only the animated figure needed the metrics, and the row is the
// only place to put them that both sides of the overlay share.
export const heroValueRowClassName =
  "flex flex-wrap items-baseline gap-3 font-numeric text-[clamp(2.5rem,6vw,4rem)] font-semibold tabular-nums leading-none tracking-tight text-[var(--text-primary)]";
// Same reasoning as the two exports above (code review, issue #96
// follow-up round five) -- TradeReplay.tsx's playing-phase overlay needs
// the exact same "(Nx)" multiplier badge this component always renders,
// with the same gain/loss color threshold (`>= 1`, not the stricter `> `
// that gates the celebration burst -- see this component's own doc
// comment for why those two thresholds deliberately differ). Exported
// rather than re-derived so the two badges can never drift apart.
export const heroMultiplierClassName = "text-xl font-semibold sm:text-2xl";
export function heroMultiplierColor(multiplier: number): string {
  return multiplier >= 1 ? "var(--status-good)" : "var(--status-critical)";
}

export function HeroStat({
  startingCapital,
  endingBalance,
  displayStartingCapital = startingCapital,
  scaleCelebrationToMagnitude = false,
}: HeroStatProps) {
  const animatedEndingBalance = useCountUp(startingCapital, endingBalance, COUNT_UP_DURATION_MS);
  const isGain = endingBalance > startingCapital;
  const settled = animatedEndingBalance === endingBalance;
  const celebrate = shouldCelebrate(isGain, settled);
  const multiplier = endingBalance / startingCapital;
  const isMultiplierGain = multiplier >= 1;
  // Burst magnitude (issue #125) -- derived from the *same* multiplier
  // the "(345x)" badge below already renders, so what the confetti says
  // about the size of the win can never disagree with what the badge
  // says. Strictly an intensity dial layered on top of `celebrate`
  // (which is still the only gate), never a second way to turn a burst
  // on: `CelebrationBurst` renders nothing whenever `active` is false,
  // whatever intensity it's handed.
  const celebrationIntensity = scaleCelebrationToMagnitude
    ? celebrationIntensityFor(multiplier)
    : FULL_CELEBRATION_INTENSITY;
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
      <p className={heroLabelClassName}>Starting from</p>
      {/* relative + the burst overlay are scoped to just this row (not
          the "Starting from" label above) so the confetti bursts from
          around the figure itself, not the caption. */}
      <div className="relative">
        <p className={heroValueRowClassName}>
          <span>{formatHeroCurrency(displayStartingCapital)}</span>
          <span aria-hidden="true" className="text-[var(--text-muted)]">
            →
          </span>
          {/* Issue #147: a box wide enough for every string this tween
              can produce, so the compact-unit ladder crossing a boundary
              mid-count ("$994.72" -> "$1K") can't change the row's width
              and re-wrap it. Sized from the tween's *endpoints*, never
              from `animatedEndingBalance` -- TradeReplay.tsx's
              playing-phase overlay renders the same component with the
              same two values, so it and this figure reserve identically
              and keep wrapping in lockstep. See AnimatedFigure.tsx. */}
          <AnimatedFigure
            aria-hidden="true"
            from={displayStartingCapital}
            to={displayedEndingBalance}
            value={formatHeroCurrency(displayedAnimatedEndingBalance)}
            className={
              settled
                ? `hero-figure-accent${animateAccentReveal ? " hero-figure-accent-animate" : ""}`
                : undefined
            }
            style={
              settled ? ({ "--hero-accent-glow": accentGlowColor } as CSSProperties) : undefined
            }
          />
          <span className="sr-only">{formatHeroCurrency(displayedEndingBalance)}</span>
          <span
            className={heroMultiplierClassName}
            style={{ color: heroMultiplierColor(multiplier) }}
          >
            ({formatMultiplier(multiplier)})
          </span>
        </p>
        <CelebrationBurst active={celebrate} intensity={celebrationIntensity} />
      </div>
    </div>
  );
}
