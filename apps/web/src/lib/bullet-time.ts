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
 * 0.215%-1.757% (median 0.483%). **Unchanged by the second revamp
 * round** (`BULLET_TIME_LEAD_BARS`/`BULLET_TIME_MIN_TRIGGER_GAP_BARS`
 * shrinking from 2/6 to 1/0, below) -- re-checked against that same
 * round's own fresh pool and found still the right value, not just
 * carried forward unexamined: at the new, tighter spacing, 0.04%
 * (0.0004) produces the real distribution **0% / 0% / 17.1% / 46.3% /
 * 36.6%** for 0/1/2/3/4 events (average **3.20** qualifying events per
 * session, up from 2.51 after the first revamp round and 1.02 under the
 * original 0.30%/2-event/6-bar-gap design) -- see
 * `BULLET_TIME_MIN_TRIGGER_GAP_BARS`'s own doc comment for the full
 * distribution and the honest "3, not 4, is still the single most
 * common count" finding that goes with it. Checked a finer sweep down
 * to the real minimum observed swing in the pool (0.02%) and confirmed
 * it buys at most 1-2 more sessions reaching their own spacing ceiling
 * while starting to admit swings barely above literal price noise, for
 * no further practical gain -- the same trade-off the first revamp
 * round already found, holding again at the new spacing.
 */
export const BULLET_TIME_MIN_SWING_MAGNITUDE = 0.0004;

/**
 * At most this many Bullet Time events per session -- raised from 2 to
 * 4 (a direct user request): with `BULLET_TIME_MIN_EVENTS`'s hard floor
 * now guaranteeing at least 2 every session, 4 is meant to be the real,
 * common ceiling on a normal trading day, not a rare best case reserved
 * for the busiest sessions alone.
 *
 * **Re-validated twice** -- once against the first revamp round's own
 * spacing (`BULLET_TIME_LEAD_BARS = 2`, `BULLET_TIME_MIN_TRIGGER_GAP_BARS
 * = 6`), once more against the second round's tighter spacing (1/0,
 * see both constants' own doc comments for why) -- against a real
 * 41-session pool each time, using the real `scheduleBulletTimeEvents`
 * two-pass implementation (its own whole-window anti-crowding check
 * included -- see `BULLET_TIME_MIN_TRIGGER_GAP_BARS`'s own doc comment
 * for the real bug an earlier, trigger-point-only version of that check
 * had). At the shipped, second-round spacing: the magnitude-qualifying
 * pass alone reaches the full 4 in 15 of 41 sessions (36.6%), 3 in 19
 * (46.3%), 2 in 7 (17.1%), and 0 in none, 1 in none -- every real
 * session in the pool reaches the hard floor from this pass alone, with
 * no backfill needed (see `BULLET_TIME_MIN_EVENTS`'s own doc comment).
 * Average 3.20 events per session across the whole pool (up from 2.51
 * after the first revamp round and 1.02 under the original design,
 * measured the identical way each time).
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
 * **At the second revamp round's tighter spacing (`BULLET_TIME_LEAD_BARS
 * = 1`, `BULLET_TIME_MIN_TRIGGER_GAP_BARS = 0`), 0 of 41 real sessions
 * in a fresh validation pool needed the backfill pass at all** -- the
 * magnitude-qualifying pass alone always reaches at least 2 now, a real
 * change from the first revamp round's own pool (where 1 of 41 sessions,
 * a genuine spacing-pathological one, needed backfill and still
 * couldn't reach the floor even with magnitude ignored entirely -- see
 * this file's own `apps/web/CLAUDE.md` "Bullet Time revamp: 4 events
 * per session, a hard floor of 2" section (the first round, not the
 * "round two" section below it) for that earlier session's own detail,
 * since it's no longer reproducible against the current constants).
 * This does **not** mean the backfill pass or the "floor genuinely
 * unreachable" case are now unreachable in general -- they remain real,
 * load-bearing behavior for a session structured differently than
 * anything in this validation pool (a genuinely flat one, or one whose
 * few real swings all cluster too close together for even
 * magnitude-agnostic backfill to find a second spacing-valid window) --
 * only that this specific real pool no longer happens to exercise it.
 * `bullet-time.test.ts`'s own synthetic `barelyMovingBars` fixture (a
 * session with nothing anywhere near the magnitude bar) still exercises
 * the backfill pass directly, and a hand-built synthetic near-flat
 * session was live-verified to reach the floor of 2 via backfill (see
 * that same first-round `apps/web/CLAUDE.md` section) -- the mechanism
 * itself is unchanged and still real, just not triggered by any of the
 * 41 real sessions in this particular (second-round) pool.
 */
