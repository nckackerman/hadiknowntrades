// Pure, unit-testable content for the OG share card (issue #33). The
// actual pixel rendering happens in the route
// (../app/api/og/[range]/route.ts) via Next's `ImageResponse` (Satori),
// which isn't practically unit-testable the way plain string/number
// logic is -- see that file's own header comment and this repo's working
// agreement to verify rendering live instead. This module holds
// everything that *is* worth a fast, deterministic unit test: which
// results currently support a card, and the exact display strings/colors
// derived from one.

import type { PrecomputedResult } from "@hadiknowntrades/core";

import { formatDate } from "./format-date";
import { formatHeroCurrency, formatMultiplier } from "./format-currency";

export interface OgCardContent {
  range: PrecomputedResult["range"];
  startingCapitalLabel: string;
  endingBalanceLabel: string;
  multiplierLabel: string;
  isMultiplierGain: boolean;
  /**
   * The line under the figures naming what this result actually is
   * (issue #134) -- e.g. "Max range - best possible 3-trade outcome" for
   * the window model, or "1 week range - best possible 3 trades a day,
   * chained day to day" for the intraday-daily model. Built here rather
   * than hardcoded in OgCard.tsx (where it used to live, back when the
   * window model was the only one with a card at all): the two models
   * genuinely describe different things, and a chained intraday range's
   * card claiming a "3-trade outcome" would be flatly wrong -- 1Y's own
   * chained result routinely runs to hundreds of trades.
   */
  subtitleLabel: string;
  dataAsOfLabel: string;
}

/**
 * Builds the OG card's display content from a precomputed result, or
 * returns `null` if this result has no single figure to headline.
 *
 * **Both result models are supported since issue #134.** This function
 * used to return `null` for anything but the "window" model (5Y/MAX), on
 * the reasoning that the "intraday-daily" model (1W/1M/3M/1Y, issue #28;
 * 1W since issue #60) had "no single top-level `endingBalance` to
 * headline, since per-day results don't compound" and that picking which
 * day to feature was its own unanswered product decision. **That reason
 * is stale**: issues #84/#91 shipped whole-range capital chaining (day
 * N starts from day N-1's own ending balance -- see
 * apps/pipeline/CLAUDE.md's "Chained per-day starting capital"), so the
 * range as a whole now has exactly one meaningful headline figure, and
 * the page itself already headlines it (`WholeRangeBalance.tsx`, fed by
 * `ResultsPanel.tsx`'s own `wholeRangeFinalBalance`). No day has to be
 * picked -- the card shows the same whole-range figure the page does.
 *
 * That whole-range balance is derived exactly the way `ResultsPanel.tsx`
 * derives its own: the **final** day's ending balance, paired with the
 * **range's own root** `startingCapital` -- never a per-day
 * `startingCapital`, which would algebraically cancel the chaining back
 * out and silently show an "as if this day started fresh" figure
 * instead (see apps/web/CLAUDE.md's "rescaleFromStartingCapital's
 * per-day pattern silently cancels out per-day capital chaining"
 * section for that trap in full).
 *
 * Still long-only, both models -- `longShort` is never read here, same
 * deliberate scoping as when the card first shipped (see
 * apps/web/CLAUDE.md's "Long-only vs. long+short mode" section on why a
 * mode-aware card would double this route's own cached-variant matrix).
 *
 * Deliberately keyed off the *result's own* `model` field rather than a
 * hardcoded range list (e.g. `["5Y", "MAX"]`) -- if a future issue ever
 * moves another range between models, this stays correct with no list to
 * remember to update.
 */
export function buildOgCardContent(result: PrecomputedResult): OgCardContent | null {
  const headline =
    result.model === "window" ? windowHeadline(result) : intradayDailyHeadline(result);
  if (!headline) return null;

  const multiplier = headline.endingBalance / headline.startingCapital;
  return {
    range: result.range,
    startingCapitalLabel: formatHeroCurrency(headline.startingCapital),
    endingBalanceLabel: formatHeroCurrency(headline.endingBalance),
    multiplierLabel: formatMultiplier(multiplier),
    // Matches HeroStat's own multiplier-badge threshold (`>=`, not `>`)
    // deliberately, not HeroStat's stricter `isGain` -- see HeroStat.tsx's
    // own comment on why those two answer different questions.
    isMultiplierGain: multiplier >= 1,
    subtitleLabel: `${rangeLabel(result.range)} range · ${headline.summary}`,
    dataAsOfLabel: formatDate(result.dataAsOf),
  };
}

interface CardHeadline {
  startingCapital: number;
  endingBalance: number;
  /** The part of the card's subtitle after the range label. */
  summary: string;
}

function windowHeadline(result: Extract<PrecomputedResult, { model: "window" }>): CardHeadline {
  return {
    startingCapital: result.startingCapital,
    endingBalance: result.endingBalance,
    // Reads `maxTrades` rather than hardcoding "3" the way this sentence
    // did while it lived in OgCard.tsx -- the schema already carries the
    // real ceiling this run used (see WindowResult.maxTrades' own doc
    // comment), and AboutSection's own copy already reads it too.
    summary: `best possible ${result.maxTrades}-trade outcome`,
  };
}

/**
 * The whole-range chained headline for an intraday-daily result (issue
 * #134) -- `null` for a result with no days at all (a range the pipeline
 * found no trading day for, e.g. a 1W window over a holiday week), which
 * has no figure to headline and so gets no card, the same 404 an
 * unpublished range already gets.
 */
function intradayDailyHeadline(
  result: Extract<PrecomputedResult, { model: "intraday-daily" }>,
): CardHeadline | null {
  const finalDay = result.days.at(-1);
  if (!finalDay) return null;

  return {
    // The range's own root, NOT finalDay.startingCapital (that day's own
    // chained carry-in) -- see this module's own doc comment above.
    startingCapital: result.startingCapital,
    endingBalance: finalDay.endingBalance,
    summary: `best possible ${result.maxTradesPerDay} trades a day, chained day to day`,
  };
}

/** Human-readable label for a preset range, for the card's caption. */
export function rangeLabel(range: PrecomputedResult["range"]): string {
  switch (range) {
    case "1W":
      return "1 week";
    case "1M":
      return "1 month";
    case "3M":
      return "3 months";
    case "1Y":
      return "1 year";
    case "5Y":
      return "5 years";
    case "MAX":
      return "Max";
  }
}
