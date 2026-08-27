"use client";

// The ticking price chart Beat the Bench plays through (issue #131).
//
// Deliberately its own small SVG rather than a reuse of
// PortfolioChart.tsx, which is a different chart of a different thing:
// that one plots a *portfolio* over trade events on a **log** value axis
// (it has to survive $20 -> $218M) and takes Trade/PortfolioPoint shapes
// this game doesn't have. This plots one ticker's real intraday closes
// across a single session, where the whole day's range is typically well
// under 2% -- a log axis there would be indistinguishable from linear
// while making every label harder to read. Same hand-rolled-SVG posture
// as the rest of this app (see apps/web/CLAUDE.md's "Chart: hand-rolled
// SVG, no library"), just its own scales.
//
// **The y-domain is derived from the *revealed* bars only, never the
// whole session.** That isn't an implementation shortcut -- an axis
// scaled to the full day would silently publish the day's high and low
// before the player reaches them, which is the one thing this game
// cannot show. The domain therefore expands as bars arrive (it can only
// ever grow, since revealed prices only accumulate), which is honest and
// stable rather than jittery.

import type { SessionBar } from "@hadiknowntrades/core";

import { formatTime } from "@/lib/format-date";
import type { Position } from "@/lib/beat-the-bench";

const WIDTH = 880;
const HEIGHT = 300;
// No bottom axis labels live inside this SVG (see the render comment
// where they used to be), so the bottom margin only has to clear the
// live-price dot's own radius where the line ends low in the plot.
const MARGIN = { top: 16, right: 16, bottom: 12, left: 16 };
const PLOT_WIDTH = WIDTH - MARGIN.left - MARGIN.right;
const PLOT_HEIGHT = HEIGHT - MARGIN.top - MARGIN.bottom;

/** Fraction of the revealed price range added above and below it, so the line never runs along the very edge of the plot. */
const DOMAIN_PADDING = 0.15;

interface BeatTheBenchChartProps {
  /** The session's full bar list -- the x-axis is laid out across all of them from the first frame, so the line grows into a stable frame instead of restretching every tick. Prices beyond `revealedIndex` are never read. */
  bars: readonly SessionBar[];
  /** How much of the session has been revealed: bars 0..revealedIndex are drawn, the rest are not (and their prices are not looked at). */
  revealedIndex: number;
  /** The player's position *after* each revealed bar, parallel to `bars[0..revealedIndex]` -- drives the in-market/in-cash styling of each segment. */
  positions: readonly Position[];
}

/**
 * Splits `[0..revealedIndex]` into runs of consecutive bars sharing one
 * position, so each run can be drawn as its own polyline. A run carries
 * the segment *leading into* each of its bars, so a run starts at the
 * previous run's last bar -- otherwise the line would visibly break at
 * every trade.
 */
export function positionRuns(
  positions: readonly Position[],
  revealedIndex: number,
): { position: Position; from: number; to: number }[] {
  if (revealedIndex < 1) return [];
  const runs: { position: Position; from: number; to: number }[] = [];
  let start = 0;
  for (let i = 1; i <= revealedIndex; i += 1) {
    // The segment from bar i-1 to bar i is ridden in whatever position
    // the player was in *at* bar i-1 (a toggle at bar i applies from
    // that bar's own price onward).
    const segmentPosition = positions[i - 1] ?? "holding";
    const nextPosition = positions[i] ?? "holding";
    if (segmentPosition !== nextPosition || i === revealedIndex) {
      runs.push({ position: segmentPosition, from: start, to: i });
      start = i;
    }
  }
  return runs;
}

