"use client";

// Drives the hero stat's count-up reveal (issue #35). Kept as a small,
// dependency-free requestAnimationFrame loop rather than pulling in an
// animation library for something this small (per the issue's own
// scope note).

import { useEffect, useState } from "react";

import { tweenValue } from "./easing";
import { prefersReducedMotion } from "./prefers-reduced-motion";

/**
 * Animates a number counting up from `from` to `to` over `durationMs`
 * on mount, easing out. Jumps straight to `to` with no animation if the
 * user has requested reduced motion.
 *
 * Deliberately mount-only (empty effect dependency array): this hook
 * exists to animate a single "reveal" moment, not to re-tween every
 * time `from`/`to` happen to change on an already-mounted instance --
 * callers that need a fresh reveal (e.g. HeroStat after a new preset
 * range loads) get one for free because the component around this hook
 * remounts with the new result rather than updating in place (see
 * ResultsPanel: loading/success are different subtrees).
 */
export function useCountUp(from: number, to: number, durationMs: number): number {
  const [value, setValue] = useState(from);

  useEffect(() => {
    // Checked once, here, rather than as a synchronous setValue(to) at
    // the top of the effect -- react-hooks/set-state-in-effect flags a
    // direct setState in an effect's body (see use-results.ts's own
    // note on this same lint rule). Folding the check into `tick`
    // instead means every setValue call happens inside a callback
    // invoked by requestAnimationFrame (an external system), the
    // pattern the rule itself recommends, and it keeps the DOM on the
    // very first render (server and client hydration alike) at `from`
    // unconditionally -- correcting to `to` only asynchronously, after
    // mount, sidesteps any hydration-mismatch risk from reading
    // `matchMedia` during render.
    const reducedMotion = prefersReducedMotion();
    let frameId: number;
    const startTime = performance.now();

    function tick(now: number) {
      if (reducedMotion) {
        setValue(to);
        return;
      }

      const elapsed = now - startTime;
      // `durationMs <= 0` short-circuits straight to done: besides being
      // the only sane reading of a non-positive duration, it also avoids
      // 0/0 = NaN when `elapsed` is also (near) zero, which the `t >= 1`
      // check below can't catch on its own (NaN >= 1 is false, so it'd
      // otherwise fall through to rendering "--" instead of `to`).
      const t = durationMs <= 0 ? 1 : Math.min(elapsed / durationMs, 1);
      // tweenValue snaps to the exact `to` once t >= 1 (see lib/easing.ts's
      // own doc comment) -- the acceptance criteria calls for a
      // pixel-identical final render, so this lands on `to` precisely
      // rather than "close enough to round the same way."
      setValue(tweenValue(from, to, t));
      if (t >= 1) {
        return;
      }
      frameId = requestAnimationFrame(tick);
    }

    frameId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frameId);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally mount-only, see doc comment above
  }, []);

  return value;
}
