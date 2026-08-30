"use client";

// The daily hero (issue #161), restructured into a fixed-height,
// cinematic "showcase" box with a one-time entrance animation, and the
// per-trade narrative folded directly into each ticker chip (issue
// #175) -- superseding the previous version's separate
// TradeNarrationList component/"Yesterday's trades" section and "See
// the trades ↓" link, both deleted outright by this issue. See
// docs/design/gamified-hero-2026-08/ (read its own README first) for
// the visual target -- 99% fidelity, not pixel-perfect; this component
// uses this app's own real design tokens/components (HeroStat's
// exported classes, PortfolioChart, TradeReplay's buttonClassName,
// trade-math.ts's computeTradeReturn), not the mockup's own literal
// inline CSS/JS.
//
// Mounted directly in ResultsPage.tsx, above the existing header/range
// explorer -- unchanged from issue #161. Still fetches its own data
// (useDailyChallenge, the same fixed `/api/results?range=1W`
// use-call-board.ts already fetches) rather than taking a
// PrecomputedResult prop.
//
// **No guess-then-reveal gate here** (unchanged from issue #161) --
// this is a direct statement, not gated behind WholeRangeBalance's own
// mechanic. That mechanic (and the whole 1W range view it lives in) is
// completely untouched by this issue; it's a secondary, demoted view
// (issue #165).
//
// **Deliberately not animated at the *value* level** -- unlike
// HeroStat.tsx's count-up reveal, the dollar figures render their final
// value immediately, no useCountUp/CelebrationBurst/reveal-accent glow.
// What issue #175 *does* animate is the showcase's own one-time entrance
// (see below) -- a different axis (does the box fade/pop into view once)
// from whether any number tweens. Reusing HeroStat's exported typography
// classes (heroValueRowClassName, heroMultiplierClassName/
// heroMultiplierColor) still gives this section the same hero-scale look
// and the same gain/loss coloring convention with zero new CSS.
//
// **Grows on reveal, no longer reserves the worst case upfront -- a
// deliberate reversal of issue #175's original design, per a later
// design pass that asked for a smaller default box.**
// SHOWCASE_MIN_HEIGHT_CLASSNAME is a CSS `min-height`, not a fixed
// `height`: the box takes up roughly half its old (issue #175) size by
// default -- loading, a 0-trade day, or a real day with the chart still
// hidden -- and grows on its own, via ordinary content flow, once
// "Watch it happen" mounts the chart into its own reserved slot (see
// below, only actually reserved while revealed). This isn't in tension
// with issue #147's "reserve the worst case, don't shrink to the common
// case" principle for the hero count-up -- that principle is about a
// *tween* sweeping through several sizes while animating (see this
// component's own "Deliberately not animated at the value level" note
// above), which never happens here; growing once, in direct response to
// a real click, is a different question, and this design pass explicitly
// asked for a smaller default that only grows on demand. `overflow-hidden`
// on the outer box stays as a defensive safety net, and every state's own
// content is still centered (`justify-center`) rather than stretched to
// fill the box.
//
// **The chart slot (CHART_SLOT_HEIGHT_CLASSNAME) is deliberately much
// taller than the mockup's own 4.75rem, and only reserved once the chart
// is actually revealed** -- the mockup's chart is a tiny decorative
// inline <svg> with `preserveAspectRatio="none"`, stretched to whatever
// box it's given; this reuses the real PortfolioChart.tsx (per issue
// #175's own Out of scope: no changes to that file or its reveal
// mechanics), whose axis text is sized in SVG viewBox units and would
// render illegibly small if squeezed into a mockup-sized box. The slot
// is sized generously enough to comfortably fit that real chart's
// natural aspect-ratio height at this card's own real content width
// (tuned against a live `next build`/`next start` render, see this
// file's own CLAUDE.md section), with `overflow-y-auto` as a defensive
// fallback -- not `overflow-hidden` -- so a viewer who expands the
// chart's own nested "View chart data as a table" disclosure can still
// scroll to see it rather than having it silently clipped. Before the
// chart is revealed, this same slot holds only the "Watch it happen"
// button at its own natural height -- no large reserved space -- which
// is what makes the box's default height roughly half its revealed one.
//
// **Entrance animation plays once and holds, respecting
// prefers-reduced-motion (issue #175)**: `useReducedMotionAfterMount`
// (not `useReducedMotionAtMount`'s `useState`-lazy-initializer shortcut
// -- that hook's own doc comment says it's only safe from a component
// that never renders during SSR, and this one, mounted unconditionally
// at the ResultsPage level, can) starts `false` on every server render
// and the client's first (hydration) render, correcting to `true` after
// mount only if the viewer genuinely prefers reduced motion -- the same
// deferred-correction shape `BeatTheBench.tsx`'s `SessionGame` already
// established this hook for (see that hook's own doc comment for the
// full SSR-safety argument). `playEntranceAnimation` only ever goes
// true -> false, never back -- safe even given the brief window where a
// fast reduced-motion correction could interrupt a just-started
// animation, because every "-animate" class's own resting sibling class
// (always applied alongside it) already renders the exact settled
// values the animation itself ends on (`animation: ... both` in
// globals.css) -- removing the "-animate" class mid-flight just snaps
// to those same values instead of stranding the element mid-fade. See
// globals.css's own `daily-hero-fade-up`/`daily-hero-pop`/
// `daily-hero-chip` comment block for the full reasoning.
//
// A re-render that doesn't remount this section's content subtree (e.g.
// an unrelated ResultsPage-level state change) never replays the
// animation -- the "-animate" classNames are unconditional strings
// computed from `playEntranceAnimation` alone, not re-added via a key or
// an effect, so React never touches the className attribute unless that
// boolean itself changes. The animation only plays again if this
// section's own content subtree is torn down and freshly mounted (e.g.
// the loading -> real-result transition), never merely because content
// changed within an already-mounted instance.
//
// **Issue #162's chart-hide mechanism is reused exactly as it was,
// unchanged (per this issue's own Out of scope for PortfolioChart.tsx
// and its reveal mechanics)** -- a plain local `chartRevealed` boolean,
// no playback animation of its own; clicking "Watch it happen" simply
// mounts <PortfolioChart>, still fed by `deriveWholeRangeIntradaySeries`.
//
// **Accessibility tradeoff, deliberate and checked (issue #175's own
// Background section): deleting TradeNarrationList/"Yesterday's
// trades"/"See the trades ↓" does not remove the exact buy/sell prices
// and times from reach.** Once "Watch it happen" is clicked,
// PortfolioChart's own already-existing accessible data table
// (ChartDataTable, see apps/web/CLAUDE.md's chart-accessibility notes)
// exposes every point's date/time/price -- nothing is silently lost, it
// just moves behind the existing chart reveal, one click away instead of
// an always-visible prose section. See apps/web/CLAUDE.md's own daily
// hero (issue #175) section for the full writeup.
//
// **Issue #187 moved the eyebrow date line out of this box entirely**,
// up into ResultsPage.tsx's own `<header>`, next to the `<h1>` -- sourced
// there via a third, independent `useDailyChallenge(mode)` call (this
// hook's own doc comment already establishes the "independent fetch
// relying on the browser's HTTP cache" pattern for a second caller,
// `CallBoard.tsx`'s `useCallBoardCloses`; a third caller is consistent
// with that precedent, not a new architectural risk). No date text
// remains inside this section at all any more -- the zero-trade
// fallback's own copy dropped its inline date reference too ("...cash
// yesterday." rather than "...cash on {date}.") for the same reason.
// The "had you known" statement is now this box's first line, and every
// later element's own `animationDelay` shifted down by 200ms (the
// eyebrow's old slot) to keep the staggered entrance's relative spacing
// unchanged.

