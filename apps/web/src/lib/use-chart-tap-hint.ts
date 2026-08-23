"use client";

import { useEffect, useState } from "react";

import { dismissChartTapHint, isChartTapHintDismissed } from "./chart-tap-hint-storage";
import { prefersReducedMotion } from "./prefers-reduced-motion";

/**
 * Whether `PortfolioChart` should show its one-time touch "you can tap
 * this" pulse hint (issue #66), and a function to dismiss it for good.
 *
 * Reads `matchMedia`/localStorage synchronously in the `useState`
 * initializer rather than going through
 * use-hydrated-local-storage-state.ts's deferred-correction dance --
 * safe here for the same reason use-daily-guess.ts's own shortcut is
 * safe (see that hook's own doc comment): `PortfolioChart` is only ever
 * mounted from `ResultsPanel`'s client-only `success` branch, which
 * never renders during SSR (`use-results.ts`'s fetch state machine
 * always starts `"loading"`, matching both server and initial client
 * render, so the branch that actually mounts `PortfolioChart` can't
 * disagree between them). Reusing this shortcut from a tree that *can*
 * render on the server would reintroduce the hydration-mismatch risk
 * `use-hydrated-local-storage-state.ts` exists to avoid.
 *
 * The hint is gated on three independent conditions, all checked once
 * at mount:
 * - `(pointer: coarse)` -- a touch-primary device, per the issue's own
 *   "signal to a touch user" framing; a mouse/trackpad user already gets
 *   the discoverable hover interaction and doesn't need a pulsing dot.
 * - Not previously shown/dismissed on this browser
 *   (`isChartTapHintDismissed`) -- true "one-time," not "once per
 *   chart mount."
 * - Not `prefersReducedMotion()` -- the hint is purely a CSS animation
 *   (see `PortfolioChart.tsx`'s `chart-tap-hint-pulse` class); a user
 *   who prefers reduced motion gets no hint at all here rather than a
 *   static substitute, the same "skip the affordance entirely" choice
 *   `should-celebrate.ts` already makes for `HeroStat`'s celebration
 *   burst -- the caption fix (`PortfolioChart.tsx`'s idle readout) is
 *   this issue's real accessibility floor for every user regardless of
 *   motion preference or pointer type.
 *
 * **Persisted immediately on mount (via the effect below), not deferred
 * until `dismiss()`/the pulse animation's own `onAnimationEnd` (real bug,
 * found in code review, fixed).** The first version only wrote the
 * dismissal from `dismiss()` itself, which meant a `PortfolioChart` that
 * unmounts before either happens -- e.g. the intraday-daily model's
 * `DayOverview` (issue #80; `DaySelector` before it) switching to a
 * different day mid-pulse, well within the
 * ~4.2s three-cycle animation -- left `isChartTapHintDismissed()` still
 * reading `false`, so the very next `PortfolioChart` mount (a different
 * day, or the same one revisited) showed the pulse all over again,
 * repeatably, contradicting this hook's own "shown once, ever" contract.
 * The effect fires synchronously on commit, before the browser can
 * dispatch any user event (a tap, or a click that would unmount this
 * component by switching days) -- so by the time either could happen,
 * the dismissal is already durable regardless of what happens to this
 * particular mount afterward.
 */
export function useChartTapHint(): [boolean, () => void] {
  const [show, setShow] = useState(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return false;
    }
    if (prefersReducedMotion() || isChartTapHintDismissed()) {
      return false;
    }
    return window.matchMedia("(pointer: coarse)").matches;
  });

  useEffect(() => {
    if (show) {
      dismissChartTapHint();
    }
    // Mount-only: `show` is only ever set once, by the initializer above
    // -- there's no later render where this should re-fire.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally mount-only, see comment above
  }, []);

  function dismiss(): void {
    setShow(false);
  }

  return [show, dismiss];
}
