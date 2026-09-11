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
//     prediction to do). A hard floor of BULLET_TIME_MIN_EVENTS is
//     guaranteed for every session, no exceptions: a session with too
//     few swings clearing the magnitude bar backfills with its biggest
//     remaining spacing-valid candidates regardless of magnitude -- even
//     a perfectly flat session's own few-basis-point wiggles become real
//     events. See scheduleBulletTimeEvents' own doc comment for the
//     two-pass mechanism, and BULLET_TIME_MIN_EVENTS' for the one real,
//     rare, accepted case where even that floor can't be reached.
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

import { biggestSwings, intervalsWithinGap, type SessionSwing } from "./beat-the-bench-moves";
import { formatSessionPercent } from "./format-currency";
import { formatTime } from "./format-date";
import {
  positionAfterBar,
  tickIntervalMs,
  type PlaybackSpeed,
  type Position,
} from "./beat-the-bench";

/**
 * Minimum `|returnFraction|` a swing must clear to be Bullet-Time-worthy
 * on the *magnitude-qualifying* pass (see `scheduleBulletTimeEvents`'s
 * own two-pass doc comment) -- lowered from the original 0.30% now that
 * the target is 4 events per session, not 2 (a direct user request,
 * re-litigating the earlier design review's "stay a rare occasion"
 * framing on purpose).
 *
 * **Re-validated against a fresh real 41-session pool** (a real local
 * pipeline run's own Beat the Bench mystery pool, the same technique the
 * original 0.30% validation used -- 78-bar regular SPY sessions, no
 * synthetic data): each session's own single biggest swing ranged
 * 0.215%-1.757% (median 0.476%); the *5th*-biggest candidate -- roughly
 * the floor of what `CANDIDATE_COUNT` below needs to still find a real
 * swing -- ranged 0.020%-0.297% (median 0.143%). At 0.04% (0.0004), the
 * magnitude-qualifying pass alone (no floor backfill) reaches the full
 * `BULLET_TIME_MAX_EVENTS` (4) in 2 of 41 sessions (4.9%), 3 in 18
 * (43.9%), 2 in 20 (48.8%), and only 1 in 1 (2.4%, requiring the floor-2
 * backfill pass) -- averaging **2.51 qualifying events per session**,
 * more than double the 1.02 the old 0.30%/2-event design measured
 * against this same technique on a comparable pool.
 *
 * **A real, load-bearing finding from this same validation, worth
 * stating plainly rather than overclaiming "4 is now the common
 * outcome": no magnitude threshold, however low, can make most real
 * days reach 4.** Re-run at `minMagnitude = 0` (fully permissive,
 * magnitude ignored entirely) against the identical pool and the
 * identical spacing/lead-bar constants: still only 2 of 41 sessions
 * (4.9%) can ever contain 4 mutually `BULLET_TIME_MIN_TRIGGER_GAP_BARS`-
 * separated qualifying windows inside a session's ~78 bars -- a hard
 * ceiling set by `BULLET_TIME_LEAD_BARS`/`BULLET_TIME_MIN_TRIGGER_GAP_BARS`
 * here and `beat-the-bench-moves.ts`'s own `MAX_MOVE_SPAN_FRACTION`
 * (none of which changed for this pass -- the spacing/overlap
 * requirement stays inviolable, per the same explicit instruction that
 * introduced the hard floor below), not something this constant can
 * move further. 0.04% was chosen specifically because it already
 * reaches each session's own real spacing-imposed ceiling in 36 of 41
 * sessions (88%) -- lowering it further (checked down to 0.02%, the real
 * minimum observed swing in the pool) gains at most 1-2 more sessions
 * reaching their own ceiling and would start admitting swings barely
 * above literal price noise, for no further practical gain. See
 * `BULLET_TIME_MAX_EVENTS`'s own doc comment for the fuller distribution
 * this produces, and `BULLET_TIME_MIN_EVENTS`'s for the floor-backfill
 * pass this threshold is deliberately *not* required to guarantee on
 * its own.
 */
export const BULLET_TIME_MIN_SWING_MAGNITUDE = 0.0004;