import { useMemo, useState } from "react";

import {
  heroMultiplierClassName,
  heroMultiplierColor,
  heroValueRowClassName,
} from "@/components/HeroStat";
import { PortfolioChart } from "@/components/PortfolioChart";
import { formatHeroCurrency, formatMultiplier, formatPercent } from "@/lib/format-currency";
import type { Mode } from "@/lib/mode";
import { deriveWholeRangeIntradaySeries, type PortfolioPoint } from "@/lib/portfolio-series";
import { computeTradeReturn } from "@/lib/trade-math";
import { useDailyChallenge } from "@/lib/use-daily-challenge";
import { useReducedMotionAfterMount } from "@/lib/use-reduced-motion-after-mount";

interface DailyHeroProps {
  mode: Mode;
}

/**
 * A CSS `min-height` floor, not a fixed `height` -- shared by every
 * top-level, chart-hidden render this section can produce (loading, a
 * 0-trade day, and a real day before "Watch it happen" is clicked), so
 * those states never visibly resize against each other. The box grows
 * past this floor on its own once the chart's own slot mounts.
 *
 * **Issue #198 shrunk this again, against a precise live measurement of
 * the design reference (`docs/design/daily-hub-condensed-2026-08/
 * mockup-daily-hub-condensed.html`'s own `.showcase.collapsed` --
 * chart-hidden/"Fresh day" state), not the earlier design pass's rough
 * "about half" eyeball.** Measured live via `next build && next start`
 * plus a headless-Chromium pass against the reference file directly, at
 * a 1280px viewport, chart-hidden state: the reference box's own real
 * rendered `getBoundingClientRect().height` is `234.46875px`
 * (`14.654...rem`) -- not the reference's own `min-height: 12.5rem` CSS
 * value alone, since its real content (the statement, figures, and
 * button) pushes it taller than that floor. Per this issue's own
 * acceptance criteria, the shipped target is that reference height minus
 * a further 5% (`234.46875 * 0.95 = 222.745px = 13.9216rem`), rounded
 * down slightly to `13.9rem` (`222.4px`) to stay safely under that
 * ceiling rather than right at its edge. This is meaningfully below the
 * previous `min-h-[20rem]` (320px) value, which measured live at very
 * close to its own floor -- i.e. the pre-#198 box really was rendering
 * ~30% taller than the reference it was meant to match, not just
 * "roughly" taller.
 */
