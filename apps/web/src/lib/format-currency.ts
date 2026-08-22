// Currency/multiplier formatting for the hero stat and chart axis. See
// packages/core/CLAUDE.md's "Fun/expected product quirk" note: the "Max"
// range genuinely produces astronomically large endingBalance values (a
// demo run hit ~$716M from $20; real full-universe runs over decades can
// go far higher) -- a naive `$` format looks broken at that scale, and
// Intl.NumberFormat's own `notation: "compact"` doesn't actually help
// past its largest defined unit (trillion): it keeps piling raw digits
// in front of "T" instead of stepping to a bigger unit, e.g.
// $1,000,000,000T for 1e21. See this file's tests for that behavior
// verified live against the runtime's Intl implementation. The same
// astronomical-scale problem applies to the endingBalance/startingCapital
// *multiplier* (issue #45) -- a "Max" range's ratio can be just as huge
// as the dollar figure it's derived from, so formatMultiplier below
// shares this same compact/scientific ladder rather than re-deriving it.

const COMPACT_UNITS: { threshold: number; suffix: string }[] = [
  { threshold: 1e12, suffix: "T" },
  { threshold: 1e9, suffix: "B" },
  { threshold: 1e6, suffix: "M" },
  { threshold: 1e3, suffix: "K" },
];

// Past this, even a single-letter-per-3-orders suffix ladder (…, T) runs
// out of letters -- switch to scientific notation rather than inventing
// non-standard unit names or letting digits pile up.
const SCIENTIFIC_THRESHOLD = 1e15;

const SUPERSCRIPT_DIGITS: Record<string, string> = {
  "0": "⁰",
  "1": "¹",
  "2": "²",
  "3": "³",
  "4": "⁴",
  "5": "⁵",
  "6": "⁶",
  "7": "⁷",
  "8": "⁸",
  "9": "⁹",
  "-": "⁻",
  "+": "",
};

function toSuperscript(exponent: number): string {
  return String(exponent)
    .split("")
    .map((char) => SUPERSCRIPT_DIGITS[char] ?? char)
    .join("");
}

/**
 * Scientific-notation fallback shared by every ladder past
 * SCIENTIFIC_THRESHOLD. `prefix`/`suffix` are the only thing that differ
 * between the `$`-prefixed currency ladder ("$1.23×10¹⁶") and the
 * unitless-`x` multiplier ladder ("1.23×10¹⁶x").
 */
function formatScientific(sign: string, abs: number, { prefix = "", suffix = "" } = {}): string {
  const exponential = abs.toExponential(2); // e.g. "1.23e+16"
  const [mantissa, exponent] = exponential.split("e");
  return `${sign}${prefix}${mantissa}×10${toSuperscript(Number(exponent))}${suffix}`;
}

/**
 * The K/M/B/T compact-suffix step, shared by both the currency and
 * multiplier ladders: scales `abs` (normally already known to be >= 1000)
 * down to the largest unit that keeps it under 1000, stepping up a unit
 * if rounding would otherwise push it out of range (e.g. 999,600 -> "1000"
 * at the K unit steps up to "1M" instead of showing "1000K"). Returns
 * `null` when even the largest unit (T) rounds out of range -- the
 * caller's cue to fall through to `formatScientific` instead.
 *
 * Also tolerates `abs` just *under* 1000 (e.g. 999.95): `formatMultiplier`'s
 * own plain-number branch calls this as its overflow guard when rounding
 * a sub-1000 value at display precision would round it up to 1000 (see
 * that function) -- no COMPACT_UNITS threshold matches (`findIndex`
 * returns -1) since none of K/M/B/T's thresholds are actually crossed, so
 * that case defaults to the smallest unit (K) rather than the
 * non-null-asserted `undefined` that a plain lookup would produce.
 */
function scaleToCompactUnit(
  abs: number,
): { scaled: number; digits: number; suffix: string } | null {
  const foundIndex = COMPACT_UNITS.findIndex((u) => abs >= u.threshold);
  const unitIndex = foundIndex === -1 ? COMPACT_UNITS.length - 1 : foundIndex;
  let unit = COMPACT_UNITS[unitIndex]!;
  let scaled = abs / unit.threshold;
  // One decimal place, but don't show a trailing ".0" (e.g. "20K" not
  // "20.0K") -- matches the stat-tile convention from the dataviz skill
  // (auto-compact: 1,284 / 12.9K / $4.2M).
  let digits = scaled >= 100 ? 0 : 1;

  // toFixed rounds, and rounding can push a value right up to the next
  // unit's boundary -- step up to the next larger unit instead of ever
  // displaying an out-of-range "1000K".
  if (Number(scaled.toFixed(digits)) >= 1000) {
    if (unitIndex === 0) {
      // Already at the largest compact unit (T): rounding pushed it past
      // 999T, which is effectively the scientific-notation boundary this
      // ladder already draws at 1e15.
      return null;
    }
    unit = COMPACT_UNITS[unitIndex - 1]!;
    scaled = abs / unit.threshold;
    digits = scaled >= 100 ? 0 : 1;
  }

  return { scaled, digits, suffix: unit.suffix };
}

