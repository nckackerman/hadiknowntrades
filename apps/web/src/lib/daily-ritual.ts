// The shared done/partial/todo status vocabulary (`STEP_STYLES`) Beat the
// Bench's and The Call Board's own compact tiles render as a small corner
// badge (`STATUS_BADGE_CLASSNAME`). Originally backed a always-visible
// "Today, so far" status rail and a shareable plain-text recap
// (issue #133, condensed by issue #186) -- both removed outright per
// direct user feedback that the recap section added little on top of what
// the two game tiles already show at a glance; only the badge vocabulary
// they share survives.
//
// Pure -- no React, no storage. Everything here is a function of plain
// values, so it stays unit-testable without mounting anything.

/** How many of a step's three states a caller's own badge is in. */
export type RitualStepState = "done" | "partial" | "todo";

/**
 * Glyph + colour for each of a step's three states -- shared by
 * `BeatTheBench.tsx` and `CallBoard.tsx`, which each render this exact
 * done/partial/todo vocabulary as a small at-a-glance corner badge on
 * their own compact tile (see `STATUS_BADGE_CLASSNAME` below).
 *
 * WCAG 1.4.1: a state must be tellable apart without relying on hue
 * alone -- "done"/"partial" each carry a real glyph, not colour only.
 * "todo" renders nothing at all, matching `docs/design/daily-hub-
 * condensed-2026-08`'s own `.status-badge.todo { display: none; }` --
 * there is no glyph to define for it, and a caller should skip
 * rendering the badge entirely for that state rather than rendering an
 * empty circle.
 */
export const STEP_STYLES: Record<RitualStepState, { glyph: string; colorClassName: string }> = {
  // Gold is --accent-reward's documented job (globals.css, issue #121):
  // earned state only. A finished step of the day's ritual is exactly
  // that -- a filled gold circle, not the outlined glyph this vocabulary
  // used back when it drove a rail item instead of a corner badge.
  done: { glyph: "✓", colorClassName: "bg-[var(--accent-reward)] text-[#241a08]" },
  // No glyph of its own: CallBoard.tsx's "partial" badge shows the
  // filled call count instead (matching the design reference), which
  // only that caller can compute -- there's nothing generic to put here.
  partial: { glyph: "", colorClassName: "bg-[var(--surface-2)] text-[var(--text-primary)]" },
  todo: { glyph: "", colorClassName: "" },
};

/**
 * Shared shape for the small at-a-glance corner badge both game tiles
 * render (`BeatTheBench.tsx`'s `CompactCard`, `CallBoard.tsx`'s
 * `CallBoardSummaryRow`) -- absolutely positioned in the tile's own
 * top-right corner, per `docs/design/daily-hub-condensed-2026-08`'s own
 * `.status-badge`. A caller combines this with `STEP_STYLES[state]`'s
 * own `colorClassName` (and, for "done", its `glyph`) on an element
 * whose nearest positioned ancestor is the tile itself -- see each
 * caller's own doc comment for why. Nothing renders for `"todo"` (see
 * `STEP_STYLES`'s own doc comment above).
 */
export const STATUS_BADGE_CLASSNAME =
  "absolute -top-2 -right-2 flex h-7 w-7 items-center justify-center rounded-full border-2 border-[var(--background)] text-sm font-bold";

/**
 * The Call Board step's state: every slot called, some called, none
 * called. What `CallBoard.tsx`'s compact tile computes its own corner
 * status badge from.
 */
export function callsState(calls: { filled: number; total: number }): RitualStepState {
  if (calls.total > 0 && calls.filled >= calls.total) return "done";
  return calls.filled > 0 ? "partial" : "todo";
}
