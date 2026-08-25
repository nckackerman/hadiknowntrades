"use client";

// Drives the "Watch it happen" trade replay (issue #96): an opt-in,
// on-click re-sequencing of an already-rendered window-model result's
// chart/hero figure through each real buy/sell event, purely a
// resequencing of data already on the page -- no new computation, no new
// fetch. Points come straight from portfolio-series.ts's
// derivePortfolioSeries, exactly the ordered PortfolioPoint[] (a
// flat/open/flat/close step function with an event annotation at each
// open/close) this issue's own Background section calls out as "already
// the exact data shape this feature needs to walk through."

import { useCallback, useEffect, useMemo, useState } from "react";

import { tweenValue } from "./easing";
import { formatDateTime, formatEpochAsDate, toPortfolioTimestamp } from "./format-date";
import type { PortfolioEvent, PortfolioPoint } from "./portfolio-series";
import { prefersReducedMotion } from "./prefers-reduced-motion";
import { computeTradeReturn, type TradeReturn } from "./trade-math";
import { useResetWhenChanged } from "./use-reset-when-changed";

export type ReplayPhase = "idle" | "rewinding" | "playing" | "done";

/** One trade-event pause during playback (see TradeReplay.tsx for the callout this renders as). */
export interface ReplayEvent {
  point: PortfolioPoint;
  event: PortfolioEvent;
  /**
   * This trade's own return, computed from the matching prior "open"
   * event's price (precomputed once per close segment by buildSegments
   * below) -- present only for a "close" event; `null` for an "open"
   * event (nothing to compare against yet) and defensively if no
   * matching open point is somehow found.
   */
  tradeReturn: TradeReturn | null;
}

export interface ReplayFrame {
  /** How many leading points of `points` are "revealed" so far -- feed `points.slice(0, revealedCount)` to PortfolioChart. Starts at 1 (just the window's own opening point) once playback begins. */
  revealedCount: number;
  /**
   * The current interpolated portfolio value, for a hero-style "$X"
   * display during playback. Tweens between a segment's two real
   * endpoint values via the same ease-out-cubic curve useCountUp
   * already uses (lib/easing.ts) -- a display stylization of a real,
   * instantaneous value change (mirroring how HeroStat's own useCountUp
   * already stylizes a reveal as a tween without claiming that's how
   * the money literally moved), not a fabricated price path. This is
   * deliberately *not* the same thing as interpolating the chart's own
   * line between two points, which this hook never does -- see
   * `revealedCount` above and portfolio-series.ts's own "flat until
   * realized" header comment for why the chart only ever reveals real,
   * already-computed points.
   */
  currentValue: number;
  /** The event playback is currently pausing on to show a callout, or null between pauses. */
  activeEvent: ReplayEvent | null;
}

/**
 * How fast this hook's two RAF loops move -- `transitionMs` per segment
 * tween, `eventPauseMs` per trade-event pause, `rewindMs` for the whole
 * rewind-intro-beat tween (issue #97). A module-level parameter (issue
 * #105), not module-level constants baked into the RAF effects directly,
 * so a caller walking a materially larger point series (1W's whole-range
 * chained intraday series, up to 50 points/49 segments/30 event-pauses
 * worst case -- see docs/plans/issue-105-plan.md section 2 for the full
 * derivation) can use tighter pacing without forking this hook.
 */
export interface ReplayPacing {
  transitionMs: number;
  eventPauseMs: number;
  rewindMs: number;
}

// The window model's own pacing (issues #96/#97), tuned by feel (per the
// issue's own scope note: "roughly 3-6 seconds for a typical 1-3 trade
// window... doesn't need to be exact") against derivePortfolioSeries's
// own point shape: 3 points per trade (open/flat/close) plus a leading
// and trailing boundary point. A 1-trade window plays in ~2.4s, a
// 3-trade window in ~6.6s. `rewindMs` (~0.6-1s) is brief enough to read
// as an intro beat, not its own event to sit through. This is the
// default `useTradeReplay` uses when a caller omits `pacing` entirely
// (every window-model caller, TradeReplay.tsx included -- it needs zero
// changes for issue #105) -- a module-level constant object, not an
// inline literal, so its identity stays stable across renders the same
// way any other caller-supplied `pacing` object must (see
// `useTradeReplay`'s own parameter doc comment below).
const DEFAULT_PACING: ReplayPacing = {
  transitionMs: 300,
  eventPauseMs: 600,
  rewindMs: 700,
};

