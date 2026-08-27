// A small, fast, fully deterministic PRNG (mulberry32) shared by any
// feature in this app that needs seeded randomness -- 32 bits of state,
// uniform enough for this and reproducible across engines, unlike
// `Math.random()`, whose sequence is not specified or seedable at all.
//
// Promoted out of `beat-the-bench-percentile.ts` (issue #132's own
// original home for this) once issue #174's
// `dailyChallengeStartingCapitalFor` (`daily-challenge.ts`) became a
// second, non-game consumer -- a plain display-layer feature depending
// on a module named "beat-the-bench" would be a real, avoidable
// coupling smell, and this codebase's own established convention is to
// extract a shared helper the moment a genuine second caller needs it
// (see e.g. `trade-math.ts`, `easing.ts`, `replay-callout.ts`,
// `select-variant.ts`, `range-copy.ts`). `beat-the-bench-percentile.ts`
// re-exports `mulberry32`/`Rng` from here so its own existing callers
// (`BeatTheBench.tsx` and its own test file) needed zero import
// changes.

/** A source of uniform `[0, 1)` numbers, shaped exactly like `Math.random` so a caller can pass that if it genuinely wants unseeded randomness. Nothing in this app does. */
export type Rng = () => number;

/**
 * Used for production seeding as well as in tests: this module has no
 * "real randomness" mode that tests then have to work around.
 */
export function mulberry32(seed: number): Rng {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
