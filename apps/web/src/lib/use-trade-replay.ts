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
//
// Issue #118 generalizes this hook's internal walk to a second,
// pluggable segment-builder (`segmentMode`, below) -- a day/chunk-based
// reveal for 1M/3M/1Y's whole-range replay, whose worst-case trade
// counts (up to ~750) are far too large for the original per-point walk
// to stay watchable (see docs/plans/issue-106-plan.md section 2 for the
// worked numbers). Every other piece of this hook (the phase machine,
// the rewind intro beat, skipToEnd, the points-identity reset,
// completedRuns) is genuinely segment-shape-agnostic and needed zero
// changes -- see this file's own git history/apps/web/CLAUDE.md for the
// full reasoning already established for that claim.

import { useCallback, useEffect, useMemo, useState } from "react";

import { tweenValue } from "./easing";
import { formatDateTime, formatEpochAsDate, toPortfolioTimestamp } from "./format-date";
import { calendarDayOf } from "./portfolio-series";
import type { PortfolioEvent, PortfolioPoint } from "./portfolio-series";
import { prefersReducedMotion } from "./prefers-reduced-motion";
import { computeTradeReturn, type TradeReturn } from "./trade-math";
import { useResetWhenChanged } from "./use-reset-when-changed";

export type ReplayPhase = "idle" | "rewinding" | "playing" | "done";

/**
 * Which segment-builder useTradeReplay walks with (issue #118).
 * `"point"` (the default, and the only mode before this issue): every
 * real point pauses on its own trade event, via buildPointSegments below
 * -- unchanged from the original #96/#97/#105/#107/#108 behavior, still
 * what the window model (TradeReplay.tsx) and 1W's own whole-range
 * replay use. `"chunk"`: points are grouped into day clusters and capped
 * to at most NUM_CHUNKS reveal steps regardless of how many real trading
 * days the range spans, via buildChunkSegments below -- see
 * docs/plans/issue-106-plan.md section 3.1 for the full mechanism this
 * implements. 1M/3M/1Y's own worst-case trade counts (up to ~750, see
 * that plan's own section 2) are too large for per-event pacing alone to
 * stay watchable; 1W's own worst case (15 trades) isn't, so it stays on
 * "point".
 */
export type ReplaySegmentMode = "point" | "chunk";

/**
 * Whether `phase` represents the real, live, un-animated view (idle or
 * done) -- shared between `TradeReplay.tsx` and `WholeRangeReplay.tsx`
 * (issue #105 code review finding), which each independently re-derived
 * this exact two-value check as their own `showLive` local. Worth
 * sharing specifically because `TradeReplay.tsx`'s own history already
 * needed this precise expression fixed once (round two's own "Skip to
 * end" gating fix used `!showLive` in place of a second, independently-
 * written complement expression for the same reason) -- a second
 * independent copy is exactly the kind of thing that class of fix is
 * meant to prevent from recurring.
 */
export function isReplayLive(phase: ReplayPhase): boolean {
  return phase === "idle" || phase === "done";
}

/**
 * The idle/done "Watch it happen"/"Replay" button's own core gate --
 * shared between `TradeReplay.tsx` and `WholeRangeReplay.tsx` (issue
 * #105 code review finding). A caller with its own additional gate on
 * top (e.g. `WholeRangeReplay.tsx`'s own `replaySupported` restriction)
 * ANDs that extra condition alongside this function's result, rather
 * than this function growing a parameter for every caller's own
 * scope-specific rule.
 */
export function canReplayFor(tradeCount: number, reducedMotionAtMount: boolean): boolean {
  return tradeCount > 0 && !reducedMotionAtMount;
}

/** One trade-event pause during playback (see TradeReplay.tsx for the callout this renders as). Built by both segment modes -- point mode for every real event, chunk mode only for the one-day/one-trade degenerate chunk (see buildChunkLanding's own doc comment). */
export interface ReplayEvent {
  point: PortfolioPoint;
  event: PortfolioEvent;
  /**
   * This trade's own return, computed from the matching prior "open"
   * event's price -- present only for a "close" event; `null` for an
   * "open" event (nothing to compare against yet) and defensively if no
   * matching open point is somehow found.
   */
  tradeReturn: TradeReturn | null;
}

