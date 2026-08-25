"use client";

// Portfolio-value-over-time chart, hand-rolled in plain SVG rather than
// pulling in a charting library -- see the dataviz skill's own
// `components.md`, which frames every chart as "assembled in plain
// HTML/SVG" from a small set of primitives. This is a single-series
// step chart with at most 6 markers (buy+sell per trade); a full
// charting library would mean fighting its defaults to match the
// skill's exact mark specs (2px line, hairline gridlines, 8px ring
// markers, log-scale axis) rather than saving any real effort.
//
// Y-axis is log-scaled: portfolio value can span from a $20 start to an
// astronomically large "Max"-range end (packages/core/CLAUDE.md notes a
// ~$716M+ demo run), and a linear axis would render the entire early
// history as indistinguishable from zero.

import { memo, useId, useMemo, useState } from "react";
import type { CSSProperties } from "react";

import { formatAxisCurrency, formatHeroCurrency } from "@/lib/format-currency";
import { formatDateTime, isPortfolioDatetime } from "@/lib/format-date";
import {
  buildChainedIntradayXPositions,
  buildLogScale,
  buildWindowModelXPositions,
  niceLogTicks,
} from "@/lib/chart-scales";
import {
  calendarDayOf,
  spansMultipleDays,
  type PortfolioEvent,
  type PortfolioPoint,
} from "@/lib/portfolio-series";
import { tradeVerbs, tradeVerbsPast } from "@/lib/trade-math";
import { useChartTapHint } from "@/lib/use-chart-tap-hint";
import { useReducedMotionAtMount } from "@/lib/use-reduced-motion-at-mount";
import { useResetWhenChanged } from "@/lib/use-reset-when-changed";

/**
 * Capitalized verb for a marker's own label / the data-table's event
 * column (issue #13): "Buy"/"Short" for an open event, "Sell"/"Cover"
 * for a close event, depending on direction -- standard finance
 * terminology, shared with TradeRow.tsx via trade-math.ts's `tradeVerbs`
 * (code review follow-up: this and TradeRow.tsx's own `verbsFor` used to
 * be two independent copies of the identical wording).
 */
function eventLabelVerb(event: PortfolioEvent): string {
  const { openVerb, closeVerb } = tradeVerbs(event.direction);
  return event.type === "open" ? openVerb : closeVerb;
}

/** Lowercase verb for the hover tooltip's prose ("...bought AAPL at...") -- shared with narrate-trades.ts via trade-math.ts's `tradeVerbsPast` (same code review follow-up as eventLabelVerb above). */
function eventTooltipVerb(event: PortfolioEvent): string {
  const { openVerb, closeVerb } = tradeVerbsPast(event.direction);
  return event.type === "open" ? openVerb : closeVerb;
}

/**
 * What "just landed" during trade replay playback (issue #108) --
 * TradeReplay.tsx computes this from its own useTradeReplay `frame` and
 * hands it down so this component can pulse/shake the matching marker
 * and show its own narration as a speech-bubble callout anchored near
 * it, replacing the plain `<p>` TradeReplay.tsx used to render below the
 * hero row instead.
 */
export interface ChartLanding {
  /**
   * Reference-identifies which marker this is, matched via `===`
   * against each `eventMarkers` entry's own `event` field below -- safe
   * because both this and this component's own `points` ultimately come
   * from the exact same array TradeReplay.tsx passes to both this
   * component and useTradeReplay (see that hook's own `Segment.event`
   * field, itself read straight off a `PortfolioPoint`).
   */
  event: PortfolioEvent;
  /** TradeReplay.tsx's own `calloutText(...)` narration -- unchanged wording/voice, just relocated from a plain paragraph into this bubble. */
  calloutText: string;
}

