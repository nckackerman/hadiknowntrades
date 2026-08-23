"use client";

import { useState } from "react";

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

  function dismiss(): void {
    if (!show) return;
    setShow(false);
    dismissChartTapHint();
  }

  return [show, dismiss];
}