const SHOWCASE_MIN_HEIGHT_CLASSNAME = "min-h-[13.9rem]";
/**
 * Height of the slot holding the revealed, real PortfolioChart --
 * applied only while `chartRevealed` is true (see this file's own header
 * comment on why this is much taller than the mockup's own tiny
 * decorative chart, and why it's no longer reserved upfront).
 *
 * **Deliberately untouched by issue #198**, which is scoped to the
 * chart-hidden default height only (see `SHOWCASE_MIN_HEIGHT_CLASSNAME`'s
 * own doc comment above) -- the revealed state renders the real
 * `PortfolioChart`, a separate, larger design pass filed as its own
 * issue, not the mockup's tiny decorative chart this constant was ever
 * meant to approximate.
 */
const CHART_SLOT_HEIGHT_CLASSNAME = "h-[24rem]";

/**
 * "Watch it happen" (issue #188): a chunky, "juicy" press-button --
 * matching the design reference's own `.watch-btn`/`.btn-juicy` -- a solid
 * bottom-edge `box-shadow` standing in for depth, which flattens to a 1px
 * edge on `:active` while the button itself shifts down the same 3px the
 * shadow gave up, reading as a physical button being pressed in rather
 * than a plain color-change hover.
 *
 * `min-h-11` (2.75rem/44px) is a real, load-bearing floor, not decoration:
 * the design reference's own first draft measured this button at roughly
 * 32-34px, under this app's established touch-target floor
 * (`CONTROL_CLASS`, `BeatTheBench.tsx`) -- caught and fixed in that
 * reference before this issue ever started, and built from that fixed
 * value here, not from scratch.
 *
 * Deliberately a new, local class rather than reusing `TradeReplay.tsx`'s
 * exported `buttonClassName` (which this button used before this issue):
 * that class is shared by `TradeReplay`'s own "Watch it happen"/"Skip to
 * end"/"Replay" buttons and `WholeRangeReplay`'s identical pair, all deep
 * inside the demoted "Explore other windows" section -- out of this
 * issue's own scope, which named only this one button. Restyling the
 * shared class would have silently reached those other buttons too.
 */
const WATCH_BUTTON_CLASSNAME =
  "inline-flex min-h-11 items-center justify-center rounded-[0.65rem] bg-[var(--surface-2)] px-[1.15rem] py-2 text-sm font-bold text-[var(--text-primary)] shadow-[0_4px_0_0_#0d0d0c] transition duration-75 ease-out active:translate-y-[3px] active:shadow-[0_1px_0_0_#0d0d0c]";

const SHOWCASE_CLASSNAME =
  "surface-card relative flex flex-col items-center justify-center gap-3 overflow-hidden rounded-xl border border-[var(--gridline)] px-6 py-8 text-center";

