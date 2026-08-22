"use client";

import { useMemo } from "react";
import type { CSSProperties } from "react";

interface CelebrationBurstProps {
  /** Whether to render the burst. See shouldCelebrate -- gain + settled + not reduced-motion is already decided by the time this is `true`. */
  active: boolean;
}

const PIECE_COUNT = 24;

// A small, deliberately festive palette -- distinct from the muted
// dataviz tokens in globals.css (this isn't a chart, it's a one-shot
// decoration), but still legible against both the light and dark
// backgrounds since this app has no in-app theme toggle to key off.
const CONFETTI_COLORS = ["#f5b301", "#ff6b6b", "#2dd4bf", "#a78bfa", "#3987e5", "#34d399"];

interface ConfettiPiece {
  id: number;
  leftPercent: number;
  color: string;
  rotationDeg: number;
  fallPx: number;
  durationMs: number;
  delayMs: number;
}

function randomPiece(id: number): ConfettiPiece {
  return {
    id,
    leftPercent: Math.random() * 100,
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
 */
export function CelebrationBurst({ active }: CelebrationBurstProps) {
  // Generated once, only once `active` actually turns true -- no point
  // paying for Math.random() calls (or holding onto stale piece state)
  // for a burst that may never fire.
  const pieces = useMemo(
    () => (active ? Array.from({ length: PIECE_COUNT }, (_, id) => randomPiece(id)) : []),
    [active],
  );

  if (!active) {
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