interface PortfolioChartProps {
  points: readonly PortfolioPoint[];
  /**
   * How many leading points of `points` to actually draw -- the line, its
   * area fill, event markers, and the accessible data table. Defaults to
   * `points.length` (draw everything, this component's behavior before
   * this prop existed).
   *
   * **The x/y axis domains (the scales, their gridlines/labels, and the
   * two start/end axis-text labels) are always computed from the FULL
   * `points` array, regardless of this value** -- a real bug, fixed in
   * code review (issue #96 follow-up round 3): TradeReplay.tsx's "Watch
   * it happen" playback used to pre-slice `points` itself and hand this
   * component an already-truncated array every reveal step, which fed
   * that same truncated array into this component's own scale-building
   * `useMemo` too -- so the x/y domain (and therefore every gridline
   * position, the axis's own start/end labels, and the plotted line's
   * pixel span) rescaled to fit whatever was currently revealed, at
   * every single reveal step. That defeated the whole point of a
   * playback animation -- a fixed frame the real trajectory line grows
   * into -- and instead rendered as the entire chart visibly reflowing
   * every ~300-600ms. Passing the full series alongside `revealedCount`
   * instead lets this component keep the domain fixed for the whole run
   * while still only drawing the revealed prefix.
   */
  revealedCount?: number;
  /**
   * Whether this chart instance is focusable/interactive at all --
   * defaults to `true`. Pass `false` for a purely visual, non-interactive
   * render (e.g. TradeReplay.tsx's chart while playing, issue #96)
   * instead of a caller re-deriving the `aria-hidden`+`inert` wrapper
   * idiom itself.
   *
   * This exact concern -- this component's own focusable descendants,
   * the root `<svg>`'s `tabIndex` and `ChartDataTable`'s `<summary>` --
   * already needed rediscovering twice in issue #96's own PR history (see
   * apps/web/CLAUDE.md's "Trade replay" section, round two's `inert`
   * finding) before this prop existed: a caller wrapping this component
   * in its own `aria-hidden` div is a real ARIA-spec violation on its
   * own (`aria-hidden` must never wrap a focusable element), so `inert`
   * is what a non-interactive render actually needs, applied here to
   * this component's own root element -- which already wraps every
   * focusable descendant -- so no caller has to remember any of this
   * again (code review, issue #96 follow-up round 3).
   */
  interactive?: boolean;
  /**
   * What "just landed" during trade replay playback (issue #108) --
   * `null`/omitted (the default) renders none of the marker-landing
   * pulse/shake/speech-bubble effects below, this component's pre-#108
   * behavior. See `ChartLanding`'s own doc comment.
   */
  landing?: ChartLanding | null;
}

const WIDTH = 880;
const HEIGHT = 400;
const MARGIN = { top: 56, right: 16, bottom: 32, left: 76 };
const PLOT_WIDTH = WIDTH - MARGIN.left - MARGIN.right;
const PLOT_HEIGHT = HEIGHT - MARGIN.top - MARGIN.bottom;

// The marker-landing speech bubble's own fixed box (issue #108) -- see
// bubblePlacement's own doc comment for how these are used.
const BUBBLE_WIDTH = 220;
const BUBBLE_HEIGHT = 60;
const BUBBLE_MARKER_GAP = 14;

/**
 * A PortfolioPoint's `date` is either a plain calendar date
 * ("2025-08-21", the window model) or a full local datetime
 * ("2025-08-21T14:30:00", an intraday day's chart -- issue #28) -- see
 * format-date.ts's isPortfolioDatetime for the (single, shared)
 * detection this and formatDateTime both use. Both are parsed "as if
 * UTC" (a "Z" appended, not re-interpreted through any real timezone)
 * purely to get a monotonic numeric timestamp to lay out points along
 * the x-axis -- consistent with how plain calendar dates were already
 * treated here before intraday support existed.
 */
function toTimestamp(date: string): number {
  return new Date(isPortfolioDatetime(date) ? `${date}Z` : `${date}T00:00:00Z`).getTime();
}

interface BubblePlacement {
  x: number;
  y: number;
  below: boolean;
  /**
   * Where the CSS tail (`.marker-landing-bubble::after`) sits along the
   * bubble's own width, as a percentage -- see this function's own doc
   * comment for why this can't just be a fixed 50%.
   */
  tailOffsetPercent: number;
}

/**
 * Where the marker-landing speech bubble (issue #108) sits relative to
 * its own marker: horizontally centered on the marker's `x`, clamped to
 * the plot's own width so it can never run off either edge; above the
 * marker by default, flipping below only when there isn't enough
 * headroom (the marker sits close enough to the plot's own top edge,
 * inside `MARGIN.top`, that the bubble's fixed height wouldn't fit
 * above it). No collision avoidance against other markers/labels is
 * needed the way issue #85's now-deleted `chart-label-layout.ts` needed
 * -- at most one bubble is ever shown at once, since playback only ever
 * pauses on a single event at a time.
 *
 * **`tailOffsetPercent` exists because the box's own horizontal
 * clamp above can decenter it from the marker (code review finding,
 * fixed) -- a marker near either plot edge (a trade opening shortly
 * after the window's own start, or closing on its final day, both
 * realistic per the "natural completion" note elsewhere in this file)
 * clamps `x` away from `marker.x - BUBBLE_WIDTH / 2`, so a tail fixed at
 * the box's own 50% would visually point at empty chart space instead
 * of the marker it's narrating.** Computed as the marker's own offset
 * *within* the final (possibly-clamped) box, as a percentage of the
 * box's width, then clamped to `[12, 88]` so the tail stays on the
 * bubble's straight body rather than sliding onto its own rounded
 * corner (`border-radius: 8px` in `globals.css`).
 */
