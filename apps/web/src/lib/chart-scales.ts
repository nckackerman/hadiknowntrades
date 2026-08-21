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