function initialFrame(points: readonly PortfolioPoint[]): ReplayFrame {
  return {
    revealedCount: Math.min(1, points.length),
    currentValue: points[0]?.value ?? 0,
    activeEvent: null,
  };
}

/** The frame a completed (or aborted-to-completion) replay lands on -- every point revealed, the true final value, no active callout. Shared by `skipToEnd`, natural completion, and `tick`'s own defensive catch (see each call site) so every "reached the end" path agrees on exactly the same shape. */
function finalFrame(points: readonly PortfolioPoint[]): ReplayFrame {
  const last = points[points.length - 1];
  return {
    revealedCount: points.length,
    currentValue: last?.value ?? 0,
    activeEvent: null,
  };
}

interface Segment {
  fromValue: number;
  toValue: number;
  toIndex: number;
  point: PortfolioPoint;
  event: PortfolioEvent | null;
  /**
   * For a "close" event segment only: the matching prior "open" event's
   * own price. Precomputed once here, in `buildSegments`'s existing
   * single forward pass over `points` (tracking "the most recently seen
   * open price" as it walks), rather than re-scanned backward through
   * `points` from inside the RAF callback every time playback lands on
   * a close segment (this hook's own earlier design -- a separate
   * `findMatchingOpenPrice` backward scan called from `replayEventFor`).
   * Safe to assume a close's own matching open is the *most recent* one
   * seen, not some earlier trade's, because derivePortfolioSeries's own
   * appendTradeSteps never interleaves trades: each trade contributes
   * its own open/flat/close points strictly in sequence before the next
   * trade's own points begin (see that module's header comment). `null`
   * for a non-close segment, or defensively if no open event precedes
   * this close at all.
   */
  openPrice: number | null;
}

function buildSegments(points: readonly PortfolioPoint[]): Segment[] {
  const segments: Segment[] = [];
  let lastOpenPrice: number | null = null;
  for (let i = 1; i < points.length; i++) {
    const point = points[i]!;
    const event = point.event;
    if (event?.type === "open") {
      lastOpenPrice = event.price;
    }
    segments.push({
      fromValue: points[i - 1]!.value,
      toValue: point.value,
      toIndex: i,
      point,
      event,
      openPrice: event?.type === "close" ? lastOpenPrice : null,
    });
  }
  return segments;
}

/** Builds this segment's own ReplayEvent (or `null` for a plain point with no event) purely from the segment's own precomputed fields -- no separate `points` lookup needed, unlike this hook's earlier design (see Segment's own `openPrice` doc comment). */
function replayEventFor(segment: Segment): ReplayEvent | null {
  if (!segment.event) return null;
  const tradeReturn =
    segment.event.type === "close" && segment.openPrice !== null
      ? computeTradeReturn(segment.openPrice, segment.event.price, segment.event.direction)
      : null;
  return { point: segment.point, event: segment.event, tradeReturn };
}