export function BeatTheBenchChart({ bars, revealedIndex, positions }: BeatTheBenchChartProps) {
  const lastIndex = Math.min(Math.max(revealedIndex, 0), bars.length - 1);
  const revealed = bars.slice(0, lastIndex + 1);
  const prices = revealed.map((bar) => bar.close);
  const openingPrice = prices[0]!;

  const rawMin = Math.min(...prices);
  const rawMax = Math.max(...prices);
  // A single revealed bar (or a dead-flat run of them) has no range to
  // scale against -- give it a small synthetic one so the line renders
  // through the middle of the plot instead of dividing by zero.
  const span = rawMax - rawMin || Math.max(rawMax * 0.001, 0.01);
  const min = rawMin - span * DOMAIN_PADDING;
  const max = rawMax + span * DOMAIN_PADDING;

  const xAt = (index: number): number =>
    bars.length <= 1 ? PLOT_WIDTH / 2 : (index / (bars.length - 1)) * PLOT_WIDTH;
  const yAt = (price: number): number => PLOT_HEIGHT - ((price - min) / (max - min)) * PLOT_HEIGHT;

  const pointsFor = (from: number, to: number): string =>
    revealed
      .slice(from, to + 1)
      .map((bar, i) => `${xAt(from + i).toFixed(2)},${yAt(bar.close).toFixed(2)}`)
      .join(" ");

  const runs = positionRuns(positions, lastIndex);
  const currentPrice = prices[lastIndex]!;
  const currentPosition = positions[lastIndex] ?? "holding";

  return (
    <svg
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      role="img"
      aria-label={`${formatTime(bars[lastIndex]!.time)}, price ${currentPrice.toFixed(2)}. The chart updates as the session plays; the live figures below it carry the same information.`}
      className="w-full"
    >
      <g transform={`translate(${MARGIN.left},${MARGIN.top})`}>
        {/* Where the session opened -- and, since the player starts in
            the market, where buying and holding breaks even. */}
        <line
          x1={0}
          x2={PLOT_WIDTH}
          y1={yAt(openingPrice)}
          y2={yAt(openingPrice)}
          stroke="var(--baseline)"
          strokeWidth={1}
          strokeDasharray="4 4"
        />
        <line
          x1={0}
          x2={PLOT_WIDTH}
          y1={PLOT_HEIGHT}
          y2={PLOT_HEIGHT}
          stroke="var(--gridline)"
          strokeWidth={1}
        />

        {/* One polyline per run of bars sharing a position: solid blue
            while the player is in the market, muted and dashed while
            they're in cash -- the price kept moving, they just weren't
            on it. */}
        {runs.map((run) => (
          <polyline
            key={`${run.position}-${run.from}`}
            points={pointsFor(run.from, run.to)}
            fill="none"
            stroke={run.position === "holding" ? "var(--series-1)" : "var(--text-muted)"}
            strokeDasharray={run.position === "holding" ? undefined : "5 4"}
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        ))}

        {/* Every point at which the player toggled. */}
        {revealed.map((bar, i) => {
          const previous = i === 0 ? null : (positions[i - 1] ?? "holding");
          const current = positions[i] ?? "holding";
          if (previous === null || previous === current) return null;
          return (
            <circle
              key={`move-${i}`}
              cx={xAt(i)}
              cy={yAt(bar.close)}
              r={5}
              fill="var(--background)"
              stroke={current === "holding" ? "var(--series-1)" : "var(--text-secondary)"}
              strokeWidth={2}
            />
          );
        })}

        {/* The live price. Gold is reserved for earned state (issue
            #121), so this stays a plain series/muted dot. */}
        <circle
          cx={xAt(lastIndex)}
          cy={yAt(currentPrice)}
          r={4.5}
          fill={currentPosition === "holding" ? "var(--series-1)" : "var(--text-muted)"}
        />

        {/* No time labels inside the SVG, deliberately. This viewBox is
            880 units wide and renders at ~295px on a 375px screen, so a
            12px label (PortfolioChart's own axis size) paints at about
            4px there -- and early in a session the opening and live
            labels overprint each other into a smudge besides. Both were
            seen for real at 375px. The caller renders the same two times
            as ordinary HTML above the chart instead, crisp at any
            width. */}
      </g>
    </svg>
  );
}
