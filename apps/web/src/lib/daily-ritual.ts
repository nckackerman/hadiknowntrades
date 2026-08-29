// The Daily Ritual (issue #133, condensed by issue #186): the shared
// done/partial/todo status vocabulary (`STEP_STYLES`) both game cards'
// own corner badges now render, and the plain-text recap a finished day
// can be shared as. The always-visible "Today, so far" rail this file's
// snapshot used to drive is gone -- see DailyRitual.tsx's own doc
// comment for what replaced it.
//
// Pure -- no React, no storage, no clipboard. Everything here is a function
// of one `DailyRitualSnapshot`, so the copy can be unit-tested against real
// shapes without mounting anything, and so the two cards' badges and the
// recap can never disagree about the same day.
//
// **The recap is Wordle-shaped, not a data dump.** Two rules decide what
// goes in it, and both are deliberate:
//
//  1. **The hindsight figure is in.** It is the same number issue #134's
//     public OG share card already headlines for anyone with the link, so
//     it is not treated as secret by this app -- and it is the only part of
//     a day here worth handing to someone. What the *sharer* is still
//     protected from is spoiling their own page: the caller passes
//     `headline: null` while this app's one guess-then-reveal gate (issue
//     #91) is unanswered, so the recap can never leak an answer the sharer
//     hasn't looked at yet either.
//  2. **Beat the Bench is reported relative, never absolute.** The session's
//     balances would give away the real trading day's direction and size to
//     a recipient who hasn't played it, and nothing in this app publishes
//     those. A gap ("0.13% ahead") says how the player did while saying
//     nothing at all about what the market did. Same reasoning keeps the
//     Call Board line at "2 of 3 called" rather than naming the buckets.

import { formatDate } from "./format-date";
import { formatHeroCurrency, formatMultiplier } from "./format-currency";
import type { HeadlineFigure } from "./headline-figure";
import type { PlayedSession } from "./beat-the-bench-storage";

/** How many of the rail's three steps are considered done. */
export type RitualStepState = "done" | "partial" | "todo";

/**
 * Glyph + colour for each of a step's three states -- promoted here
 * (issue #186) from `DailyRitual.tsx`'s own private constant, since
 * `BeatTheBench.tsx` and `CallBoard.tsx` now render this exact
 * done/partial/todo vocabulary too, as a small at-a-glance corner badge
 * on their own compact tile (see `STATUS_BADGE_CLASSNAME` below), not
 * just the rail item DailyRitual.tsx itself no longer renders.
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
 * Shared shape for the small at-a-glance corner badge both game cards
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

/** One day's Beat the Bench record, plus the session date it belongs to. */
export interface RitualBench {
  /** The session's own trading date (not the viewer's calendar day) -- see beat-the-bench-storage.ts. */
  date: string;
  session: PlayedSession;
}

/**
 * Today's Order state for the recap line (issue #207) -- `null` means
 * nothing has been submitted yet today, distinct from "played but not
 * solved" (`attemptsUsed > 0`, `solved: false`). Mirrors `RitualBench`'s
 * own shape: the smallest slice of order-storage.ts's own OrderDayState
 * this file's copy actually needs, not the whole stored shape.
 */
export interface RitualOrder {
  attemptsUsed: number;
  maxAttempts: number;
  solved: boolean;
  /** The most exact-matches any single submitted attempt scored -- shown when the day wasn't solved. */
  bestExactCount: number;
  /**
   * Whether today's puzzle is finished -- solved, out of guesses, *or*
   * bailed out via reveal with zero guesses submitted. Distinct from
   * `attemptsUsed === 0` alone: a player can bail out via reveal
   * (use-order-game.ts's own `reveal`) without ever submitting a guess,
   * which also leaves `attemptsUsed` at 0 -- `done` is what tells that
   * apart from "genuinely never opened today" (see orderRecapClause).
   */
  done: boolean;
}