/**
 * A day/chunk-based reveal's own pause data for a genuine multi-trade
 * chunk (issue #118, 1M/3M/1Y's chunked whole-range replay) -- narrated
 * by lib/replay-callout.ts's `chunkSummaryText`, a distinct, deliberately
 * less granular register than the single-trade `calloutText` voice: a
 * chunk can span up to `chunkDayCount * maxTradesPerDay` trades, and
 * narrating each individually inside one pause would be an unreadable
 * blur, not "watch it happen." The one-day/one-trade degenerate case
 * never produces one of these -- see `buildChunkLanding`'s own doc
 * comment for why that case reuses `ReplayEvent`/`calloutText` instead.
 */
export interface ChunkSummary {
  /** This chunk's first day (calendar date, "YYYY-MM-DD"). */
  startDate: string;
  /** This chunk's last day (calendar date, "YYYY-MM-DD") -- equal to startDate for a single-day chunk (1M's common case, since NUM_CHUNKS comfortably exceeds its own ~21 trading days). */
  endDate: string;
  /** Total real trades across every day this chunk spans. */
  tradeCount: number;
  /** Portfolio value entering this chunk. */
  startValue: number;
  /** Portfolio value at the end of this chunk. */
  endValue: number;
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
  /** The single real trade event playback is currently pausing on to show a callout, or null between pauses -- point mode's only pause shape, and chunk mode's shape too for the one-day/one-trade degenerate case (see ChunkSummary's own doc comment). */
  activeEvent: ReplayEvent | null;
  /**
   * The multi-trade chunk summary playback is currently pausing on
   * (chunk segment mode only, issue #118) -- always `null` in point
   * mode, and `null` in chunk mode too except during the pause after a
   * genuine multi-trade chunk lands. Mutually exclusive with
   * `activeEvent`: a pause is either a single real trade event or a
   * chunk summary, never both.
   */
  activeChunk: ChunkSummary | null;
}

/**
 * How fast this hook's two RAF loops move -- `transitionMs` per segment
 * tween, `eventPauseMs` per pause (a single trade event in point mode, a
 * chunk's own pause in chunk mode -- issue #118's own chunk-level
 * constants are literal instances of this same shape, not a separate ad
 * hoc constant pair), `rewindMs` for the whole rewind-intro-beat tween
 * (issue #97). A module-level parameter (issue #105), not module-level
 * constants baked into the RAF effects directly, so a caller walking a
 * materially larger point series (1W's whole-range chained intraday
 * series, up to 50 points/49 segments/30 event-pauses worst case; 1M/3M/
 * 1Y's own chunked walk, capped to at most NUM_CHUNKS reveal steps
 * regardless of point count -- see docs/plans/issue-106-plan.md sections
 * 2/3.1 for both derivations) can use tighter pacing without forking
 * this hook.
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

// Chunk segment mode's own cap (issue #118) -- at most this many reveal
// steps regardless of how many real trading days a range spans, per
// docs/plans/issue-106-plan.md section 3.1: `chunkCount =
// min(dayGroups.length, NUM_CHUNKS)`, each chunk holding
// `ceil(dayGroups.length / chunkCount)` consecutive day groups. Tuned by
// feel (this repo's own established precedent for a pacing-adjacent
// constant -- see DEFAULT_PACING's own comment): 1M's ~21 trading days
// stay under this cap (one chunk per day, for free); 3M's ~62 and 1Y's
// ~250 both exceed it and land on the identical worst-case chunk *count*
// by construction, not coincidence -- see that plan section for the full
// "why not a per-range-tuned pause budget instead" reasoning.
const NUM_CHUNKS = 30;

function initialFrame(points: readonly PortfolioPoint[]): ReplayFrame {
  return {
    revealedCount: Math.min(1, points.length),
    currentValue: points[0]?.value ?? 0,
    activeEvent: null,
    activeChunk: null,
  };
}

/** The frame a completed (or aborted-to-completion) replay lands on -- every point revealed, the true final value, no active callout. Shared by `skipToEnd`, natural completion, and `tick`'s own defensive catch (see each call site) so every "reached the end" path agrees on exactly the same shape. */
function finalFrame(points: readonly PortfolioPoint[]): ReplayFrame {
  const last = points[points.length - 1];
  return {
    revealedCount: points.length,
    currentValue: last?.value ?? 0,
    activeEvent: null,
    activeChunk: null,
  };
}