/**
 * The showcase box's subtle top-to-bottom wash, restored by issue #198 --
 * the box had regressed to a flat `bg-[var(--surface-1)]` fill (no
 * gradient at all), which is what read as "the mocks have a gradient
 * that's missing locally" in that issue's own live-vs-mock comparison
 * pass. Matches the design reference's own `.showcase` rule
 * (`docs/design/daily-hub-condensed-2026-08/
 * mockup-daily-hub-condensed.html`) byte-for-byte: `#1d1d1b` at the top
 * fading into `--surface-1` by the 55% mark.
 *
 * Set via inline `style` (not a Tailwind arbitrary-value background
 * class), following `BeatTheBench.tsx`'s own `CompactCard` gradient doc
 * comment's established reasoning for this exact choice: a gradient
 * `background-image` is easy to get subtly wrong through Tailwind's
 * bracket-value parsing (space-to-underscore escaping, gradient- vs.
 * color-detection heuristics), and there's no test/reuse reason here
 * that needs it to be a class instead. Shared as one constant (not
 * hand-copied per call site) since this component renders the showcase
 * box from three different branches (loading, zero-trade, and the real
 * result) that must never visually drift from one another.
 */
const SHOWCASE_GRADIENT_STYLE = {
  backgroundImage: "linear-gradient(180deg, #1d1d1b 0%, var(--surface-1) 55%)",
};

const STATEMENT_CLASSNAME = "min-h-[2.6em] max-w-md text-sm text-[var(--text-secondary)]";

/** `base` plus `animateClass` when `play` is true -- every entrance element's own resting (base) class already renders the settled, fully-visible final state, so this never needs a third "reduced motion" variant of its own; see globals.css's own comment on `daily-hero-fade-up`/`daily-hero-pop`/`daily-hero-chip` for why. */
function entranceClassName(base: string, animateClass: string, play: boolean): string {
  return play ? `${base} ${animateClass}` : base;
}

function LoadingCard() {
  return (
    <div
      aria-hidden="true"
      className={`${SHOWCASE_CLASSNAME} ${SHOWCASE_MIN_HEIGHT_CLASSNAME} animate-pulse`}
      style={SHOWCASE_GRADIENT_STYLE}
    >
      <div className="h-3 w-48 rounded bg-[var(--surface-2)]" />
      <div className="h-12 w-72 rounded bg-[var(--surface-2)]" />
      <div className="h-4 w-56 rounded bg-[var(--surface-2)]" />
    </div>
  );
}

/**
 * The daily hero showcase: a one-time-animated box, shrunk to match the
 * design reference by default (issue #198 -- `SHOWCASE_MIN_HEIGHT_CLASSNAME`,
 * not "half-height" any more; that was issue #175's original reduction from
 * a taller fixed height, since superseded), holding the "had you known"
 * statement (its own first line --
 * the eyebrow date line that used to sit above it moved up into
 * ResultsPage.tsx's own `<header>`, next to the `<h1>`, issue #187), the
 * $X -> $Y figures + multiplier badge, a slot holding either the
 * "Watch it happen" button or the revealed chart (issue #162's mechanic,
 * unchanged) -- the box grows to fit the chart only once it's revealed --
 * and the ticker chips -- each folding in its own trade's signed return
 * (issue #175's own Scope item 3), via `trade-math.ts`'s
 * `computeTradeReturn` directly rather than routing through
 * `narrate-trades.ts` for a sentence this component no longer needs. See
 * this file's own header comment for the full design reasoning (the
 * grow-on-reveal box, entrance animation, the accessibility tradeoff of
 * removing the old always-visible trade narration).
 */
