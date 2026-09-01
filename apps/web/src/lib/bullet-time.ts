// Bullet Time (issue #224) -- the pure engine behind Beat the Bench's one
// forced-decision moment per session. No React, no storage: the trigger
// schedule, the phase/pacing derivation, and live call resolution are all
// unit-testable against a real (or synthetic) bar array with nothing
// mounted.
//
// Genuinely additive to `beat-the-bench.ts` (issue #131) -- reuses its
// exact same all-in/all-out `Holding`/`Position` model and
// `positionAfterBar` unchanged (see the design review's own "Engine
// changes needed: None to settlement math" comparison row, linked from
// issue #224). This module only decides *when* the game asks the player
// to commit, and grades the call once it resolves; it never touches a
// balance.
//
// The mechanic, stated once here:
//
//   - Up to BULLET_TIME_MAX_EVENTS swings are scheduled once, up front,
//     from the full known bar array (this is a replay of a real closed
//     session -- the whole thing is already known, so there's no live
//     prediction to do). A session with no swing large enough to qualify
//     simply never schedules one; that's a real, valid outcome.
//   - A scheduled event has three phases as playback reaches it:
//     "approaching" (a few bars of dramatic slow-motion before the
//     swing's own start), "deciding" (playback pauses at the swing's own
//     first bar; the player has a visible window to choose "Ride it
//     out" or "Step aside," mapped onto the existing toggle -- no
//     decision locks to whatever they're already holding, a real no-op,
//     never a penalty), and "catchup" (a brisk pace through the swing's
//     own bars once the window closes).
//   - The call resolves live, the instant the swing's own end bar is
//     reached: whichever position the player is actually holding then is
//     compared against which side of the swing was actually profitable.

import type { SessionBar } from "@hadiknowntrades/core";

import { biggestSwings, type SessionSwing } from "./beat-the-bench-moves";
import { formatSessionPercent } from "./format-currency";
import { formatTime } from "./format-date";
import {
  positionAfterBar,
  tickIntervalMs,
  type PlaybackSpeed,
  type Position,
} from "./beat-the-bench";

/**
 * Minimum `|returnFraction|` a swing must clear to be Bullet-Time-worthy.
 *
 * **Validated against a real 41-session pool** (a real local pipeline
 * run's own Beat the Bench mystery pool, issue #127 -- 78-79-bar regular
 * SPY sessions, no synthetic data): each session's own single biggest
 * swing (in either direction) ranged from 0.215% to 1.757%, median
 * 0.483%. At 0.30%, 37 of the 41 real sessions (90%) have at least one
 * qualifying swing with enough lead room -- a real, common occasion, not
 * a rare one -- while the remaining ~10% genuinely have nothing large
 * enough, exactly the "a session with no swing large enough simply never
 * triggers one" case this module's own scheduler treats as valid rather
 * than worked around. A lower threshold (e.g. 0.15-0.20%) pushed the
 * qualifying rate to ~95-100% of sessions, which stopped reading as "a
 * real occasion" at all -- see `BULLET_TIME_MAX_EVENTS`'s own doc
 * comment for the other half of that same "occasion, not constant
 * interruption" reasoning.
 */
export const BULLET_TIME_MIN_SWING_MAGNITUDE = 0.003;

/**
 * At most this many Bullet Time events per session -- deliberately low
 * (the design review's own "Risks" note) so this stays a real occasion
 * rather than constant interruption. Against the same real 41-session
 * pool: 20 of 41 sessions (49%) qualify for 2 events at the thresholds
 * above; the rest get 0 or 1. Average 1.39 events per session across the
 * whole pool.
 */
export const BULLET_TIME_MAX_EVENTS = 2;

/**
 * How many bars before a qualifying swing's own start index the approach
 * begins. Two bars, not the design doc's own illustrative "one bar ahead"
 * (that storyboard was walking one specific real session for narrative
 * purposes, not dictating the constant) -- enough for the slow-motion
 * pace below to actually read as a build-up rather than a single slowed
 * tick, while keeping the worst-case timing overhead (see
 * `BULLET_TIME_APPROACH_TICK_MS`) inside a real, checked budget.
 */
