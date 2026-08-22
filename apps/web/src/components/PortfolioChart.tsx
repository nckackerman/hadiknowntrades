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
import { buildLogScale, buildTimeScale, niceLogTicks } from "@/lib/chart-scales";
import type { PortfolioEvent, PortfolioPoint } from "@/lib/portfolio-series";

/**
 * Capitalized verb for a marker's own label / the data-table's event
 * column (issue #13): "Buy"/"Short" for an open event, "Sell"/"Cover"
 * for a close event, depending on direction -- standard finance
 * terminology, same wording TradeRow.tsx's own verbsFor uses.
 */
function eventLabelVerb(event: PortfolioEvent): string {
  if (event.type === "open") return event.direction === "long" ? "Buy" : "Short";
  return event.direction === "long" ? "Sell" : "Cover";
}

/** Lowercase verb for the hover tooltip's prose ("...bought AAPL at..."). */
function eventTooltipVerb(event: PortfolioEvent): string {
  if (event.type === "open") return event.direction === "long" ? "bought" : "shorted";
  return event.direction === "long" ? "sold" : "covered";
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

/** Anchors a label so it never runs past the plot's left/right edge. */
function anchorFor(x: number): "start" | "middle" | "end" {
  if (x < PLOT_WIDTH * 0.15) return "start";
  if (x > PLOT_WIDTH * 0.85) return "end";
  return "middle";
}

export function PortfolioChart({ points }: PortfolioChartProps) {
  const gradientId = useId();
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  const { yScale, yTicks, plotted } = useMemo(() => {
    const timestamps = points.map((p) => toTimestamp(p.date));
    const values = points.map((p) => p.value);

    const minTs = Math.min(...timestamps);
    const maxTs = Math.max(...timestamps);
    // A single-point series (e.g. a window with no trades and start ===
    // end) still needs a non-zero domain to lay out -- pad by a day.
    const dayMs = 24 * 60 * 60 * 1000;
    const xDomain: [number, number] =
      minTs === maxTs ? [minTs - dayMs, maxTs + dayMs] : [minTs, maxTs];

    const rawMin = Math.min(...values);
    const rawMax = Math.max(...values);
    const padFactor = 1.15;
    const yDomain: [number, number] =
      rawMin === rawMax ? [rawMin / 1.5, rawMax * 1.5] : [rawMin / padFactor, rawMax * padFactor];

    const xScale = buildTimeScale(xDomain, [0, PLOT_WIDTH]);
    const yScale = buildLogScale(yDomain, [PLOT_HEIGHT, 0]);
    const yTicks = niceLogTicks(yDomain[0], yDomain[1], 5);

    const plotted = points.map((p, i) => ({
      ...p,
      x: xScale(timestamps[i]!),
      y: yScale(p.value),
    }));

    return { yScale, yTicks, plotted };
  }, [points]);

  const linePath = plotted
    .map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(2)},${p.y.toFixed(2)}`)
    .join(" ");
  const areaPath = `${linePath} L ${plotted[plotted.length - 1]!.x.toFixed(2)},${PLOT_HEIGHT} L ${plotted[0]!.x.toFixed(2)},${PLOT_HEIGHT} Z`;

  const eventMarkers = plotted.filter((p) => p.event !== null);

  const hovered = hoverIndex !== null ? plotted[hoverIndex] : null;

  /**
   * Shared by pointermove (mouse hover / drag) and pointerdown (a
   * single tap, issue #44) -- a tap fires pointerdown+pointerup with no
   * intervening pointermove, so without also wiring this to pointerdown
   * the tooltip/crosshair was only reachable by dragging a finger across
   * the chart, which most touch users won't discover.
   */
  function revealNearestPoint(clientEvent: { clientX: number; currentTarget: SVGSVGElement }) {
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
        className="w-full outline-none focus-visible:ring-2 focus-visible:ring-[var(--series-1)]"
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
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--series-1)" stopOpacity="0.1" />
            <stop offset="100%" stopColor="var(--series-1)" stopOpacity="0" />
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

          {/* X-axis: start and end date only -- trade dates are already
              carried by the markers' own direct labels. */}
          <text
            x={0}
            y={PLOT_HEIGHT + 20}
            textAnchor="start"
            fontSize={11}
            fill="var(--text-muted)"
          >
            {formatDateTime(points[0]!.date)}
          </text>
          <text
            x={PLOT_WIDTH}
            y={PLOT_HEIGHT + 20}
            textAnchor="end"
            fontSize={11}
            fill="var(--text-muted)"
          >
            {formatDateTime(points[points.length - 1]!.date)}
          </text>

          {/* Area wash + line */}
          <path d={areaPath} fill={`url(#${gradientId})`} stroke="none" />
          <path
            d={linePath}
            fill="none"
            stroke="var(--series-1)"
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
          />

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

          {/* Open/close markers with direct labels (ticker, date, price) --
              "Buy"/"Sell" for a long, "Short"/"Cover" for a short (issue
              #13, see eventLabelVerb). */}
          {eventMarkers.map((p, i) => {
            const event = p.event!;
            const isAbove = event.type === "open";
            const labelY = isAbove ? p.y - 14 : p.y + 24;
            return (
              <g key={`${p.date}-${event.type}-${event.ticker}-${i}`}>
                <circle
                  cx={p.x}
                  cy={p.y}
                  r={4}
                  fill="var(--series-1)"
                  stroke="var(--surface-1)"
                  strokeWidth={2}
                />
                <text
                  x={p.x}
                  y={labelY}
                  textAnchor={anchorFor(p.x)}
                  fontSize={10.5}
                  fontWeight={600}
                  fill="var(--text-primary)"
                >
                  {eventLabelVerb(event)} {event.ticker}
                </text>
                <text
                  x={p.x}
                  y={labelY + 13}
                  textAnchor={anchorFor(p.x)}
                  fontSize={10}
                  fill="var(--text-secondary)"
                >
                  {formatDateTime(p.date)} · {formatHeroCurrency(event.price)}
                </text>
              </g>
            );
          })}

          {/* Hover point */}
          {hovered && (
            <circle
              cx={hovered.x}
              cy={hovered.y}
              r={4}
              fill="var(--series-1)"
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
              {formatDateTime(hovered.date)}
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
          <p>Hover or focus the chart (use the arrow keys) to inspect a point.</p>
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
                <td className="py-1 pr-4">{formatDateTime(p.date)}</td>
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
