"use client";

// Tracks whether the first-visit onboarding intro banner (issue #64) has
// been dismissed, persisted across reloads via onboarding-storage.ts.

import { dismissOnboarding, isOnboardingDismissed } from "./onboarding-storage";
import { useHydratedLocalStorageState } from "./use-hydrated-local-storage-state";

/**
 * `readStored` for use-hydrated-local-storage-state.ts's generic hook
 * below -- `null` means "no correction needed" (the hook's own default
 * of `false`, not-dismissed, already covers that case), so a plain
 * `isOnboardingDismissed()` boolean is only meaningful to report when
 * it's actually `true`.
 */
function readStoredDismissed(): true | null {
  return isOnboardingDismissed() ? true : null;
}

/**
 * Whether the onboarding intro has been dismissed, and a function to
 * dismiss it.
 *
 * A thin wrapper around use-hydrated-local-storage-state.ts's generic
 * hydration-safe "start at a default, correct from storage after mount"
 * hook -- see that file's own doc comment for the full hydration-safety
 * reasoning and the mount-to-microtask race guard, both shared verbatim
 * with use-starting-capital.ts (issue #15), the hook this one's shared
 * logic was originally factored out of.
 *
 * This is deliberately **not** the simpler use-daily-guess.ts-style
 * "read synchronously in the useState initializer" shortcut -- that
 * shortcut is safe there only because that hook is exclusively mounted
 * from ResultsPanel's client-only `success` branch, which never renders
 * during SSR (see use-daily-guess.ts's own doc comment). This hook backs
 * a page-level banner mounted unconditionally on the root page, which
 * *can* render during SSR, so it needs the deferred-correction approach
 * instead (see use-hydrated-local-storage-state.ts for why).
 */
export function useOnboardingDismissed(): [boolean, () => void] {
  const [dismissed, setDismissed] = useHydratedLocalStorageState<boolean>(
    false,
    readStoredDismissed,
    dismissOnboarding,
  );

  function dismiss(): void {
    setDismissed(true);
  }

  return [dismissed, dismiss];
}