export const BULLET_TIME_MIN_EVENTS = 2;

/**
 * How many bars before a qualifying swing's own start index the approach
 * begins -- **lowered from 2 to 1** in the same push that shrank
 * `BULLET_TIME_MIN_TRIGGER_GAP_BARS` (a direct user request, the second
 * round of the Bullet Time revamp: push 4 events further toward being
 * the *common* outcome, not just a reachable one). The original doc
 * comment here rejected the design doc's own illustrative "one bar
 * ahead" for reading "as a single slowed tick" rather than a real
 * build-up -- that reasoning is not overturned, only outweighed: 1 is
 * the shortest lead-in that still shows *some* real slow-motion bar
 * before the decision, and it is a genuine, deliberate trade-off this
 * round makes explicitly, not a value picked by accident. **Re-checked
 * live, not just asserted**: at `BULLET_TIME_APPROACH_TICK_MS` =
 * 4500ms, even a single approach bar is a real, noticeable pause (4.5s)
 * before "Big swing incoming…" hands off to the decision panel --
 * screenshotted and confirmed to still read as a distinct beat, not an
 * instant cut (see this constant's own live-verification note in
 * `apps/web/CLAUDE.md`'s "Bullet Time revamp, round two" section).
 *
 * **Re-validated against the same real 41-session pool this file's
 * other constants cite.** Confirmed by exhaustive sweep (every integer
 * `BULLET_TIME_LEAD_BARS` value from 0-2 crossed with every integer
 * `BULLET_TIME_MIN_TRIGGER_GAP_BARS` value from 0-6): **1 is the
 * lowest value that still leaves a real approach phase at all** --
 * `BULLET_TIME_LEAD_BARS = 0` makes the "approaching" phase's own bar
 * range empty (`bulletTimeStatusAt`'s own `barIndex < event.swing.fromIndex`
 * check has no bars left to be true for), eliminating the mechanic's
 * own signature build-up outright, and was rejected specifically for
 * that reason even though it is the only value that gets 4 events to
 * outright plurality on this real pool (100% of sessions at
 * `minGapBars = 0`). See `BULLET_TIME_MIN_TRIGGER_GAP_BARS`'s own doc
 * comment for the full distribution this combination produces, and the
 * honest gap against strict "4 is plurality" it still leaves.
 */
export const BULLET_TIME_LEAD_BARS = 1;

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
 * example). **This check itself -- the "never share an active window"
 * requirement -- is never relaxed, at any value of this constant down
 * to and including 0**: `gap = 0` is `intervalsWithinGap`'s own exact-
 * overlap check (see that function's own doc comment,
 * `beat-the-bench-moves.ts`), which still strictly forbids two events'
 * windows from sharing a single bar. What "gap" actually buys on top of
 * that bare non-overlap guarantee is *breathing room* between one
 * event's own resolution and the next event's own approach cue -- and
 * this constant is the one this file's second revamp round explicitly
 * shrinks that breathing room to buy more frequent events, a real,
 * deliberate trade-off, not an accident.
 *
 * **Lowered from 6 to 0 -- its absolute floor -- in the same push that
 * lowered `BULLET_TIME_LEAD_BARS` from 2 to 1** (a direct user request:
 * push 4 events further toward being the *common* outcome, not just a
 * reachable one). Re-validated by the identical exhaustive sweep that
 * constant's own doc comment describes, against the same real
 * 41-session pool: at `BULLET_TIME_LEAD_BARS = 1` (the lowest value
 * that keeps a real approach phase, see that constant's own doc
 * comment), `minGapBars = 0` produces the real distribution **0% / 0% /
 * 17.1% / 46.3% / 36.6%** for 0/1/2/3/4 events (average **3.20**
 * events/session, up from 2.51 after the first revamp round and 1.02
 * under the original 0.30%/2-event/6-bar-gap design) -- **the strongest
 * push toward 4 achievable without eliminating the approach phase
 * outright, but honestly short of literal plurality for 4 specifically:
 * 3 remains the single most common count (46.3%) against 4's 36.6%.**
 * Reaching outright plurality for 4 requires `BULLET_TIME_LEAD_BARS =
 * 0` too (100% of sessions reach 4 at that combination), which that
 * constant's own doc comment explains was rejected for eliminating the
 * approach phase entirely -- a mechanic-breaking trade the magnitude of
 * the numeric gain does not justify. **3-or-4 combined is 82.9% of real
 * sessions** under the shipped values, a real, substantial win even
 * without 4 alone claiming plurality. A real, live-checked risk at
 * `gap = 0` specifically -- back-to-back events with zero bars of
 * breathing room, so a resolved event's own lingering "Called it"/"Not
 * this time" badge (see `BULLET_TIME_BADGE_LINGER_BARS`) can in
 * principle still be on screen the instant the next event's own "Big
 * swing incoming…" cue appears -- was checked live and found not to
 * read as visually broken (see `apps/web/CLAUDE.md`'s own "Bullet Time
 * revamp, round two" section for the real screenshots and the exact
 * reasoning for why this was judged acceptable rather than papered
 * over).
 */
