// Shared easing curve for this app's RAF-driven value tweens -- extracted
// from use-count-up.ts (issue #35) once a second animation
// (use-trade-replay.ts, issue #96) needed the identical curve, per that
// issue's own Background section: "extract the easing function to a
// shared location if a second animation needs it."

/** ease-out cubic: fast start, settles gently into the final value -- reads as a value "arriving," not a linear ticker. */
export function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}
