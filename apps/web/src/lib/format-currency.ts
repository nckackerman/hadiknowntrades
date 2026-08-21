// Currency formatting for the hero stat and chart axis. See
// packages/core/CLAUDE.md's "Fun/expected product quirk" note: the "Max"
// range genuinely produces astronomically large endingBalance values (a
// demo run hit ~$716M from $20; real full-universe runs over decades can
// go far higher) -- a naive `$` format looks broken at that scale, and
// Intl.NumberFormat's own `notation: "compact"` doesn't actually help
// past its largest defined unit (trillion): it keeps piling raw digits
// in front of "T" instead of stepping to a bigger unit, e.g.
// $1,000,000,000T for 1e21. See this file's tests for that behavior
// verified live against the runtime's Intl implementation.

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

function formatScientific(sign: string, abs: number): string {
  const exponential = abs.toExponential(2); // e.g. "1.23e+16"
  const [mantissa, exponent] = exponential.split("e");
  return `${sign}$${mantissa}×10${toSuperscript(Number(exponent))}`;
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

  if (abs >= SCIENTIFIC_THRESHOLD) {
    return formatScientific(sign, abs);
  }

  // COMPACT_UNITS' smallest threshold is 1e3 and abs >= 1000 is already
  // guaranteed above, so this always finds a unit -- non-null assertion
  // documents that instead of an unreachable fallback branch.
  const unitIndex = COMPACT_UNITS.findIndex((u) => abs >= u.threshold);
  let unit = COMPACT_UNITS[unitIndex]!;
  let scaled = abs / unit.threshold;
  // One decimal place, but don't show a trailing ".0" (e.g. "$20K" not
  // "$20.0K") -- matches the stat-tile convention from the dataviz skill
  // (auto-compact: 1,284 / 12.9K / $4.2M).
  let digits = scaled >= 100 ? 0 : 1;

  // toFixed rounds, and rounding can push a value right up to the next
  // unit's boundary (e.g. 999,600 -> "1000" at the K unit) -- step up to
  // the next larger unit instead of ever displaying an out-of-range
  // "$1000K".
  if (Number(scaled.toFixed(digits)) >= 1000) {
    if (unitIndex === 0) {
      // Already at the largest compact unit (T): rounding pushed it
      // past 999T, which is effectively the scientific-notation
      // boundary this function already draws at 1e15.
      return formatScientific(sign, abs);
    }
    unit = COMPACT_UNITS[unitIndex - 1]!;
    scaled = abs / unit.threshold;
    digits = scaled >= 100 ? 0 : 1;
  }

  const formatted = scaled.toFixed(digits).replace(/\.0$/, "");
  return `${sign}$${formatted}${unit.suffix}`;
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