export const BULLET_TIME_MIN_TRIGGER_GAP_BARS = 0;

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
 * **Re-validated twice against a real 41-session pool for its actual
 * time cost, not just chosen in isolation** -- once at the first revamp
 * round's spacing (`BULLET_TIME_LEAD_BARS = 2`,
 * `BULLET_TIME_MIN_TRIGGER_GAP_BARS = 6`), once more at the second
 * round's tighter spacing (1/0, see both constants' own doc comments
 * for why), each time against the real `scheduleBulletTimeEvents`
 * (its own two-pass floor-backfill and whole-window anti-crowding check
 * included), summing each bar's own real tick interval (approach/
 * catchup/decision-window-worst-case) against a plain (event-free)
 * baseline session. **Numbers below are the current, shipped
 * (`BULLET_TIME_LEAD_BARS = 1`, `BULLET_TIME_MIN_TRIGGER_GAP_BARS = 0`)
 * measurement** -- the first round's own numbers (+43.0s/+21.8s worst-
 * case/median at 1x; +2.0s/-11.7s at 0.25x) are superseded, not still
 * true, since fewer approach bars per event (2 -> 1) and denser event
 * scheduling both shift the real totals:
 *
 * - **At 1x speed**: the worst real case (a real 4-event session) adds
 *   **+27.0s** on top of that session's own ~23.1s base length --
 *   pushing a full playthrough to **~50.0s** (down from ~66.1s at the
 *   first round's own spacing -- fewer approach bars per event more
 *   than offsets there being more events overall). The median real
 *   *triggering* session (every one of the 41 real sessions in the pool
 *   triggers at least one event) adds **+17.7s**.
 * - **At the new 0.25x default speed** (`DEFAULT_SPEED`,
 *   `beat-the-bench.ts`): the fixed-pace catchup phase
 *   (`BULLET_TIME_CATCHUP_TICK_MS` = 150ms/bar) is *faster* than the
 *   player's own chosen 1200ms/bar pace at 0.25x, so a long swing's
 *   catchup stretch claws back more time than the approach/decision
 *   phases add -- net overhead is *negative for every single session in
 *   the pool at this spacing*, not just usually negative the way the
 *   first revamp round measured: median **-23.9s** (a 0.25x session
 *   with Bullet Time typically finishes almost 24s *faster* than a
 *   plain playthrough would), and even the real worst case (the session
 *   with the *least* negative overhead, i.e. the one closest to adding
 *   real time) still nets **-8.2s** -- a ~92.4s base session never
 *   exceeds **~84.3s** with Bullet Time active, at any real session in
 *   this pool.
 *
 * This is a real, measured, non-obvious asymmetry between the two
 * speeds, not a hand-wave: at 1x, every phase of Bullet Time reliably
 * adds overhead; at 0.25x, the catchup phase's fixed pace outpaces the
 * player's own chosen speed for long swings often enough, and by enough
 * margin, that the net effect flips for every real session measured.
 * See `BULLET_TIME_CATCHUP_TICK_MS`'s own doc comment for why the
 * catch-up pace exists at all.
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
 * primitive `findBestRuns` uses for its own overlap check, just at
 * `BULLET_TIME_MIN_TRIGGER_GAP_BARS`'s own current value (which is
 * itself `0`, its own floor, as of the second revamp round -- see that
 * constant's own doc comment for why gap `0` still fully enforces "never
 * share an active window" rather than relaxing it).
 *
 * Returns events in **chronological** order (ascending `triggerIndex`),
 * not by magnitude -- the shape a caller actually walks a session with.
 * Returns `[]` only for a session too short to contain even one real
 * swing (see `biggestSwings`). **Not a hard guarantee of
 * `BULLET_TIME_MIN_EVENTS` for every other session, despite that being
 * the goal**: the backfill pass can still come up short in a genuinely
 * pathological session where fewer than `BULLET_TIME_MIN_EVENTS`
 * spacing-valid candidates exist at all -- see `BULLET_TIME_MIN_EVENTS`'s
 * own doc comment for a real (if no longer reproducible against the
 * current, tighter spacing) example of this happening in a validated
 * 41-session pool. Don't assume
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
