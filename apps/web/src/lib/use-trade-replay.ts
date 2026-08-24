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

import { useCallback, useEffect, useState } from "react";

import { tweenValue } from "./easing";
import { formatEpochAsDate } from "./format-date";
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

// Tuned by feel (per the issue's own scope note: "roughly 3-6 seconds for
// a typical 1-3 trade window... doesn't need to be exact") against
// derivePortfolioSeries's own point shape: 3 points per trade
// (open/flat/close) plus a leading and trailing boundary point. A
// 1-trade window plays in ~2.4s, a 3-trade window in ~6.6s.
const TRANSITION_MS = 300;
const EVENT_PAUSE_MS = 600;
// Per the issue's own scope note ("~0.6-1s") -- brief enough to read as
// an intro beat, not its own event to sit through.
const REWIND_MS = 700;

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
   * The backward-ticking date readout for the `"rewinding"` phase
   * (issue #97) -- a formatted date string ("Aug 21, 2025") while
   * `phase === "rewinding"`, `null` in every other phase. Deliberately
   * not folded into `ReplayFrame`: it has nothing to do with the trade
   * walk `ReplayFrame` describes (no revealedCount/currentValue/
   * activeEvent meaning applies during a rewind), so giving it its own
   * top-level field keeps `ReplayFrame` describing exactly one thing.
   */
  rewindDate: string | null;
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
 * doesn't touch `frame` at all (see `rewindDate`'s own doc comment for
 * why it's a separate top-level field, not folded into `ReplayFrame`).
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
 */
export function useTradeReplay(points: readonly PortfolioPoint[]): UseTradeReplayResult {
  const [phase, setPhase] = useState<ReplayPhase>("idle");
  const [frame, setFrame] = useState<ReplayFrame>(() => initialFrame(points));
  // Non-null only while phase === "rewinding" -- see UseTradeReplayResult's
  // own rewindDate doc comment.
  const [rewindDate, setRewindDate] = useState<string | null>(null);
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
    setRewindDate(null);
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
      setRewindDate(null);
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

    const targetEpoch = Date.parse(`${points[0]!.date}T00:00:00Z`);
    const startEpoch = Date.now();
    const startTime = performance.now();
    let frameId: number;

    function tick(now: number) {
      const elapsed = now - startTime;
      const t = Math.min(elapsed / REWIND_MS, 1);
      setRewindDate(formatEpochAsDate(tweenValue(startEpoch, targetEpoch, t)));
      if (t >= 1) {
        setPhase("playing");
        return;
      }
      frameId = requestAnimationFrame(tick);
    }

    frameId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frameId);
  }, [phase, points]);

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
        const t = Math.min(elapsed / TRANSITION_MS, 1);
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
      } else if (elapsed < EVENT_PAUSE_MS) {
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
        setFrame(finalFrame(points));
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
  }, [phase, points]);

  return { phase, frame, rewindDate, play, skipToEnd, completedRuns };
}
