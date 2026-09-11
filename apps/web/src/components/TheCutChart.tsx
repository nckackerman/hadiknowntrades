// The Cut's reveal chart (issue #233): a new, small, hand-rolled SVG
// chart -- no existing chart component fits an N-on-x-axis domain
// (PortfolioChart is time/bar-domain, see apps/web/CLAUDE.md's own
// "Chart: hand-rolled SVG, no library" section for that precedent).
// Reuses chart-scales.ts's log-tick machinery for the y-axis (portfolio
// value can span orders of magnitude across N=1..universeSize, the same
// reason PortfolioChart's own value axis is log-scaled) -- a plain
// linear scale for the x-axis (N itself), since prefix length has no
// equivalent multi-order-of-magnitude spread.
//
// Deliberately simpler than PortfolioChart: static (no hover/tap
// crosshair, no keyboard point inspection, no reveal animation) -- this
// renders once, at the end of a finished game, not as an interactive
// exploration surface. A screen-reader user gets the same information
// via the sr-only summary paragraph this component renders alongside the
// SVG, not a PortfolioChart-style accessible data table (the curve can
// have up to ~500 points; a table that size would be its own UI problem,
// and the three numbers that actually matter -- the guess, the best N,
// and the baseline -- are already stated in plain text just above this
// chart by TheCut.tsx itself).

import type { Sp500PrefixCurvePoint } from "@hadiknowntrades/core";

import { formatAxisCurrency } from "@/lib/format-currency";
import { buildLogScale, niceLogTicks } from "@/lib/chart-scales";
import { curvePointAtOrBelow } from "@/lib/the-cut-scoring";

const WIDTH = 640;
const HEIGHT = 320;
const MARGIN = { top: 20, right: 16, bottom: 32, left: 72 };
const PLOT_WIDTH = WIDTH - MARGIN.left - MARGIN.right;
const PLOT_HEIGHT = HEIGHT - MARGIN.top - MARGIN.bottom;

/** Linear x-scale over N=1..universeSize -- prefix length has no multi-order-of-magnitude spread the way portfolio value does, so no log scale is needed here. */
function buildLinearScale(domain: [number, number], range: [number, number]) {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const span = d1 - d0;
  return (value: number): number =>
    span === 0 ? (r0 + r1) / 2 : r0 + ((value - d0) / span) * (r1 - r0);
}

export interface TheCutChartProps {
  curve: readonly Sp500PrefixCurvePoint[];
  universeSize: number;
  bestN: number;
  /** The N=universeSize baseline point (the game's own internally-consistent "buy the whole index" comparison -- see docs/design/the-cut-2026-09/README.md's "Baseline comparison" section). */
  n500EndingBalance: number;
  /** The player's own final guess this game, marked distinctly from bestN. */
  guessedN: number;
}