/**
 * Formats `abs` (>= 1000) via the shared compact/scientific ladder,
 * wrapping the result in `prefix`/`suffix` -- the one piece of the
 * ladder that's specific to which caller (currency vs. multiplier) is
 * using it.
 */
function formatCompactOrScientific(
  sign: string,
  abs: number,
  options: { prefix?: string; suffix?: string } = {},
): string {
  if (abs >= SCIENTIFIC_THRESHOLD) {
    return formatScientific(sign, abs, options);
  }

  const scale = scaleToCompactUnit(abs);
  if (!scale) {
    return formatScientific(sign, abs, options);
  }

  const formatted = scale.scaled.toFixed(scale.digits).replace(/\.0$/, "");
  return `${sign}${options.prefix ?? ""}${formatted}${scale.suffix}${options.suffix ?? ""}`;
}

const plainCurrencyWithCents = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const plainCurrencyWhole = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

/**
 * Shared formatting logic for the hero stat and chart axis labels, which
 * only differ in whether a sub-$1,000 value shows cents (the hero stat
 * does; an axis tick doesn't need that precision).
 *
 *   - Below $1,000: plain "$1,234.56" (or "$1,235" without cents).
 *   - $1,000 up to $1e15: a compact suffix, "$6.9K" / "$716M" / "$1.2T".
 *   - $1e15 and above: scientific notation, "$1.23×10¹⁶" -- never a
 *     wall of piled-up digits.
 *
 * Handles non-finite input defensively (NaN/Infinity can't come from a
 * well-formed PrecomputedResult, but this is display code at the edge of
 * the app, not internal plumbing that gets to assume a clean upstream).
 */
function formatCurrency(value: number, { cents }: { cents: boolean }): string {
  if (!Number.isFinite(value)) {
    return "--";
  }

  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);

  if (abs < 1000) {
    return sign + (cents ? plainCurrencyWithCents : plainCurrencyWhole).format(abs);
  }

  return formatCompactOrScientific(sign, abs, { prefix: "$" });
}

/**
 * Formats a dollar amount for the hero stat ("$20.00 -> $6.9K"), staying
 * readable across the full range this app can produce -- a few dollars
 * up through astronomical perfect-hindsight compounding. See
 * `formatCurrency` above for the exact rules.
 */
export function formatHeroCurrency(value: number): string {
  return formatCurrency(value, { cents: true });
}

/** A shorter form for compact spaces (chart Y-axis ticks) -- same rules, no cents. */
export function formatAxisCurrency(value: number): string {
  return formatCurrency(value, { cents: false });
}

/** Formats a signed percentage return, e.g. "+412.3%" / "-8.0%". */
export function formatPercent(fraction: number): string {
  if (!Number.isFinite(fraction)) {
    return "--";
  }
  const sign = fraction >= 0 ? "+" : "";
  return `${sign}${(fraction * 100).toFixed(1)}%`;
}

/**
 * Formats a unitless "345x" multiplier badge for the hero stat (issue
 * #45), e.g. `formatMultiplier(endingBalance / startingCapital)`. Shares
 * `formatCurrency`'s compact-suffix/scientific-notation ladder
 * (`scaleToCompactUnit`, `formatScientific`) rather than duplicating it,
 * since a "Max" range's multiplier can be just as astronomically large
 * as the dollar figure it's derived from -- see this file's top-of-file
 * comment and `packages/core/CLAUDE.md`'s "Max range" note.
 *
 *   - Below 1000x: a plain number, whole from 10x up ("345x"), one
 *     decimal below that ("1.5x") -- unlike formatCurrency, there's no
 *     currency-style cents concept for a unitless ratio. If rounding to
 *     that precision would push the value up to 1000 (e.g. 999.95 ->
 *     "1000" at 0 decimals), steps up into the compact ladder instead of
 *     ever displaying an out-of-range "1000x" -- the same class of
 *     overflow `scaleToCompactUnit` already guards against one tier up
 *     (e.g. 999,600 -> "1M" rather than "1000K").
 *   - 1000x up to 1e15x: a compact suffix, same ladder as currency
 *     ("6.9Kx" / "716Mx" / "1.2Tx").
 *   - 1e15x and above: scientific notation ("1.23×10¹⁶x").
 */
export function formatMultiplier(value: number): string {
  if (!Number.isFinite(value)) {
    return "--";
  }

  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);

  if (abs < 1000) {
    const digits = abs >= 10 ? 0 : 1;
    const rounded = abs.toFixed(digits);
    if (Number(rounded) < 1000) {
      return `${sign}${rounded.replace(/\.0$/, "")}x`;
    }
    // Rounding overflowed to 1000 -- fall through to the compact ladder
    // below instead of returning "1000x".
  }

  return formatCompactOrScientific(sign, abs, { suffix: "x" });
}