export const BULLET_TIME_LEAD_BARS = 2;

/**
 * Minimum bar-index gap required between two scheduled events' own
 * trigger points, so two events can never crowd into the same stretch of
 * a session. `biggestSwings` already guarantees its returned swings
 * never share a bar *interval* with each other (see that function's own
 * doc comment), but two adjacent, non-overlapping swings could still
 * have trigger points close enough together to feel like one long,
 * un-breathable event rather than two distinct occasions -- this is the
 * extra buffer that prevents that.
 */
export const BULLET_TIME_MIN_TRIGGER_GAP_BARS = 6;

/**
 * How many of the session's biggest swings the scheduler considers
 * before filtering by magnitude/lead-room/gap -- generous enough that
 * losing a couple of candidates to insufficient lead room or a gap
 * conflict still leaves real ones to pick from.
 */
const CANDIDATE_COUNT = 5;

/**
 * Milliseconds per bar during the approach -- its own constant, not
 * derived from `PLAYBACK_SPEEDS` (per issue #224's own scope), and
 * deliberately slower than even the slowest existing speed option (0.1x
 * = `tickIntervalMs(0.1)` = 3000ms/bar): 4500ms is 50% slower again, a
 * real, noticeable step down from the app's own most patient existing
 * pace, not just a marginal one.
 *
 * **Validated against real session data for its actual time cost, not
 * just chosen in isolation.** Against the real 41-session pool, at
 * `BULLET_TIME_LEAD_BARS = 2`: the worst real case (a session that
 * schedules the maximum 2 events) adds 20.45s of total wall-clock time
 * at 1x speed on top of that session's own ~23.4s base length --
 * pushing a full playthrough to ~43.9s, a real but bounded cost for what
 * the design review calls this mechanic's own "central dramatic beat."
 * The median real triggering session adds 17.6s. See
 * `BULLET_TIME_CATCHUP_TICK_MS`'s own doc comment for how the catch-up
 * pace claws some of this back rather than letting every phase add pure
 * overhead.
 */
export const BULLET_TIME_APPROACH_TICK_MS = 4500;

/**
 * Milliseconds the decision window stays open before locking to
 * whatever position the player is already holding -- a real, honest
 * no-op (matches this app's own "no fees, no slippage" copy), never a
 * penalty. Long enough to read a two-choice prompt and act (four
 * seconds, comfortably inside typical human reaction-plus-decision time
 * for a binary choice), short enough that the mechanic doesn't stall the
 * session -- factored into the worst-case timing measurement above.
 */
export const BULLET_TIME_DECISION_WINDOW_MS = 4000;

/**
 * Milliseconds per bar while catching the flagged swing's own bars up
 * once the decision window closes -- faster than 1x's own 300ms/bar, so
 * this phase claws back some of the approach's added time rather than
 * letting every phase compound into pure overhead. A real, deliberately
 * brisk "the moment is happening now" pace, not a return to the
 * player's own chosen speed (which only resumes once the swing's own
 * end bar is reached) -- see `bulletTimeTickIntervalMs`.
 */
export const BULLET_TIME_CATCHUP_TICK_MS = 150;

/**
 * How many bars past a resolved event's own `swing.toIndex` the caller
 * should keep its "Called it"/"Not this time" badge on screen, purely as
 * a bar count rather than a wall-clock timer -- deliberately so the
 * badge needs no state or timer of its own: whether to show it is a
 * plain derived comparison against the current `barIndex`, the same
 * "compute it, don't store it" posture `bulletTimeStatusAt` already
 * takes for phase itself. A short window (a few bars) rather than a
 * fixed number of seconds means the badge naturally lingers longer at a
 * slower chosen speed and shorter at a faster one, which is the right
 * behavior either way -- it's meant to be legible at whatever pace the
 * player is actually watching, not to hold the screen for some fixed
 * real-time duration regardless of it.
 */
