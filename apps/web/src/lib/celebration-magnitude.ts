// Scales HeroStat's celebration burst to how big the win actually was
// (issue #125).

/**
 * How much confetti a burst renders. `pieceCount` of `0` means "no burst
 * at all" -- a real, deliberate tier, not a degenerate case (see
 * `celebrationIntensityFor`'s own threshold table below).
 *
 * `spreadPercent` is the *width* of the horizontal band pieces spawn
 * across, centered on the hero figure: `100` reproduces the original
 * full-row `Math.random() * 100` distribution exactly, `40` confines
 * pieces to the middle 40% of the row. Scaling the spread alongside the
 * count is what keeps a small burst reading as "a modest little
 * celebration" rather than "the same wide burst, just sparser."
 */
export interface CelebrationIntensity {
  pieceCount: number;
  spreadPercent: number;
}

/**
 * The original, pre-#125 fixed burst -- 24 pieces across the full width
 * of the hero figure's row. Still exactly what a genuinely spectacular
 * result renders, and still `CelebrationBurst`'s own default for any
 * caller that doesn't opt into magnitude scaling (the intraday-daily
 * model's per-day HeroStat, today), so this issue changes nothing for
 * those call sites.
 */
export const FULL_CELEBRATION_INTENSITY: CelebrationIntensity = {
  pieceCount: 24,
  spreadPercent: 100,
};

/**
 * Below this multiplier a win gets no confetti at all. A +20% window is
 * a real gain and still reads as one -- the multiplier badge and the
 * reveal-accent glow (issue #77) both render in `--status-good`
 * regardless, and neither is touched here -- it just isn't a "throw
 * confetti" moment, which is precisely the complaint issue #125 exists
 * to fix (every gain, however small, firing the identical burst).
 *
 * Deliberately expressed against the multiplier, not the dollar delta:
 * dollars scale with the user's own configurable starting capital
 * (issue #15) while the multiplier doesn't, so a $20 user and a
 * $1,000,000 user get the same celebration for the same result.
 */
const SUPPRESS_BELOW_MULTIPLIER = 1.25;

/**
 * Order-of-magnitude tier boundaries. Decades, not linear steps, because
 * the outcome space this app renders genuinely spans many of them (a
 * few-day custom anchor lands near 1x; a real Max-range result has been
 * measured at ~35.8Mx -- see apps/web/CLAUDE.md's multiplier-badge
 * section) and the portfolio chart already plots it on a log scale for
 * exactly that reason. A linear ladder would put essentially every
 * window-model result in the top tier and defeat the point.
 */
const MODEST_BELOW_MULTIPLIER = 10;
const STRONG_BELOW_MULTIPLIER = 100;

const MODEST_CELEBRATION_INTENSITY: CelebrationIntensity = {
  pieceCount: 8,
  spreadPercent: 45,
};
const STRONG_CELEBRATION_INTENSITY: CelebrationIntensity = {
  pieceCount: 16,
  spreadPercent: 72,
};

/**
 * Picks a burst intensity from the *same* `endingBalance /
 * startingCapital` multiplier HeroStat's own "(345x)" badge already
 * computes -- deliberately reusing that value rather than deriving a
 * second notion of "how big was this" that could drift from what the
 * badge on screen says.
 *
 * **This only ever scales an already-approved burst down; it can never
 * turn one on.** `shouldCelebrate(isGain, settled)` (lib/should-celebrate.ts)
 * remains the sole gate on whether a burst renders at all -- HeroStat
 * ANDs this tier's own "is there anything left to render" result on top
 * of that gate, never in place of it, so a loss, a flat result, an
 * unsettled tween, or a reduced-motion preference all still render
 * nothing regardless of what this function returns. (A loss can't even
 * reach a non-suppressed tier: every multiplier below 1.25 suppresses,
 * and a loss is by definition below 1.)
 *
 * A non-finite multiplier (a `startingCapital` of `0` would give
 * `Infinity`; `0/0` gives `NaN`) falls through to the suppressed tier
 * rather than the spectacular one -- `NaN >= x` is `false` for every
 * comparison, and `Infinity` is explicitly rejected, so corrupt input
 * degrades to "no decoration" instead of an unbounded celebration.
 */
export function celebrationIntensityFor(multiplier: number): CelebrationIntensity {
  if (!Number.isFinite(multiplier) || multiplier < SUPPRESS_BELOW_MULTIPLIER) {
    return { pieceCount: 0, spreadPercent: 0 };
  }
  if (multiplier < MODEST_BELOW_MULTIPLIER) {
    return MODEST_CELEBRATION_INTENSITY;
  }
  if (multiplier < STRONG_BELOW_MULTIPLIER) {
    return STRONG_CELEBRATION_INTENSITY;
  }
  return FULL_CELEBRATION_INTENSITY;
}