export interface UseTradeReplayResult {
  phase: ReplayPhase;
  frame: ReplayFrame;
  /**
   * A formatted date readout ("Aug 21, 2025"), non-null while `phase`
   * is `"rewinding"` or `"playing"`, `null` in `"idle"`/`"done"`.
   * Generalized from the `"rewinding"`-only `rewindDate` issue #97
   * introduced (issue #107 extends the same readout through forward
   * playback too, per that issue's own Background section) -- kept as
   * one field, not two, since both phases are the same continuous
   * on-screen readout from the caller's point of view (see
   * `TradeReplay.tsx`'s own doc comment on why the transition between
   * them must read as continuous).
   *
   * Two different sources feed it, chosen per phase:
   *  - `"rewinding"`: a tween from "now" to the result's own start date
   *    (see this hook's own doc comment) -- there's no discrete "point"
   *    to read a date off yet, so this genuinely needs animating.
   *  - `"playing"`: `points[frame.revealedCount - 1].date`, the real
   *    date of whichever point is currently revealed -- no tween at
   *    all, since `revealedCount` already jumps point-to-point (the
   *    chart itself never interpolates a position between two points,
   *    see `ReplayFrame.currentValue`'s own doc comment for the parallel
   *    reasoning) and there's nothing to animate between: a "date"
   *    between two real trading days isn't a meaningful intermediate
   *    value the way a dollar figure is. This is computed fresh from
   *    `frame`/`points` below (not written into a `useState` from
   *    inside the playing effect's `tick()`), which is what keeps this
   *    always exactly in sync with `revealedCount` for free -- no
   *    separate state to remember to update at every one of `tick()`'s
   *    several `setFrame` call sites.
   *  - `"idle"`/`"done"`: `null` -- deliberately not folded into
   *    `ReplayFrame`: it has nothing to do with the trade walk
   *    `ReplayFrame` describes (no revealedCount/currentValue/
   *    activeEvent meaning applies to a date readout), so giving it its
   *    own top-level field keeps `ReplayFrame` describing exactly one
   *    thing.
   */
  displayDate: string | null;
  /** Starts (or restarts, from "done") playback from the very beginning -- via a brief `"rewinding"` intro beat first (issue #97), or straight to `"playing"` under reduced motion (see this hook's own doc comment). A no-op while already `"rewinding"` or `"playing"`. */
  play: () => void;
  /** Jumps straight to the final state and marks playback "done" -- always available during playback *or* the rewinding intro beat (issue #97's own "works identically whether triggered during this phase or during trade playback" acceptance criterion), per the issue's own "give me the answer fast" scope note. */
  skipToEnd: () => void;
  /**
   * Bumped every time `phase` actually *lands on* `"done"` -- natural
   * completion, `skipToEnd`, or the corrupted-price defensive catch, the
   * same three call sites that call `setPhase("done")` below. Lets a
   * caller (TradeReplay.tsx) detect "playback just finished" directly
   * from this hook's own state, instead of shadow-tracking `phase`
   * itself with a second local state variable purely to notice the same
   * transition this hook already owns (code review, issue #96 follow-up
   * round four) -- this hook is the one place that actually knows when a
   * "done" landing is genuine, so it's the natural owner of counting
   * them.
   */
  completedRuns: number;
}

