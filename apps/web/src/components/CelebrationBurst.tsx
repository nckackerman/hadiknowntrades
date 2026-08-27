"use client";

import { useMemo } from "react";
import type { CSSProperties } from "react";

import { FULL_CELEBRATION_INTENSITY, type CelebrationIntensity } from "@/lib/celebration-magnitude";

interface CelebrationBurstProps {
  /** Whether to render the burst. See shouldCelebrate -- gain + settled + not reduced-motion is already decided by the time this is `true`. */
  active: boolean;
  /**
   * How much confetti to throw (issue #125) -- defaults to the original
   * fixed 24-piece, full-width burst, so a caller that doesn't care
   * about magnitude renders exactly what it did before this prop
   * existed. A `pieceCount` of `0` renders nothing at all.
   *
   * Purely an intensity dial: it never overrides `active`, which is
   * still the only thing that decides whether a burst is allowed at all
   * (see `lib/should-celebrate.ts`).
   */
  intensity?: CelebrationIntensity;
}

// A small, deliberately festive palette -- distinct from the muted
// dataviz tokens in globals.css (this isn't a chart, it's a one-shot
// decoration), chosen to stay legible against this app's one dark
// background (issue #76: dark is the only theme, no toggle to key off).
//
// Two of these six are real token references, not festive literals
// (issue #156, filed by issue #135's cross-feature QA pass): this array
// used to hardcode `#f5b301` (a second, undocumented gold, distinct from
// `--accent-reward`'s `#e8a33d`) and `#3987e5` (a byte-for-byte literal
// copy of `--series-1`). Both were live, on screen, at the same moment
// as the token's own real color elsewhere on the page -- `--accent-reward`
// on The Call Board's exact-match history cells, `--series-1` on the
// portfolio chart's own line -- which is exactly the "two golds"/"two
// blues" drift globals.css's own token doc comment exists to prevent.
// Referencing the tokens directly means a future change to either one
// (a rebalance like issue #123's, or a hue shift) reaches the confetti
// automatically instead of leaving a stale duplicate behind for a future
// QA pass to re-discover a third time. `<span>` background-color is a
// plain HTML inline style, not an SVG/canvas paint operation that would
// need a resolved literal -- a CSS custom property works here exactly as
// it would in a stylesheet.
//
// The other four (`#ff6b6b`, `#2dd4bf`, `#a78bfa`, `#34d399`) are
// deliberately kept as festive literals, not promoted to tokens: none of
// them duplicates an existing semantic color anywhere else in this app,
// so there is no drift risk to guard against and no semantic meaning
// (gain/loss, selection, reward) they'd need to inherit or misrepresent.
// They exist purely to make the burst read as colorful confetti, with no
// collision to avoid -- don't "finish the migration" by tokenizing these
// too; that would just invent meaning for colors that were never meant
// to carry any.
const CONFETTI_COLORS = [
  "var(--accent-reward)",
  "#ff6b6b",
  "#2dd4bf",
  "#a78bfa",
  "var(--series-1)",
  "#34d399",
];

interface ConfettiPiece {
  id: number;
  leftPercent: number;
  color: string;
  rotationDeg: number;
  fallPx: number;
  durationMs: number;
  delayMs: number;
}

function randomPiece(id: number, spreadPercent: number): ConfettiPiece {
  return {
    id,
    // Centered on the hero figure, spanning `spreadPercent` of the row's
    // width -- at the default 100 this is exactly the original
    // `Math.random() * 100` full-width distribution, byte-for-byte.
    leftPercent: 50 + (Math.random() - 0.5) * spreadPercent,
    color: CONFETTI_COLORS[id % CONFETTI_COLORS.length]!,
    // Signed rotation so pieces spin in both directions, not uniformly clockwise.
    rotationDeg: (Math.random() < 0.5 ? -1 : 1) * (360 + Math.random() * 360),
    fallPx: 70 + Math.random() * 60,
    durationMs: 900 + Math.random() * 500,
    delayMs: Math.random() * 150,
  };
}

/**
 * A one-shot confetti burst over the hero stat, rendered once
 * shouldCelebrate says the reveal landed on a gain. Plain CSS
 * keyframe animation on a handful of absolutely-positioned `<span>`s
 * (see globals.css's `.confetti-piece`) -- no canvas, no animation
 * library. This is the same "no dependency" call the count-up reveal
 * and the hand-rolled SVG chart already made; a few dozen short-lived
 * elements is well within what CSS animation handles smoothly, and
 * pulling in a confetti package for this would cost real bundle size
 * for something a ~40-line component covers (see the PR description
 * for the measured bundle-size delta).
 *
 * Decorative only: the whole thing is `aria-hidden` and
 * `pointer-events-none`, so it's invisible to assistive tech and never
 * intercepts a click or tap on the page underneath it.
 *
 * How *much* confetti is a separate axis from whether any renders at all
 * (issue #125): `intensity` scales the piece count and horizontal spread
 * to the size of the win, and can suppress the burst entirely for a
 * marginal one, but it is only ever consulted once `active` has already
 * said yes -- see `lib/celebration-magnitude.ts` for the tier table and
 * `lib/should-celebrate.ts` for the gate itself.
 */
export function CelebrationBurst({
  active,
  intensity = FULL_CELEBRATION_INTENSITY,
}: CelebrationBurstProps) {
  const { pieceCount, spreadPercent } = intensity;
  // Generated once, only once `active` actually turns true -- no point
  // paying for Math.random() calls (or holding onto stale piece state)
  // for a burst that may never fire.
  const pieces = useMemo(
    () =>
      active ? Array.from({ length: pieceCount }, (_, id) => randomPiece(id, spreadPercent)) : [],
    [active, pieceCount, spreadPercent],
  );

  // `pieceCount === 0` is the suppressed tier (a marginal win), not a
  // degenerate input -- rendering the empty overlay div for it would
  // leave a stray, testable "a burst happened" marker in the DOM for a
  // result that deliberately isn't celebrating.
  if (!active || pieces.length === 0) {
    return null;
  }

  return (
    <div
      aria-hidden="true"
      data-testid="celebration-burst"
      className="pointer-events-none absolute inset-0 overflow-visible"
    >
      {pieces.map((piece) => (
        <span
          key={piece.id}
          className="confetti-piece absolute -top-3 block h-2.5 w-1.5 rounded-[1px]"
          style={
            {
              left: `${piece.leftPercent}%`,
              backgroundColor: piece.color,
              "--confetti-rotation": `${piece.rotationDeg}deg`,
              "--confetti-fall": `${piece.fallPx}px`,
              animationDuration: `${piece.durationMs}ms`,
              animationDelay: `${piece.delayMs}ms`,
            } as CSSProperties
          }
        />
      ))}
    </div>
  );
}
