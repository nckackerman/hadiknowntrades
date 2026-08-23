"use client";

// Tracks whether the first-visit onboarding intro banner (issue #64) has
// been dismissed, persisted across reloads via onboarding-storage.ts.

import { useEffect, useRef, useState } from "react";

import { dismissOnboarding, isOnboardingDismissed } from "./onboarding-storage";

/**
 * Whether the onboarding intro has been dismissed, and a function to
 * dismiss it.
 *
 * Always starts `false` (banner visible) on every render -- including the
 * very first client render during hydration -- and only corrects to `true`
 * from an effect after mount, if a previous dismissal is actually found in
 * storage. This is the same hydration-safety trick use-starting-capital.ts
 * uses for the same reason (see its own doc comment): reading localStorage
 * during render would make the client's first render (during hydration)
 * disagree with the server-rendered HTML whenever the banner had already
 * been dismissed on a prior visit -- exactly the kind of hydration
 * mismatch that hook (and prefers-reduced-motion.ts/use-count-up.ts)
 * already warn against.
 *
 * This is deliberately **not** the simpler use-daily-guess.ts-style
 * "read synchronously in the useState initializer" shortcut -- that
 * shortcut is safe there only because that hook is exclusively mounted
 * from ResultsPanel's client-only `success` branch, which never renders
 * during SSR (see use-daily-guess.ts's own doc comment). This hook backs
 * a page-level banner mounted unconditionally on the root page, which
 * *can* render during SSR, so it needs the deferred-correction approach
 * instead. The tradeoff is the same one use-starting-capital.ts accepts
 * too -- a first-time-this-session flash of the banner (for a returning
 * visitor who already dismissed it) before the real state applies just
 * after mount -- rather than a console-visible hydration error.
 *
 * Guarded against a race with an in-flight `dismiss` call the same way
 * use-starting-capital.ts's own setter is: `userSetRef` flips to `true`
 * synchronously inside `dismiss` (same tick as its own `setDismissed`
 * call, so there's no gap for the microtask to slip in between), and the
 * deferred microtask checks it first, bailing out if a real dismissal
 * already happened -- otherwise a very fast dismiss-then-remount could
 * have the microtask silently flip `dismissed` back to whatever was
 * (not) in storage a moment before the write landed.
 */
export function useOnboardingDismissed(): [boolean, () => void] {
  const [dismissed, setDismissed] = useState(false);
  const userSetRef = useRef(false);

  useEffect(() => {
    // Deferred to a microtask rather than called synchronously as the
    // first thing in the effect body -- react-hooks/set-state-in-effect
    // flags exactly that shape, the same lint use-count-up.ts's and
    // use-starting-capital.ts's own doc comments describe working around.
    queueMicrotask(() => {
      // A real dismiss() call already landed in the window between mount
      // and this microtask running -- don't clobber it (see this hook's
      // own doc comment).
      if (userSetRef.current) return;
      if (isOnboardingDismissed()) {
        setDismissed(true);
      }
    });
    // Mount-only: a one-time "hydrate from storage" correction, not a
    // subscription that should ever re-run.
  }, []);

  function dismiss(): void {
    userSetRef.current = true;
    setDismissed(true);
    dismissOnboarding();
  }

  return [dismissed, dismiss];
}
