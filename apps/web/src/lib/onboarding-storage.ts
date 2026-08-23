// Persists whether the first-visit onboarding intro banner has been
// dismissed (issue #64) -- built on local-storage.ts's defensive
// read/write rather than touching `window.localStorage` directly, per
// apps/web/CLAUDE.md's "localStorage pattern" section.
//
// Unlike daily-guess-storage.ts (keyed per (range, date, mode) triple)
// or use-starting-capital.ts (a numeric value), this is the simplest
// possible shape: one namespaced key, one boolean flag, no keying and
// no re-prompt logic -- once dismissed on a browser, it never shows
// again there, full stop (see the issue's own "Scope" section).

import { readLocalStorage, writeLocalStorage } from "./local-storage";

// Namespaced (not just e.g. "dismissed") so this can't collide with a key
// some other feature picks -- see apps/web/CLAUDE.md's localStorage note
// and daily-guess-storage.ts/use-starting-capital.ts's own prefixes.
const STORAGE_KEY = "hikt:onboarding-dismissed";

// The only value this module ever writes; any other stored value (there
// is no other real write path, so this only happens via a hand-edited or
// otherwise corrupted entry) is treated the same as "not dismissed"
// rather than throwing or being misread as a dismissal.
const DISMISSED_VALUE = "1";

/**
 * Whether the onboarding intro has previously been dismissed on this
 * browser -- `false` covers "never dismissed," "localStorage itself
 * unavailable/throwing" (readLocalStorage already degrades to `null` for
 * both), and any unrecognized stored value uniformly, since every one of
 * those cases means the same thing to the caller: show the banner.
 */
export function isOnboardingDismissed(): boolean {
  return readLocalStorage(STORAGE_KEY) === DISMISSED_VALUE;
}

/** Records the onboarding intro as dismissed on this browser. */
export function dismissOnboarding(): void {
  writeLocalStorage(STORAGE_KEY, DISMISSED_VALUE);
}
