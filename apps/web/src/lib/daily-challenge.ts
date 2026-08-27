// The daily hero's own pure computation (issue #161): what the most
// recently completed intraday trading day's own trades turned a *fresh*
// $20 into, ignoring that day's real chained `startingCapital` (issue
// #84's `chainStartingCapital`, which carries a day's own starting
// balance forward from the *previous* day's real ending balance -- see
// apps/web/CLAUDE.md's "rescaleFromStartingCapital's per-day pattern..."
// section for the full story on why a day's own `startingCapital` isn't
// a flat $20 any more).
//
// No new pipeline/schema computation is needed for this: the optimal
// trade sequence and its multiplier are entirely a function of price
// ratios, never of `startingCapital` itself (see
// packages/core/CLAUDE.md's note on this, already relied on by issue
// #15's configurable-starting-capital feature) -- so recompounding from
// $20 instead of the day's own chained capital is just a different
// starting value fed through the same multiplicative chain
// `narrate-trades.ts`'s own running-balance loop and `trade-math.ts`'s
// `compoundBalance` already use.

import type { IntradayDayResult, IntradayTrade } from "@hadiknowntrades/core";

import type { Mode } from "./mode";
import { selectVariant } from "./select-variant";
import { compoundBalance } from "./trade-math";

/**
 * The daily challenge always starts from a fresh $20, regardless of what
 * the underlying day's own (chained) `startingCapital` actually is --
 * see this module's own header comment.
 */
export const DAILY_CHALLENGE_STARTING_CAPITAL = 20;

export interface DailyChallenge {
  /** The day's own calendar date, YYYY-MM-DD. */
  date: string;
  /** Always DAILY_CHALLENGE_STARTING_CAPITAL -- kept on the shape (rather than every caller hardcoding 20 a second time) so a formatter can read it the same way it reads `endingBalance`. */
  startingCapital: number;
  /**
   * DAILY_CHALLENGE_STARTING_CAPITAL compounded through this day's own
   * mode-selected trade sequence, in order -- deliberately NOT
   * `day.endingBalance`/`day.longShort.endingBalance` (both chained from
   * the *previous* day's real ending balance, issue #84), which would
   * silently answer a different question ("what did this day turn
   * whatever came before it into") than the one this feature asks
   * ("what would a fresh $20 have turned into on this one day").
   */
  endingBalance: number;
  trades: IntradayTrade[];
}

/**
 * Recompounds `day`'s own mode-selected trade sequence (issue #13's
 * `selectVariant`) from a fresh $20, ignoring the day's real chained
 * `startingCapital` entirely.
 */
export function dailyChallengeFor(day: IntradayDayResult, mode: Mode): DailyChallenge {
  const variant = selectVariant<IntradayTrade>(day, day.longShort, mode);
  const endingBalance = variant.trades.reduce(
    (balance, trade) =>
      compoundBalance(balance, trade.openPrice, trade.closePrice, trade.direction),
    DAILY_CHALLENGE_STARTING_CAPITAL,
  );
  return {
    date: day.date,
    startingCapital: DAILY_CHALLENGE_STARTING_CAPITAL,
    endingBalance,
    trades: variant.trades,
  };
}
