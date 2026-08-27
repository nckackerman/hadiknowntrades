"use client";

// The SSR-safe sibling of use-reduced-motion-at-mount.ts (issue #131).
//
// That hook reads `prefersReducedMotion()` in a `useState` lazy
// initializer, and its own doc comment spells out the precondition:
// it is only safe from a component that never renders during SSR (i.e.
// one mounted from ResultsPanel's client-only success branch). Per issue
// #122, Beat the Bench mounts at the ResultsPage level, which *does*
// render on the server -- so that initializer would run once server-side
// (always `false`, per prefersReducedMotion()'s own `typeof window`
// guard) and again during hydration with the real value, exactly the
// mismatch that hook warns about.
//
// This one takes the same deferred-correction shape
// use-hydrated-local-storage-state.ts uses for localStorage instead:
// always `false` on the first render (server and client agree), then
// corrected after mount if the viewer really does prefer reduced motion.

import { useEffect, useState } from "react";

import { prefersReducedMotion } from "./prefers-reduced-motion";

/**
 * `true` once mounted if the viewer prefers reduced motion; `false` on
 * every server render and on the client's first (hydration) render.
 *
 * Read once after mount, not subscribed live -- same posture as every
 * other reduced-motion read in this app (see
 * `prefers-reduced-motion.ts`'s own doc comment). For Beat the Bench
 * that is exactly right: the preference decides how playback *starts*
 * (paused, in step-through mode), and the viewer can change speed or
 * step by hand from there regardless.
 */
export function useReducedMotionAfterMount(): boolean {
  const [reducedMotion, setReducedMotion] = useState(false);

  useEffect(() => {
    // Deferred to a microtask rather than called as the effect's own
    // first statement -- react-hooks/set-state-in-effect flags exactly
    // that shape; see use-hydrated-local-storage-state.ts's own comment
    // on the identical workaround.
    queueMicrotask(() => {
      if (prefersReducedMotion()) setReducedMotion(true);
    });
  }, []);

  return reducedMotion;
}