/**
 * A small explicit state machine (idle -> rewinding -> playing -> done),
 * following the same style as use-results.ts's own ResultsState, driven
 * by two RAF loops (one per animated phase -- see the two effects
 * below). `play`/`skipToEnd` are plain functions meant to be called from
 * a button's onClick, not from an effect body -- calling setState
 * synchronously inside them doesn't trip react-hooks/set-state-in-effect,
 * which only reaches setState calls in an effect's own body. Each RAF
 * loop itself follows useCountUp's established shape: the effect below
 * only ever *schedules* a frame; every setState call happens inside the
 * frame callback itself (a callback invoked by an external system, the
 * pattern the lint recommends).
 *
 * **The `"rewinding"` phase (issue #97)** is a brief, purely decorative
 * intro beat -- a date readout ticking backward from "now" to the
 * result's own start date (`points[0].date`, the same leading boundary
 * point `initialFrame`/`finalFrame` already read) -- that `play()` now
 * enters before `"playing"` begins, selling the "had I known" fantasy
 * this app's whole premise is built on. It carries no new data and
 * doesn't touch `frame` at all (see `displayDate`'s own doc comment --
 * issue #107 later extended the same readout through the `"playing"`
 * phase too, but "rewinding" itself still never touches `frame`).
 * Respects the same reduced-motion posture #96 already established for
 * this feature (see that issue's own "the button doesn't render at all,
 * not an instant step-through equivalent" note): `play()` checks
 * `prefersReducedMotion()` itself and skips `"rewinding"` entirely,
 * landing straight on `"playing"` exactly like pre-#97 behavior --
 * matching the issue's own "skip straight past this phase with zero
 * delay" acceptance criterion at the hook level. In the real UI this
 * check is never actually exercised -- `TradeReplay.tsx`'s own
 * `canReplay` gate already hides the button that calls `play()` at all
 * once `reducedMotionAtMount` is true, so `play()` is never reachable
 * under reduced motion in the first place -- but it's still the right
 * place to enforce the contract: `play()` is this hook's own public
 * API, and a future caller (or a future test) shouldn't have to trust
 * an upstream button gate for the hook to behave correctly on its own.
 *
 * Two distinct kinds of motion, driven by the same loop (see
 * ReplayFrame's own doc comments for the full reasoning):
 *  - The chart only ever reveals real, already-computed points --
 *    `revealedCount` grows one at a time, never interpolating a
 *    position between two points (which would fabricate an interim
 *    mark-to-market price this app's model doesn't have).
 *  - The balance figure (`currentValue`) tweens between a segment's two
 *    real endpoint values. Most segments have an identical start/end
 *    value (the open -> flat -> close shape holds flat through a
 *    trade's entire holding period), so only the segments landing on a
 *    trade's close actually move.
 *
 * Playback pauses for EVENT_PAUSE_MS once it lands on a point carrying a
 * real open/close event, so the orchestrating component (TradeReplay.tsx)
 * can show a narrated callout -- a plain point with no event (the
 * mid-trade "flat" vertex, or the window's own start/end) is passed
 * straight through with no pause.
 *
 * `play()` is a no-op while `phase` is already `"rewinding"` or
 * `"playing"` (the former not reachable via the shipped UI today either
 * -- same reasoning as the latter, below -- but both are real contracts
 * this hook's own public API needs regardless, code-review found and
 * fixed for the original `"playing"` case). **Simplified in round four**
 * from an earlier `runId` state variable (bumped on every `play()`/
 * `skipToEnd()` call, included in the effect's own dependency array
 * purely to force a restart even when `phase`'s own value happened to
 * repeat) down to a plain guard at the top of `play()` itself: since
 * every reachable caller only ever invokes `play()` from `"idle"` or
 * `"done"`, never `"rewinding"`/`"playing"`, a guard that simply
 * declines to act while already mid-flight is behaviorally identical
 * for every real call site, and is arguably the more literal reading of
 * "idempotent" the original round-two fix was named for (repeating the
 * call has no additional effect, rather than restarting the walk). No
 * `runId` needed, and no "is this tick stale?" check inside either
 * `tick` either -- each effect's own dependency array still forces a
 * genuine restart (and its cleanup's `cancelAnimationFrame` still tears
 * down the prior loop first) on every *real* transition, which is now
 * the only kind `play()`/`skipToEnd()` ever produce.
 *
 * **`pacing` (issue #105) must be a stable-identity object across
 * renders, same discipline this file's own `points` parameter already
 * requires.** Both RAF effects below include `pacing` in their own
 * dependency array alongside `phase`/`points`, so a genuinely different
 * `pacing` object (by reference) restarts the effect the same way a
 * `points` change does -- an inline object literal passed on every
 * render would therefore restart the RAF loop on every render too,
 * exactly the same failure mode this file's own doc comments already
 * warn about for `points`/`landing` elsewhere in this feature. Every
 * real caller passes one fixed, module-level object for its entire
 * lifetime (`TradeReplay.tsx`'s implicit `DEFAULT_PACING`,
 * `WholeRangeReplay.tsx`'s own `WHOLE_RANGE_REPLAY_PACING`), so this is
 * satisfied today by construction, not by extra bookkeeping.
 */
