import { describe, expect, it } from "vitest";

import {
  formatAxisCurrency,
  formatHeroCurrency,
  formatMultiplier,
  formatPercent,
} from "./format-currency";

describe("formatHeroCurrency", () => {
  it("formats sub-$1,000 values plainly, with cents", () => {
    expect(formatHeroCurrency(20)).toBe("$20.00");
    expect(formatHeroCurrency(0)).toBe("$0.00");
    expect(formatHeroCurrency(999.99)).toBe("$999.99");
  });

  it("formats thousands with a K suffix", () => {
    expect(formatHeroCurrency(6876.860256895814)).toBe("$6.9K");
    expect(formatHeroCurrency(1000)).toBe("$1K");
  });

  it("formats millions/billions/trillions with compact suffixes", () => {
    expect(formatHeroCurrency(716_000_000)).toBe("$716M");
    expect(formatHeroCurrency(1_500_000_000)).toBe("$1.5B");
    expect(formatHeroCurrency(2_000_000_000_000)).toBe("$2T");
  });

  it("drops trailing .0 rather than showing e.g. $20.0K", () => {
    expect(formatHeroCurrency(20_000)).toBe("$20K");
  });

  it("switches to scientific notation for astronomical values instead of piling up digits", () => {
    // This is the case the CLAUDE.md note warns about: real full-universe
    // "Max" runs can compound far past what a suffix ladder (…, T) can
    // express -- verified live that Intl's own compact notation just
    // pastes raw digits in front of "T" (e.g. "$1,000,000,000T" for
    // 1e21) rather than doing anything readable, which is exactly the
    // "looks broken" failure mode this function exists to avoid.
    expect(formatHeroCurrency(1e15)).toBe("$1.00×10¹⁵");
    expect(formatHeroCurrency(1e21)).toBe("$1.00×10²¹");
    expect(formatHeroCurrency(5.678e33)).toBe("$5.68×10³³");
  });

  it("handles non-finite input defensively", () => {
    expect(formatHeroCurrency(NaN)).toBe("--");
    expect(formatHeroCurrency(Infinity)).toBe("--");
  });

  it("handles negative values (theoretical, but this is display code)", () => {
    expect(formatHeroCurrency(-6876.86)).toBe("-$6.9K");
  });

  it("steps up to the next unit instead of rounding to an out-of-range value like $1000K", () => {
    // 999,600 / 1000 = 999.6, which toFixed(0)'s to "1000" -- must step
    // up to M rather than display "$1000K".
    expect(formatHeroCurrency(999_600)).toBe("$1M");
    // Same boundary one unit up: 999,950,000,000 rounds to "1000B" at
    // the B unit, must step up to T.
    expect(formatHeroCurrency(999_950_000_000)).toBe("$1T");
    // Just under the boundary: no step-up, still shows at the smaller unit.
    expect(formatHeroCurrency(999_400)).toBe("$999K");
  });

  it("falls through to scientific notation when rounding would push the largest compact unit (T) out of range", () => {
    // 999,960,000,000,000 / 1e12 = 999.96, which toFixed(0)'s to "1000"
    // -- there's no unit above T to step up to, so this must format as
    // scientific instead of showing "$1000T".
    expect(formatHeroCurrency(999_960_000_000_000)).toBe("$1.00×10¹⁵");
  });
});

describe("formatAxisCurrency", () => {
  it("rounds to whole dollars, no cents", () => {
    expect(formatAxisCurrency(19.6)).toBe("$20");
  });

  it("still uses compact suffixes above $1,000", () => {
    expect(formatAxisCurrency(6876.86)).toBe("$6.9K");
  });
});

describe("formatMultiplier", () => {
  it("formats sub-10x values with one decimal place, no trailing .0", () => {
    expect(formatMultiplier(1)).toBe("1x");
    expect(formatMultiplier(1.5)).toBe("1.5x");
    expect(formatMultiplier(0.2)).toBe("0.2x");
  });

  it("formats 10x and above as a whole number", () => {
    expect(formatMultiplier(345)).toBe("345x");
    expect(formatMultiplier(999.4)).toBe("999x");
  });

  it("switches to the compact K/M/B/T ladder at 1000x, same as currency", () => {
    expect(formatMultiplier(1000)).toBe("1Kx");
    expect(formatMultiplier(6876.860256895814)).toBe("6.9Kx");
    expect(formatMultiplier(716_000_000)).toBe("716Mx");
    expect(formatMultiplier(1_500_000_000)).toBe("1.5Bx");
    expect(formatMultiplier(2_000_000_000_000)).toBe("2Tx");
  });

  it("drops trailing .0 rather than showing e.g. 20.0Kx", () => {
    expect(formatMultiplier(20_000)).toBe("20Kx");
  });

  it("steps up to the next unit instead of rounding to an out-of-range value like 1000Kx", () => {
    expect(formatMultiplier(999_600)).toBe("1Mx");
    expect(formatMultiplier(999_950_000_000)).toBe("1Tx");
    expect(formatMultiplier(999_400)).toBe("999Kx");
  });

  it("switches to scientific notation at/above SCIENTIFIC_THRESHOLD instead of piling up digits", () => {
    // Same astronomical-scale case as formatHeroCurrency's own test --
    // a "Max" range's multiplier can be just as huge as the dollar
    // figure it's derived from (packages/core/CLAUDE.md's "Max range"
    // note), and the shared ladder must cover it the same way.
    expect(formatMultiplier(1e15)).toBe("1.00×10¹⁵x");
    expect(formatMultiplier(1e21)).toBe("1.00×10²¹x");
    expect(formatMultiplier(5.678e33)).toBe("5.68×10³³x");
  });

  it("falls through to scientific notation when rounding would push the largest compact unit (T) out of range", () => {
    expect(formatMultiplier(999_960_000_000_000)).toBe("1.00×10¹⁵x");
  });

  it("handles non-finite input defensively", () => {
    expect(formatMultiplier(NaN)).toBe("--");
    expect(formatMultiplier(Infinity)).toBe("--");
  });

  it("handles negative values (theoretical, but this is display code)", () => {
    expect(formatMultiplier(-6876.86)).toBe("-6.9Kx");
  });
});

describe("formatPercent", () => {
  it("signs positive and negative returns", () => {
    expect(formatPercent(4.123)).toBe("+412.3%");
    expect(formatPercent(-0.08)).toBe("-8.0%");
    expect(formatPercent(0)).toBe("+0.0%");
  });

  it("handles non-finite input defensively", () => {
    expect(formatPercent(NaN)).toBe("--");
  });
});
