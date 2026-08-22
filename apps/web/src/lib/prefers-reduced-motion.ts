// Shared `prefers-reduced-motion` check for every animation in this app
// (issue #35's count-up, issue #36's celebration burst, and whatever
// comes next). Previously lived only inside use-count-up.ts; pulled out
// once a second animation needed the exact same guard, so both agree on
// what "reduced motion" means instead of two copies of the same check
// drifting apart.

/**
 * Meant to be checked once per animation start, not subscribed to live --
 * every current caller only ever animates once per mount (a "reveal"),
 * so there's no later moment where a mid-flight OS-setting change would
 * need to be honored. Guarded for environments without `matchMedia`
 * (jsdom in this repo's test setup doesn't implement it at all) by
 * treating "unknown" as "no preference," matching how missing
 * media-query support degrades in real browsers too.
 */
export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