function bubblePlacement(marker: { x: number; y: number }): BubblePlacement {
  const x = Math.min(Math.max(marker.x - BUBBLE_WIDTH / 2, 0), PLOT_WIDTH - BUBBLE_WIDTH);
  const above = marker.y - BUBBLE_MARKER_GAP - BUBBLE_HEIGHT;
  const below = above < -MARGIN.top + 4;
  const tailOffsetPercent = Math.min(Math.max(((marker.x - x) / BUBBLE_WIDTH) * 100, 12), 88);
  return { x, y: below ? marker.y + BUBBLE_MARKER_GAP : above, below, tailOffsetPercent };
}

/**
 * Wrapped in `React.memo` (code review, issue #96 follow-up round four)
 * -- matches `ChartDataTable` below, which was already memoized for the
 * identical reason. During TradeReplay.tsx's RAF-driven playback, most
 * tween frames leave `points`/`revealedCount`/`interactive` completely
 * unchanged (only the hero figure's own `currentValue`, owned entirely
 * by TradeReplay.tsx, moves) -- without this, `linePath`/`areaPath`/
 * `eventMarkers` still recomputed and the full SVG still re-diffed on
 * every one of those frames for no visible difference. All props are
 * safe under `memo`'s default shallow comparison: `points` is a stable
 * reference for the whole run (TradeReplay.tsx passes the same array
 * throughout, only `revealedCount` grows -- see that prop's own doc
 * comment), `revealedCount`/`interactive` are primitives, and `landing`
 * (issue #108) is `null`/memoized by TradeReplay.tsx itself specifically
 * so its object identity stays stable whenever the actual landed event
 * hasn't changed -- a fresh-but-equivalent object every render would
 * otherwise make this memo pointless whenever `landing` is non-null.
 */