/**
 * One reveal step in either segment mode -- a generalization (issue
 * #118) of the original point-mode-only `Segment` type, unified so both
 * `buildPointSegments` and `buildChunkSegments` below can drive the same
 * `tick()` RAF loop. Private to this module (never exported) -- the
 * *public* per-pause shapes (`ReplayEvent`/`ChunkSummary`) are what
 * every other file actually consumes, via `ReplayFrame.activeEvent`/
 * `activeChunk`.
 */
interface WalkSegment {
  fromValue: number;
  toValue: number;
  /** revealedCount to show while this segment's own value tween is in flight. */
  tweenRevealedCount: number;
  /**
   * revealedCount once this segment fully lands (the tween completes,
   * and -- if it pauses -- the pause elapses). Point mode: one more than
   * `tweenRevealedCount` (the point itself isn't "revealed" until its
   * own tween finishes, matching the original #96 behavior exactly).
   * Chunk mode: identical to `tweenRevealedCount` -- a chunk's whole
   * point range jumps in at once, per docs/plans/issue-106-plan.md
   * section 3.1 step 3(a) ("revealedCount jumps straight to the chunk's
   * last point... only the display figure tweens").
   */
  landedRevealedCount: number;
  /**
   * `null` = no pause, advance immediately once the tween lands (a plain
   * point with no event in point mode; a chunk with zero real trades in
   * chunk mode -- the "skippable/fast-forwarded no-trade days" behavior
   * the issue names literally). Non-null = pause and call this to build
   * the frame's `activeEvent`/`activeChunk`. Deferred (not called while
   * building the segment list) because it can throw -- point mode's
   * existing corrupted-stored-price defensive catch, also reachable via
   * chunk mode's own one-day/one-trade degenerate case, which computes a
   * real trade return the identical way -- and a throw here must be
   * caught from inside the RAF loop (see `tick()`'s own try/catch), not
   * while eagerly building every segment upfront.
   */
  buildLanding: (() => SegmentLanding) | null;
}

type SegmentLanding =
  { kind: "event"; replayEvent: ReplayEvent } | { kind: "chunk"; summary: ChunkSummary };

/** Builds a `ReplayEvent` from a point's own event and (for a close) the matching prior open's price -- shared by both segment builders below (point mode's every real event; chunk mode's one-day/one-trade degenerate case). */
function buildReplayEvent(
  point: PortfolioPoint,
  event: PortfolioEvent,
  openPriceForClose: number | null,
): ReplayEvent {
  const tradeReturn =
    event.type === "close" && openPriceForClose !== null
      ? computeTradeReturn(openPriceForClose, event.price, event.direction)
      : null;
  return { point, event, tradeReturn };
}

/**
 * The original, per-point walk (issues #96/#105) -- every real point
 * pauses on its own event, via `buildReplayEvent` above. Unchanged
 * behavior from before issue #118 (only the internal `Segment` ->
 * `WalkSegment` shape changed, to unify with `buildChunkSegments`
 * below); still what the window model and 1W's own whole-range replay
 * use.
 */
function buildPointSegments(points: readonly PortfolioPoint[]): WalkSegment[] {
  const segments: WalkSegment[] = [];
  let lastOpenPrice: number | null = null;

  for (let i = 1; i < points.length; i++) {
    const point = points[i]!;
    const event = point.event;
    if (event?.type === "open") {
      lastOpenPrice = event.price;
    }
    const openPriceForClose = event?.type === "close" ? lastOpenPrice : null;

    segments.push({
      fromValue: points[i - 1]!.value,
      toValue: point.value,
      tweenRevealedCount: i,
      landedRevealedCount: i + 1,
      buildLanding: event
        ? () => ({ kind: "event", replayEvent: buildReplayEvent(point, event, openPriceForClose) })
        : null,
    });
  }

  return segments;
}

