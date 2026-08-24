"use client";

// "Watch it happen" trade playback (issue #96) -- an opt-in, on-click
// replay of a window-model result's HeroStat + PortfolioChart pairing,
// re-sequencing data already on the page (derivePortfolioSeries's own
// PortfolioPoint[]) rather than computing or fetching anything new. See
// use-trade-replay.ts for the RAF-driven state machine this orchestrates.

import { useMemo, useState, type ReactNode } from "react";

import { formatHeroCurrency, formatPercent } from "@/lib/format-currency";
import { formatDateTime } from "@/lib/format-date";
import type { PortfolioPoint } from "@/lib/portfolio-series";
import { spansMultipleDays } from "@/lib/portfolio-series";
import { rescaleFromStartingCapital } from "@/lib/rescale-starting-capital";
import { tradeVerbsPast } from "@/lib/trade-math";
import { useReducedMotionAtMount } from "@/lib/use-reduced-motion-at-mount";
import { useTradeReplay, type ReplayEvent } from "@/lib/use-trade-replay";
import { HeroStat } from "@/components/HeroStat";
import { PortfolioChart } from "@/components/PortfolioChart";
import { WorstCaseStat } from "@/components/WorstCaseStat";

interface TradeReplayProps {
  /** The already-rendered window-model result's own chart series (derivePortfolioSeries's output, already display-rescaled -- see ResultsPanel.tsx's own `points`). */
  points: readonly PortfolioPoint[];
  /** How many trades this result has -- the button only renders with at least one (per the issue's own acceptance criteria). */
  tradeCount: number;
  /** Base key identifying "this result" -- see HeroAndWorstCaseProps' own heroKey doc comment. Suffixed per replay run so HeroStat genuinely remounts (and replays its own reveal animation) each time playback finishes. */
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

/** Sentence-cases a lowercase past-tense verb ("bought" -> "Bought") for the start of a callout sentence. */
function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/**
 * Past-tense narration for one playback callout, matching TradeList's
 * established voice ("bought AAPL on Mar 12, 2025 at $142.00") rather
 * than inventing new copy -- per the issue's own Background section.
 * Always retrospective, never present/future tense: this app's premise
 * is hindsight, not a live trading terminal.
 */
function calloutText(replayEvent: ReplayEvent, includeDate: boolean): string {
  const { point, event, tradeReturn } = replayEvent;
  const verb = tradeVerbsPast(event.direction)[event.type === "open" ? "openVerb" : "closeVerb"];
  const sentence = `${capitalize(verb)} ${event.ticker} on ${formatDateTime(point.date, includeDate)} at ${formatHeroCurrency(event.price)}`;
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
 * **Returns a Fragment of two top-level pieces -- the hero/controls
 * block and the chart -- not one wrapping div (code-review finding,
 * fixed).** Before this fix, both lived inside one shared `flex
 * flex-col gap-2` wrapper, which silently shrank the pre-existing
 * spacing between the methodology paragraph/BenchmarkStat (passed as
 * `children`, rendered just above the chart) and the chart itself from
 * `gap-8` (2rem, `FadeInWrapper`'s own spacing in `ResultsPanel.tsx`,
 * unchanged since before this issue) down to `gap-2` (0.5rem) -- on
 * *every* window-model page load, not just during replay. Returning a
 * Fragment means both pieces splice directly into `WindowResultBody`'s
 * own `FadeInWrapper` as siblings of the "Trades" block below, restoring
 * the original three-sibling `gap-8` spacing exactly.
 *
 * Idle and done both render the *real*, untouched `HeroStat` --
 * remounted (a fresh `key`) each time so its own reveal animation
 * (useCountUp, CelebrationBurst) replays fresh, "ending on the existing
 * count-up/confetti payoff" per the issue's own Scope wording. Only
 * while `phase === "playing"` does this swap in a plain, non-animated
 * "$X -> $Y" figure (driven by the replay hook's own tween, not
 * useCountUp -- HeroStat's own count-up is mount-only and can't be
 * re-driven mid-mount) and a truncated `points.slice(0, revealedCount)`
 * fed to the same PortfolioChart component.
 *
 * **`WorstCaseStat` renders unconditionally, in every phase (code-review
 * finding, fixed)** -- it has no animation of its own to protect, and
 * the issue's own Scope names "the chart and hero figure" specifically,
 * not the worst-case contrast stat, so it must never actually disappear
 * for the ~3-6s playback runs. `HeroStat`/`WorstCaseStat` are composed
 * directly here (not via `HeroAndWorstCase`) specifically so this
 * component can swap only the `HeroStat` half while leaving
 * `WorstCaseStat` always mounted with the same layout that shared
 * wrapper already used.
 *
 * Reduced motion fully bypasses this feature (not an instant step-through
 * equivalent): no button ever renders, so HeroStat/WorstCaseStat/
 * PortfolioChart render exactly as they did before this issue,
 * unconditionally -- the same "skip the affordance entirely" choice
 * this app already makes for the celebration burst (should-celebrate.ts)
 * and the chart tap hint (use-chart-tap-hint.ts). Zero information loss
 * either way: every trade is already reachable via the always-present
 * TradeList/ChartDataTable.
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
  // Bumped on every genuine playback start so HeroStat gets a fresh
  // `key` (a real remount, not just a prop update) once phase settles
  // back to "done" -- the same "remount to replay the reveal" reasoning
  // heroKey already documents everywhere else in this app (see
  // HeroAndWorstCaseProps' own doc comment).
  const [replayRun, setReplayRun] = useState(0);

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
  const liveKey = `${heroKey}-replay-${replayRun}`;

  function handleWatch() {
    setReplayRun((n) => n + 1);
    play();
  }

  const endingBalanceDisplayValue = rescaleFromStartingCapital(
    endingBalance,
    startingCapital,
    displayStartingCapital,
  );
  const worstCaseDisplayValue = rescaleFromStartingCapital(
    worstCaseEndingBalance,
    worstCaseStartingCapital,
    displayStartingCapital,
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
          <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:gap-8">
            {showLive ? (
              <HeroStat
                key={liveKey}
                startingCapital={startingCapital}
                endingBalance={endingBalance}
                displayStartingCapital={displayStartingCapital}
              />
            ) : (
              // Purely visual during playback -- aria-hidden, since the
              // status region below announces the meaningful moments
              // (each trade event, then the finished sentence) instead
              // of this per-frame-changing figure.
              <div aria-hidden="true" className="flex flex-col items-start gap-1">
                <p className="text-sm font-medium text-[var(--text-secondary)]">Starting from</p>
                <p className="flex flex-wrap items-baseline gap-3 text-[clamp(2.5rem,6vw,4rem)] font-semibold leading-none tracking-tight text-[var(--text-primary)]">
                  <span>{formatHeroCurrency(displayStartingCapital)}</span>
                  <span className="text-[var(--text-muted)]">→</span>
                  <span>{formatHeroCurrency(frame.currentValue)}</span>
                </p>
              </div>
            )}
            <WorstCaseStat
              startingCapital={displayStartingCapital}
              endingBalance={worstCaseDisplayValue}
            />
          </div>
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
              <button type="button" onClick={handleWatch} className={buttonClassName}>
                {phase === "done" ? "Replay" : "Watch it happen"}
              </button>
            </div>
          )
        )}

        {children}
      </div>

      <div aria-hidden={showLive ? undefined : "true"}>
        <PortfolioChart
          key={showLive ? liveKey : undefined}
          points={showLive ? points : truncatedPoints}
        />
      </div>
    </>
  );
}
