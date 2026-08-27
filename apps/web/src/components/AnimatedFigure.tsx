import { useMemo, type ComponentPropsWithoutRef } from "react";

import { heroCurrencyWidthProbes } from "@/lib/format-currency";

interface AnimatedFigureProps extends ComponentPropsWithoutRef<"span"> {
  /**
   * The tween's *endpoints*, as displayed (already rescaled) -- not the
   * value currently on screen. The reserved box is derived from these,
   * so it must not move while the figure counts.
   */
  from: number;
  to: number;
  /** The already-formatted figure to show this frame. */
  value: string;
}

/**
 * A `formatHeroCurrency` figure that changes value in place, in a box
 * that never changes width (issue #147).
 *
 * **The problem this solves.** Issue #124 measured the real app: the
 * hero's 1.2s count-up changed the animated span's bounding box on
 * essentially every frame, which re-wrapped the `flex flex-wrap` row it
 * sits in and moved everything below the hero -- the chart, the "Trades"
 * heading, the page's own scroll height -- by up to 76px while the
 * number counted. Two independent causes:
 *
 *   1. Geist Sans' proportional figures: its "1" is 25.4px against its
 *      "0"'s 42.4px at 64px/600, so even two *same-length* strings
 *      ("$11.11" vs "$00.00") differ by 81px. Fixed by `font-numeric
 *      tabular-nums` on the shared value-row classes (`HeroStat.tsx`'s
 *      `heroValueRowClassName`, `WholeRangeBalance.tsx`'s
 *      `wholeRangeValueRowClassName`) -- see those constants' own
 *      comments for why the row, not this span, is where that belongs,
 *      and `HeroStat.tsx`'s doc comment for why Geist Sans'
 *      `tabular-nums` alone measured insufficient.
 *   2. `formatHeroCurrency`'s compact-unit ladder changing the string's
 *      *shape* mid-tween ("$994.72" -> "$1K", a 128px drop in one frame).
 *      No choice of figures does anything about this one -- seven
 *      characters are wider than three in any face -- and this component
 *      is the part that does.
 *
 * **How the box is reserved.** Not by predicting pixel widths in JS (the
 * app can't measure a glyph it hasn't painted, and jsdom can't measure
 * one at all): the browser measures it. Every candidate string the tween
 * could pass through -- one per ladder tier it crosses, from
 * `heroCurrencyWidthProbes` -- is rendered as an invisible sibling, all
 * stacked into the same single grid cell as the real value. A grid
 * column is sized to its widest item, so the box is exactly as wide as
 * the widest string the tween can produce, on every frame including the
 * first and last. Each probe paints from a `data-figure-probe` attribute
 * via `globals.css`'s `.figure-width-probe` rule rather than holding a
 * real text node, so the probes never leak into this figure's own
 * `textContent` -- see that rule's own comment.
 *
 * The reservation stays correct if the row's typography changes, since
 * nothing here assumes anything about glyph metrics -- but note the
 * probe set is a bound on *length*, and only a face whose glyphs all
 * share one advance (the `font-numeric` Geist Mono the value rows use,
 * issue #121/#147) makes "longest string" and "widest string" the same
 * question. `format-currency.test.ts` asserts the length bound directly.
 *
 * Typically that is 1-3 probes ("$99.99" alone for a `$20 -> $21.43`
 * day; "$999.99"/"$9.9K" added for a 5Y result that crosses $1K), and
 * at most one per tier for even a `$20 -> $218M` sweep. When the tween
 * crosses no boundary at all the single probe is the same shape as the
 * value itself, so the reservation costs no extra width -- it just makes
 * the constancy explicit rather than incidental.
 *
 * **Both sides of an overlay must render this with the same `from`/`to`.**
 * `HeroAndWorstCase`'s `heroSlot` and `WholeRangeBalance`'s `revealSlot`
 * are `absolute inset-0` overlays sized by the real, invisible figure
 * behind them, so the two only stay the same height while they wrap
 * identically -- issue #107 broke exactly that, twice, each time by
 * changing one side's metrics and not the other's. Reserving through one
 * shared component (rather than a class string each side applies by
 * hand) is what makes the two impossible to give different widths.
 */
export function AnimatedFigure({ from, to, value, ...spanProps }: AnimatedFigureProps) {
  // Constant for a whole run, but every caller re-renders on each of the
  // dozens of RAF-driven frames while animating -- the same reason every
  // other per-frame value in TradeReplay.tsx/WholeRangeReplay.tsx is
  // memoized.
  const probes = useMemo(() => heroCurrencyWidthProbes(from, to), [from, to]);

  return (
    <span {...spanProps} className={`grid${spanProps.className ? ` ${spanProps.className}` : ""}`}>
      {probes.map((probe) => (
        <span
          key={probe}
          aria-hidden="true"
          data-figure-probe={probe}
          className="figure-width-probe invisible col-start-1 row-start-1"
        />
      ))}
      <span className="col-start-1 row-start-1">{value}</span>
    </span>
  );
}