interface DayGroupTrade {
  closePoint: PortfolioPoint;
  closeEvent: PortfolioEvent;
  openPrice: number;
}

interface DayGroup {
  /** This day's calendar date (calendarDayOf(point.date)). */
  date: string;
  /** Index into `points` of this day group's own last point. */
  endIndex: number;
  trades: DayGroupTrade[];
}

/**
 * Groups `points` into consecutive calendar-day clusters (issue #118,
 * docs/plans/issue-106-plan.md section 3.1 step 1), reusing
 * portfolio-series.ts's own `calendarDayOf` -- no new pipeline field and
 * no change to `deriveWholeRangeIntradaySeries` needed, since every
 * point it produces already carries a real calendar day this way. A
 * single forward pass also collects each day's own completed trades
 * (tracking "the most recently seen open price" exactly the way
 * `buildPointSegments` above does, since a day's own trades never
 * interleave -- see portfolio-series.ts's own header comment) so
 * `buildChunkSegments` below needs no second pass or any raw
 * `IntradayTrade[]` data of its own; `points` alone is enough.
 *
 * Deliberately not shared with `chart-scales.ts`'s own day-bucketing
 * (`buildChainedIntradayXPositions`, issue #93), despite both grouping
 * points by `calendarDayOf` -- that function only needs each day's pixel
 * span for x-axis layout, this one needs each day's own trade list, and
 * the two turned out to not be structurally identical once written (the
 * plan's own section 3.1 flagged this as a real implementation-time call
 * either way).
 */
function groupPointsIntoDayGroups(points: readonly PortfolioPoint[]): DayGroup[] {
  const groups: DayGroup[] = [];
  let lastOpenPrice: number | null = null;

  for (let index = 0; index < points.length; index++) {
    const point = points[index]!;
    const day = calendarDayOf(point.date);
    let group = groups[groups.length - 1];
    if (!group || group.date !== day) {
      group = { date: day, endIndex: index, trades: [] };
      groups.push(group);
    } else {
      group.endIndex = index;
    }

    const event = point.event;
    if (event?.type === "open") {
      lastOpenPrice = event.price;
    } else if (event?.type === "close" && lastOpenPrice !== null) {
      group.trades.push({ closePoint: point, closeEvent: event, openPrice: lastOpenPrice });
    }
  }

  return groups;
}

/**
 * Decides what a chunk's own pause shows (issue #118, plan section 3.1
 * steps 3(b)/(c)) -- `null` for a chunk with zero real trades (advance
 * immediately, no pause). For a chunk with at least one trade, the "free
 * degenerate case" the plan's own section 1/3.1 calls out: a chunk that
 * happens to contain exactly one day with exactly one trade (the common
 * shape for 1M, where the day cap always exceeds 1M's own ~21 trading
 * days, so every chunk defaults to a single day) falls through to the
 * *existing*, real, shared single-trade `ReplayEvent`/`calloutText`
 * voice unchanged -- not a hypothetical reuse, this literally builds the
 * same `ReplayEvent` shape point mode does, via the same
 * `buildReplayEvent` helper. Only a genuine multi-trade chunk (more than
 * one trade, or a single trade spanning more than one day group within
 * the chunk) gets the new `ChunkSummary` voice -- narrating up to
 * `chunkDayCount * maxTradesPerDay` trades individually inside one pause
 * would be an unreadable blur, not "watch it happen."
 */
