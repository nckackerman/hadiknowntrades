"use client";

// Shared "latch prefersReducedMotion() once, at mount" hook (issue #77),
// extracted from two independent copies of the identical pattern found
// in the same `/code-review` pass: ResultsPanel.tsx's FadeInWrapper
// (issue #65) and HeroStat.tsx's reveal accent. See below for the full
// hydration-safety/mid-session-toggle reasoning both callers share.

import { useState } from "react";

import { prefersReducedMotion } from "./prefers-reduced-motion";

/**
 * Reads `prefersReducedMotion()` exactly once, via a `useState` lazy
 * initializer, rather than as a plain expression recomputed on every
 * render. This is *not* the same short-circuit shape
 * `shouldCelebrate`'s own `isGain && settled` uses (see that file's own
 * doc comment) -- it doesn't depend on some other value being provably
 * `false` at mount. Instead it fixes a different, real bug class found
 * twice independently in `/code-review`: a live `prefersReducedMotion()`
 * read recomputed on every render can add/remove an animation class on
 * an element that's already mounted and has already reached whatever
 * "done" state gates it, if the OS-level preference changes value
 * *between* two renders of that same still-mounted instance (e.g. an
 * unrelated prop change triggers a re-render with no new mount). A
 * `useState` lazy initializer only ever runs once, at the moment React
 * actually creates a new instance of the calling component -- so the
 * fix falls straight out of relying on React's own reconciliation
 * rules for "was this a genuine mount," not a hand-rolled ref/effect
 * check.
 *
 * **Safe from a hydration-mismatch perspective only under the same
 * precondition `use-daily-guess.ts`/`use-chart-tap-hint.ts`/
 * `FadeInWrapper` already document for this exact shortcut**: the
 * calling component must be one that never actually renders during SSR
 * (e.g. only ever mounted from `ResultsPanel`'s client-only `success`
 * branch -- `use-results.ts`'s fetch state machine always starts
 * `"loading"`, matching both server and initial client render). A
 * component that *can* render during SSR would have this lazy
 * initializer run once server-side (always computing `false`, per
 * `prefersReducedMotion()`'s own `typeof window === "undefined"` guard)
 * and once again on the client's hydration render (computing the real
 * value) -- two independent calls that can disagree, which is exactly
 * the mismatch `use-count-up.ts`/`should-celebrate.ts` defer their own
 * `matchMedia` reads to avoid. Re-check this precondition before reusing
 * this hook from a new caller.
 */
export function useReducedMotionAtMount(): boolean {
  const [reducedMotionAtMount] = useState(() => prefersReducedMotion());
  return reducedMotionAtMount;
}