export const BULLET_TIME_BADGE_LINGER_BARS = 3;

/** One scheduled Bullet Time occasion. */
export interface BulletTimeEvent {
  /** The bar index at which slow-motion playback begins -- `swing.fromIndex - BULLET_TIME_LEAD_BARS`, always >= 0 (a swing without enough lead room is filtered out before scheduling, never clamped). */
  triggerIndex: number;
  /** The real swing this event was scheduled against -- see `beat-the-bench-moves.ts`'s `SessionSwing`. */
  swing: SessionSwing;
}

/**
 * Schedules up to `BULLET_TIME_MAX_EVENTS` Bullet Time events from the
 * full known bar array, once, up front -- this is a replay of a real
 * closed session, so the whole thing is already known and there is
 * nothing to predict live. Greedy by swing magnitude (the biggest
 * qualifying swing is always considered first): a candidate is skipped
 * if it doesn't have `BULLET_TIME_LEAD_BARS` of room before its own
 * start, or if its trigger point falls within
 * `BULLET_TIME_MIN_TRIGGER_GAP_BARS` of an already-scheduled one.
 *
 * Returns events in **chronological** order (ascending `triggerIndex`),
 * not by magnitude -- the shape a caller actually walks a session with.
 * Returns `[]` when nothing in the session qualifies -- a real, valid
 * outcome (see `BULLET_TIME_MIN_SWING_MAGNITUDE`'s own doc comment), not
 * a bug to work around.
 */
export function scheduleBulletTimeEvents(bars: readonly SessionBar[]): BulletTimeEvent[] {
  const candidates = biggestSwings(bars, CANDIDATE_COUNT).filter(
    (swing) =>
      Math.abs(swing.returnFraction) >= BULLET_TIME_MIN_SWING_MAGNITUDE &&
      swing.fromIndex >= BULLET_TIME_LEAD_BARS,
  );

  const events: BulletTimeEvent[] = [];
  for (const swing of candidates) {
    const triggerIndex = swing.fromIndex - BULLET_TIME_LEAD_BARS;
    const tooClose = events.some(
      (event) => Math.abs(triggerIndex - event.triggerIndex) < BULLET_TIME_MIN_TRIGGER_GAP_BARS,
    );
    if (tooClose) continue;
    events.push({ triggerIndex, swing });
    if (events.length >= BULLET_TIME_MAX_EVENTS) break;
  }

  return events.sort((a, b) => a.triggerIndex - b.triggerIndex);
}

/** Which stretch of a Bullet Time event the session is currently in, or `"none"` between events. */
export type BulletTimePhase = "none" | "approaching" | "deciding" | "catchup";

export interface BulletTimeStatus {
  phase: BulletTimePhase;
  /** The event currently governing `phase` -- `null` exactly when `phase === "none"`. */
  event: BulletTimeEvent | null;
  /** `events`' own index of `event`, or `-1` when `phase === "none"` -- lets a caller key/look up without a second scan. */
  eventIndex: number;
}

/**
 * Derives the current Bullet Time phase from `barIndex` alone -- no
 * separate state to keep in sync. An event governs every bar from its
 * own `triggerIndex` through (but not including) its swing's own
 * `toIndex`; at `toIndex` itself the event has resolved (see
 * `evaluateBulletTimeCall`) and `phase` is back to `"none"`, even though
 * a caller may still want to show a lingering "Called it"/"Not this
 * time" badge for a few more bars -- that's a presentation choice for
 * the caller, not this function's concern.
 */
export function bulletTimeStatusAt(
  events: readonly BulletTimeEvent[],
  barIndex: number,
): BulletTimeStatus {
  const eventIndex = events.findIndex(
    (event) => barIndex >= event.triggerIndex && barIndex < event.swing.toIndex,
  );
  if (eventIndex === -1) return { phase: "none", event: null, eventIndex: -1 };
  const event = events[eventIndex]!;
  const phase: BulletTimePhase =
    barIndex < event.swing.fromIndex
      ? "approaching"
      : barIndex === event.swing.fromIndex
        ? "deciding"
        : "catchup";
  return { phase, event, eventIndex };
}

