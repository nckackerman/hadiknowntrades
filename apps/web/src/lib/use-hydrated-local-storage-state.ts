"use client";

// Shared hydration-safe "start at a default, correct from localStorage
// after mount" hook, factored out of use-starting-capital.ts (issue #15)
// once use-onboarding-dismissed.ts (issue #64) needed the identical
// shape a second time -- found as a real reuse/simplification finding in
// code review on issue #64's own PR (two near-verbatim copies of the
// same mount-hydration + race-guard logic, differing only in the
// storage read/write calls and the default value), not written
// speculatively ahead of a second real use.

import { useEffect, useRef, useState } from "react";

/**
 * Generic version of the hydration-safety trick this app uses everywhere
 * it reads a localStorage-backed value that could affect the very first
 * render: `useStartingCapital` (issue #15) is a thin wrapper around this.
 * `useOnboardingDismissed` (issue #64), the second caller whose addition
 * originally prompted extracting this hook out of use-starting-capital.ts,
 * was deleted by issue #165 (the standalone onboarding banner was folded
 * into the page's own header caption) -- the extraction and its reasoning
 * below still stand on their own merits, not just for this one caller.
 *
 * Always starts at `defaultValue` on every render -- including the very
 * first client render during hydration -- and only corrects to whatever
 * `readStored` actually finds from an effect after mount. Reading
 * localStorage during render would make the client's first render
 * (during hydration) disagree with the server-rendered HTML whenever a
 * non-default value was already stored -- exactly the kind of hydration
 * mismatch prefers-reduced-motion.ts/use-count-up.ts already warn
 * against for their own (unrelated) `window.matchMedia` reads. The
 * tradeoff is the same one those files accept too -- a brief flash of
 * the default value before the real one applies just after mount --
 * rather than a console-visible hydration error.
 *
 * This is deliberately **not** safe to use from a component that's only
 * ever mounted from a client-only branch that never renders during SSR
 * (see use-daily-guess.ts's own doc comment for that alternate,
 * simpler-but-narrower pattern, which reads storage synchronously in a
 * `useState` initializer instead) -- if the caller's own render tree
 * genuinely can't render during SSR, that shortcut is simpler and this
 * hook is unnecessary ceremony. Reach for this one whenever that
 * precondition doesn't hold, as it doesn't for either current caller.
 *
 * **Guarded against a race with an in-flight `setValue` call**: deferring
 * the hydration read to a microtask (see the comment below) opens a
 * window, between mount and that microtask actually running, where a
 * caller could invoke the returned setter. Without a guard, the
 * microtask's correction would land *after* that update and silently
 * clobber it back to whatever stale value `readStored` returns, discarding
 * the update with no error and no trace. `userSetRef` closes that window:
 * the setter flips it to `true` synchronously (same tick as its own
 * `setValueState` call, so there's no gap for the microtask to slip in
 * between), and the microtask checks it immediately before applying the
 * stored value, bailing out if a real update already happened.
 *
 * @param defaultValue The value returned on every render until (and
 *   unless) a stored value is found after mount.
 * @param readStored Reads the current persisted value, or `null` if
 *   nothing usable is stored (covers "never written," "unparseable," and
 *   "storage itself unavailable/throwing" uniformly -- see e.g.
 *   onboarding-storage.ts/starting-capital.ts's own read helpers).
 * @param writeStored Persists `next` when `setValue(next)` is called.
 *   Any failure here is expected to already degrade silently (see
 *   local-storage.ts) -- this hook does not itself guard against a
 *   throwing write.
 */
export function useHydratedLocalStorageState<T>(
  defaultValue: T,
  readStored: () => T | null,
  writeStored: (next: T) => void,
): [T, (next: T) => void] {
  const [value, setValueState] = useState(defaultValue);
  const userSetRef = useRef(false);

  useEffect(() => {
    // Deferred to a microtask rather than called synchronously as the
    // first thing in the effect body -- react-hooks/set-state-in-effect
    // flags exactly that shape (a direct, unconditional-looking setState
    // at the top of an effect), the same lint use-count-up.ts's own doc
    // comment describes working around by folding a setState call into a
    // callback invoked by something external to the effect itself
    // (there, requestAnimationFrame; here, the microtask queue) instead
    // of calling it as the effect's own first statement.
    queueMicrotask(() => {
      // A real setValue call already landed in the window between mount
      // and this microtask running -- don't clobber it with a stale
      // persisted value (see this hook's own doc comment).
      if (userSetRef.current) return;
      const stored = readStored();
      if (stored !== null) {
        setValueState(stored);
      }
    });
    // Mount-only: a one-time "hydrate from storage" correction, not a
    // subscription that should ever re-run -- readStored is deliberately
    // omitted from the dep array below (both current callers pass a
    // stable reference anyway; re-running this on every render a caller
    // happened to pass a fresh closure would defeat the "one microtask
    // right after mount" contract this hook promises).
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally mount-only, see comment above
  }, []);

  function setValue(next: T): void {
    userSetRef.current = true;
    setValueState(next);
    writeStored(next);
  }

  return [value, setValue];
}