function buildChunkLanding(
  dayGroups: readonly DayGroup[],
  trades: readonly DayGroupTrade[],
  startValue: number,
  endValue: number,
): (() => SegmentLanding) | null {
  if (trades.length === 0) return null;

  if (dayGroups.length === 1 && trades.length === 1) {
    const trade = trades[0]!;
    return () => ({
      kind: "event",
      replayEvent: buildReplayEvent(trade.closePoint, trade.closeEvent, trade.openPrice),
    });
  }

  const summary: ChunkSummary = {
    startDate: dayGroups[0]!.date,
    endDate: dayGroups[dayGroups.length - 1]!.date,
    tradeCount: trades.length,
    startValue,
    endValue,
  };
  return () => ({ kind: "chunk", summary });
}

/**
 * The day/chunk-based walk (issue #118, plan section 3.1 steps 1-3):
 * groups `points` into day clusters (`groupPointsIntoDayGroups` above),
 * clusters those into at most `NUM_CHUNKS` chunks (`chunkCount =
 * min(dayGroups.length, NUM_CHUNKS)`, each chunk holding
 * `ceil(dayGroups.length / chunkCount)` consecutive day groups), and
 * builds one `WalkSegment` per chunk -- `fromValue`/`toValue` spanning
 * the chunk's own start/end portfolio value, `tweenRevealedCount`/
 * `landedRevealedCount` both jumping straight to the chunk's own last
 * point (see `WalkSegment.landedRevealedCount`'s own doc comment for
 * why chunk mode's two revealedCount fields are identical, unlike point
 * mode's).
 */
function buildChunkSegments(points: readonly PortfolioPoint[]): WalkSegment[] {
  const dayGroups = groupPointsIntoDayGroups(points);
  if (dayGroups.length === 0) return [];

  const chunkCount = Math.min(dayGroups.length, NUM_CHUNKS);
  const chunkSize = Math.ceil(dayGroups.length / chunkCount);

  const segments: WalkSegment[] = [];
  let fromValue = points[0]!.value;

  for (let i = 0; i < dayGroups.length; i += chunkSize) {
    const chunkDayGroups = dayGroups.slice(i, i + chunkSize);
    const lastGroup = chunkDayGroups[chunkDayGroups.length - 1]!;
    const toIndex = lastGroup.endIndex;
    const toValue = points[toIndex]!.value;
    const trades = chunkDayGroups.flatMap((group) => group.trades);
    const revealedCount = toIndex + 1;

    segments.push({
      fromValue,
      toValue,
      tweenRevealedCount: revealedCount,
      landedRevealedCount: revealedCount,
      buildLanding: buildChunkLanding(chunkDayGroups, trades, fromValue, toValue),
    });

    fromValue = toValue;
  }

  return segments;
}

