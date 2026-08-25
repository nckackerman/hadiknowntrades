"use client";

// First-visit onboarding intro banner (issue #64) -- a one-line explainer
// shown above the results for a visitor who hasn't dismissed it yet, so
// they don't land mid-result (e.g. "$20 -> $472K") with no framing at
// all. Since issue #104 collapsed every disclaimer/methodology surface
// behind a single click (AboutSection, now rendered per result view, not
// at the page level), this banner is the only unclick-required framing
// left on first paint -- not a substitute for AboutSection's fuller
// disclaimer/methodology content, just this app's one remaining
// always-visible context for a first-time visitor.

import { useOnboardingDismissed } from "@/lib/use-onboarding-dismissed";

/**
 * Renders nothing once dismissed (this session or a previous visit --
 * see use-onboarding-dismissed.ts for the hydration-safety tradeoff that
 * makes it always render on the very first client render regardless).
 * No re-prompt logic, no multi-step tour, no modal -- a single dismissal
 * hides it permanently on this browser, per the issue's own scope.
 */
export function OnboardingIntro() {
  const [dismissed, dismiss] = useOnboardingDismissed();

  if (dismissed) return null;

  return (
    <div
      role="note"
      className="surface-card flex items-start justify-between gap-3 rounded-lg border border-[var(--gridline)] bg-[var(--surface-2)] px-4 py-3 text-sm text-[var(--text-secondary)]"
    >
      <p>
        This is a hindsight toy: starting from $20, it finds the best possible outcome from at most
        3 trades across the whole S&amp;P 500, using only closed daily prices -- not a predictor of
        what happens next.
      </p>
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss intro"
        className="shrink-0 rounded-full px-2 py-0.5 text-base leading-none text-[var(--text-muted)] hover:text-[var(--text-primary)]"
      >
        &times;
      </button>
    </div>
  );
}
