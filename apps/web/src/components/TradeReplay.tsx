"use client";

// "Watch it happen" trade playback (issue #96) -- an opt-in, on-click
// replay of a window-model result's HeroStat + PortfolioChart pairing,
// re-sequencing data already on the page (derivePortfolioSeries's own
// PortfolioPoint[]) rather than computing or fetching anything new. See
// use-trade-replay.ts for the RAF-driven state machine this orchestrates.

import { useMemo, type ReactNode } from "react";

import { formatHeroCurrency, formatPercent } from "@/lib/format-currency";
import { formatDateTime } from "@/lib/format-date";
import type { PortfolioPoint } from "@/lib/portfolio-series";
import { spansMultipleDays } from "@/lib/portfolio-series";
import { rescaleFromStartingCapital } from "@/lib/rescale-starting-capital";
import { tradeVerbsPastCapitalized } from "@/lib/trade-math";
import { useReducedMotionAtMount } from "@/lib/use-reduced-motion-at-mount";
import { useTradeReplay, type ReplayEvent } from "@/lib/use-trade-replay";
import { HeroAndWorstCase } from "@/components/HeroAndWorstCase";
import { PortfolioChart } from "@/components/PortfolioChart";

interface TradeReplayProps {
  /** The already-rendered window-model result's own chart series (derivePortfolioSeries's output, already display-rescaled -- see ResultsPanel.tsx's own `points`). */
  points: readonly PortfolioPoint[];
  /** How many trades this result has -- the button only renders with at least one (per the issue's own acceptance criteria). */
  tradeCount: number;
  /** Identifies "this result" -- passed straight through as HeroAndWorstCase's own `heroKey` (see that component's prop doc comment) and as PortfolioChart's own `key`, so both remount and replay their reveal animations on a genuine new result (a fetch, or a mode switch) but never mid-playback for any other reason. */
  heroKey: string;
  startingCapital: number;
  endingBalance: number;
  worstCaseEndingBalance: number;
  worstCaseStartingCapital: number;
  displayStartingCapital: number;
  /** Rendered next to the hero row, e.g. StartingCapitalInput -- unaffected by playback. */
  startingCapitalInput?: ReactNode;
  /** Rendered between the hero row and the chart (the methodology paragraph, BenchmarkStat) -- unaffected by playback, always the same regardless of phase. */
  children?: ReactNode;
}

/**
 * Past-tense narration for one playback callout, matching TradeList's
 * established voice ("bought AAPL on Mar 12, 2025 at $142.00") rather
 * than inventing new copy -- per the issue's own Background section.
 * Always retrospective, never present/future tense: this app's premise
 * is hindsight, not a live trading terminal. Verb pair comes from
 * trade-math.ts's `tradeVerbsPastCapitalized` (code-review follow-up --
 * a one-off `capitalize()` helper used to live in this file instead,
 * reinventing exactly the class of verb-pair fragmentation that
 * module's own header comment already centralizes).
 */
function calloutText(replayEvent: ReplayEvent, includeDate: boolean): string {
  const { point, event, tradeReturn } = replayEvent;
  const verb = tradeVerbsPastCapitalized(event.direction)[
    event.type === "open" ? "openVerb" : "closeVerb"
  ];
  const sentence = `${verb} ${event.ticker} on ${formatDateTime(point.date, includeDate)} at ${formatHeroCurrency(event.price)}`;
  if (event.type === "close" && tradeReturn) {
    return `${sentence} (${formatPercent(tradeReturn.returnFraction)}).`;
  }
  return `${sentence}.`;
}

const buttonClassName =
  "self-start rounded-md border border-[var(--gridline)] px-4 py-2 text-sm font-semibold text-[var(--text-secondary)] transition-colors hover:border-[var(--text-muted)] hover:text-[var(--text-primary)]";