export const PortfolioChart = memo(function PortfolioChart({
  points,
  revealedCount,
  interactive = true,
  landing = null,
}: PortfolioChartProps) {
  const gradientId = useId();
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const [showTapHint, dismissTapHint] = useChartTapHint();

  // Clears a stale hoverIndex, and suppresses the touch tap-hint pulse,
  // whenever `points` changes identity or `interactive` flips (code
  // review, issue #96 follow-up rounds 3 and 4) -- previously safe to
  // leave either alone across any prop change because a `points` change
  // always came with a fresh `key` (a remount resets all state for
  // free); that stopped being true once TradeReplay.tsx started keeping
  // one PortfolioChart instance mounted across the live/truncated swap
  // (round two's `key={heroKey}` fix). A user who hovers/taps a point
  // and then clicks "Watch it happen" without the pointer leaving the
  // SVG bounds never fires onPointerLeave/onPointerCancel/onBlur --
  // hoverIndex stayed set to the pre-playback index and popped the
  // crosshair/tooltip back into view once `revealedCount` grew past that
  // stale index mid-replay. `interactive` is tracked alongside `points`
  // specifically because TradeReplay.tsx's own `points` prop no longer
  // changes identity at all across that transition (see
  // `revealedCount`'s own doc comment above) -- only `interactive` (and
  // `revealedCount`) do.
  //
  // **Round four's own addition**: the same reset also dismisses the
  // touch tap-hint pulse (`showTapHint`, below) the instant `interactive`
  // goes false. That pulse targets `eventMarkers[eventMarkers.length -
  // 1]` (see the JSX below), and `eventMarkers` derives from `drawn` --
  // the `revealedCount`-truncated prefix TradeReplay.tsx's playback
  // grows one marker at a time. Without this, a touch-primary first-time
  // visitor who saw the pulse on the chart's final marker and then
  // clicked "Watch it happen" mid-animation would see the hint circle
  // relocate between successive trade markers as `revealedCount` grew --
  // an animated "tap here" invitation jumping around on content that's
  // simultaneously `inert` (pointer events disabled) via this
  // component's own root wrapper below. Gating the pulse's own render on
  // `interactive` (see the JSX below) independently prevents it from
  // ever painting while non-interactive; this reset is defense-in-depth
  // on top of that gate, the same "belt and suspenders" posture this
  // component's `aria-hidden` + `inert` pairing already uses -- and it's
  // genuinely correct on its own terms too, since `dismissTapHint` is
  // idempotent (a no-op if the hint was never shown, or already
  // dismissed) and playback starting is itself a real interaction with
  // the chart, the same class of event `revealNearestPoint` already
  // treats as "the hint did its job."
  useResetWhenChanged([points, interactive], () => {
    if (hoverIndex !== null) {
      setHoverIndex(null);
    }
    if (!interactive) {
      dismissTapHint();
    }
  });
  // Same "on mount only, not a live subscription" hook HeroStat's own
  // reveal accent (issue #77) and ResultsPanel's FadeInWrapper already
  // share -- see that hook's own doc comment for the hydration-safety
  // precondition (only safe from a client-only success-branch mount,
  // which is exactly where PortfolioChart is always rendered from).
  const animateReveal = !useReducedMotionAtMount();

  // Whether formatDateTime should disambiguate points with their own
  // calendar date (issue #91's whole-range chart) or stay time-only (a
  // single day's own chart) -- see that function's own doc comment.
  const includeDate = useMemo(() => spansMultipleDays(points), [points]);

  // Whether this series is the chained multi-day intraday chart (issue
  // #91: many real trading days chained together, datetime-labeled points)
  // rather than the window model (plain calendar-date points, sparse
  // trade-event spacing) -- see buildChainedIntradayXPositions's own doc
  // comment for why only the chained-intraday case gets day-bucketed x
  // positions (issue #93). `includeDate` alone isn't enough: it's true
  // for almost any real window result too (its points fall on genuinely
  // different calendar dates), so it's ANDed with isPortfolioDatetime,
  // the one thing that's actually false for every window-model point.
  const isChainedIntradaySeries = includeDate && isPortfolioDatetime(points[0]!.date);

  const { yScale, yTicks, plotted } = useMemo(() => {
    const values = points.map((p) => p.value);

    const rawMin = Math.min(...values);
    const rawMax = Math.max(...values);
    const padFactor = 1.15;
    const yDomain: [number, number] =
      rawMin === rawMax ? [rawMin / 1.5, rawMax * 1.5] : [rawMin / padFactor, rawMax * padFactor];

    const yScale = buildLogScale(yDomain, [PLOT_HEIGHT, 0]);
    const yTicks = niceLogTicks(yDomain[0], yDomain[1], 5);

    const timestamps = points.map((p) => toTimestamp(p.date));

    // x-positions, one per point, built one of two ways depending on
    // isChainedIntradaySeries (see that flag's own comment above):
    //   - chained intraday: day-bucketed (buildChainedIntradayXPositions)
    //     -- an equal-width slot per calendar day, so neither
    //     market-closed dead time nor a day's own trade count skews
    //     pixel width, with real intraday time placing points within
    //     each day's slot.
    //   - window model: the original linear scale over real timestamps,
    //     since the time between points there is meaningful holding
    //     duration, not dead time.
    const xPositions: number[] = isChainedIntradaySeries
      ? buildChainedIntradayXPositions(
          points.map((p) => calendarDayOf(p.date)),
          timestamps,
          [0, PLOT_WIDTH],
        )
      : buildWindowModelXPositions(timestamps, [0, PLOT_WIDTH]);

    const plotted = points.map((p, i) => ({
      ...p,
      x: xPositions[i]!,
      y: yScale(p.value),
    }));

    return { yScale, yTicks, plotted };
  }, [points, isChainedIntradaySeries]);

  // The revealed prefix actually drawn (the line, its area fill, event
  // markers, and the interaction/hover logic below) -- `plotted` above
  // stays keyed purely on the FULL `points`/`isChainedIntradaySeries`, so
  // a caller growing `revealedCount` frame by frame (TradeReplay.tsx's
  // playback) never defeats that useMemo or moves the axis it defines
  // (see this component's own `revealedCount` prop doc comment).
  //
  // Clamped to `[1, plotted.length]` (code review, issue #96 follow-up
  // round four) -- `revealedCount` is a public, unvalidated prop, and
  // without a lower bound a caller passing `0` (or a negative number)
  // produces an empty `drawn` array, which every non-null assertion
  // below (`drawn[drawn.length - 1]!`, `drawn[0]!`) assumes can never
  // happen. Today that's only true by an emergent combination of
  // independently-maintained checks elsewhere -- use-trade-replay.ts's
  // own `play()` length guard, `buildSegments`'s 1-indexed loop, and
  // TradeReplay.tsx's own `showLive` gating -- not one explicit
  // invariant at this component's own boundary. This clamp makes that
  // invariant real here, regardless of what any future caller passes.
  const revealed = Math.min(Math.max(revealedCount ?? points.length, 1), plotted.length);
  const drawn = useMemo(() => plotted.slice(0, revealed), [plotted, revealed]);

  const linePath = drawn
    .map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(2)},${p.y.toFixed(2)}`)
    .join(" ");
  const areaPath = `${linePath} L ${drawn[drawn.length - 1]!.x.toFixed(2)},${PLOT_HEIGHT} L ${drawn[0]!.x.toFixed(2)},${PLOT_HEIGHT} Z`;

  const eventMarkers = drawn.filter((p) => p.event !== null);

  // The marker `landing` refers to (issue #108), found by reference
  // equality against `landing.event` -- safe because both ultimately
  // come from the same `points` array TradeReplay.tsx passes to both
  // this component and useTradeReplay (see `ChartLanding`'s own doc
  // comment). `landedBubble` bundles the placement with the narration
  // text so the JSX below never has to separately null-check `landing`
  // alongside `landedMarker` -- if either is missing, there's no bubble.
  const landedMarker = landing
    ? (eventMarkers.find((p) => p.event === landing.event) ?? null)
    : null;
  const landedBubble =
    landedMarker && landing
      ? { ...bubblePlacement(landedMarker), calloutText: landing.calloutText }
      : null;

  // Gain/loss-aware color (issue #85), replacing the single flat
  // --series-1 accent this chart used to render regardless of outcome.
  // Same ">= is good" convention TradeRow's own `returnFraction >= 0`
  // and HeroStat's multiplier badge/reveal-accent (`endingBalance /
  // startingCapital >= 1`) already use -- a flat/no-trade window (start
  // === end) renders "good," consistent with how the rest of the app
  // already treats flat as good-or-neutral, not bad. --gridline/
  // --baseline/--text-muted (gridlines, baseline, axis text) stay
  // neutral -- only the data itself carries the accent color. Based on
  // `drawn` (the revealed prefix), not the full series -- unaffected by
  // this round's axis-domain fix, and consistent with this chart's own
  // pre-#96 behavior of coloring by whatever it's currently showing.
  const isGain = drawn[drawn.length - 1]!.value >= drawn[0]!.value;
  const seriesColor = isGain ? "var(--status-good)" : "var(--status-critical)";

  const hovered = hoverIndex !== null ? drawn[hoverIndex] : null;

  /**
   * Shared by pointermove (mouse hover / drag) and pointerdown (a
   * single tap, issue #44) -- a tap fires pointerdown+pointerup with no
   * intervening pointermove, so without also wiring this to pointerdown
   * the tooltip/crosshair was only reachable by dragging a finger across
   * the chart, which most touch users won't discover.
   */
  function revealNearestPoint(clientEvent: { clientX: number; currentTarget: SVGSVGElement }) {
    // Any real interaction with the chart is itself proof the tap hint
    // (if shown) did its job -- dismiss it for good rather than waiting
    // for its pulse animation to run its course (see
    // chart-tap-hint-pulse's own onAnimationEnd below for the other,
    // no-interaction dismissal path).
    dismissTapHint();

    const rect = clientEvent.currentTarget.getBoundingClientRect();
    const scaleX = WIDTH / rect.width;
    const localX = (clientEvent.clientX - rect.left) * scaleX - MARGIN.left;

    let nearestIndex = 0;
    let nearestDistance = Infinity;
    drawn.forEach((p, i) => {
      const distance = Math.abs(p.x - localX);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearestIndex = i;
      }
    });
    setHoverIndex(nearestIndex);
  }

  function stepFocus(delta: number) {
    setHoverIndex((current) => {
      const from = current ?? 0;
      const next = Math.min(drawn.length - 1, Math.max(0, from + delta));
      return next;
    });
  }

  return (
    <div
      className="flex flex-col gap-3"
      aria-hidden={interactive ? undefined : "true"}
      inert={!interactive}
    >
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        role="img"
        aria-label="Portfolio value over time, with trade open and close markers"
        tabIndex={0}
        className={`w-full outline-none focus-visible:ring-2 ${
          isGain
            ? "focus-visible:ring-[var(--status-good)]"
            : "focus-visible:ring-[var(--status-critical)]"
        }`}
        onPointerDown={revealNearestPoint}
        onPointerMove={revealNearestPoint}
        onPointerLeave={() => setHoverIndex(null)}
        onPointerCancel={() => setHoverIndex(null)}
        onBlur={() => setHoverIndex(null)}
        onKeyDown={(keyboardEvent) => {
          if (keyboardEvent.key === "ArrowRight") {
            keyboardEvent.preventDefault();
            stepFocus(1);
          } else if (keyboardEvent.key === "ArrowLeft") {
            keyboardEvent.preventDefault();
            stepFocus(-1);
          } else if (keyboardEvent.key === "Escape") {
            setHoverIndex(null);
          }
        }}
      >
        <defs>
          {/* Area-fill gradient beneath the line (issue #77) -- was
              already present but faint enough (a flat 10% -> 0%) to read
              as "no fill" on a live screenshot against this app's dark
              background. A middle stop gives the falloff a visibly
              curved (not linear) taper, reading as a proper wash rather
              than a flat tint that just stops abruptly. */}
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={seriesColor} stopOpacity="0.32" />
            <stop offset="55%" stopColor={seriesColor} stopOpacity="0.08" />
            <stop offset="100%" stopColor={seriesColor} stopOpacity="0" />
          </linearGradient>
        </defs>

        <g transform={`translate(${MARGIN.left},${MARGIN.top})`}>
          {/* Gridlines + y-axis labels */}
          {yTicks.map((tick) => {
            const y = yScale(tick);
            return (
              <g key={tick}>
                <line
                  x1={0}
                  x2={PLOT_WIDTH}
                  y1={y}
                  y2={y}
                  stroke="var(--gridline)"
                  strokeWidth={1}
                />
                <text
                  x={-10}
                  y={y}
                  textAnchor="end"
                  dominantBaseline="middle"
                  fontSize={11}
                  fill="var(--text-muted)"
                >
                  {formatAxisCurrency(tick)}
                </text>
              </g>
            );
          })}

          {/* Baseline */}
          <line
            x1={0}
            x2={PLOT_WIDTH}
            y1={PLOT_HEIGHT}
            y2={PLOT_HEIGHT}
            stroke="var(--baseline)"
            strokeWidth={1}
          />

          {/* X-axis: start and end date only -- correct as-is for today's
              at-most-3-trade window (issue #85's own plan); individual
              trade dates are available via the hover/tap tooltip and the
              data table below, not as on-chart labels any more.
              Deliberately reads the FULL `points` (not `drawn`) so these
              two labels stay fixed at the plot's edges for the whole
              run of a `revealedCount`-driven reveal, matching the fixed
              axis frame -- see this component's own `revealedCount` prop
              doc comment. */}
          <text
            x={0}
            y={PLOT_HEIGHT + 20}
            textAnchor="start"
            fontSize={11}
            fill="var(--text-muted)"
          >
            {formatDateTime(points[0]!.date, includeDate)}
          </text>
          <text
            x={PLOT_WIDTH}
            y={PLOT_HEIGHT + 20}
            textAnchor="end"
            fontSize={11}
            fill="var(--text-muted)"
          >
            {formatDateTime(points[points.length - 1]!.date, includeDate)}
          </text>

          {/* Area wash + line, gain/loss-colored (issue #85) and grouped so
              the reveal-on-mount animation applies to the data itself, not
              the gridlines/axis above (which stay immediately present so
              the chart never looks broken mid-animation). Two-layer
              reduced-motion guard: `animateReveal` (derived once at mount
              via useReducedMotionAtMount, same shared hook/precondition
              HeroStat's own reveal accent uses) is the primary gate
              deciding whether to add the class at all; globals.css's own
              `@media (prefers-reduced-motion: reduce)` rule on
              `.portfolio-chart-reveal` is defense-in-depth. */}
          <g className={animateReveal ? "portfolio-chart-reveal" : undefined}>
            <path d={areaPath} fill={`url(#${gradientId})`} stroke="none" />
            <path
              d={linePath}
              fill="none"
              stroke={seriesColor}
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          </g>

          {/* Crosshair */}
          {hovered && (
            <line
              x1={hovered.x}
              x2={hovered.x}
              y1={0}
              y2={PLOT_HEIGHT}
              stroke="var(--text-muted)"
              strokeWidth={1}
              strokeDasharray="3 3"
            />
          )}

          {/* Open/close markers -- no on-chart text labels (issue #85; the
              exact ticker/date/price they duplicated is already shown,
              unconditionally, by TradeList/IntradayTradeList immediately
              below the chart, and by this readout/the data table below).
              Shape alone still distinguishes an "open" event (no value
              change, a hollow ring) from a "close" event (the point where
              value actually jumps, a filled dot) -- the same open/close
              distinction the removed label text conveyed via its verb
              ("Buy" vs. "Sell"), now wordless. A sibling `<g>` of the
              area/line group above (sharing the same reveal class/timing)
              rather than nested inside it -- markers must paint *after*
              the crosshair below to stay on top of it, matching this
              chart's pre-#85 stacking (code review finding, fixed: an
              earlier draft nested markers inside the area/line group,
              which paints before the crosshair and let it visually cut
              through a marker whenever a hovered point landed near one). */}
          <g className={animateReveal ? "portfolio-chart-reveal" : undefined}>
            {eventMarkers.map((p, i) => {
              const event = p.event!;
              const isOpen = event.type === "open";
              // Issue #108: a subtle shake on the real marker itself,
              // close events only -- "the point where value actually
              // jumps" per this comment block's own open/close
              // distinction above, i.e. the moment a value change is
              // worth calling out with motion, not just a color/shape
              // distinction. Gated on `animateReveal` (the same
              // mount-latched reduced-motion read `.portfolio-chart-reveal`
              // already uses just above) as the JS-level "don't render
              // the animated element at all" half of this app's two-layer
              // reduced-motion pattern; globals.css's own media query on
              // `.marker-landing-shake` is the CSS belt on top.
              const isLanded = animateReveal && landing?.event === event;
              return (
                <circle
                  key={`${p.date}-${event.type}-${event.ticker}-${i}`}
                  cx={p.x}
                  cy={p.y}
                  r={4}
                  fill={isOpen ? "none" : seriesColor}
                  stroke={isOpen ? seriesColor : "var(--surface-1)"}
                  strokeWidth={2}
                  className={
                    isLanded && event.type === "close" ? "marker-landing-shake" : undefined
                  }
                />
              );
            })}
          </g>

          {/* One-shot marker-landing pulse ring (issue #108) -- every
              open/close event gets this (not just close, unlike the
              shake above), reusing chart-tap-hint-pulse's own
              chart-tap-pulse keyframe/shape (a single iteration instead
              of three, see globals.css's own `.marker-landing-pulse`) so
              this reads as the same visual language, not a competing
              one. A decorative sibling overlay, not applied to the real
              marker's own circle above -- that keyframe's own scale/fade
              would make the *real* marker vanish once it finishes if
              applied directly, the same reasoning the pre-existing touch
              tap hint just below already established. Mounts fresh
              (a plain conditional render, no key trickery needed) every
              time a new event lands -- `landing` only stays pointed at
              one event for the length of use-trade-replay.ts's own
              EVENT_PAUSE_MS pause, during which this component never
              re-renders (see that hook's own `tick()`), so this element
              is always a genuinely fresh DOM node when it appears,
              which is what makes the CSS animation replay correctly on
              every landing rather than needing to be manually
              retriggered. Same `animateReveal` JS-level gate as the
              shake above. */}
          {animateReveal && landedMarker && (
            <circle
              cx={landedMarker.x}
              cy={landedMarker.y}
              r={4}
              fill="none"
              stroke={seriesColor}
              strokeWidth={2}
              className="marker-landing-pulse"
              pointerEvents="none"
              aria-hidden="true"
            />
          )}

          {/* Marker-landing speech-bubble callout (issue #108) --
              replaces TradeReplay.tsx's old plain <p> rendered below the
              hero row (see that file's own doc comment) with a callout
              anchored near its own marker instead. Rendered inside an
              SVG <foreignObject> so ordinary HTML text wrapping applies
              to a real sentence-length string, instead of hand-measuring
              per-character SVG <text> widths the way issue #85's now-
              deleted chart-label-layout.ts had to for its own on-chart
              labels. Purely decorative/duplicate of the sr-only
              aria-live announcement (TradeReplay.tsx's own `announced`)
              -- aria-hidden, `pointerEvents="none"` so it can never
              intercept a hover/tap on the chart underneath it, and
              deliberately never gated on `animateReveal`: unlike the
              pulse/shake above, the bubble's own *presence* isn't
              itself an animation (no CSS keyframe of its own), it just
              mounts/unmounts as `landing` changes -- the same "content,
              not motion" treatment this app's other reduced-motion-gated
              features don't extend to their own static text either. */}
          {landedBubble && (
            <foreignObject
              x={landedBubble.x}
              y={landedBubble.y}
              width={BUBBLE_WIDTH}
              height={BUBBLE_HEIGHT}
              pointerEvents="none"
            >
              <div
                aria-hidden="true"
                className={`marker-landing-bubble ${
                  landedBubble.below ? "marker-landing-bubble-below" : "marker-landing-bubble-above"
                }`}
                style={
                  {
                    "--marker-landing-bubble-tail-offset": `${landedBubble.tailOffsetPercent}%`,
                  } as CSSProperties
                }
              >
                {landedBubble.calloutText}
              </div>
            </foreignObject>
          )}

          {/* One-time touch "you can tap this" pulse hint (issue #66) --
              only rendered for a touch-primary device that hasn't
              already seen/dismissed it (see use-chart-tap-hint.ts), on
              the most recent trade marker specifically, since that's
              the marker a user exploring the chart is most likely to
              reach for first. No hint at all if there's no marker to
              point at (a zero-trade window). Also gated on `interactive`
              (code review, issue #96 follow-up round four) -- defense-
              in-depth alongside the `useResetWhenChanged` dismissal
              above: `eventMarkers` derives from `drawn`, the
              `revealedCount`-truncated prefix during TradeReplay.tsx's
              playback, so without this gate the pulse could relocate
              between successive markers as `revealedCount` grows, on
              content that's simultaneously `inert` (see this
              component's root wrapper below). */}
          {interactive && showTapHint && eventMarkers.length > 0 && (
            <circle
              cx={eventMarkers[eventMarkers.length - 1]!.x}
              cy={eventMarkers[eventMarkers.length - 1]!.y}
              r={4}
              fill="none"
              stroke={seriesColor}
              strokeWidth={2}
              className="chart-tap-hint-pulse"
              pointerEvents="none"
              aria-hidden="true"
              onAnimationEnd={dismissTapHint}
            />
          )}

          {/* Hover point */}
          {hovered && (
            <circle
              cx={hovered.x}
              cy={hovered.y}
              r={4}
              fill={seriesColor}
              stroke="var(--surface-1)"
              strokeWidth={2}
            />
          )}
        </g>
      </svg>

      {/* Tooltip readout -- lives in normal flow below the chart so it
          never overlaps data or gets clipped at the SVG's edge. */}
      <div aria-live="polite" className="min-h-[2.5rem] text-sm text-[var(--text-secondary)]">
        {hovered ? (
          <p>
            <span className="font-semibold text-[var(--text-primary)]">
              {formatDateTime(hovered.date, includeDate)}
            </span>
            {" - "}
            <span className="font-semibold text-[var(--text-primary)]">
              {formatHeroCurrency(hovered.value)}
            </span>
            {hovered.event && (
              <span>
                {" "}
                ({eventTooltipVerb(hovered.event)} {hovered.event.ticker} at{" "}
                {formatHeroCurrency(hovered.event.price)})
              </span>
            )}
          </p>
        ) : (
          <p>Tap, hover, or focus the chart (use the arrow keys) to inspect a point.</p>
        )}
      </div>

      <ChartDataTable points={drawn} />
    </div>
  );
});