/**
 * How long the current bar should stay on screen, given Bullet Time's
 * own phase -- the one thing a caller's tick interval needs, decided in
 * one place so its own effect doesn't have to re-derive the branching.
 *
 * **Reduced motion always falls back to the player's own chosen
 * speed, for every phase** -- issue #224's own scope: no slow-motion
 * animation. `"deciding"` never reaches this function in the first
 * place under normal use (a caller should pause ticking entirely while
 * deciding, per `BulletTimePhase`'s own doc comment) -- it's handled
 * here anyway, falling back the same way, so this function has no
 * silently-wrong answer for a phase a caller might still pass it.
 */
export function bulletTimeTickIntervalMs(
  phase: BulletTimePhase,
  speed: PlaybackSpeed,
  reducedMotion: boolean,
): number {
  if (!reducedMotion) {
    if (phase === "approaching") return BULLET_TIME_APPROACH_TICK_MS;
    if (phase === "catchup") return BULLET_TIME_CATCHUP_TICK_MS;
  }
  return tickIntervalMs(speed);
}

/** How a resolved Bullet Time call came out. */
export type BulletTimeCallResult = "correct" | "incorrect";

/**
 * Resolves a Bullet Time call live, the instant the flagged swing's own
 * end bar is reached: whether the player's resulting position (in the
 * market vs. cash) was the side that was actually profitable. Derivable
 * entirely from the existing bar prices (`swing.returnFraction`'s own
 * sign) -- no new side-channel, no player-specific bookkeeping beyond
 * the position itself.
 */
export function evaluateBulletTimeCall(
  position: Position,
  swing: SessionSwing,
): BulletTimeCallResult {
  const profitableToHold = swing.returnFraction > 0;
  const wasHolding = position === "holding";
  return wasHolding === profitableToHold ? "correct" : "incorrect";
}

/**
 * Every scheduled event's own resolved call, derived purely from
 * `moves` and the events' own `swing.toIndex` -- safe to call
 * unconditionally once a session has settled (every event's own
 * `toIndex` is, by construction, `<= bars.length - 1`, so it's always
 * reachable by the time the session's own last bar is). This is what
 * feeds the settlement's "Bullet Time calls: N of M correct" line.
 */
export function resolvedBulletTimeCalls(
  events: readonly BulletTimeEvent[],
  moveBarIndexes: readonly number[],
): BulletTimeCallResult[] {
  return events.map((event) =>
    evaluateBulletTimeCall(positionAfterBar(moveBarIndexes, event.swing.toIndex), event.swing),
  );
}

/** The settlement's one-line Bullet Time tally, or `null` for a session that never scheduled one -- omitted rather than a misleading "0 of 0 correct". */
export function bulletTimeTallyLine(results: readonly BulletTimeCallResult[]): string | null {
  if (results.length === 0) return null;
  const correct = results.filter((result) => result === "correct").length;
  return `Bullet Time calls: ${correct} of ${results.length} correct.`;
}

/**
 * The live resolution sentence shown right where the call happened --
 * earnest either way, per this app's own "never a scold" register (see
 * `beat-the-bench.ts`'s `outcomeDetail`'s own note). A correct call
 * doesn't crow, and an incorrect one doesn't apologize; both simply
 * state what the swing did.
 */
export function bulletTimeCallSentence(result: BulletTimeCallResult, swing: SessionSwing): string {
  const span = `${formatTime(swing.fromTime)} to ${formatTime(swing.toTime)}`;
  const magnitude = formatSessionPercent(swing.returnFraction);
  if (result === "correct") {
    return `Called it -- the swing from ${span} moved ${magnitude}, and you were positioned for it.`;
  }
  return `Not this time -- the swing from ${span} moved ${magnitude} while you were positioned the other way.`;
}