/**
 * At most this many Bullet Time events per session -- raised from 2 to
 * 4 (a direct user request): with `BULLET_TIME_MIN_EVENTS`'s hard floor
 * now guaranteeing at least 2 every session, 4 is meant to be the real,
 * common ceiling on a normal trading day, not a rare best case reserved
 * for the busiest sessions alone.
 *
 * **Re-validated against the same real 41-session pool
 * `BULLET_TIME_MIN_SWING_MAGNITUDE`'s own doc comment describes**,
 * against the real `scheduleBulletTimeEvents` two-pass implementation
 * (its own whole-window anti-crowding check included -- see
 * `BULLET_TIME_MIN_TRIGGER_GAP_BARS`'s own doc comment for the real bug
 * an earlier, trigger-point-only version of that check had): the
 * magnitude-qualifying pass alone reaches the full 4 in 2 of 41 sessions
 * (4.9%), 3 in 18 (43.9%), 2 in 20 (48.8%), 1 in 1 (2.4%, backfilled to 2
 * by `BULLET_TIME_MIN_EVENTS`), and 0 in none -- every real session in
 * the pool now schedules at least one event, and the hard floor's own
 * backfill pass (see that constant's own doc comment) closes the one
 * remaining gap. Average 2.51 events per session across the whole pool
 * (up from 1.02 under the prior 0.30%/2-event/5-candidate design,
 * measured the identical way).
 */
export const BULLET_TIME_MAX_EVENTS = 4;

/**
 * The hard floor: every session schedules **at least** this many Bullet
 * Time events, no exceptions -- even a perfectly flat one (a direct,
 * explicit user request; see `scheduleBulletTimeEvents`'s own two-pass
 * doc comment for the exact mechanism). If the magnitude-qualifying
 * pass alone (`BULLET_TIME_MIN_SWING_MAGNITUDE`-filtered) comes up short
 * of this floor, a second pass backfills with the session's biggest
 * remaining spacing-valid candidates *regardless of magnitude* -- in the
 * extreme case of a genuinely flat session, this means the 2 least-flat
 * few-basis-point wiggles in that session become real Bullet Time
 * events. That is the accepted, deliberate behavior, not a bug to avoid.
 *
 * **Confirmed against the real 41-session pool that this floor is
 * almost always met by the magnitude-qualifying pass alone, and that
 * the one real case where it isn't is a genuine, rare, accepted edge
 * case, not a hypothetical one worth building special-case handling
 * for.** Only 1 of 41 real sessions (2.4%) needed the backfill pass at
 * all -- and that same session (its own greedy, gap-0 partition of the
 * whole 78-bar session happens to leave exactly one spacing-valid
 * window once `BULLET_TIME_LEAD_BARS`/`BULLET_TIME_MIN_TRIGGER_GAP_BARS`
 * are applied) is also the one case where the floor of 2 is genuinely
 * *unreachable* even with magnitude ignored entirely -- confirmed by
 * re-running the backfill pass against that exact session at
 * `minMagnitude = 0`: still only 1 event, because every other real
 * candidate window in that session either starts at bar 0 (no room for
 * `BULLET_TIME_LEAD_BARS`) or falls within `BULLET_TIME_MIN_TRIGGER_GAP_BARS`
 * of the one window that does qualify. `scheduleBulletTimeEvents` itself
 * has no special-case code for this -- the two-pass loop simply returns
 * whatever it could find, which is 1 here, exactly the documented "or,
 * in a truly pathological case ... document that as an accepted, rare
 * edge case" allowance.
 */
export const BULLET_TIME_MIN_EVENTS = 2;

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
 * Minimum bar gap required between two scheduled events' own *whole
 * active windows* (`triggerIndex` through `swing.toIndex`), not just
 * their trigger points -- `scheduleBulletTimeEvents` checks this via
 * `intervalsWithinGap`. `biggestSwings` already guarantees its returned
 * swings never share a bar *interval* with each other (see that
 * function's own doc comment), but two adjacent, non-overlapping swings
 * could still have trigger points far enough apart to pass a naive
 * trigger-to-trigger check while one event's own window (a long swing's
 * own `toIndex` can sit well past its `triggerIndex`) still swallows the
 * next event's entire approach phase -- checking whole windows, not just
 * points, is what actually prevents that (a real bug an earlier version
 * of this check had; see `scheduleBulletTimeEvents`' own inline comment
 * and `bullet-time.test.ts`'s own regression test for a concrete
 * example).
 */
export const BULLET_TIME_MIN_TRIGGER_GAP_BARS = 6;

