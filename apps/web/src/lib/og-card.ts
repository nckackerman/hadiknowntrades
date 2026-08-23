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
  dataAsOfLabel: string;
}

/**
 * Builds the OG card's display content from a precomputed result, or
 * returns `null` if this result doesn't support a card yet.
 *
 * A share card only exists for the "window" model today (5Y/MAX) -- the
 * "intraday-daily" model (1M/3M/1Y, issue #28) has no single top-level
 * `endingBalance` to headline, since per-day results don't compound (see
 * packages/core/CLAUDE.md's "Per-day intraday optimizer" note). Picking
 * which day's result a card would even feature is its own product
 * decision, not just a plumbing gap -- deliberately left out of scope for
 * this issue rather than guessed at. See apps/web/CLAUDE.md's OG card
 * note for the full reasoning.
 *
 * Deliberately keyed off the *result's own* `model` field rather than a
 * hardcoded range list (e.g. `["5Y", "MAX"]`) -- if a future issue ever
 * moves another range onto the intraday model (or the window model grows
 * a new range), this stays correct with no list to remember to update.
 */
export function buildOgCardContent(result: PrecomputedResult): OgCardContent | null {
  if (result.model !== "window") return null;

  const multiplier = result.endingBalance / result.startingCapital;
  return {
    range: result.range,
    startingCapitalLabel: formatHeroCurrency(result.startingCapital),
    endingBalanceLabel: formatHeroCurrency(result.endingBalance),
    multiplierLabel: formatMultiplier(multiplier),
    // Matches HeroStat's own multiplier-badge threshold (`>=`, not `>`)
    // deliberately, not HeroStat's stricter `isGain` -- see HeroStat.tsx's
    // own comment on why those two answer different questions.
    isMultiplierGain: multiplier >= 1,
    dataAsOfLabel: formatDate(result.dataAsOf),
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
