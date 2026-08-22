// Shared constants + validation for the user-configurable starting
// dollar amount (issue #15). Kept separate from use-starting-capital.ts
// (the localStorage-backed hook) so the pure parsing/clamping logic is
// trivially unit-testable without touching React or storage at all.

/** Today's fixed value, unchanged since before this feature -- the
 * default shown/used until a user picks something else, and what every
 * precomputed result's own `startingCapital` already is. */
export const DEFAULT_STARTING_CAPITAL = 20;

/** A cent -- the smallest amount that still reads as a real dollar
 * figure; there's no product reason to allow $0 or a negative starting
 * capital (the optimizer itself requires a positive startingCapital,
 * see packages/core/src/optimizer.ts's own validation). */
export const MIN_STARTING_CAPITAL = 0.01;

/**
 * $1 billion -- generous enough that no realistic user request feels
 * artificially capped, while still keeping the rescaled dollar figures
 * this produces (which multiply this by a possibly-astronomical Max
 * range multiplier, see packages/core/CLAUDE.md's "Max range" note)
 * comfortably within both float64's safe range and this app's existing
 * compact/scientific-notation formatting ladder (format-currency.ts) --
 * there is no risk of overflow to Infinity at this bound even against
 * the largest multipliers this app has ever produced.
 */
export const MAX_STARTING_CAPITAL = 1_000_000_000;

/** Clamps a starting-capital candidate into the supported
 * [MIN_STARTING_CAPITAL, MAX_STARTING_CAPITAL] range. Does not validate
 * finiteness -- callers that might hand this a NaN/Infinity (untrusted
 * input) should go through parseStartingCapital instead, which does. */
export function clampStartingCapital(value: number): number {
  return Math.min(MAX_STARTING_CAPITAL, Math.max(MIN_STARTING_CAPITAL, value));
}

/**
 * Parses a starting-capital candidate -- raw user input from the text
 * field, or a value read back from localStorage -- into a usable,
 * clamped, finite, positive number. Returns `null` for anything that
 * isn't a usable positive number at all (blank, whitespace-only, NaN,
 * zero, negative, or non-numeric text): callers fall back to
 * DEFAULT_STARTING_CAPITAL in that case rather than accepting garbage.
 */
export function parseStartingCapital(raw: string): number | null {
  if (raw.trim() === "") return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return null;
  return clampStartingCapital(value);
}