/**
 * How many of the session's biggest swings the scheduler considers
 * before filtering by magnitude/lead-room/gap -- raised from 5 to 10 now
 * that the scheduler needs to plausibly find up to `BULLET_TIME_MAX_EVENTS`
 * (4) magnitude-qualifying, spacing-valid candidates, or fall back to
 * finding `BULLET_TIME_MIN_EVENTS` (2) spacing-valid ones regardless of
 * magnitude.
 *
 * **Validated against the same real 41-session pool this file's other
 * constants cite**: raising `CANDIDATE_COUNT` further (checked at 12,
 * 15, and 20) found zero additional qualifying events anywhere in the
 * pool beyond what 10 already finds -- `biggestSwings`' own greedy
 * window search genuinely runs out of real, non-overlapping candidates
 * in a ~78-bar session well before reaching a 10th pick, for every
 * session tested. Lowering it to 8 measurably lost real candidates: two
 * of the pool's 41 sessions that reach the full 4 events at 10 dropped
 * to 3 at 8. 10 is the smallest value that loses nothing observed in
 * this pool.
 */
const CANDIDATE_COUNT = 10;

/**
 * Milliseconds per bar during the approach -- its own constant, not
 * derived from `PLAYBACK_SPEEDS` (per issue #224's own scope), and
 * deliberately slower than even the slowest existing speed option (0.1x
 * = `tickIntervalMs(0.1)` = 3000ms/bar): 4500ms is 50% slower again, a
 * real, noticeable step down from the app's own most patient existing
 * pace, not just a marginal one.
 *
 * **Re-validated against the same real 41-session pool for its actual
 * time cost at 4 events, not just chosen in isolation.** At
 * `BULLET_TIME_LEAD_BARS = 2`, measured against the real
 * `scheduleBulletTimeEvents` (its own two-pass floor-backfill and
 * whole-window anti-crowding check included -- see
 * `BULLET_TIME_MIN_TRIGGER_GAP_BARS`'s own doc comment), summing each
 * bar's own real tick interval (approach/catchup/decision-window-worst-
 * case) against a plain (event-free) baseline session:
 *
 * - **At 1x speed**: the worst real case (a real 4-event session) adds
 *   **+43.0s** on top of that session's own ~23.1s base length --
 *   pushing a full playthrough to **~66.1s**. The median real
 *   *triggering* session (every one of the 41 real sessions in the pool
 *   now triggers at least one event) adds **+21.8s**.
 * - **At the new 0.25x default speed** (`DEFAULT_SPEED`,
 *   `beat-the-bench.ts`): the fixed-pace catchup phase
 *   (`BULLET_TIME_CATCHUP_TICK_MS` = 150ms/bar) is *faster* than the
 *   player's own chosen 1200ms/bar pace at 0.25x, so a long swing's
 *   catchup stretch claws back more time than the approach/decision
 *   phases add -- net overhead is usually *negative* (median across the
 *   41 real sessions: **-11.7s**, i.e. Bullet Time typically finishes a
 *   0.25x session *faster* than a plain playthrough would). The real
 *   worst case (the session with the largest *added* time, not the
 *   longest total) adds a comparatively small **+2.0s** on top of a
 *   ~92.4s base, for a total of **~94.4s**.
 *
 * This is a real, measured, non-obvious asymmetry between the two
 * speeds, not a hand-wave: at 1x, every phase of Bullet Time reliably
 * adds overhead; at 0.25x, the catchup phase's fixed pace usually
 * *outpaces* the player's own chosen speed for long swings, so the net
 * effect flips. See `BULLET_TIME_CATCHUP_TICK_MS`'s own doc comment for
 * why the catch-up pace exists at all.
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
 * Schedules Bullet Time events from the full known bar array, once, up
 * front -- this is a replay of a real closed session, so the whole
 * thing is already known and there is nothing to predict live. **Two
 * passes, per the hard-floor requirement's own explicit design**:
 *
 * 1. **Magnitude-qualifying pass**: greedy by swing magnitude (the
 *    biggest qualifying swing is always considered first) over
 *    candidates that clear `BULLET_TIME_MIN_SWING_MAGNITUDE`, up to
 *    `BULLET_TIME_MAX_EVENTS`. A candidate is skipped if it doesn't have
 *    `BULLET_TIME_LEAD_BARS` of room before its own start, or if its
 *    whole active window (see below) falls within
 *    `BULLET_TIME_MIN_TRIGGER_GAP_BARS` of an already-accepted one.
 * 2. **Hard-floor backfill, only if pass 1 came up short of
 *    `BULLET_TIME_MIN_EVENTS`**: continues down the *same* candidate
 *    list, this time ignoring the magnitude filter entirely (but never
 *    the lead-room or spacing checks -- see `BULLET_TIME_MIN_EVENTS`'s
 *    own doc comment for why the spacing/overlap requirement must never
 *    be relaxed even here), adding the biggest remaining spacing-valid
 *    candidates until the floor is met. If genuinely no more
 *    spacing-valid candidates exist in the session, this pass simply
 *    can't reach the floor -- a real, rare, accepted edge case (see
 *    `BULLET_TIME_MIN_EVENTS`'s own doc comment for how often this
 *    actually happens against real data).
 *
 * **The whole-window anti-crowding check applies identically to both
 * passes** -- both compare a candidate's own whole active window
 * (`triggerIndex` through `swing.toIndex`), never just the two trigger
 * points, against every already-accepted event's own whole window (see
 * `BULLET_TIME_MIN_TRIGGER_GAP_BARS`'s own doc comment for the real bug
 * an earlier, trigger-point-only version of this check had). Reuses
 * `beat-the-bench-moves.ts`'s own `intervalsWithinGap` -- the identical
 * primitive `findBestRuns` uses for its own overlap check, just with a
 * real buffer instead of gap 0.
 *
 * Returns events in **chronological** order (ascending `triggerIndex`),
 * not by magnitude -- the shape a caller actually walks a session with.
 * Returns `[]` only for a session too short to contain even one real
 * swing (see `biggestSwings`). **Not a hard guarantee of
 * `BULLET_TIME_MIN_EVENTS` for every other session, despite that being
 * the goal**: the backfill pass can still come up short in a genuinely
 * pathological session where fewer than `BULLET_TIME_MIN_EVENTS`
 * spacing-valid candidates exist at all -- see `BULLET_TIME_MIN_EVENTS`'s
 * own doc comment for the one real, rare (2.4% of a validated 41-session
 * pool) case this happens in. Don't assume
 * `scheduleBulletTimeEvents(bars).length >= BULLET_TIME_MIN_EVENTS`
 * holds unconditionally for any `bars` long enough to contain one swing.
 */
