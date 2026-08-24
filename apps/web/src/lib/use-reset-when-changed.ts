"use client";

import { useState } from "react";

/**
 * Shared implementation of this app's own "track a value during render,
 * and react the instant it changes" idiom -- React's own documented
 * "adjusting state when a prop changes" pattern, which lets a component
 * correct dependent state in the very same render the triggering value
 * changes, rather than paying for an extra render (and tripping
 * `react-hooks/set-state-in-effect`) by doing the correction from inside
 * a `useEffect` body instead.
 *
 * Used independently, by hand, at six sites in this app before being
 * centralized here (code review, issue #96 follow-up round four):
 * `use-results.ts`'s `trackedUrl`, `use-range-guess.ts`'s `tracked`, and
 * `StartingCapitalInput.tsx`'s `trackedValue` (all pre-existing), plus
 * `use-trade-replay.ts`'s `trackedPoints` and `PortfolioChart.tsx`'s
 * `trackedPoints`/`trackedInteractive` pair (both new in issue #96) --
 * each an independent hand-rolled copy of the identical shape, despite
 * several of their own comments explicitly cross-referencing the others
 * by name as precedent for the same pattern.
 *
 * `deps` is compared element-by-element against whatever was last seen,
 * the same way `useEffect`'s own dependency array is (`Object.is`, not a
 * deep-equality check) -- pass every value the caller's `onChange` needs
 * to detect a change in, e.g. `[points, interactive]` for a two-value
 * case. The instant any element differs, `onChange` is called
 * synchronously during render, before this function returns -- any
 * `setState` calls it makes land in the exact same render as the
 * triggering change, batched together with it, so there's no extra
 * render where stale dependent state would otherwise be briefly visible.
 *
 * `onChange` takes no arguments deliberately: the caller already has the
 * new values in scope (they're whatever it just passed as `deps`), so
 * there's nothing this hook could hand back that the caller doesn't
 * already have -- keeping the callback a plain `() => void` avoids an
 * awkward "reconstruct the tuple" step at every call site.
 */
export function useResetWhenChanged(deps: readonly unknown[], onChange: () => void): void {
  const [tracked, setTracked] = useState(deps);
  const changed =
    deps.length !== tracked.length || deps.some((dep, i) => !Object.is(dep, tracked[i]));
  if (changed) {
    setTracked(deps);
    onChange();
  }
}
