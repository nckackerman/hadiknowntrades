// Persists whether PortfolioChart's one-time touch "tap this" pulse hint
// (issue #66) has already been shown/dismissed on this browser -- same
// simplest-possible single-sentinel shape as onboarding-storage.ts
// (issue #64) -- see that file's own comment. Once shown once (or
// dismissed by an actual interaction) on a browser, it never shows
// again there, full stop -- there's no per-range/per-day keying, since
// this is a generic "you can tap charts on this page" affordance, not
// content tied to any one result.

import { readLocalStorage, writeLocalStorage } from "./local-storage";

// Namespaced (not just e.g. "tap-hint-dismissed") so this can't collide
// with a key some other feature picks -- see apps/web/CLAUDE.md's
// localStorage note and onboarding-storage.ts/daily-guess-storage.ts's
// own prefixes.
const STORAGE_KEY = "hikt:chart-tap-hint-dismissed";

// The only value this module ever writes; any other stored value (there
// is no other real write path, so this only happens via a hand-edited or
// otherwise corrupted entry) is treated the same as "not dismissed"
// rather than throwing or being misread as a dismissal.
const DISMISSED_VALUE = "1";

/**
 * Whether the chart's touch tap-hint has previously been shown/dismissed
 * on this browser -- `false` covers "never shown," "localStorage itself
 * unavailable/throwing" (readLocalStorage already degrades to `null` for
 * both), and any unrecognized stored value uniformly, since every one of
 * those cases means the same thing to the caller: the hint may show.
 */
export function isChartTapHintDismissed(): boolean {
  return readLocalStorage(STORAGE_KEY) === DISMISSED_VALUE;
}

/** Records the chart tap-hint as shown/dismissed on this browser. */
export function dismissChartTapHint(): void {
  writeLocalStorage(STORAGE_KEY, DISMISSED_VALUE);
}