/**
 * Wraps the HeroStat + WorstCaseStat + PortfolioChart trio for a
 * window-model result (5Y/MAX, and custom-window anchors -- any range
 * using derivePortfolioSeries) with an opt-in "Watch it happen" replay.
 *
 * Returns a Fragment of two top-level pieces -- the hero/controls block
 * and the chart, not one wrapping div -- so both splice as direct
 * siblings into `WindowResultBody`'s own `FadeInWrapper` alongside the
 * "Trades" block below, preserving that flex column's own `gap-8`
 * spacing between all three (code-review finding, fixed: an earlier
 * version put both inside one shared `gap-2` div, which silently shrank
 * the pre-existing spacing between `children` -- the methodology
 * paragraph/BenchmarkStat -- and the chart, on *every* page load, not
 * just during replay).
 *
 * Idle and done both render the *real*, untouched `HeroAndWorstCase` --
 * `HeroStat` remounts (a fresh `key={heroKey}`) on a genuine new result
 * (a fetch, or a mode switch, both of which change `heroKey` upstream)
 * so its own reveal animation (useCountUp, CelebrationBurst) replays
 * fresh, "ending on the existing count-up/confetti payoff" per the
 * issue's own Scope wording -- but *never* remounts merely because
 * playback started or finished, since idle/done and playing are
 * different *element types* at the hero slot (see `heroSlot` below),
 * and reverting to the same type+key after an unrelated type swap is
 * already a guaranteed fresh mount on its own (code-review finding,
 * fixed: an earlier version also suffixed this key with a `replayRun`
 * counter bumped on every "Watch it happen" click, entirely redundant
 * once this was understood -- removed, see this file's own git history
 * if the reasoning here ever needs re-deriving). Only while `phase ===
 * "playing"` does this swap in a plain, non-animated "$X -> $Y" figure
 * via `HeroAndWorstCase`'s own `heroSlot` override prop (driven by the
 * replay hook's own tween, not useCountUp -- HeroStat's own count-up is
 * mount-only and can't be re-driven mid-mount) and a truncated
 * `points.slice(0, revealedCount)` fed to the same `PortfolioChart`
 * instance -- which, unlike the hero slot, is the *same* element type
 * in every phase, so it needs a genuinely stable `key` (always
 * `heroKey`, never toggled) to avoid an unwanted remount -- and the
 * reveal-on-mount CSS animation replaying with it -- right at the two
 * moments playback starts and stops (a second code-review finding,
 * fixed: an earlier version toggled this chart's own `key` between a
 * real string and `undefined` depending on phase, which is a real key
 * change either way).
 *
 * `WorstCaseStat` (via `HeroAndWorstCase`) renders unconditionally, in
 * every phase -- it has no animation of its own to protect, and the
 * issue's own Scope names "the chart and hero figure" specifically, not
 * the worst-case contrast stat, so it must never actually disappear for
 * the ~3-6s playback runs. See `HeroAndWorstCase`'s own `heroSlot` doc
 * comment for why this composes through that shared wrapper again
 * rather than hand-duplicating its layout markup a second time (a
 * code-review finding on this exact point, fixed).
 *
 * Reduced motion fully bypasses this feature (not an instant step-through
 * equivalent): no button ever renders, so `HeroAndWorstCase`/
 * `PortfolioChart` render exactly as they did before this issue,
 * unconditionally -- the same "skip the affordance entirely" choice
 * this app already makes for the celebration burst (should-celebrate.ts)
 * and the chart tap hint (use-chart-tap-hint.ts). Zero information loss
 * either way: every trade is already reachable via the always-present
 * TradeList/ChartDataTable.
 *
 * **The truncated chart is `inert`, not just `aria-hidden`, while
 * playing (code-review finding, fixed).** Per the ARIA spec,
 * `aria-hidden` must never be applied to a focusable element or an
 * ancestor of one -- `PortfolioChart`'s root `<svg>` is focusable
 * (`tabIndex={0}`, with an arrow-key point-inspection handler), and its
 * own `ChartDataTable` child renders a native `<details>`/`<summary>`
 * disclosure, whose `<summary>` is *also* natively focusable (a second
 * instance of the same violation class, not called out in the original
 * finding but caught while fixing it). Browsers disagree on whether
 * focus/keydown still reach a focusable descendant of an `aria-hidden`
 * ancestor, so a keyboard user could otherwise interact with a chart
 * announced as not present in the accessibility tree at all. `inert`
 * (a real DOM/HTML property, not an ARIA attribute) is the correct fix
 * for *both* focusable descendants at once, with no `PortfolioChart`
 * API change needed: it removes an entire subtree from both the tab
 * order and the accessibility tree together, so there's no
 * "aria-hidden but still focusable" combination possible in the first
 * place. Kept alongside `aria-hidden="true"` anyway (harmless, and this
 * app's own established two-layer-guard style elsewhere) as
 * defense-in-depth for any assistive-tech/browser pairing that doesn't
 * fully honor `inert`'s own AT-hiding behavior yet.
 */