/**
 * The accessible data-table fallback, split out and memoized on `points`
 * alone -- PortfolioChart itself re-renders on every hover/focus move
 * (hoverIndex is component-local state), and this table's content is
 * invariant under hovering, so without this split every mouse move would
 * re-map and re-format every row for no visible change.
 */
const ChartDataTable = memo(function ChartDataTable({
  points,
}: {
  points: readonly PortfolioPoint[];
}) {
  // Own copy of this flag (not threaded down as a prop) -- it's a pure
  // function of `points`, which this component already takes, and
  // adding it as a separate prop would just be one more thing for a
  // caller to keep in sync with the same array.
  const includeDate = spansMultipleDays(points);

  return (
    <details className="text-sm">
      <summary className="cursor-pointer text-[var(--text-secondary)]">
        View chart data as a table
      </summary>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full min-w-[24rem] border-collapse text-left text-sm">
          <thead>
            <tr className="border-b border-[var(--gridline)] text-[var(--text-muted)]">
              <th className="py-1 pr-4 font-medium">Date</th>
              <th className="py-1 pr-4 font-medium">Value</th>
              <th className="py-1 font-medium">Event</th>
            </tr>
          </thead>
          <tbody>
            {points.map((p, i) => (
              <tr key={i} className="border-b border-[var(--gridline)] last:border-0">
                <td className="py-1 pr-4">{formatDateTime(p.date, includeDate)}</td>
                <td className="py-1 pr-4 tabular-nums">{formatHeroCurrency(p.value)}</td>
                <td className="py-1">
                  {p.event
                    ? `${eventLabelVerb(p.event)} ${p.event.ticker} @ ${formatHeroCurrency(p.event.price)}`
                    : ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
});
