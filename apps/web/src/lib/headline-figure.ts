// "Which number does this page headline right now?" (issue #133).
//
// The daily ritual's shareable recap has to quote the *real* headline
// figure, and this app has two result models that headline two genuinely
// different figures:
//
//   - **window / custom-window (5Y, Max, and a custom start-date anchor):**
//     `HeroStat`'s own figure -- the variant's `endingBalance` for the
//     active mode, rescaled to the viewer's starting capital.
//   - **intraday-daily (1W/1M/3M/1Y):** the whole-range *chained* balance
//     `WholeRangeBalance` headlines -- the final day's ending balance for
//     the active mode, rescaled from the **range's own root**
//     `startingCapital`. Explicitly not the per-day hero figure the
//     drill-down below it shows, and explicitly not the per-day rescale
//     pattern (see `wholeRangeFinalBalance` below).
//
// Stating it here once, rather than leaving the recap to read "whatever's
// active", is the whole point of this module: `ResultsPanel.tsx` computes
// the second of those figures through this same function, so the recap and
// the page can't drift apart on what the day's number actually was.

import type { CustomWindowResult, IntradayResult, PrecomputedResult } from "@hadiknowntrades/core";
import type { IntradayTrade, PresetRange, Trade } from "@hadiknowntrades/core";

import { formatDate } from "./format-date";
import type { Mode } from "./mode";
import { RANGE_COPY } from "./range-copy";
import { rescaleFromStartingCapital } from "./rescale-starting-capital";
import { selectVariant } from "./select-variant";

/** The single figure the active view headlines, plus enough context to write a sentence about it. */
export interface HeadlineFigure {
  /**
   * Which model produced it. Callers that gate on this app's one
   * guess-then-reveal spoiler gate (issue #91) need it: only the
   * intraday-daily model's figure is hidden behind a guess.
   */
  model: "window" | "intraday-daily";
  /**
   * The full phrase naming the window, preposition included -- "over the
   * past week", "since Mar 1, 2019". Carries its own preposition for the
   * same reason `WindowResultBody`'s `descriptionPhrase` does: a preset
   * range and a custom start-date anchor need different ones.
   */
  rangePhrase: string;
  /** What the viewer started with, in the dollars they chose (issue #15). */
  startingCapital: number;
  /** What perfect hindsight turned it into, in those same dollars. */
  endingBalance: number;
}

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

/**
 * The headline figure for a loaded result, or `null` when there's nothing
 * to headline yet (no days in an intraday range).
 *
 * `range` is the active preset range, or `null` in custom start-date anchor
 * mode (issue #11) -- in which case `data` is always a `CustomWindowResult`
 * and the label comes from its own start date instead.
 */
export function headlineFigureFor(
  data: PrecomputedResult | CustomWindowResult,
  range: PresetRange | null,
  mode: Mode,
  startingCapital: number | undefined,
): HeadlineFigure | null {
  if (data.model === "intraday-daily") {
    if (data.days.length === 0) return null;
    const effectiveStartingCapital = startingCapital ?? data.startingCapital;
    return {
      model: "intraday-daily",
      // A preset range is the only way this model is ever fetched (see
      // ResultsPanel's own invariant check), so RANGE_COPY always has a
      // phrase for it; the fallback is defensive, not a reachable state.
      rangePhrase: range === null ? "over this range" : `over ${RANGE_COPY[range]}`,
      startingCapital: effectiveStartingCapital,
      endingBalance: wholeRangeFinalBalance(data, mode, effectiveStartingCapital),
    };
  }

  const effectiveStartingCapital = startingCapital ?? data.startingCapital;
  const variant = selectVariant<Trade>(data, data.longShort, mode);
  return {
    model: "window",
    rangePhrase:
      data.model === "custom-window"
        ? `since ${formatDate(data.startDate)}`
        : `over ${RANGE_COPY[data.range]}`,
    startingCapital: effectiveStartingCapital,
    endingBalance: rescaleFromStartingCapital(
      variant.endingBalance,
      data.startingCapital,
      effectiveStartingCapital,
    ),
  };
}