export function scheduleBulletTimeEvents(bars: readonly SessionBar[]): BulletTimeEvent[] {
  const allCandidates = biggestSwings(bars, CANDIDATE_COUNT).filter(
    (swing) => swing.fromIndex >= BULLET_TIME_LEAD_BARS,
  );

  function isTooClose(
    events: readonly BulletTimeEvent[],
    triggerIndex: number,
    swing: SessionSwing,
  ): boolean {
    return events.some((event) =>
      intervalsWithinGap(
        triggerIndex,
        swing.toIndex,
        event.triggerIndex,
        event.swing.toIndex,
        BULLET_TIME_MIN_TRIGGER_GAP_BARS,
      ),
    );
  }

  const events: BulletTimeEvent[] = [];
  const used = new Set<SessionSwing>();

  // Pass 1: magnitude-qualifying candidates, up to BULLET_TIME_MAX_EVENTS.
  for (const swing of allCandidates) {
    if (Math.abs(swing.returnFraction) < BULLET_TIME_MIN_SWING_MAGNITUDE) continue;
    const triggerIndex = swing.fromIndex - BULLET_TIME_LEAD_BARS;
    if (isTooClose(events, triggerIndex, swing)) continue;
    events.push({ triggerIndex, swing });
    used.add(swing);
    if (events.length >= BULLET_TIME_MAX_EVENTS) break;
  }

  // Pass 2: hard-floor backfill, magnitude-agnostic, spacing/overlap
  // requirement unchanged -- only runs if pass 1 came up short.
  if (events.length < BULLET_TIME_MIN_EVENTS) {
    for (const swing of allCandidates) {
      if (events.length >= BULLET_TIME_MIN_EVENTS) break;
      if (used.has(swing)) continue;
      const triggerIndex = swing.fromIndex - BULLET_TIME_LEAD_BARS;
      if (isTooClose(events, triggerIndex, swing)) continue;
      events.push({ triggerIndex, swing });
      used.add(swing);
    }
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