export function useTradeReplay(
  points: readonly PortfolioPoint[],
  pacing: ReplayPacing = DEFAULT_PACING,
): UseTradeReplayResult {
  const [phase, setPhase] = useState<ReplayPhase>("idle");
  const [frame, setFrame] = useState<ReplayFrame>(() => initialFrame(points));
  // The rewind tween's own current value -- only meaningful while
  // phase === "rewinding". Not returned directly; `displayDate` below
  // combines this with the playing-phase readout (derived straight from
  // `frame`/`points`, no state of its own needed) into the one field
  // UseTradeReplayResult actually exposes. See that field's own doc
  // comment for why "rewinding" alone needs a tween and "playing"
  // doesn't.
  const [rewindTweenDate, setRewindTweenDate] = useState<string | null>(null);
  // Bumped at every one of the three `setPhase("done")` call sites below
  // -- see `UseTradeReplayResult.completedRuns`'s own doc comment for why
  // this hook (not a caller shadow-tracking `phase`) owns the count.
  const [completedRuns, setCompletedRuns] = useState(0);

  const play = useCallback(() => {
    if (points.length < 2 || phase === "rewinding" || phase === "playing") return;
    setFrame(initialFrame(points));
    // Reduced motion skips the rewind intro beat entirely (issue #97's
    // own "skip straight past this phase with zero delay" acceptance
    // criterion) -- straight to "playing", exactly the pre-#97 behavior.
    // See this function's own surrounding doc comment for why this check
    // lives here rather than trusting the caller to have already gated
    // on it.
    setPhase(prefersReducedMotion() ? "playing" : "rewinding");
  }, [points, phase]);

  const skipToEnd = useCallback(() => {
    setFrame(finalFrame(points));
    setRewindTweenDate(null);
    setPhase("done");
    setCompletedRuns((run) => run + 1);
  }, [points]);

  // If `points` changes identity while a replay is mid-flight (or just
  // finished) -- a live starting-capital edit or a ModeToggle switch,
  // both of which recompute ResultsPanel's own `points` memo without
  // unmounting `TradeReplay` -- treat it as a fresh mount rather than
  // silently rebuilding `segments` under the effect below while `frame`
  // still holds stale mid-playback values from the *old* points. The
  // effect's own `[phase, points]` dependency array already restarts
  // `segmentIndex`/`phaseStart` from scratch in that case regardless
  // (and its cleanup's `cancelAnimationFrame` already stops the old
  // points' in-flight loop before the new effect body ever runs);
  // without this reset, `frame` wouldn't catch up until the next tick
  // fires, and even then would resume mid-walk through data that no
  // longer matches what's on screen -- visibly snapping the chart/hero
  // backward and re-narrating an already-shown trade with no indication
  // anything reset. Resetting to "idle" here (not "done") means the
  // user sees the plain, real hero row/chart again and a fresh "Watch
  // it happen" button, exactly as if this were the first time. Uses the
  // shared useResetWhenChanged helper (code review, issue #96 follow-up
  // round four) rather than a hand-rolled `trackedPoints` companion
  // state -- the same "adjust state during render when a prop changes"
  // idiom `use-results.ts`'s own reset and `use-range-guess.ts`'s reset
  // already use, so this stays lint-safe (a plain render-time setState,
  // not one inside an effect body) and needs no extra render before it
  // applies.
  useResetWhenChanged([points], () => {
    if (phase !== "idle") {
      setPhase("idle");
      setFrame(initialFrame(points));
      // Mid-rewind is one of the phases this reset can interrupt (issue
      // #97) -- clear the stale readout the same defensive way `frame`
      // itself is reset, so a caller never renders a leftover rewind
      // date against an "idle" phase.
      setRewindTweenDate(null);
    }
  });

  // The rewind intro beat (issue #97): a single tween from "now" to the
  // result's own start date, following the exact same RAF shape
  // use-count-up.ts uses for a lone tween (unlike the multi-segment loop
  // below) -- one requestAnimationFrame-scheduled tick, no
  // segment/sub-phase state machine needed, since there's only ever one
  // thing to animate here (a date, not a multi-point walk). `points[0]`
  // is safe to read unconditionally: `play()` already guards
  // `points.length < 2` before ever setting phase to "rewinding", the
  // only way this effect body actually runs its tween (the `phase !==
  // "rewinding"` bail-out above covers every other case, including a
  // stale scheduled tick after skipToEnd/the points-reference reset
  // above already moved phase elsewhere -- this effect's own cleanup
  // cancels it before that happens).
  useEffect(() => {
    if (phase !== "rewinding") return;

    // toPortfolioTimestamp (issue #105), not a bare
    // `Date.parse(`${points[0]!.date}T00:00:00Z`)` -- that inline parse
    // assumed `points[0].date` is always a plain calendar date, which is
    // true for the window model this hook originally shipped against
    // but not for a chained-intraday series (1W's whole-range replay):
    // a datetime-labeled point ("2025-08-21T09:30:00") produced a
    // malformed double-`T` string ("2025-08-21T09:30:00T00:00:00Z"),
    // which Date.parse silently resolves to NaN -- the rewind's own
    // tween target would be NaN, and formatEpochAsDate(NaN) renders
    // "Invalid Date" for the entire rewind beat. toPortfolioTimestamp
    // already handles both shapes correctly (the same function
    // PortfolioChart.tsx uses for its own x-axis timestamps), so this
    // reuses it instead of inventing a third copy of the same
    // datetime-vs-plain-date check.
    const targetEpoch = toPortfolioTimestamp(points[0]!.date);
    const startEpoch = Date.now();
    const startTime = performance.now();
    let frameId: number;

    function tick(now: number) {
      const elapsed = now - startTime;
      const t = Math.min(elapsed / pacing.rewindMs, 1);
      if (t >= 1) {
        // Clear the internal tween state in this same tick, not just on
        // some later setPhase("done")/points-change -- so a *future*
        // rewind (a "Replay" click) starts its own tween fresh rather
        // than briefly showing this run's stale fully-tweened value
        // before its first tick recomputes it (code review follow-up,
        // real bug once fixed for a distinct reason: this branch used
        // to call setRewindTweenDate(...) with the fully-tweened target
        // date and *then* setPhase("playing") on the same tick, which
        // used to leave that stale string sitting in the then-directly-
        // exposed `rewindDate` field for the entire subsequent
        // trade-playback stretch, visible the whole time TradeReplay.tsx
        // read it while phase === "playing" -- issue #107 later made
        // that reachable case moot by deriving the playing-phase
        // readout straight from `frame`/`points` instead of this state
        // at all (see `displayDate`'s own doc comment), but clearing
        // this internal tween state here is still the right hygiene for
        // the *next* rewind).
        setRewindTweenDate(null);
        setPhase("playing");
        return;
      }
      setRewindTweenDate(formatEpochAsDate(tweenValue(startEpoch, targetEpoch, t)));
      frameId = requestAnimationFrame(tick);
    }

    frameId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frameId);
  }, [phase, points, pacing]);

  // The `let frameId; function tick(now) {...}; frameId =
  // requestAnimationFrame(tick); return () => cancelAnimationFrame(frameId)`
  // scaffold below structurally mirrors use-count-up.ts's own RAF loop --
  // considered extracting a shared "run this RAF loop, call me each tick,
  // support cancel/restart" primitive (code review, issue #96 follow-up
  // round four), but the two loops' actual substance genuinely diverges
  // enough that it didn't compose cleanly: use-count-up.ts's tick closes
  // over a single fixed `startTime` captured once and runs unconditionally
  // on a mount-only `[]` effect, while this one restarts a multi-segment
  // tween/pause state machine (`segmentIndex`/`subPhase`/`phaseStart`, all
  // reassigned mid-loop as segments advance, not just read) on every
  // `[phase, points]` change. A shared primitive would need the caller to
  // hand it a memoized "build my own tick(now)" callback and thread that
  // through its own dependency array -- a genuine dependency-array-of-a-
  // dependency-array layer of indirection for what's otherwise ~5 lines of
  // schedule/cleanup boilerplate, likely making both hooks harder to read
  // rather than easier. Left un-extracted; only `tweenValue`'s own curve
  // math (lib/easing.ts, round three) is actually shared between them.
  useEffect(() => {
    if (phase !== "playing") return;

    const segments = buildSegments(points);

    let frameId: number;
    let segmentIndex = 0;
    // "tween" (animating currentValue toward the segment's target) or
    // "pause" (holding on an event's callout).
    let subPhase: "tween" | "pause" = "tween";
    let phaseStart = performance.now();

    function tick(now: number) {
      // segments.length is always >= 1 here -- play() already guards
      // points.length < 2 (so buildSegments always produces at least one
      // segment) before ever setting phase to "playing", the only way
      // this effect ever runs. An earlier version of this function kept
      // a defensive `if (segments.length === 0)` branch "just in case" --
      // deleted (code review, issue #96 follow-up round 3): confirmed
      // genuinely unreachable, not just defensively guarded, so it was
      // dead code rather than a real safety net.
      const segment = segments[segmentIndex]!;
      const elapsed = now - phaseStart;

      if (subPhase === "tween") {
        const t = Math.min(elapsed / pacing.transitionMs, 1);
        if (t < 1) {
          setFrame({
            revealedCount: segment.toIndex,
            currentValue: tweenValue(segment.fromValue, segment.toValue, t),
            activeEvent: null,
          });
          frameId = requestAnimationFrame(tick);
          return;
        }

        // computeTradeReturn (inside replayEventFor) throws
        // InvalidTradePriceError for a non-finite/non-positive stored
        // price -- correct and consistent with every other caller
        // (TradeRow.tsx, narrate-trades.ts), but those are both
        // render-time throws caught by app/error.tsx/global-error.tsx
        // (issue #46). A throw from inside this RAF callback isn't a
        // render, so nothing would catch it -- the loop would just die
        // uncaught, leaving `cancelAnimationFrame`'s cleanup referencing
        // a stale `frameId` and the UI silently frozen mid-playback with
        // no error surfaced anywhere. Caught here and failed into the
        // same final state `skipToEnd` produces instead: not silent
        // (logged), but contained, matching this app's other
        // "contained but not silent" defensive fixes (see
        // trade-math.ts's own InvalidTradePriceError doc comment) --
        // and if the underlying price really is corrupted, the page's
        // real static render (TradeList/narrate-trades.ts, once this
        // hands off to it) still throws its own render-time error there,
        // caught by the existing boundaries as usual.
        let replayEvent: ReplayEvent | null;
        try {
          replayEvent = replayEventFor(segment);
        } catch (error) {
          console.error(
            "useTradeReplay: failed to compute a trade event mid-playback; skipping to the final state",
            error,
          );
          setFrame(finalFrame(points));
          setRewindTweenDate(null);
          setPhase("done");
          setCompletedRuns((run) => run + 1);
          return;
        }
        setFrame({
          revealedCount: segment.toIndex + 1,
          currentValue: segment.toValue,
          activeEvent: replayEvent,
        });
        if (replayEvent) {
          subPhase = "pause";
          phaseStart = now;
          frameId = requestAnimationFrame(tick);
          return;
        }
        // No event on this point -- fall through to advance immediately,
        // in the same tick, rather than scheduling a whole extra frame
        // just to notice there's nothing to pause for.
      } else if (elapsed < pacing.eventPauseMs) {
        frameId = requestAnimationFrame(tick);
        return;
      }

      segmentIndex += 1;
      if (segmentIndex >= segments.length) {
        // Natural completion must land on exactly the same frame shape
        // skipToEnd/the corrupted-price catch above already produce
        // (every point revealed, the true final value, no lingering
        // activeEvent from whatever the last segment paused on) -- code
        // review found this branch used to only setPhase("done"),
        // leaving `frame.activeEvent` still set to the last trade's own
        // close event whenever that close's date happened to equal the
        // window's own end date (derivePortfolioSeries appends no
        // trailing flat point in that case -- a realistic, not
        // hypothetical, shape: the best trade in a 5Y/MAX window closing
        // on the most recent trading day).
        //
        // Also clears the internal rewind-tween state here (issue #97
        // follow-up, code review found and fixed) -- this is one of the
        // three setPhase("done") call sites this hook has (alongside
        // skipToEnd and the corrupted-price catch above). Without this,
        // a natural (non-skipped) completion left the *previous* run's
        // target date sitting in that state all through "done", visible
        // for one frame as a wrong date at the very start of the *next*
        // rewind if the user then clicks "Replay" -- skipToEnd already
        // got this right; natural completion and the defensive catch
        // above didn't. (This state feeds `displayDate` only while
        // phase === "rewinding" -- see that field's own doc comment --
        // so it's pure hygiene for the next rewind now, not required to
        // satisfy `displayDate`'s own "null in idle/done" contract,
        // which the derivation below already guarantees regardless of
        // this state's value.)
        setFrame(finalFrame(points));
        setRewindTweenDate(null);
        setPhase("done");
        setCompletedRuns((run) => run + 1);
        return;
      }
      subPhase = "tween";
      phaseStart = now;
      frameId = requestAnimationFrame(tick);
    }

    frameId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frameId);
  }, [phase, points, pacing]);

  // The one field UseTradeReplayResult actually exposes for the date
  // readout (issue #107) -- see its own doc comment for the full
  // per-phase reasoning. Derived fresh from `frame`/`points` rather than
  // written into a state of its own for the "playing" branch: `frame` is
  // already the single source of truth for "which point is currently
  // revealed" (`revealedCount`), so reading `points[revealedCount -
  // 1].date` straight from it can never drift out of sync the way a
  // second, independently-`setState`'d value could.
  //
  // Memoized (code review finding) -- without this, a mid-tween frame
  // (most of them: `revealedCount` only advances once per segment, but
  // `setFrame` fires roughly a dozen times per segment as `currentValue`
  // tweens) would re-run `formatDateTime` for a string that hasn't
  // actually changed, the same wasted-work class `TradeReplay.tsx`'s own
  // `endingBalanceDisplayValue`/`displayStartingCapitalFormatted`/
  // `multiplier` already guard against on this identical hot path.
  //
  // `formatDateTime(..., true)` (issue #105), not a bare
  // `formatDate(points[index]!.date)` -- `formatDate` unconditionally
  // does the exact same `Date.parse(`${isoDate}T00:00:00Z`)` this file's
  // own rewind-effect fix above just moved off of, so it hit the
  // identical malformed-double-`T` bug against a chained-intraday
  // series' datetime-labeled points, for the whole rest of forward
  // playback rather than just the rewind beat. `formatDateTime` already
  // delegates to `formatDate` unconditionally for a plain-date point
  // (`includeDate` is simply ignored in that branch), so this is a safe,
  // zero-behavior-change swap for the window model and the correct
  // multi-day-aware format ("Aug 21, 9:30 AM") for the chained intraday
  // case -- `true` is always the right value here, since a single day in
  // isolation is never what this hook walks; only multi-day window/
  // whole-range series are.
  //
  // Clamped to `[1, points.length]` (code review finding) -- `revealedCount`
  // is fully internal state, always set by this hook's own `setFrame`
  // calls, but today that stays in range only via an emergent
  // combination of independently-maintained invariants elsewhere
  // (`play()`'s own `points.length < 2` guard, `buildSegments`'s
  // 1-indexed loop), not one explicit check at this read site -- the
  // same "emergent, not enforced" gap `PortfolioChart.tsx`'s own
  // `revealedCount` prop had before its own code-review fix (see that
  // component's `revealed` local's own doc comment, issue #96 follow-up
  // round four). A future change that lets `phase` reach `"playing"`
  // without going through `play()`'s guard, or that weakens
  // `useResetWhenChanged`'s reset condition, would otherwise crash this
  // derivation on `undefined.date` mid-render with no defensive catch
  // (unlike the RAF `tick()`'s own corrupted-price path, which does
  // catch the analogous risk) -- this clamp makes the same invariant
  // `PortfolioChart.tsx` already enforces real here too, regardless of
  // what a future change to this hook does to `frame.revealedCount`.
  const displayDate = useMemo(() => {
    if (phase === "rewinding") return rewindTweenDate;
    if (phase !== "playing") return null;
    const index = Math.min(Math.max(frame.revealedCount, 1), points.length) - 1;
    return formatDateTime(points[index]!.date, true);
  }, [phase, points, frame.revealedCount, rewindTweenDate]);

  return { phase, frame, displayDate, play, skipToEnd, completedRuns };
}