/** Dispatches to the right segment-builder for `segmentMode` -- the one place `useTradeReplay`'s own playing effect decides which walk to run. */
function buildWalkSegments(
  points: readonly PortfolioPoint[],
  segmentMode: ReplaySegmentMode,
): WalkSegment[] {
  return segmentMode === "chunk" ? buildChunkSegments(points) : buildPointSegments(points);
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
   *    all, since `revealedCount` already jumps point-to-point (or, in
   *    chunk mode, straight to a whole chunk's own last point -- see
   *    `WalkSegment.landedRevealedCount`'s own doc comment) and there's
   *    nothing to animate between: a "date" between two real trading
   *    days isn't a meaningful intermediate value the way a dollar
   *    figure is. This is computed fresh from `frame`/`points` below
   *    (not written into a `useState` from inside the playing effect's
   *    `tick()`), which is what keeps this always exactly in sync with
   *    `revealedCount` for free -- no separate state to remember to
   *    update at every one of `tick()`'s several `setFrame` call sites.
   *  - `"idle"`/`"done"`: `null` -- deliberately not folded into
   *    `ReplayFrame`: it has nothing to do with the trade walk
   *    `ReplayFrame` describes (no revealedCount/currentValue/
   *    activeEvent/activeChunk meaning applies to a date readout), so
   *    giving it its own top-level field keeps `ReplayFrame` describing
   *    exactly one thing.
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
 *    `revealedCount` grows in whole steps, never interpolating a
 *    position between two points (which would fabricate an interim
 *    mark-to-market price this app's model doesn't have). Point mode
 *    grows it one point at a time, after each point's own tween lands;
 *    chunk mode (issue #118) jumps it straight to a whole chunk's own
 *    last point at the *start* of that chunk's tween -- see
 *    `WalkSegment.landedRevealedCount`'s own doc comment.
 *  - The balance figure (`currentValue`) tweens between a segment's two
 *    real endpoint values. In point mode most segments have an
 *    identical start/end value (the open -> flat -> close shape holds
 *    flat through a trade's entire holding period), so only the
 *    segments landing on a trade's close actually move; in chunk mode
 *    every chunk's own tween moves from its starting value to its
 *    ending value regardless of how many (if any) trades it contains.
 *
 * Playback pauses for `pacing.eventPauseMs` once it lands on a segment
 * that has something to show -- point mode: a real open/close event;
 * chunk mode: a chunk containing at least one real trade (the
 * "skippable/fast-forwarded no-trade days" behavior the issue names
 * literally is exactly a chunk with zero trades never pausing at all).
 * The orchestrating component (TradeReplay.tsx/WholeRangeReplay.tsx)
 * reads `frame.activeEvent`/`frame.activeChunk` to show a narrated
 * callout during that pause.
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
 * "idempotent" the original round-two fix was named for. No `runId`
 * needed, and no "is this tick stale?" check inside either `tick`
 * either -- each effect's own dependency array still forces a genuine
 * restart (and its cleanup's `cancelAnimationFrame` still tears down
 * the prior loop first) on every *real* transition, which is now the
 * only kind `play()`/`skipToEnd()` ever produce.
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
 * `WholeRangeReplay.tsx`'s own `WHOLE_RANGE_REPLAY_PACING`/
 * `CHUNKED_WHOLE_RANGE_REPLAY_PACING`), so this is satisfied today by
 * construction, not by extra bookkeeping.
 *
 * **`segmentMode` (issue #118)** picks which segment-builder the playing
 * effect below walks with -- see `ReplaySegmentMode`'s own doc comment.
 * Expected to be stable per caller (a given `WholeRangeReplay` instance
 * always passes the same mode for its own range group), so it isn't
 * folded into `useResetWhenChanged`'s own points-identity reset the way
 * `points` is -- only `points`/`pacing`/`segmentMode` together determine
 * the playing effect's own dependency array, forcing a genuine restart
 * on any real change to any of the three.
 */
export function useTradeReplay(
  points: readonly PortfolioPoint[],
  pacing: ReplayPacing = DEFAULT_PACING,
  segmentMode: ReplaySegmentMode = "point",
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
  // effect's own `[phase, points, pacing, segmentMode]` dependency array
  // already restarts `segmentIndex`/`phaseStart` from scratch in that
  // case regardless (and its cleanup's `cancelAnimationFrame` already
  // stops the old points' in-flight loop before the new effect body ever
  // runs); without this reset, `frame` wouldn't catch up until the next
  // tick fires, and even then would resume mid-walk through data that no
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
    // but not for a chained-intraday series (1W/1M/3M/1Y's whole-range
    // replay): a datetime-labeled point ("2025-08-21T09:30:00") produced
    // a malformed double-`T` string ("2025-08-21T09:30:00T00:00:00Z"),
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
        // before its first tick recomputes it.
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
  // `[phase, points, pacing, segmentMode]` change. Left un-extracted; only
  // `tweenValue`'s own curve math (lib/easing.ts) is actually shared
  // between them.
  useEffect(() => {
    if (phase !== "playing") return;

    const segments = buildWalkSegments(points, segmentMode);

    let frameId: number;
    let segmentIndex = 0;
    // "tween" (animating currentValue toward the segment's target) or
    // "pause" (holding on a landed event/chunk's callout).
    let subPhase: "tween" | "pause" = "tween";
    let phaseStart = performance.now();

    function tick(now: number) {
      // segments.length is always >= 1 here -- play() already guards
      // points.length < 2 (so both segment-builders always produce at
      // least one segment) before ever setting phase to "playing", the
      // only way this effect ever runs.
      const segment = segments[segmentIndex]!;
      const elapsed = now - phaseStart;

      if (subPhase === "tween") {
        const t = Math.min(elapsed / pacing.transitionMs, 1);
        if (t < 1) {
          setFrame({
            revealedCount: segment.tweenRevealedCount,
            currentValue: tweenValue(segment.fromValue, segment.toValue, t),
            activeEvent: null,
            activeChunk: null,
          });
          frameId = requestAnimationFrame(tick);
          return;
        }

        // `segment.buildLanding` (a real ReplayEvent, via
        // computeTradeReturn -- point mode's every close event, and
        // chunk mode's one-day/one-trade degenerate case) can throw
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
        let landing: SegmentLanding | null = null;
        if (segment.buildLanding) {
          try {
            landing = segment.buildLanding();
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
        }
        setFrame({
          revealedCount: segment.landedRevealedCount,
          currentValue: segment.toValue,
          activeEvent: landing?.kind === "event" ? landing.replayEvent : null,
          activeChunk: landing?.kind === "chunk" ? landing.summary : null,
        });
        if (landing) {
          subPhase = "pause";
          phaseStart = now;
          frameId = requestAnimationFrame(tick);
          return;
        }
        // No landing on this segment -- fall through to advance
        // immediately, in the same tick, rather than scheduling a whole
        // extra frame just to notice there's nothing to pause for.
      } else if (elapsed < pacing.eventPauseMs) {
        frameId = requestAnimationFrame(tick);
        return;
      }

      segmentIndex += 1;
      if (segmentIndex >= segments.length) {
        // Natural completion must land on exactly the same frame shape
        // skipToEnd/the corrupted-price catch above already produce
        // (every point revealed, the true final value, no lingering
        // activeEvent/activeChunk from whatever the last segment paused
        // on) -- also clears the internal rewind-tween state here, the
        // same hygiene skipToEnd already applies, for the *next* rewind
        // (this state feeds displayDate only while phase === "rewinding",
        // so it's not required to satisfy displayDate's own "null in
        // idle/done" contract, which the derivation below already
        // guarantees regardless -- just hygiene for a future "Replay").
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
  }, [phase, points, pacing, segmentMode]);

  // The one field UseTradeReplayResult actually exposes for the date
  // readout (issue #107) -- see its own doc comment for the full
  // per-phase reasoning. Derived fresh from `frame`/`points` rather than
  // written into a state of its own for the "playing" branch: `frame` is
  // already the single source of truth for "which point is currently
  // revealed" (`revealedCount`), so reading `points[revealedCount -
  // 1].date` straight from it can never drift out of sync the way a
  // second, independently-`setState`'d value could. Works identically
  // for chunk mode (issue #118): `revealedCount` there just jumps in
  // bigger leaps, straight to a chunk's own last point, so this reads as
  // "the end date of whichever chunk is currently revealed" -- still a
  // real, meaningful date with no separate handling needed.
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
  // (`play()`'s own `points.length < 2` guard, both segment-builders'
  // own construction), not one explicit check at this read site. A
  // future change that lets `phase` reach `"playing"` without going
  // through `play()`'s guard, or that weakens `useResetWhenChanged`'s
  // reset condition, would otherwise crash this derivation on
  // `undefined.date` mid-render with no defensive catch (unlike the RAF
  // `tick()`'s own corrupted-price path, which does catch the analogous
  // risk) -- this clamp makes the same invariant `PortfolioChart.tsx`
  // already enforces real here too, regardless of what a future change
  // to this hook does to `frame.revealedCount`.
  const displayDate = useMemo(() => {
    if (phase === "rewinding") return rewindTweenDate;
    if (phase !== "playing") return null;
    const index = Math.min(Math.max(frame.revealedCount, 1), points.length) - 1;
    return formatDateTime(points[index]!.date, true);
  }, [phase, points, frame.revealedCount, rewindTweenDate]);

  return { phase, frame, displayDate, play, skipToEnd, completedRuns };
}
