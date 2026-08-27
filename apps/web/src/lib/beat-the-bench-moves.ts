// "What were the session's real best moves, and were you in the market
// for them?" -- the narrative half of Beat the Bench's Final Settlement
// (issue #132).
//
// This is the same hindsight question the rest of the app asks, at
// intraday scale: `topUpMoves` finds the best few non-overlapping
// long trades that were available inside one real session, in exactly
// the "had you known" spirit of packages/core's optimizer (it is a
// greedy pick over every (from, to) pair rather than that module's DP --
// see `topUpMoves`' own note on why that is honest here and cheap).
//
// **Everything in this module is retrospective.** It says nothing about
// what a player should have done, only what the day actually did and
// where they were standing while it did it.

import { balanceAtBar, positionAfterBar } from "./beat-the-bench";
import { formatHeroCurrency, formatSessionPercent } from "./format-currency";
import { formatTime } from "./format-date";
import type { SessionBar } from "@hadiknowntrades/core";

/** How many of the session's best moves the settlement names. Three is enough to characterise a day without turning the settlement into a list. */
export const TOP_MOVE_COUNT = 3;

/**
 * The longest stretch a single reported move may span, as a fraction of
 * the session.
 *
 * **Not cosmetic -- an uncapped search degenerates on exactly the days
 * this analysis is most interesting for.** Measured against the real
 * 2026-08-04 fixture (+1.24% on the day): with no cap, the single best
 * move is bar 0 to bar 74, 09:30 to 15:40, and it overlaps essentially
 * everything else, so the "biggest runs" list comes back with one entry
 * that is just buy-and-hold restated -- which tells a player nothing they
 * aren't already reading two lines above. A third of the session keeps
 * the reported moves to runs that happened *within* the day, which is the
 * thing the settlement is actually asking about ("were you on it?").
 */
export const MAX_MOVE_SPAN_FRACTION = 1 / 3;

export interface SessionMove {
  /** Index of the bar the move starts from -- the price you'd have bought at. */
  fromIndex: number;
  /** Index of the bar the move ends at -- the price you'd have sold at. */
  toIndex: number;
  fromTime: string;
  toTime: string;
  /** `close[toIndex] / close[fromIndex] - 1`, always positive (only up-moves are returned). */
  returnFraction: number;
  /**
   * **An approximation, in benchmark dollars.** See
   * `benchmarkDollarsFor` below for exactly what is and isn't being
   * claimed -- this is not a compounded counterfactual of the player's
   * own portfolio path.
   */
  benchmarkDollars: number;
  /** Whether the player was in the market for the *whole* move, start to finish. A move they were partly out of counts as missed. */
  playerHeld: boolean;
}

/**
 * The dollar figure the settlement puts on one move, and the whole of
 * what it means.
 *
 * **Methodology, exactly as computed:**
 * `benchmarkBalanceAt(fromIndex) * returnFraction`, where
 * `benchmarkBalanceAt(i)` is `balanceAtBar(bars, [], capital, i)` -- i.e.
 * what a buy-and-hold position (the bench) was worth at the bar the move
 * started from, multiplied by the move's own price return. In words: *if
 * you had been holding the bench's position when this move happened, this
 * move would have added this many dollars to it.*
 *
 * **What this is NOT**: it is not what this one move would have added to
 * *the player's* balance, and it is not a counterfactual re-simulation of
 * the player's session with that one decision changed. Both of those
 * would require replaying the whole session from that changed decision
 * onward -- every later move compounds off a different balance, so the
 * effect of "being in for this one move" is not a value any single
 * multiplication can produce. The figures for several missed moves are
 * likewise **not additive into a single "this is what your mistakes
 * cost you" total**, because they would each have compounded into each
 * other.
 *
 * It is stated in benchmark dollars specifically so that it is a
 * well-defined, checkable number about the *session* rather than a
 * fabricated number about the player, and the UI copy that renders it
 * says so in the same breath rather than presenting it as precise.
 */
export function benchmarkDollarsFor(
  bars: readonly SessionBar[],
  capital: number,
  fromIndex: number,
  returnFraction: number,
): number {
  return balanceAtBar(bars, [], capital, fromIndex) * returnFraction;
}

/**
 * The session's best `count` non-overlapping up-moves, descending by
 * return.
 *
 * Greedy over all `(from, to)` pairs: take the single best move in the
 * session, then the best move that doesn't overlap it, and so on. That is
 * genuinely greedy rather than optimal (packages/core's optimizer runs a
 * real DP for the equivalent whole-window question), and that is the
 * right call here for two reasons: the settlement's claim is only ever
 * "here are some of the day's biggest moves", never "here is the best
 * possible three-trade sequence", and the greedy pick is the one that
 * actually answers *that* question -- the biggest single move in the day
 * is always in this list, whereas a maximum-total DP could drop it in
 * favour of three merely-good ones.
 *
 * Cost is `O(n^2)` per pick over a session of at most ~79 bars (~3k
 * pairs), i.e. nothing, and it runs once at settlement.
 *
 * Overlap is treated as sharing any bar *interval*, not any bar index:
 * one move ending exactly where the next begins is two distinct moves
 * (you'd have sold and re-bought at that price), which is how the real
 * game's own toggles work too.
 */
