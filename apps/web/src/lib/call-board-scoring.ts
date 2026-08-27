// The Call Board's pure scoring/resolution engine (issue #128): what the
// four buckets are, what a pick is worth once a day closes, how a stored
// pick turns into a resolved call against real SPY daily closes, and how a
// run of resolved calls rolls up into the handful of stats the UI (issue
// #129) shows.
//
// Everything in this file is pure -- no storage, no React, no clock reads
// beyond what a caller passes in -- so all of it is unit-testable without
// mounting anything. The storage layer lives in call-board-storage.ts and
// the calendar/market-open approximation in market-calendar.ts.

import { isValidPrice, type DailyClose } from "@hadiknowntrades/core";

import { exchangeClock, isPickEditable, tradingDaysFrom } from "./market-calendar";

/**
 * The four things a viewer can call for a coming trading day, from most
 * bullish to most bearish. "Strong" is the confidence half of the call;
 * up/down is the direction half (see `bucketDirection`), and the scoring
 * below rewards those two independently.
 */
export type CallBucket = "up-strong" | "up" | "down" | "down-strong";

/** Every bucket, in display order (most bullish first). */
export const CALL_BUCKETS: readonly CallBucket[] = ["up-strong", "up", "down", "down-strong"];

/**
 * The daily-move size that separates a "strong" call from an ordinary one:
 * +/-0.5%.
 *
 * **This is a first-pass value, NOT derived from SPY's real volatility
 * distribution.** It was picked because it reads as a round, intuitive
 * number for a viewer, not because it splits real trading days into
 * balanced buckets -- nobody has fitted it to SPY's actual daily-return
 * distribution, and it is very likely undertuned. (For what it's worth, the
 * 62 real trading days in test-fixtures/spy-daily-closes.ts happen to split
 * 16/16/16/14 across the four buckets at this threshold, but a single
 * quarter of one index is not a calibration.) Retuning it is a real,
 * deliberately-deferred follow-up -- as is the confidence-weighted,
 * volatility-priced scoring issue #128 explicitly put out of scope.
 */
export const STRONG_MOVE_THRESHOLD = 0.005;

/** The most not-yet-started trading days a viewer can hold open calls on at once. */
export const MAX_OPEN_CALLS = 3;

/** What one resolved call is worth: 2 for an exact bucket match, 1 for the right direction at the wrong confidence, 0 for the wrong direction. */
export type CallScore = 0 | 1 | 2;

/** A call counts as a win at 1 point or better, i.e. whenever the direction was right. */
export const WINNING_SCORE: CallScore = 1;

/** A day's fractional close-to-close move, e.g. 0.0123 for +1.23%. */
export function dailyMoveFraction(previousClose: number, close: number): number {
  return close / previousClose - 1;
}

/** Which bucket a real daily move lands in. A dead-flat day (exactly 0.0%) counts as "up" -- an arbitrary but fixed tie-break, so a scorer never has to represent a fifth "unchanged" outcome. */
export function bucketForMove(moveFraction: number): CallBucket {
  if (moveFraction >= STRONG_MOVE_THRESHOLD) return "up-strong";
  if (moveFraction >= 0) return "up";
  if (moveFraction > -STRONG_MOVE_THRESHOLD) return "down";
  return "down-strong";
}

/** The direction half of a bucket, ignoring confidence. */
export function bucketDirection(bucket: CallBucket): "up" | "down" {
  return bucket === "up-strong" || bucket === "up" ? "up" : "down";
}

/**
 * What `pick` scores against a day that actually landed in `actual`:
 * 2 for an exact bucket match, 1 for the right direction but the wrong
 * confidence, 0 for the wrong direction (at either confidence).
 */
export function scoreCall(pick: CallBucket, actual: CallBucket): CallScore {
  if (pick === actual) return 2;
  return bucketDirection(pick) === bucketDirection(actual) ? 1 : 0;
}

/** One call the viewer made that has since been settled by a real closing price. */
export interface ResolvedCall {
  /** The trading day called, YYYY-MM-DD. */
  date: string;
  /** What the viewer called before that day opened. */
  pick: CallBucket;
  /** What the day actually did, per its real close-to-close move. */
  actual: CallBucket;
  /** That day's fractional move, kept so the UI can show the real number rather than only the bucket. */
  moveFraction: number;
  score: CallScore;
}

/** The rolled-up record the UI shows next to the board. */
export interface CallBoardStats {
  /** How many calls have been settled. */
  resolvedCalls: number;
  /** How many of those scored at least `WINNING_SCORE`. */
  wins: number;
  /**
   * Wins as a fraction of resolved calls (0-1), or `null` when nothing has
   * resolved yet. **Deliberately the only success percentage this engine
   * computes** -- a second, points-based percentage (points earned over
   * points available) would be a different number for the same history, and
   * two disagreeing "how am I doing" figures on one board is worse than one
   * simpler one. Total points are still available as a raw count via
   * `totalPoints`; they're just never turned into a competing rate.
   */
  winRate: number | null;
  /** Every point scored across `resolvedCalls`, for a raw score display. */
  totalPoints: number;
  /** Wins in the most recent unbroken run, counting back from the newest resolved call. */
  currentStreak: number;
  /** The longest such run anywhere in the resolved history. */
  bestStreak: number;
}

