// The daily hero's own pure computation (issue #161): what the most
// recently completed intraday trading day's own trades turned a *fresh*,
// date-seeded starting capital into, ignoring that day's real chained
// `startingCapital` (issue #84's `chainStartingCapital`, which carries a
// day's own starting balance forward from the *previous* day's real
// ending balance -- see apps/web/CLAUDE.md's
// "rescaleFromStartingCapital's per-day pattern..." section for the full
// story on why a day's own `startingCapital` isn't a flat value either).
//
// No new pipeline/schema computation is needed for this: the optimal
// trade sequence and its multiplier are entirely a function of price
// ratios, never of `startingCapital` itself (see
// packages/core/CLAUDE.md's note on this, already relied on by issue
// #15's configurable-starting-capital feature) -- so recompounding from
// a date-derived starting capital instead of the day's own chained
// capital is just a different starting value fed through the same
// multiplicative chain `narrate-trades.ts`'s own running-balance loop
// and `trade-math.ts`'s `compoundBalance` already use.
//
// The starting capital itself (issue #174) is deterministic per date,
// not literally random: `dailyChallengeStartingCapitalFor(date)` seeds
// this app's shared `mulberry32` PRNG (`lib/seeded-random.ts`) from a
// small FNV-1a-style hash of the date string (`seedFromDate`, mirroring
// `beat-the-bench-percentile.ts`'s own `seedFromBars`) and draws a
// single value in `[1, 10000)` -- so the same date always shows the
// exact same figure (no request-to-request/reload flicker), while
// different dates show different ones, purely for day-to-day visual
// variety in the daily hero. Unlike `seedFromBars`'s own doc comment
// (which explicitly warns against ever seeding from a session date, for
// Mystery Day's secrecy reasons), seeding from a date here is safe: the
// daily hero's date is already public, printed right in its own
// eyebrow -- there is nothing to leak.
//
// This does NOT randomize which trades are shown or how many -- the
// real trade count for a given day is whatever the optimizer actually
// found (0-3), unaffected by this seed; only the two dollar figures
// (and the prose narration's dollar figures, which already take
// `startingCapital` as a parameter) rescale to the new baseline.

import type { IntradayDayResult, IntradayTrade } from "@hadiknowntrades/core";

import type { Mode } from "./mode";
import { selectVariant } from "./select-variant";
import { mulberry32 } from "./seeded-random";
import { compoundBalance } from "./trade-math";

/** The inclusive lower bound `dailyChallengeStartingCapitalFor` can return. */
const MIN_STARTING_CAPITAL = 1;
/** Added to `MIN_STARTING_CAPITAL`; the resulting upper bound is exclusive -- a single `mulberry32` draw in `[0, 1)` scaled by this can never itself reach $10,000. */
const STARTING_CAPITAL_SPAN = 9999;

/**
 * A small FNV-1a-style hash of `date`, mirroring
 * `beat-the-bench-percentile.ts`'s own `seedFromBars` in style (loop
 * over characters, no external dependency) -- deterministic, so the
 * same date string always produces the same seed.
 */
function seedFromDate(date: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < date.length; i += 1) {
    hash = Math.imul(hash ^ date.charCodeAt(i), 0x01000193);
  }
  return hash >>> 0;
}

/**
 * A deterministic, date-seeded starting capital in `[1, 10000)` (the
 * lower bound is inclusive, the upper bound is exclusive). Calling this
 * twice with the same `date` always returns the exact same value --
 * it's a pure function of the date string, not the clock or a counter --
 * and different dates return different values in practice (not a
 * guarantee any PRNG can make in principle, but true for any real
 * sequence of calendar dates this app will ever see).
 */
export function dailyChallengeStartingCapitalFor(date: string): number {
  const rng = mulberry32(seedFromDate(date));
  return MIN_STARTING_CAPITAL + rng() * STARTING_CAPITAL_SPAN;
}

export interface DailyChallenge {
  /** The day's own calendar date, YYYY-MM-DD. */
  date: string;
  /** `dailyChallengeStartingCapitalFor(date)` -- kept on the shape (rather than every caller re-deriving it a second time) so a formatter can read it the same way it reads `endingBalance`. */
  startingCapital: number;
  /**
   * `startingCapital` compounded through this day's own mode-selected
   * trade sequence, in order -- deliberately NOT `day.endingBalance`/
   * `day.longShort.endingBalance` (both chained from the *previous*
   * day's real ending balance, issue #84), which would silently answer
   * a different question ("what did this day turn whatever came before
   * it into") than the one this feature asks ("what would this day's
   * own seeded starting capital have turned into on this one day").
   */
  endingBalance: number;
  trades: IntradayTrade[];
}

/**
 * Recompounds `day`'s own mode-selected trade sequence (issue #13's
 * `selectVariant`) from `dailyChallengeStartingCapitalFor(day.date)`,
 * ignoring the day's real chained `startingCapital` entirely.
 */
export function dailyChallengeFor(day: IntradayDayResult, mode: Mode): DailyChallenge {
  const variant = selectVariant<IntradayTrade>(day, day.longShort, mode);
  const startingCapital = dailyChallengeStartingCapitalFor(day.date);
  const endingBalance = variant.trades.reduce(
    (balance, trade) =>
      compoundBalance(balance, trade.openPrice, trade.closePrice, trade.direction),
    startingCapital,
  );
  return {
    date: day.date,
    startingCapital,
    endingBalance,
    trades: variant.trades,
  };
}