/** Everything the rail renders and the recap is written from, taken against one instant. */
export interface DailyRitualSnapshot {
  /**
   * Always `true`, and deliberately so.
   *
   * Nothing gates the hero reveal for either result model, so the first
   * step of the day is already done the moment someone arrives. That is an
   * **endowed-progress** choice (a ritual that starts at 1 of 3 gets
   * finished far more often than one that starts at 0 of 3), not an
   * oversight or a placeholder for a gate that was removed -- don't "clean
   * it up" by deleting the step.
   */
  heroSeen: true;
  /** Today's played session, or `null` if it hasn't been played (or storage is unavailable). */
  bench: RitualBench | null;
  /** How many of the board's open sessions the viewer has called, and how many there are. */
  calls: { filled: number; total: number };
  /** Today's Order state, or `null` if nothing has been submitted yet today (issue #207). */
  order: RitualOrder | null;
  /**
   * The figure the results page is currently headlining, or `null` when
   * there is none to quote -- the results fetch hasn't landed, the range
   * has no days, or (intraday-daily only) the viewer hasn't cleared issue
   * #91's guess-then-reveal gate yet.
   */
  headline: HeadlineFigure | null;
}

/** Whether the shareable recap is unlocked: Beat the Bench has been played once today. */
export function isRecapUnlocked(snapshot: DailyRitualSnapshot): boolean {
  return snapshot.bench !== null;
}

/**
 * The Call Board step's state: every slot called, some called, none
 * called. Originally the rail's own item state; now also what
 * `CallBoard.tsx`'s compact card computes its own corner status badge
 * from (issue #186) -- the same three-way split, just consumed by a
 * different caller.
 */
export function callsState(calls: { filled: number; total: number }): RitualStepState {
  if (calls.total > 0 && calls.filled >= calls.total) return "done";
  return calls.filled > 0 ? "partial" : "todo";
}

/**
 * The recap disclosure's own locked summary line (issue #186) -- shown
 * collapsed, before Beat the Bench has been played today.
 *
 * Deliberately the design reference's own literal wording
 * (`docs/design/daily-hub-condensed-2026-08`), not this constant's
 * earlier "second person, earnest" rewrite of the same idea (see git
 * history): a one-line disclosure summary has no room for a full
 * sentence explaining *why*, so that explanation moved into the
 * expanded body instead (`RECAP_LOCKED_DETAIL`, unchanged, still in this
 * app's own voice) and the summary itself just states the fact plainly.
 */
export const RECAP_LOCKED_HEADLINE = "Today's recap unlocks after you play Beat the Bench";

/**
 * The recap disclosure's own unlocked summary line (issue #186),
 * matching the design reference verbatim -- shown collapsed, once
 * Beat the Bench has been played today.
 */
export const RECAP_UNLOCKED_HEADLINE = "Today's recap is ready -- Copy";

/** The disclosure body's own explanatory paragraph while locked -- unchanged in substance since before issue #186 moved this from an always-visible panel into a single-line disclosure. */
export const RECAP_LOCKED_DETAIL =
  "It gathers what hindsight would have made, how your session came out, and the calls you've " +
  "made so far -- short enough to paste anywhere.";

/**
 * How far ahead or behind the bench a played session finished, in words --
 * a *relative* phrase only (see this file's own rule 2 above).
 *
 * Mirrors `gapPhrase`'s own thresholds in beat-the-bench.ts, deliberately
 * rather than by calling it: that function writes a full sentence for the
 * settlement card ("0.13% behind the bench."), and this needs a clause that
 * can be dropped into a recap line. Both round to two decimals and both
 * refuse to print a misleading "0.00%", so they can't disagree about
 * whether a gap is real.
 */
export function benchGapClause(session: PlayedSession): string | null {
  const { playerBalance, benchmarkBalance } = session;
  if (playerBalance === benchmarkBalance) return null;
  const gap = playerBalance / benchmarkBalance - 1;
  const magnitude = Math.abs(gap);
  if (magnitude < 0.00005) return "less than 0.01%";
  return `${(magnitude * 100).toFixed(2)}%`;
}

/**
 * The recap's Beat the Bench line, minus its label -- lowercase, so it
 * reads as one sentence after "Beat the Bench: ".
 *
 * A zero-move session gets its own phrasing for the same reason
 * `outcomeHeadline` gives it one: never touching it isn't a coin flip that
 * came up level, it's buy-and-hold, and it ties the bench to the cent by
 * construction.
 */