/** Stats for a history with nothing resolved yet. */
const EMPTY_STATS: CallBoardStats = {
  resolvedCalls: 0,
  wins: 0,
  winRate: null,
  totalPoints: 0,
  currentStreak: 0,
  bestStreak: 0,
};

/**
 * Rolls a resolved history (ascending by date, as every producer in this
 * module returns it) up into the board's stats. Pure: the same history
 * always produces the same stats, so nothing needs to persist them.
 */
export function computeCallBoardStats(resolved: readonly ResolvedCall[]): CallBoardStats {
  if (resolved.length === 0) return EMPTY_STATS;

  let wins = 0;
  let totalPoints = 0;
  let currentStreak = 0;
  let bestStreak = 0;
  for (const call of resolved) {
    totalPoints += call.score;
    if (call.score >= WINNING_SCORE) {
      wins += 1;
      currentStreak += 1;
      if (currentStreak > bestStreak) bestStreak = currentStreak;
    } else {
      currentStreak = 0;
    }
  }

  return {
    resolvedCalls: resolved.length,
    wins,
    winRate: wins / resolved.length,
    totalPoints,
    currentStreak,
    bestStreak,
  };
}

/**
 * A close is only usable as a scoring input if it's a real, positive price.
 * Delegates to packages/core's own `isValidPrice` rather than re-deriving
 * `Number.isFinite(v) && v > 0` here -- that module exists precisely so this
 * predicate can't drift between call sites (see its own doc comment, and
 * packages/core/CLAUDE.md's note about a validator that had quietly
 * re-implemented it a third time).
 */
function isUsableClose(close: unknown): close is number {
  return typeof close === "number" && isValidPrice(close);
}

/**
 * Settles every pick that a real closing price now covers.
 *
 * `closes` is a real SPY daily-close series -- in the shipped app, a
 * PrecomputedResult's `benchmarkSeries.closes` (issue #126), which is
 * ascending by date, strictly deduplicated, and holds only real trading
 * days. This function re-sorts a copy anyway rather than trusting that
 * contract, since a resolved score is the one thing here a viewer can't
 * re-derive for themselves if it's silently wrong.
 *
 * A day resolves only when the series holds both that day's close and the
 * previous trading day's, since the move is close-to-close. The first entry
 * in the window therefore never resolves (there's no prior close to measure
 * it against) -- which is correct rather than lossy: any pick that old has
 * already been resolved and persisted once, back when the window still
 * reached far enough to cover it.
 */
export function resolveCalls(
  closes: readonly DailyClose[],
  picks: Readonly<Record<string, CallBucket>>,
): ResolvedCall[] {
  const usable = closes
    .filter((entry) => isUsableClose(entry.close))
    .slice()
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const resolved: ResolvedCall[] = [];
  for (let i = 1; i < usable.length; i += 1) {
    const day = usable[i]!;
    const pick = picks[day.date];
    if (pick === undefined) continue;
    const moveFraction = dailyMoveFraction(usable[i - 1]!.close, day.close);
    const actual = bucketForMove(moveFraction);
    resolved.push({
      date: day.date,
      pick,
      actual,
      moveFraction,
      score: scoreCall(pick, actual),
    });
  }
  return resolved;
}

/**
 * Folds newly-resolved calls into an existing history: ascending by date,
 * one entry per date, and an already-recorded date keeps its original entry
 * rather than being rewritten.
 *
 * Last-write-*loses* is deliberate. A stored history outlives the trailing
 * ~90-day close window it was resolved from, so a date can legitimately fall
 * out of that window and later reappear in a differently-sliced one; a
 * settled call should never quietly change score because of that.
 */
export function mergeResolvedCalls(
  existing: readonly ResolvedCall[],
  incoming: readonly ResolvedCall[],
): ResolvedCall[] {
  const byDate = new Map<string, ResolvedCall>();
  for (const call of existing) byDate.set(call.date, call);
  for (const call of incoming) {
    if (!byDate.has(call.date)) byDate.set(call.date, call);
  }
  return [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/**
 * The rolling lookahead: at most `MAX_OPEN_CALLS` trading days whose
 * sessions haven't started yet, ascending, per `now`.
 *
 * Today itself is included before its own 9:30 AM open and drops off the
 * front the moment that boundary passes -- which is exactly what makes the
 * board "rolling" with no scheduled job: the window is derived from the
 * clock on every read, never advanced by a stored cursor.
 */
export function upcomingCallDays(now: Date, count: number = MAX_OPEN_CALLS): string[] {
  const today = exchangeClock(now).date;
  // Scan a few more trading days than needed: today (and, right at the
  // boundary, nothing else) can already be locked, so the first candidates
  // may not all survive the editability filter.
  return tradingDaysFrom(today, count + 1)
    .filter((date) => isPickEditable(date, now))
    .slice(0, count);
}