export function TradeReplay({
  points,
  tradeCount,
  heroKey,
  startingCapital,
  endingBalance,
  worstCaseEndingBalance,
  worstCaseStartingCapital,
  displayStartingCapital,
  startingCapitalInput,
  children,
}: TradeReplayProps) {
  const reducedMotionAtMount = useReducedMotionAtMount();
  const { phase, frame, play, skipToEnd } = useTradeReplay(points);

  const includeDate = spansMultipleDays(points);
  // Gates the *idle*/*done* button ("Watch it happen" / "Replay") only
  // -- deliberately NOT also gating "Skip to end" (code-review finding,
  // fixed; see the button row below). `tradeCount` is threaded from
  // `WindowResultBody`'s own live `variant.trades.length`, which can
  // change mid-playback (a ModeToggle switch to a zero-trade variant)
  // without this component unmounting -- but a live `points` reference
  // change is exactly what use-trade-replay.ts's own render-time reset
  // already treats as "abort back to idle" (see that hook's own doc
  // comment), so `canReplay` flipping false never actually strands the
  // user mid-playback with no control to click: the moment `points`
  // changes, phase resets to "idle" on its own, and this button row
  // re-renders in its idle shape (present or absent per the *new*
  // `canReplay`) rather than lingering in "playing" with the wrong gate.
  const canReplay = tradeCount > 0 && !reducedMotionAtMount;
  const showLive = phase !== "playing";

  // Memoized (code-review finding, issue #96 follow-up): constant for
  // the whole playback run, but this component re-renders on every one
  // of the dozens of RAF-driven frames while playing -- see
  // HeroAndWorstCase.tsx's own identical fix for the worst-case figure's
  // own rescale, which used to live here too before this file started
  // composing through that shared wrapper again (see this component's
  // own doc comment).
  const endingBalanceDisplayValue = useMemo(
    () => rescaleFromStartingCapital(endingBalance, startingCapital, displayStartingCapital),
    [endingBalance, startingCapital, displayStartingCapital],
  );

  // Computed once per render, not twice (code-review finding, fixed) --
  // the sr-only status region and the visible callout paragraph below
  // both need this exact same sentence, and computing it independently
  // at each call site was both wasted work every frame and a drift risk
  // if one call site's wording ever changed without the other.
  const activeCallout = frame.activeEvent ? calloutText(frame.activeEvent, includeDate) : null;

  // A single role="status" aria-live="polite" region, always present,
  // that announces each trade event once (not per-frame -- see
  // use-trade-replay.ts's own ReplayFrame.activeEvent, which only
  // changes value at the discrete moments a real event is reached) and
  // a final "Replay finished..." sentence once playback completes.
  // Empty (nothing announced) until the user actually opts in -- this
  // never fires on mount or on an unrelated re-render, matching the
  // issue's own "never auto-plays" requirement.
  const announced =
    phase === "done"
      ? `Replay finished. Ending balance ${formatHeroCurrency(endingBalanceDisplayValue)}.`
      : (activeCallout ?? "");

  // Memoized so a re-render that doesn't actually change `revealedCount`
  // (most mid-tween frames, where only `currentValue` moves) doesn't
  // hand PortfolioChart a fresh array reference every frame either
  // (code-review finding, fixed) -- that would defeat that component's
  // own useMemos, which are keyed on `points` by reference.
  const truncatedPoints = useMemo(
    () => points.slice(0, frame.revealedCount),
    [points, frame.revealedCount],
  );

  return (
    <>
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <HeroAndWorstCase
            heroKey={heroKey}
            startingCapital={startingCapital}
            endingBalance={endingBalance}
            worstCaseEndingBalance={worstCaseEndingBalance}
            worstCaseStartingCapital={worstCaseStartingCapital}
            displayStartingCapital={displayStartingCapital}
            heroSlot={
              showLive ? undefined : (
                // Purely visual during playback -- aria-hidden, since
                // the status region below announces the meaningful
                // moments (each trade event, then the finished
                // sentence) instead of this per-frame-changing figure.
                <div aria-hidden="true" className="flex flex-col items-start gap-1">
                  <p className="text-sm font-medium text-[var(--text-secondary)]">Starting from</p>
                  <p className="flex flex-wrap items-baseline gap-3 text-[clamp(2.5rem,6vw,4rem)] font-semibold leading-none tracking-tight text-[var(--text-primary)]">
                    <span>{formatHeroCurrency(displayStartingCapital)}</span>
                    <span className="text-[var(--text-muted)]">→</span>
                    <span>{formatHeroCurrency(frame.currentValue)}</span>
                  </p>
                </div>
              )
            }
          />
          {startingCapitalInput}
        </div>

        <div role="status" aria-live="polite" aria-label="Trade replay status" className="sr-only">
          {announced}
        </div>

        {!showLive && activeCallout && (
          <p aria-hidden="true" className="text-sm text-[var(--text-secondary)]">
            {activeCallout}
          </p>
        )}

        {phase === "playing" ? (
          // Always available while playing, regardless of `canReplay` --
          // see that variable's own doc comment above for why this can't
          // just reuse the same gate the idle/done button below does.
          <div className="flex items-center gap-3">
            <button type="button" onClick={skipToEnd} className={buttonClassName}>
              Skip to end
            </button>
          </div>
        ) : (
          canReplay && (
            <div className="flex items-center gap-3">
              <button type="button" onClick={play} className={buttonClassName}>
                {phase === "done" ? "Replay" : "Watch it happen"}
              </button>
            </div>
          )
        )}

        {children}
      </div>

      <div aria-hidden={showLive ? undefined : "true"} inert={!showLive}>
        <PortfolioChart key={heroKey} points={showLive ? points : truncatedPoints} />
      </div>
    </>
  );
}
