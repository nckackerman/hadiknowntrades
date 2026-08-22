// Gates HeroStat's celebration burst (issue #36).

import { prefersReducedMotion } from "./prefers-reduced-motion";

/**
 * Whether the celebration burst should render this render, given `isGain`
 * (a live comparison against the props -- see HeroStat's own doc
 * comment for why this isn't hardcoded to "every reveal is a win") and
 * `settled` (the count-up tween has landed on its exact final value).
 *
 * Deliberately a plain derived value, not a `useEffect` + `setState`
 * hook: `condition` (`isGain && settled`) is `false` on every render up
 * through and including hydration for any real gain -- `settled` can
 * only become `true` once useCountUp's requestAnimationFrame loop has
 * run at least one tick, which never happens before mount. That means
 * `&&`'s short-circuit guarantees `prefersReducedMotion()` (the only
 * part of this that touches `window`) is never called on the
 * SSR-matching first render, so there's no hydration-mismatch risk to
 * guard against here the way useCountUp's own RAF-callback deferral
 * does for its animation. It also sidesteps the
 * `react-hooks/set-state-in-effect` lint entirely -- this is a value
 * derived during render, not state synchronized from an effect.
 *
 * Once `isGain && settled` goes true it stays true for the lifetime of
 * a given HeroStat mount (the props that feed it don't change after the
 * reveal lands, and ResultsPanel remounts HeroStat fresh for every new
 * result -- see HeroStat's doc comment), so this doesn't need its own
 * one-shot latch to avoid the burst re-triggering on unrelated re-renders.
 */
export function shouldCelebrate(isGain: boolean, settled: boolean): boolean {
  return isGain && settled && !prefersReducedMotion();
}
