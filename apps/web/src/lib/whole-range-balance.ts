// The intraday-daily model's whole-range chained final balance (issue
// #84's chaining pass) -- `WholeRangeBalance.tsx`'s own headline figure,
// also read by `WholeRangeReplay.tsx` and `og-card.ts` so none of the
// three can drift on what the range's own number actually is.
//
// This file used to also hold `headlineFigureFor`/`HeadlineFigure`, a
// second, more general "what does the active view headline right now"
// helper backing the daily ritual's shareable recap (issue #133) -- both
// removed when that recap section was removed outright (direct user
// feedback that it added little on top of what the two game tiles
// already show at a glance). `wholeRangeFinalBalance` below was always
// the narrower, still-needed piece; renamed from `headline-figure.ts` to
// `whole-range-balance.ts` so the file name matches what's actually left
// in it.

import type { IntradayTrade, IntradayResult } from "@hadiknowntrades/core";

import type { Mode } from "./mode";
import { rescaleFromStartingCapital } from "./rescale-starting-capital";
import { selectVariant } from "./select-variant";

/**
 * The intraday-daily model's whole-range chained final balance, for
 * whichever track `mode` selects, rescaled from the range's own root
 * starting capital.
 *
 * **Deliberately NOT the per-day rescale pattern** (a day's
 * `endingBalance` paired with that *same day's own* `startingCapital`),
 * which would algebraically cancel the day-to-day chaining back out and
 * silently produce the "as if this day started fresh" figure instead of the
 * real carried-over one. See apps/web/CLAUDE.md's
 * "rescaleFromStartingCapital's per-day pattern silently cancels out..."
 * section for the exact trap this avoids -- do not "simplify" this to reuse
 * that pattern.
 *
 * Returns 0 for a result with no days at all, matching what the page
 * renders in that state.
 */
export function wholeRangeFinalBalance(
  data: IntradayResult,
  mode: Mode,
  effectiveStartingCapital: number,
): number {
  const finalDay = data.days.at(-1);
  if (!finalDay) return 0;
  return rescaleFromStartingCapital(
    selectVariant<IntradayTrade>(finalDay, finalDay.longShort, mode).endingBalance,
    data.startingCapital,
    effectiveStartingCapital,
  );
}
