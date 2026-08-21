import { describe, expect, it } from "vitest";

import { formatAxisCurrency, formatHeroCurrency, formatPercent } from "./format-currency";

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
});

describe("formatAxisCurrency", () => {
  it("rounds to whole dollars, no cents", () => {
    expect(formatAxisCurrency(19.6)).toBe("$20");
  });

  it("still uses compact suffixes above $1,000", () => {
    expect(formatAxisCurrency(6876.86)).toBe("$6.9K");
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
