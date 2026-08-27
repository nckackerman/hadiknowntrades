// The Daily Ritual (issue #133): what "today, so far" actually says, and
// the plain-text recap a finished day can be shared as.
//
// Pure -- no React, no storage, no clipboard. Everything here is a function
// of one `DailyRitualSnapshot`, so the copy can be unit-tested against real
// shapes without mounting anything, and so the rail and the recap can never
// disagree about the same day.
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

/** One day's Beat the Bench record, plus the session date it belongs to. */
export interface RitualBench {
  /** The session's own trading date (not the viewer's calendar day) -- see beat-the-bench-storage.ts. */
  date: string;
  session: PlayedSession;
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

/** How many of the three steps are complete -- the rail's own "N of 3" readout. */
export function stepsDone(snapshot: DailyRitualSnapshot): number {
  return (
    1 + (snapshot.bench === null ? 0 : 1) + (snapshot.calls.filled >= snapshot.calls.total ? 1 : 0)
  );
}

/** The Call Board step's state: every slot called, some called, none called. */
export function callsState(calls: { filled: number; total: number }): RitualStepState {
  if (calls.total > 0 && calls.filled >= calls.total) return "done";
  return calls.filled > 0 ? "partial" : "todo";
}

/**
 * The locked-state copy, before Beat the Bench has been played today.
 *
 * The design artifact's own line was "Play Beat the Bench above to unlock a
 * shareable recap" -- accurate but transactional, in the register of a
 * product telling you to complete a task. This app's voice (see
 * `narrate-trades.ts`, and issue #131's own tone correction for the same
 * mechanic) is second person, earnest and a little wistful: it tells you
 * what would have been, it doesn't instruct you. So the instruction stays
 * (it genuinely has to say what to do) but the reason comes with it, and
 * the sentence is about the day rather than about the button.
 */
export const RECAP_LOCKED_HEADLINE = "Play Beat the Bench above, and the day has a recap.";

/** The quieter second line under `RECAP_LOCKED_HEADLINE`. */
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
  lines.push("", "Hindsight only -- not advice, and not a predictor.");
  return lines.join("\n");
}
