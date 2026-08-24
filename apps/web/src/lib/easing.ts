// Shared easing curve and tween helper for this app's RAF-driven value
// tweens -- extracted from use-count-up.ts (issue #35) once a second
// animation (use-trade-replay.ts, issue #96) needed the identical curve,
// per that issue's own Background section: "extract the easing function to
// a shared location if a second animation needs it."

/** ease-out cubic: fast start, settles gently into the final value -- reads as a value "arriving," not a linear ticker. */
export function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

/**
 * Interpolates from `from` to `to` at progress `t` (0..1) via
 * `easeOutCubic`, snapping to the exact `to` once `t >= 1` rather than
 * relying on `from + (to - from) * easeOutCubic(1)` to land there
 * bit-for-bit -- mathematically the same, but not guaranteed bit-identical
 * by floating point. Extracted here (code review, issue #96 follow-up
 * round 3) once this exact "linear-interpolate via easeOutCubic, snap at
 * the end" formula turned out to be duplicated between use-count-up.ts and
 * use-trade-replay.ts: only the curve itself (`easeOutCubic` above) had
 * been shared before this, so use-count-up.ts's own snap guard (needed for
 * its "pixel-identical final render" acceptance criteria -- landing on a
 * hair less than the true target would otherwise round differently in
 * rare cases) never made it into use-trade-replay.ts's own independent
 * copy of the same formula. One implementation now backs both call sites.
 */
export function tweenValue(from: number, to: number, t: number): number {
  return t >= 1 ? to : from + (to - from) * easeOutCubic(t);
}
