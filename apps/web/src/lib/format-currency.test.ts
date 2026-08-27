import { describe, expect, it } from "vitest";

import {
  formatAxisCurrency,
  formatHeroCurrency,
  formatMultiplier,
  formatPercent,
  formatSessionPercent,
  heroCurrencyWidthProbes,
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

  it("steps up to the compact ladder instead of rounding a sub-$1,000 value up to $1,000.00 (issue #45's known-but-unfixed bug, now fixed)", () => {
    // 999.995 rounds to "1000.00" at 2 decimals (the cents branch) --
    // must step up to "$1K" rather than ever displaying "$1,000.00".
    expect(formatHeroCurrency(999.995)).toBe("$1K");
  });
});

describe("formatAxisCurrency", () => {
  it("rounds to whole dollars, no cents", () => {
    expect(formatAxisCurrency(19.6)).toBe("$20");
  });

  it("still uses compact suffixes above $1,000", () => {
    expect(formatAxisCurrency(6876.86)).toBe("$6.9K");
  });

  it("steps up to the compact ladder instead of rounding a sub-$1,000 value up to $1,000 (issue #45's known-but-unfixed bug, now fixed)", () => {
    // 999.6 rounds to "1000" at 0 decimals (the no-cents branch) -- must
    // step up to "$1K" rather than ever displaying "$1,000".
    expect(formatAxisCurrency(999.6)).toBe("$1K");
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

  it("steps up to the compact ladder instead of rounding a sub-1000 value up to 1000x", () => {
    // 999.95 rounds to "1000" at 0 decimals in the plain-number branch --
    // must step up to "1Kx" rather than ever displaying "1000x".
    expect(formatMultiplier(999.95)).toBe("1Kx");
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

describe("formatSessionPercent", () => {
  // A single trading session (Beat the Bench, issue #131) moves a
  // fraction of a percent -- at formatPercent's one decimal, a real
  // 0.053% day and a real 0.086% one both print "+0.1%", and the
  // player's return and the bench's would routinely read identical even
  // when one genuinely won.
  it("keeps a second decimal, where formatPercent would round the difference away", () => {
    expect(formatSessionPercent(0.00052898)).toBe("+0.05%");
    expect(formatPercent(0.00052898)).toBe("+0.1%");
    expect(formatSessionPercent(0.0042798)).toBe("+0.43%");
  });

  it("signs both directions, same convention as formatPercent", () => {
    expect(formatSessionPercent(-0.0031)).toBe("-0.31%");
    expect(formatSessionPercent(0)).toBe("+0.00%");
  });

  it("handles non-finite input defensively", () => {
    expect(formatSessionPercent(NaN)).toBe("--");
  });
});

describe("heroCurrencyWidthProbes (issue #147)", () => {
  // The probes exist to reserve a fixed box for a figure that counts up,
  // and that figure renders in a monospace face (see AnimatedFigure.tsx),
  // so "widest string" and "longest string" are the same question --
  // which is exactly the half that IS assertable without a real browser.
  const longest = (strings: string[]) => Math.max(0, ...strings.map((s) => s.length));

  /** Values a tween from `from` to `to` passes through, densely sampled. */
  function sweep(from: number, to: number): number[] {
    const values: number[] = [from, to];
    // Linear *and* geometric sampling: a purely linear sweep barely
    // resolves the bottom of a $20 -> $218M range, where several of the
    // ladder's tiers live.
    for (let i = 1; i < 2000; i++) {
      values.push(from + ((to - from) * i) / 2000);
      values.push(from * Math.pow(to / from, i / 2000));
    }
    return values;
  }

  it("bounds every string a tween can produce, for each range issue #147 measures", () => {
    // 1W/1Y per-day (no ladder crossing), 5Y (crosses $1K), MAX (crosses
    // $1K and $1M), plus a scientific-notation sweep for completeness.
    for (const [from, to] of [
      [20, 21.43],
      [20, 1145.91],
      [20, 218_048_363.85],
      [20, 4.2e19],
    ] as const) {
      const bound = longest(heroCurrencyWidthProbes(from, to));
      for (const value of sweep(from, to)) {
        expect(formatHeroCurrency(value).length).toBeLessThanOrEqual(bound);
      }
    }
  });

  it("is tight, not merely safe -- the bound is a string the tween really reaches", () => {
    // A reservation wider than anything actually displayed would show as
    // dead space beside the figure, so the widest probe should equal the
    // widest string the sweep genuinely produces.
    for (const [from, to] of [
      [20, 21.43],
      [20, 1145.91],
      [20, 218_048_363.85],
    ] as const) {
      const observed = Math.max(...sweep(from, to).map((v) => formatHeroCurrency(v).length));
      expect(longest(heroCurrencyWidthProbes(from, to))).toBe(observed);
    }
  });

  it("stays correct when an interval straddles a tier without containing its widest value", () => {
    // $1,000 -> $2,000 formats as "$1K"/"$2K" at both endpoints but
    // "$1.5K" in between -- sampling the endpoints would under-reserve.
    expect(heroCurrencyWidthProbes(1000, 2000)).toEqual(["$9.9K"]);
    expect(formatHeroCurrency(1500).length).toBeLessThanOrEqual(longest(["$9.9K"]));
  });

  it("returns one probe per ladder tier the interval touches", () => {
    expect(heroCurrencyWidthProbes(20, 21.43)).toEqual(["$99.99"]);
    expect(heroCurrencyWidthProbes(20, 1145.91)).toEqual(["$99.99", "$999.99", "$9.9K"]);
    expect(heroCurrencyWidthProbes(5, 250)).toEqual(["$9.99", "$99.99", "$999.99"]);
  });

  it("is symmetric in its arguments -- a losing tween reserves the same box as a winning one", () => {
    expect(heroCurrencyWidthProbes(1145.91, 20)).toEqual(heroCurrencyWidthProbes(20, 1145.91));
  });

  it("covers the sign and every magnitude down to zero for a negative endpoint", () => {
    // Not reachable from any real result (balances are positive), but
    // this is display code at the edge of the app -- see the function's
    // own comment on why it over-reserves rather than modelling this.
    const probes = heroCurrencyWidthProbes(-50, 20);
    expect(probes).toEqual(["-$9.99", "-$99.99"]);
    expect(formatHeroCurrency(-49.99).length).toBeLessThanOrEqual(longest(probes));
  });

  it("reserves nothing for a non-finite endpoint, since the figure renders a fixed '--'", () => {
    expect(heroCurrencyWidthProbes(20, NaN)).toEqual([]);
    expect(heroCurrencyWidthProbes(Infinity, 20)).toEqual([]);
  });
});
