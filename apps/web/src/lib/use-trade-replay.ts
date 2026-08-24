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
import type { PortfolioEvent, PortfolioPoint } from "./portfolio-series";
import { computeTradeReturn, type TradeReturn } from "./trade-math";

export type ReplayPhase = "idle" | "playing" | "done";

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
  /** Starts (or restarts, from "done") playback from the very beginning. */
  play: () => void;
  /** Jumps straight to the final state and marks playback "done" -- always available during playback, per the issue's own "give me the answer fast" scope note. */
  skipToEnd: () => void;
}

/**
 * A small explicit state machine (idle -> playing -> done), following the
 * same style as use-results.ts's own ResultsState, driven by one RAF
 * loop. `play`/`skipToEnd` are plain functions meant to be called from a
 * button's onClick, not from an effect body -- calling setState
 * synchronously inside them doesn't trip react-hooks/set-state-in-effect,
 * which only reaches setState calls in an effect's own body. The RAF
 * loop itself follows useCountUp's established shape: the effect below
 * only ever *schedules* a frame; every setState call happens inside the
 * frame callback itself (a callback invoked by an external system, the
 * pattern the lint recommends).
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
 * `runId` is real React state (not a ref) specifically so `play()` is
 * safe to call even while `phase` is already `"playing"` (not reachable
 * via the shipped UI today -- the button that calls `play()` is hidden
 * while playing -- but a real bug in this hook's own public API,
 * code-review found and fixed): bumping `phase` from `"playing"` to
 * `"playing"` again is a no-op by React's own `Object.is` bail-out, so
 * without a second, always-genuinely-different value in the effect's
 * dependency array, the effect below would never restart and no RAF
 * loop would be left to advance the freshly-reset `frame`. Every
 * `play()`/`skipToEnd()` call bumps `runId`, which *always* differs
 * from its previous value, guaranteeing the effect's cleanup
 * (`cancelAnimationFrame`) tears down any prior loop and a fresh one
 * starts -- the same "force a restart via a real dependency, not a
 * value that might legitimately repeat" fix use-trade-replay.ts's own
 * points-reference reset (below) already relies on for a different
 * trigger. No separate "is this tick stale?" check is needed inside
 * `tick` any more either, now that every genuine restart is guaranteed
 * to actually cancel the previous loop via the effect's own cleanup --
 * the earlier `runIdRef`-based version needed that check only because a
 * same-value `phase` update couldn't force a restart at all.
 */
export function useTradeReplay(points: readonly PortfolioPoint[]): UseTradeReplayResult {
  const [phase, setPhase] = useState<ReplayPhase>("idle");
  const [frame, setFrame] = useState<ReplayFrame>(() => initialFrame(points));
  const [runId, setRunId] = useState(0);

  const play = useCallback(() => {
    if (points.length < 2) return;
    setRunId((id) => id + 1);
    setFrame(initialFrame(points));
    setPhase("playing");
  }, [points]);

  const skipToEnd = useCallback(() => {
    setRunId((id) => id + 1);
    setFrame(finalFrame(points));
    setPhase("done");
  }, [points]);

  // If `points` changes identity while a replay is mid-flight (or just
  // finished) -- a live starting-capital edit or a ModeToggle switch,
  // both of which recompute ResultsPanel's own `points` memo without
  // unmounting `TradeReplay` -- treat it as a fresh mount rather than
  // silently rebuilding `segments` under the effect below while `frame`
  // still holds stale mid-playback values from the *old* points. The
  // effect's own `[phase, points, runId]` dependency array already
  // restarts `segmentIndex`/`phaseStart` from scratch in that case
  // regardless (and its cleanup's `cancelAnimationFrame` already stops
  // the old points' in-flight loop before the new effect body ever
  // runs); without this reset, `frame` wouldn't catch up until the next
  // tick fires, and even then would resume mid-walk through data that no
  // longer matches what's on screen -- visibly snapping the chart/hero
  // backward and re-narrating an already-shown trade with no indication
  // anything reset. Resetting to "idle" here (not "done") means the
  // user sees the plain, real hero row/chart again and a fresh "Watch
  // it happen" button, exactly as if this were the first time -- the
  // same "adjust state during render when a prop changes" idiom
  // `use-results.ts`'s own `trackedUrl` check and `use-range-guess.ts`'s
  // `tracked` check already use, so this stays lint-safe (a plain
  // render-time setState, not one inside an effect body) and needs no
  // extra render before it applies.
  const [trackedPoints, setTrackedPoints] = useState(points);
  if (points !== trackedPoints) {
    setTrackedPoints(points);
    if (phase !== "idle") {
      setPhase("idle");
      setFrame(initialFrame(points));
    }
  }

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
        return;
      }
      subPhase = "tween";
      phaseStart = now;
      frameId = requestAnimationFrame(tick);
    }

    frameId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frameId);
  }, [phase, points, runId]);

  return { phase, frame, play, skipToEnd };
}
