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

interface PortfolioChartProps {
  points: readonly PortfolioPoint[];
}

const WIDTH = 880;
const HEIGHT = 400;
const MARGIN = { top: 56, right: 16, bottom: 32, left: 76 };
const PLOT_WIDTH = WIDTH - MARGIN.left - MARGIN.right;
const PLOT_HEIGHT = HEIGHT - MARGIN.top - MARGIN.bottom;

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

export function PortfolioChart({ points }: PortfolioChartProps) {
  const gradientId = useId();
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const [showTapHint, dismissTapHint] = useChartTapHint();
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

  const linePath = plotted
    .map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(2)},${p.y.toFixed(2)}`)
    .join(" ");
  const areaPath = `${linePath} L ${plotted[plotted.length - 1]!.x.toFixed(2)},${PLOT_HEIGHT} L ${plotted[0]!.x.toFixed(2)},${PLOT_HEIGHT} Z`;

  const eventMarkers = plotted.filter((p) => p.event !== null);

  // Gain/loss-aware color (issue #85), replacing the single flat
  // --series-1 accent this chart used to render regardless of outcome.
  // Same ">= is good" convention TradeRow's own `returnFraction >= 0`
  // and HeroStat's multiplier badge/reveal-accent (`endingBalance /
  // startingCapital >= 1`) already use -- a flat/no-trade window (start
  // === end) renders "good," consistent with how the rest of the app
  // already treats flat as good-or-neutral, not bad. --gridline/
  // --baseline/--text-muted (gridlines, baseline, axis text) stay
  // neutral -- only the data itself carries the accent color.
  const isGain = plotted[plotted.length - 1]!.value >= plotted[0]!.value;
  const seriesColor = isGain ? "var(--status-good)" : "var(--status-critical)";

  const hovered = hoverIndex !== null ? plotted[hoverIndex] : null;

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
    plotted.forEach((p, i) => {
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
      const next = Math.min(plotted.length - 1, Math.max(0, from + delta));
      return next;
    });
  }

  return (
    <div className="flex flex-col gap-3">
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
              data table below, not as on-chart labels any more. */}
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
              return (
                <circle
                  key={`${p.date}-${event.type}-${event.ticker}-${i}`}
                  cx={p.x}
                  cy={p.y}
                  r={4}
                  fill={isOpen ? "none" : seriesColor}
                  stroke={isOpen ? seriesColor : "var(--surface-1)"}
                  strokeWidth={2}
                />
              );
            })}
          </g>

          {/* One-time touch "you can tap this" pulse hint (issue #66) --
              only rendered for a touch-primary device that hasn't
              already seen/dismissed it (see use-chart-tap-hint.ts), on
              the most recent trade marker specifically, since that's
              the marker a user exploring the chart is most likely to
              reach for first. No hint at all if there's no marker to
              point at (a zero-trade window). */}
          {showTapHint && eventMarkers.length > 0 && (
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

      <ChartDataTable points={points} />
    </div>
  );
}

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
