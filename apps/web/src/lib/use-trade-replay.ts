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

import { useCallback, useEffect, useRef, useState } from "react";

import { easeOutCubic } from "./easing";
import type { PortfolioEvent, PortfolioPoint } from "./portfolio-series";
import { computeTradeReturn, type TradeReturn } from "./trade-math";

export type ReplayPhase = "idle" | "playing" | "done";

/** One trade-event pause during playback (see TradeReplay.tsx for the callout this renders as). */
export interface ReplayEvent {
  point: PortfolioPoint;
  event: PortfolioEvent;
  /**
   * This trade's own return, computed from the matching prior "open"
   * event's price (see findMatchingOpenPrice below) -- present only for
   * a "close" event; `null` for an "open" event (nothing to compare
   * against yet) and defensively if no matching open point is somehow
   * found.
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

/** The frame a completed (or aborted-to-completion) replay lands on -- every point revealed, the true final value, no active callout. Shared by `skipToEnd` and `tick`'s own defensive catch (see its doc comment) so both "jump to the end" paths agree on exactly the same shape. */
function finalFrame(points: readonly PortfolioPoint[]): ReplayFrame {
  const last = points[points.length - 1];
  return {
    revealedCount: points.length,
    currentValue: last?.value ?? 0,
    activeEvent: null,
  };
}

/**
 * Scans backward from `closeIndex` for the nearest point carrying an
 * "open" event -- the trade this close event belongs to. Safe to assume
 * it's the *same* trade (not some earlier one) because
 * derivePortfolioSeries's own appendTradeSteps never interleaves trades:
 * each trade contributes its own open/flat/close points strictly in
 * sequence before the next trade's own points begin (see that module's
 * header comment).
 */
function findMatchingOpenPrice(
  points: readonly PortfolioPoint[],
  closeIndex: number,
): number | null {
  for (let i = closeIndex - 1; i >= 0; i--) {
    const event = points[i]!.event;
    if (event?.type === "open") return event.price;
  }
  return null;
}

interface Segment {
  fromValue: number;
  toValue: number;
  toIndex: number;
  event: PortfolioEvent | null;
}

function buildSegments(points: readonly PortfolioPoint[]): Segment[] {
  const segments: Segment[] = [];
  for (let i = 1; i < points.length; i++) {
    segments.push({
      fromValue: points[i - 1]!.value,
      toValue: points[i]!.value,
      toIndex: i,
      event: points[i]!.event,
    });
  }
  return segments;
}

function replayEventFor(points: readonly PortfolioPoint[], segment: Segment): ReplayEvent | null {
  if (!segment.event) return null;
  let tradeReturn: TradeReturn | null = null;
  if (segment.event.type === "close") {
    const openPrice = findMatchingOpenPrice(points, segment.toIndex);
    if (openPrice !== null) {
      tradeReturn = computeTradeReturn(openPrice, segment.event.price, segment.event.direction);
    }
  }
  return { point: points[segment.toIndex]!, event: segment.event, tradeReturn };
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
 */
export function useTradeReplay(points: readonly PortfolioPoint[]): UseTradeReplayResult {
  const [phase, setPhase] = useState<ReplayPhase>("idle");
  const [frame, setFrame] = useState<ReplayFrame>(() => initialFrame(points));
  // Bumped on every play()/skipToEnd() so a stale in-flight RAF loop from
  // a *previous* play() (e.g. a fast Replay double-click) recognizes
  // it's no longer current and stops scheduling further frames -- the
  // same "ignore a stale response" shape use-results.ts's own fetch
  // cancellation uses.
  const runIdRef = useRef(0);

  const play = useCallback(() => {
    if (points.length < 2) return;
    runIdRef.current += 1;
    setFrame(initialFrame(points));
    setPhase("playing");
  }, [points]);

  const skipToEnd = useCallback(() => {
    runIdRef.current += 1;
    setFrame(finalFrame(points));
    setPhase("done");
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
  // points' in-flight loop before the new effect body ever runs, so
  // there's no need to also bump `runIdRef` here -- doing that would
  // mean writing a ref during render, which `react-hooks/refs` rightly
  // flags); without this reset, `frame` wouldn't catch up until the next
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

    const runId = runIdRef.current;
    let frameId: number;
    let segmentIndex = 0;
    // "tween" (animating currentValue toward the segment's target) or
    // "pause" (holding on an event's callout).
    let subPhase: "tween" | "pause" = "tween";
    let phaseStart = performance.now();

    function tick(now: number) {
      if (runIdRef.current !== runId) return; // superseded by a later play()/skipToEnd()

      // Defensive -- play() already guards points.length < 2 (so
      // segments.length >= 1) before ever setting phase to "playing",
      // but this check lives inside the RAF callback rather than
      // before scheduling it so a setPhase call here is always inside a
      // callback from an external system (requestAnimationFrame), the
      // shape react-hooks/set-state-in-effect wants -- see
      // use-count-up.ts's own identical reasoning for its own
      // reduced-motion branch.
      if (segments.length === 0) {
        setPhase("done");
        return;
      }

      const segment = segments[segmentIndex]!;
      const elapsed = now - phaseStart;

      if (subPhase === "tween") {
        const t = Math.min(elapsed / TRANSITION_MS, 1);
        if (t < 1) {
          setFrame({
            revealedCount: segment.toIndex,
            currentValue:
              segment.fromValue + (segment.toValue - segment.fromValue) * easeOutCubic(t),
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
          replayEvent = replayEventFor(points, segment);
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
        setPhase("done");
        return;
      }
      subPhase = "tween";
      phaseStart = now;
      frameId = requestAnimationFrame(tick);
    }

    frameId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frameId);
  }, [phase, points]);

  return { phase, frame, play, skipToEnd };
}
