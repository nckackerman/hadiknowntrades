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
 * Whether bar-interval `[aFrom, aTo)` and `[bFrom, bTo)` come within
 * `gap` bars of each other -- `gap = 0` (the default) is exact interval
 * overlap, the same check `findBestRuns` uses inline to keep its own
 * picks from sharing a bar. Exported so a caller scheduling something
 * *around* a run -- Bullet Time's own trigger scheduler
 * (`bullet-time.ts`), which needs two events' whole active windows kept
 * `BULLET_TIME_MIN_TRIGGER_GAP_BARS` apart, not just their own trigger
 * points -- can reuse the identical primitive instead of writing a
 * second, differently-shaped "close enough to conflict" check.
 */
export function intervalsWithinGap(
  aFrom: number,
  aTo: number,
  bFrom: number,
  bTo: number,
  gap = 0,
): boolean {
  return aFrom < bTo + gap && bFrom < aTo + gap;
}

/**
 * The shared shape `topUpMoves` and `biggestSwings` each build their own
 * return objects from -- one place computing `fromTime`/`toTime` off
 * `bars` so the two can't quietly disagree about how a run's own time
 * span is read from the same array.
 */
function runFields(
  bars: readonly SessionBar[],
  run: { from: number; to: number; returnFraction: number },
): {
  fromIndex: number;
  toIndex: number;
  fromTime: string;
  toTime: string;
  returnFraction: number;
} {
  return {
    fromIndex: run.from,
    toIndex: run.to,
    fromTime: bars[run.from]!.time,
    toTime: bars[run.to]!.time,
    returnFraction: run.returnFraction,
  };
}

/**
 * The greedy window-search shared by `topUpMoves` and `biggestSwings`
 * (issue #224): take the single best-scoring `(from, to)` run in the
 * session, then the best-scoring run that doesn't overlap it, and so on,
 * until `count` picks are made or none qualify.
 *
 * `score` is what "best" means to the caller -- `topUpMoves` scores an
 * up-move by its own `returnFraction` (so a bigger gain always beats a
 * smaller one, and a flat/down move is disqualified via `null`);
 * `biggestSwings` scores by `Math.abs(returnFraction)` instead, so the
 * single biggest move in *either* direction wins regardless of sign.
 * Both are genuinely greedy rather than optimal (packages/core's
 * optimizer runs a real DP for the equivalent whole-window question),
 * and that is the right call for both callers: neither's claim is "here
 * is the best possible sequence", only "here are some of the day's
 * biggest runs" -- the greedy pick is what actually answers that
 * question, since the single biggest run in the day is always in the
 * result, where a maximum-total DP could drop it in favour of several
 * merely-good ones.
 *
 * Cost is `O(n^2)` per pick over a session of at most ~79 bars (~3k
 * pairs), i.e. nothing, and both callers run it once, either at
 * settlement (`topUpMoves`) or once up front from the full known bar
 * array (`biggestSwings`, scheduling Bullet Time before playback even
 * starts -- see `bullet-time.ts`).
 *
 * Overlap is treated as sharing any bar *interval*, not any bar index:
 * one run ending exactly where the next begins is two distinct runs
 * (you'd have sold and re-bought, or reversed, at that price), which is
 * how the real game's own toggles work too.
 */
function findBestRuns(
  bars: readonly SessionBar[],
  count: number,
  score: (returnFraction: number) => number | null,
): { from: number; to: number; returnFraction: number }[] {
  if (bars.length < 2) return [];

  // At least one bar interval, so a very short session still reports
  // something rather than nothing.
  const maxSpan = Math.max(1, Math.floor((bars.length - 1) * MAX_MOVE_SPAN_FRACTION));
  const taken: { from: number; to: number }[] = [];
  const runs: { from: number; to: number; returnFraction: number }[] = [];

  for (let pick = 0; pick < count; pick += 1) {
    let best: { from: number; to: number; returnFraction: number; score: number } | null = null;

    for (let from = 0; from < bars.length - 1; from += 1) {
      for (let to = from + 1; to <= Math.min(from + maxSpan, bars.length - 1); to += 1) {
        if (taken.some((range) => intervalsWithinGap(from, to, range.from, range.to))) continue;
        const returnFraction = bars[to]!.close / bars[from]!.close - 1;
        const runScore = score(returnFraction);
        if (runScore === null) continue;
        if (best === null || runScore > best.score) {
          best = { from, to, returnFraction, score: runScore };
        }
      }
    }

    if (best === null) break;
    taken.push({ from: best.from, to: best.to });
    runs.push({ from: best.from, to: best.to, returnFraction: best.returnFraction });
  }

  return runs;
}

/**
 * The session's best `count` non-overlapping up-moves, descending by
 * return. See `findBestRuns` for the shared search this builds on.
 */
export function topUpMoves(
  bars: readonly SessionBar[],
  moveBarIndexes: readonly number[],
  capital: number,
  count: number = TOP_MOVE_COUNT,
): SessionMove[] {
  const runs = findBestRuns(bars, count, (returnFraction) =>
    returnFraction > 0 ? returnFraction : null,
  );
  return runs.map((run) => ({
    ...runFields(bars, run),
    benchmarkDollars: benchmarkDollarsFor(bars, capital, run.from, run.returnFraction),
    playerHeld: heldThroughout(moveBarIndexes, run.from, run.to),
  }));
}

/**
 * One of the session's biggest price swings, in *either* direction --
 * `biggestSwings`' own return shape. Unlike `SessionMove`, this carries
 * no player-dependent fields (`playerHeld`/`benchmarkDollars`): Bullet
 * Time's trigger scheduler (see `bullet-time.ts`) runs once, up front,
 * from the full known bar array, before any moves exist to compare
 * against.
 */
export interface SessionSwing {
  /** Index of the bar the swing starts from. */
  fromIndex: number;
  /** Index of the bar the swing ends at. */
  toIndex: number;
  fromTime: string;
  toTime: string;
  /**
   * `close[toIndex] / close[fromIndex] - 1`, **signed**: positive for an
   * up-swing, negative for a down-swing. Never zero -- see `findBestRuns`'
   * `score` callback below, which disqualifies a flat run the same way
   * `topUpMoves` disqualifies a non-positive one.
   */
  returnFraction: number;
}

/**
 * The session's biggest `count` non-overlapping price swings, in either
 * direction, descending by magnitude -- the direction-agnostic sibling
 * `topUpMoves` doesn't provide, needed by Bullet Time (issue #224) to
 * schedule its trigger against a real up-or-down move rather than only
 * ever an up-move. Same underlying window search as `topUpMoves` (see
 * `findBestRuns`), just scored by `Math.abs(returnFraction)` instead of
 * `returnFraction` itself, so the single biggest move in the session --
 * whichever way it broke -- always wins the first pick.
 */
export function biggestSwings(
  bars: readonly SessionBar[],
  count: number = TOP_MOVE_COUNT,
): SessionSwing[] {
  const runs = findBestRuns(bars, count, (returnFraction) =>
    returnFraction === 0 ? null : Math.abs(returnFraction),
  );
  return runs.map((run) => runFields(bars, run));
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