export function topUpMoves(
  bars: readonly SessionBar[],
  moveBarIndexes: readonly number[],
  capital: number,
  count: number = TOP_MOVE_COUNT,
): SessionMove[] {
  if (bars.length < 2) return [];

  // At least one bar interval, so a very short session still reports
  // something rather than nothing.
  const maxSpan = Math.max(1, Math.floor((bars.length - 1) * MAX_MOVE_SPAN_FRACTION));
  const taken: { from: number; to: number }[] = [];
  const moves: SessionMove[] = [];

  for (let pick = 0; pick < count; pick += 1) {
    let best: { from: number; to: number; returnFraction: number } | null = null;

    for (let from = 0; from < bars.length - 1; from += 1) {
      for (let to = from + 1; to <= Math.min(from + maxSpan, bars.length - 1); to += 1) {
        if (taken.some((range) => from < range.to && range.from < to)) continue;
        const returnFraction = bars[to]!.close / bars[from]!.close - 1;
        if (returnFraction <= 0) continue;
        if (best === null || returnFraction > best.returnFraction) {
          best = { from, to, returnFraction };
        }
      }
    }

    if (best === null) break;
    taken.push({ from: best.from, to: best.to });
    moves.push({
      fromIndex: best.from,
      toIndex: best.to,
      fromTime: bars[best.from]!.time,
      toTime: bars[best.to]!.time,
      returnFraction: best.returnFraction,
      benchmarkDollars: benchmarkDollarsFor(bars, capital, best.from, best.returnFraction),
      playerHeld: heldThroughout(moveBarIndexes, best.from, best.to),
    });
  }

  return moves;
}

/**
 * Whether the player was in the market for every bar interval of
 * `[from, to)`.
 *
 * Checked interval by interval rather than just at the endpoints: a
 * player who sold halfway through a rally and bought back before it ended
 * was holding at both ends but genuinely missed part of the move, and
 * calling that "you were in for it" would be flattering rather than
 * honest. The position that matters for the segment leading into bar
 * `i + 1` is the position *after* bar `i` -- the same convention
 * `BeatTheBenchChart`'s own `positionRuns` uses to colour each segment.
 */
export function heldThroughout(
  moveBarIndexes: readonly number[],
  from: number,
  to: number,
): boolean {
  for (let i = from; i < to; i += 1) {
    if (positionAfterBar(moveBarIndexes, i) !== "holding") return false;
  }
  return true;
}

/**
 * The moves in `moves` the player was not fully in the market for.
 * Ordered as `topUpMoves` returned them (biggest first).
 */
export function missedMoves(moves: readonly SessionMove[]): SessionMove[] {
  return moves.filter((move) => !move.playerHeld);
}

/**
 * The settlement's one-line summary of the biggest move the player sat
 * out, or `null` if they were in the market for all of the day's best
 * moves.
 *
 * Deliberately names **one** move rather than summing several: per
 * `benchmarkDollarsFor`'s methodology note, the per-move figures are not
 * additive, so a total would be a number with no defensible meaning. The
 * wording hedges to match ("would have been worth about ... to a
 * buy-and-hold position").
 */
export function biggestMissedMove(moves: readonly SessionMove[]): SessionMove | null {
  return missedMoves(moves)[0] ?? null;
}

/**
 * The settlement's sentence about the biggest move the player sat out,
 * or the one for a player who was in for all of them.
 *
 * **The hedging is load-bearing, not throat-clearing.** "About" and "to a
 * buy-and-hold position" are what keep this sentence true: the figure is
 * `benchmarkDollarsFor`'s benchmark-dollar approximation, not what this
 * move would have added to *this player's* balance, and the copy must not
 * imply otherwise. Same earnest register as `beat-the-bench.ts`'s
 * `outcomeDetail` -- it describes what the day did, it doesn't scold.
 */
export function missedMoveSentence(move: SessionMove | null): string {
  if (move === null) {
    return "You were in the market for every one of the session's biggest runs.";
  }
  // "Not in the market for all of", not "in cash from X to Y": a player
  // who sold halfway through a run and bought back before it ended missed
  // part of it without ever being in cash for the whole stretch, and
  // `heldThroughout` counts that as missed. The sentence has to be true
  // for that player too.
  return (
    `You weren't in the market for all of the run from ${formatTime(move.fromTime)} to ` +
    `${formatTime(move.toTime)}, when the price ran ${formatSessionPercent(move.returnFraction)} ` +
    `-- about ${formatHeroCurrency(move.benchmarkDollars)} to a buy-and-hold position of this size.`
  );
}