export function DailyHero({ mode }: DailyHeroProps) {
  const { dailyChallenge, loading } = useDailyChallenge(mode);
  // Called unconditionally, before the early returns below, per the
  // Rules of Hooks -- `dailyChallenge` can be `null` (still loading, or
  // nothing to show) on plenty of renders, so these can't wait until
  // after those checks.
  const [chartRevealed, setChartRevealed] = useState(false);
  const reducedMotionAfterMount = useReducedMotionAfterMount();
  const playEntranceAnimation = !reducedMotionAfterMount;
  const points: PortfolioPoint[] = useMemo(() => {
    if (dailyChallenge === null || dailyChallenge.trades.length === 0) {
      return [];
    }
    return deriveWholeRangeIntradaySeries(dailyChallenge.startingCapital, [
      { date: dailyChallenge.date, trades: dailyChallenge.trades },
    ]);
  }, [dailyChallenge]);

  if (loading) {
    return <LoadingCard />;
  }
  if (dailyChallenge === null) {
    // Degrades to nothing rather than an error box -- the same silent
    // graceful-degrade posture `BenchmarkStat`'s own `null` render and
    // the OG card route's 404 already take elsewhere in this app. The
    // existing range explorer below still works even when this section
    // has nothing to show (a fetch error, or a range with no trading
    // days published yet).
    return null;
  }

  const tickers = dailyChallenge.trades.map((trade) => trade.ticker);
  const tradeCount = tickers.length;

  if (tradeCount === 0) {
    return (
      <section
        aria-label="Yesterday's result"
        className={`${SHOWCASE_CLASSNAME} ${SHOWCASE_MIN_HEIGHT_CLASSNAME}`}
        style={SHOWCASE_GRADIENT_STYLE}
      >
        <p className="text-sm text-[var(--text-secondary)]">
          No trade would have beaten holding cash yesterday.
        </p>
      </section>
    );
  }

  const multiplier = dailyChallenge.endingBalance / dailyChallenge.startingCapital;

  return (
    <section
      aria-label="Yesterday's result"
      className={`${SHOWCASE_CLASSNAME} ${SHOWCASE_MIN_HEIGHT_CLASSNAME}`}
      style={SHOWCASE_GRADIENT_STYLE}
    >
      <p
        className={entranceClassName(
          STATEMENT_CLASSNAME,
          "daily-hero-fade-up-animate",
          playEntranceAnimation,
        )}
        style={{ animationDelay: "100ms" }}
      >
        Had you known, you&apos;d have made{" "}
        <strong className="font-semibold text-[var(--text-primary)]">
          {tradeCount} {tradeCount === 1 ? "trade" : "trades"}
        </strong>{" "}
        and turned
      </p>
      <p
        className={entranceClassName(
          `${heroValueRowClassName} justify-center`,
          "daily-hero-pop-animate",
          playEntranceAnimation,
        )}
        style={{ animationDelay: "450ms" }}
      >
        <span>{formatHeroCurrency(dailyChallenge.startingCapital)}</span>
        <span aria-hidden="true" className="text-[var(--text-muted)]">
          →
        </span>
        <span style={{ color: heroMultiplierColor(multiplier) }}>
          {formatHeroCurrency(dailyChallenge.endingBalance)}
        </span>
        <span
          className={heroMultiplierClassName}
          style={{ color: heroMultiplierColor(multiplier) }}
        >
          ({formatMultiplier(multiplier)})
        </span>
      </p>

      <div
        className={`flex w-full flex-col items-center justify-center gap-2 ${
          chartRevealed ? `${CHART_SLOT_HEIGHT_CLASSNAME} overflow-y-auto` : ""
        }`}
      >
        {chartRevealed ? (
          <PortfolioChart points={points} />
        ) : (
          <button
            type="button"
            onClick={() => setChartRevealed(true)}
            className={entranceClassName(
              WATCH_BUTTON_CLASSNAME,
              "daily-hero-pop-animate",
              playEntranceAnimation,
            )}
            style={{ animationDelay: "750ms" }}
          >
            Watch it happen
          </button>
        )}
      </div>

      <p className="flex min-h-[1.9rem] flex-wrap items-center justify-center gap-1.5 font-numeric text-sm font-semibold text-[var(--text-secondary)]">
        {dailyChallenge.trades.map((trade, index) => {
          const { returnFraction, isGain } = computeTradeReturn(
            trade.openPrice,
            trade.closePrice,
            trade.direction,
          );
          return (
            <span key={`${trade.ticker}-${index}`} className="flex items-center gap-1.5">
              {index > 0 && (
                <span aria-hidden="true" className="font-normal text-[var(--text-muted)]">
                  →
                </span>
              )}
              <span
                className={entranceClassName(
                  "inline-flex items-baseline gap-1 rounded-full border border-[var(--gridline)] bg-[var(--surface-2)] px-2.5 py-1",
                  "daily-hero-chip-animate",
                  playEntranceAnimation,
                )}
                style={{ animationDelay: `${950 + index * 200}ms` }}
              >
                <span className="font-semibold text-[var(--text-primary)]">{trade.ticker}</span>{" "}
                <span
                  className="font-semibold"
                  style={{ color: isGain ? "var(--status-good)" : "var(--status-critical)" }}
                >
                  {formatPercent(returnFraction)}
                </span>
              </span>
            </span>
          );
        })}
      </p>
    </section>
  );
}