export function TheCutChart({
  curve,
  universeSize,
  bestN,
  n500EndingBalance,
  guessedN,
}: TheCutChartProps) {
  if (curve.length === 0) {
    return null;
  }

  const values = curve.map((point) => point.endingBalance);
  const minValue = Math.min(...values, n500EndingBalance);
  const maxValue = Math.max(...values, n500EndingBalance);
  // A flat curve (every point at the same value) still needs a non-zero
  // log-domain span to lay out -- pad by a decade either side, the same
  // "give a zero-span domain some room" posture buildWindowModelXPositions
  // takes for a single-point series.
  const yDomain: [number, number] =
    minValue === maxValue ? [minValue / 10, maxValue * 10] : [minValue * 0.95, maxValue * 1.05];

  const xScale = buildLinearScale([1, universeSize], [0, PLOT_WIDTH]);
  const yScale = buildLogScale(yDomain, [PLOT_HEIGHT, 0]);
  const yTicks = niceLogTicks(yDomain[0], yDomain[1], 5);

  const linePath = curve
    .map((point, i) => `${i === 0 ? "M" : "L"}${xScale(point.n)},${yScale(point.endingBalance)}`)
    .join(" ");

  // curvePointAtOrBelow (the-cut-scoring.ts), not a bare exact-`n` find:
  // the same fallback the scoring logic itself uses for a guess/bestN
  // that has no exact curve entry (a leading run of the very
  // highest-ranked companies lacking window data -- see that function's
  // own doc comment), so a marker's on-chart position always matches the
  // value the score was actually computed from.
  const bestPoint = curvePointAtOrBelow(curve, bestN);
  const guessedPoint = curvePointAtOrBelow(curve, guessedN);

  const baselineY = yScale(n500EndingBalance);

  return (
    <figure className="flex flex-col gap-2">
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        role="img"
        aria-label={`Portfolio value by prefix length, from N=1 to N=${universeSize}. Your guess was N=${guessedN}, the real best was N=${bestN}.`}
        className="w-full"
      >
        <g transform={`translate(${MARGIN.left},${MARGIN.top})`}>
          {/* Log-scale y gridlines + labels (chart-scales.ts's niceLogTicks). */}
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
                  x={-8}
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

          {/* The N=universeSize baseline -- dashed, muted, de-emphasized (docs/design/the-cut-2026-09/README.md's own "Reveal" section wording). */}
          <line
            x1={0}
            x2={PLOT_WIDTH}
            y1={baselineY}
            y2={baselineY}
            stroke="var(--text-muted)"
            strokeWidth={1.5}
            strokeDasharray="4 4"
          />
          <text
            x={PLOT_WIDTH}
            y={baselineY - 6}
            textAnchor="end"
            fontSize={11}
            fill="var(--text-muted)"
          >
            N={universeSize} baseline
          </text>

          {/* The real curve. */}
          <path d={linePath} fill="none" stroke="var(--series-1)" strokeWidth={2} />

          {/* The real best N. */}
          {bestPoint && (
            <g>
              <circle
                cx={xScale(bestPoint.n)}
                cy={yScale(bestPoint.endingBalance)}
                r={6}
                fill="var(--accent-reward)"
              />
              <text
                x={xScale(bestPoint.n)}
                y={yScale(bestPoint.endingBalance) - 12}
                textAnchor="middle"
                fontSize={11}
                fontWeight={700}
                fill="var(--accent-reward)"
              >
                Best: N={bestPoint.n}
              </text>
            </g>
          )}

          {/* The player's own guess, if it landed anywhere other than exactly on the best (bestPoint would otherwise render both markers on top of each other with no visual distinction). */}
          {guessedPoint && guessedN !== bestN && (
            <g>
              <circle
                cx={xScale(guessedPoint.n)}
                cy={yScale(guessedPoint.endingBalance)}
                r={6}
                fill="var(--accent-selection)"
              />
              <text
                x={xScale(guessedPoint.n)}
                y={yScale(guessedPoint.endingBalance) + 18}
                textAnchor="middle"
                fontSize={11}
                fontWeight={700}
                fill="var(--accent-selection)"
              >
                You: N={guessedPoint.n}
              </text>
            </g>
          )}

          {/* x-axis: start/end labels only (mirroring PortfolioChart.tsx's own two-label convention) -- every N in between is what the curve itself traces. */}
          <text
            x={0}
            y={PLOT_HEIGHT + 20}
            textAnchor="start"
            fontSize={11}
            fill="var(--text-muted)"
          >
            N=1
          </text>
          <text
            x={PLOT_WIDTH}
            y={PLOT_HEIGHT + 20}
            textAnchor="end"
            fontSize={11}
            fill="var(--text-muted)"
          >
            N={universeSize}
          </text>
        </g>
      </svg>
      <p className="sr-only">
        The best possible outcome held companies #1 through #{bestN} by real S&amp;P 500 weight.
        Your final guess was N={guessedN}. The full N=1 through N={universeSize} curve is plotted
        above, with the N={universeSize} (whole-index) baseline shown as a dashed, muted reference
        line.
      </p>
    </figure>
  );
}
