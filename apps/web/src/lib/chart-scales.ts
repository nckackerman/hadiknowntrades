// Small scale helpers for PortfolioChart. Kept separate from the
// component so the tick-generation logic (the only genuinely tricky
// part) is unit-testable without rendering React/SVG.

/**
 * A linear scale from a [min, max] date range (as epoch millis) to a
 * pixel range. Values can span many orders of magnitude across a
 * portfolio's lifetime, but time itself is linear -- no log scale
 * needed here, only for the value axis (see buildLogScale below).
 */
export function buildTimeScale(domain: [number, number], range: [number, number]) {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const span = d1 - d0;
  return (t: number): number => (span === 0 ? (r0 + r1) / 2 : r0 + ((t - d0) / span) * (r1 - r0));
}

/**
 * Positions for a chained multi-day intraday series (issue #93): every
 * distinct calendar day in `dayKeys` gets an equal-width slot across
 * `range` -- ordinal *by day*, not by point -- and within a day, its own
 * points are placed linearly by their real timestamp, proportional to
 * that day's own first-to-last point span.
 *
 * Ordinal-by-day rather than plain ordinal-by-point (an earlier version
 * of this fix, found wrong in code review): a day chained by
 * deriveWholeRangeIntradaySeries produces a different number of points
 * depending on how many trades happened -- 1 point for a no-trade day,
 * up to 10 for a day at DEFAULT_MAX_TRADES_PER_DAY = 3 (appendTradeSteps
 * pushes 3 points per trade, plus the day's own leading point). Spacing
 * evenly *by point* would give a single busy day disproportionate pixel
 * width purely because it has more plotted points -- on a 5-day range,
 * one maxed-out day among four quiet ones could claim roughly 70% of the
 * chart's width despite being 1 of 5 trading days, trading the original
 * calendar-dead-time distortion this fix targets for a new
 * trade-activity-count distortion instead of actually fixing anything.
 * Giving every day an equal slot regardless of its own point count
 * avoids that, while linear placement *within* a day's slot still
 * reflects real intraday timing -- a single trading session has no
 * market-closed gaps to compress, so real time is still the honest
 * choice there.
 *
 * `dayKeys` and `timestamps` are parallel arrays, one entry per point (a
 * point's calendar-day key and its real epoch-millisecond timestamp,
 * respectively) -- both derived from the same points array by the
 * caller, kept as plain arrays here so this stays unit-testable without
 * PortfolioPoint's other fields.
 */
export function buildChainedIntradayXPositions(
  dayKeys: readonly string[],
  timestamps: readonly number[],
  range: [number, number],
): number[] {
  const [r0, r1] = range;
  if (dayKeys.length === 0) return [];
  // A single point overall has no real span to lay out -- same "midpoint
  // on a zero-span domain" fallback the other scales in this file use,
  // and avoids the first/last-point pinning below (see it below)
  // colliding on the same lone index.
  if (dayKeys.length === 1) return [(r0 + r1) / 2];

  const dayIndex = new Map<string, number>();
  for (const key of dayKeys) {
    if (!dayIndex.has(key)) dayIndex.set(key, dayIndex.size);
  }
  const totalDays = dayIndex.size;
  const slotWidth = (r1 - r0) / totalDays;

  // Each day's own [min, max] timestamp, to normalize its points into a
  // [0, 1] fraction of that day's slot.
  const dayMin = new Map<string, number>();
  const dayMax = new Map<string, number>();
  dayKeys.forEach((key, i) => {
    const ts = timestamps[i]!;
    dayMin.set(key, Math.min(dayMin.get(key) ?? ts, ts));
    dayMax.set(key, Math.max(dayMax.get(key) ?? ts, ts));
  });

  const positions = dayKeys.map((key, i) => {
    const slotStart = r0 + dayIndex.get(key)! * slotWidth;
    const min = dayMin.get(key)!;
    const max = dayMax.get(key)!;
    // A day with only one point (no trades that day) has no real span to
    // interpolate across -- center it in its slot, the same "midpoint on
    // a zero-span domain" fallback buildTimeScale/buildLogScale use.
    const fraction = min === max ? 0.5 : (timestamps[i]! - min) / (max - min);
    return slotStart + fraction * slotWidth;
  });

  // The series' very first and last points are pinned exactly to r0/r1,
  // overriding the centered placement above when the first or last day
  // happens to be a single-point (no-trade) day -- otherwise the line
  // (and PortfolioChart's own start/end axis labels, which are always
  // pinned to the plot's edges regardless of where a point actually
  // lands) would visibly stop short of the chart's edge.
  positions[0] = r0;
  positions[positions.length - 1] = r1;

  return positions;
}

/**
 * A log10 scale for the value axis. Portfolio values here can span from
 * a $20 starting balance to an astronomically large "Max" range ending
 * balance (see packages/core/CLAUDE.md's note on ~$716M+ demo runs) --
 * many orders of magnitude in one chart. A linear axis would render
 * every early, small value as visually indistinguishable from zero;
 * log keeps every step legible regardless of scale. Domain values must
 * be > 0 (portfolio value is always positive by construction -- see
 * derivePortfolioSeries).
 */
export function buildLogScale(domain: [number, number], range: [number, number]) {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const logD0 = Math.log10(d0);
  const logD1 = Math.log10(d1);
  const span = logD1 - logD0;
  return (value: number): number => {
    const logValue = Math.log10(value);
    return span === 0 ? (r0 + r1) / 2 : r0 + ((logValue - logD0) / span) * (r1 - r0);
  };
}

/**
 * Picks readable tick values for a log-scaled axis spanning [min, max]
 * (both > 0): whole powers of ten, thinned to at most `maxTicks` by
 * stepping over exponents rather than crowding every single one in
 * (e.g. a 20-order-of-magnitude domain gets every 4th power of ten, not
 * all 20).
 *
 * Whole powers of ten only work as gridlines when they actually land
 * inside [min, max] -- a domain narrower than one decade (a flat result,
 * or a modest gain on a short range) can have none at all, which would
 * otherwise render every gridline/label off the visible plot. Falls
 * back to evenly log-spaced points across the real domain in that case,
 * so the axis always has *some* in-bounds reference ticks.
 */
export function niceLogTicks(min: number, max: number, maxTicks = 5): number[] {
  if (!(min > 0) || !(max > 0) || min > max) {
    return [];
  }

  const loExp = Math.floor(Math.log10(min));
  const hiExp = Math.ceil(Math.log10(max));
  const exponentCount = hiExp - loExp + 1;
  const step = exponentCount <= maxTicks ? 1 : Math.ceil(exponentCount / maxTicks);

  const powersOfTen: number[] = [];
  for (let exp = loExp; exp <= hiExp; exp += step) {
    powersOfTen.push(10 ** exp);
  }

  const inDomain = powersOfTen.filter((tick) => tick >= min && tick <= max);
  if (inDomain.length > 0) {
    return inDomain;
  }

  const logMin = Math.log10(min);
  const logMax = Math.log10(max);
  const count = Math.min(maxTicks, 4);
  // Clamp rather than trust the interpolated 10**x round-trip exactly --
  // floating-point error can otherwise land the last tick a hair past
  // `max` (or the first a hair before `min`), which is the exact bug
  // this fallback exists to avoid.
  return Array.from({ length: count }, (_, i) => {
    const value = 10 ** (logMin + ((logMax - logMin) * i) / (count - 1));
    return Math.min(max, Math.max(min, value));
  });
}