export function benchRecapClause(session: PlayedSession): string {
  const gap = benchGapClause(session);
  if (session.outcome === "win") return `you beat the bench by ${gap ?? "less than 0.01%"}`;
  if (session.outcome === "loss") {
    return `the bench stayed ahead by ${gap ?? "less than 0.01%"}`;
  }
  return session.moves === 0
    ? "you rode it out, level with the bench to the cent"
    : "dead even with the bench";
}

/** The recap's Call Board line, minus its label. */
export function callsRecapClause(calls: { filled: number; total: number }): string {
  return `${calls.filled} of ${calls.total} upcoming sessions called`;
}

/**
 * The recap's Order line, minus its label -- spec-the-order.md's own
 * proposed copy verbatim ("Recap-line copy proposal"), never leaking a
 * ticker, a real return figure, or the real order itself.
 *
 * **Follows `callsRecapClause`'s always-render shape, not
 * `benchRecapClause`'s whole-recap-blocking one** (per spec-the-order.md's
 * own "Inclusion rule"): `order === null` renders an honest "not played
 * yet today" fallback rather than gating the entire recap on a second
 * required mechanic -- Beat the Bench alone stays the recap's one lock
 * (see isRecapUnlocked above), unchanged by this issue.
 *
 * **`attemptsUsed === 0` alone does NOT mean "not played" -- `done` is
 * what actually distinguishes the two real zero-guess cases.** A player
 * can bail out via reveal (use-order-game.ts's own `reveal`) without
 * ever submitting a guess, leaving `attemptsUsed` at 0 but `done` at
 * `true` -- genuinely different from never having opened the game at
 * all (`order === null`, or `done === false` with zero guesses, e.g.
 * mid-move/shuffle with nothing submitted yet). Checking `done` first is
 * what a real fix here needs; checking `attemptsUsed` alone previously
 * misreported the bailed-out case as unplayed.
 */
export function orderRecapClause(order: RitualOrder | null): string {
  if (order === null) return "not played yet today";
  if (order.attemptsUsed === 0) {
    return order.done ? "revealed without guessing" : "not played yet today";
  }
  return order.solved
    ? `solved in ${order.attemptsUsed} of ${order.maxAttempts}`
    : `${order.bestExactCount} of 5 exact after ${order.attemptsUsed} guesses`;
}

/** The recap's hindsight line, minus its label -- "$20.00 became $2.4K (122x)". */
export function headlineRecapClause(headline: HeadlineFigure): string {
  const multiple = formatMultiplier(headline.endingBalance / headline.startingCapital);
  return `${formatHeroCurrency(headline.startingCapital)} became ${formatHeroCurrency(
    headline.endingBalance,
  )} (${multiple})`;
}

/**
 * The full shareable recap, as plain text.
 *
 * Returns `null` while the recap is locked, so a caller can't accidentally
 * render or copy a half-day. Lines are joined with "\n" and the whole thing
 * is short enough to paste into a message without wrapping into a wall --
 * the hindsight line is omitted entirely (rather than stubbed) when there
 * is no figure to quote, which keeps a recap made during a failed results
 * fetch honest instead of blank-filled.
 */
export function buildRecapText(snapshot: DailyRitualSnapshot): string | null {
  const { bench } = snapshot;
  if (bench === null) return null;

  const lines: string[] = [`Had I Known Trades · ${formatDate(bench.date)}`, ""];
  if (snapshot.headline !== null) {
    lines.push(
      `Hindsight ${snapshot.headline.rangePhrase}: ${headlineRecapClause(snapshot.headline)}`,
    );
  }
  lines.push(`Beat the Bench: ${benchRecapClause(bench.session)}`);
  lines.push(`The Call Board: ${callsRecapClause(snapshot.calls)}`);
  lines.push(`The Order: ${orderRecapClause(snapshot.order)}`);
  lines.push("", "Hindsight only -- not advice, and not a predictor.");
  return lines.join("\n");
}
