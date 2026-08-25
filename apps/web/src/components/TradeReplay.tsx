"use client";

// "Watch it happen" trade playback (issue #96) -- an opt-in, on-click
// replay of a window-model result's HeroStat + PortfolioChart pairing,
// re-sequencing data already on the page (derivePortfolioSeries's own
// PortfolioPoint[]) rather than computing or fetching anything new.
// Issue #97 added a brief "rewinding" intro beat (a backward-ticking
// date readout) immediately before real trade playback begins. Issue
// #107 carried that same date readout through the rest of forward
// playback too, so it no longer disappears the moment "rewinding" hands
// off to "playing" -- see use-trade-replay.ts for the RAF-driven state
// machine this orchestrates, and its own `displayDate` doc comment for
// the per-phase reasoning.

import { useMemo, type ReactNode } from "react";

import { formatHeroCurrency, formatMultiplier, formatPercent } from "@/lib/format-currency";
import { formatDateTime } from "@/lib/format-date";
import type { PortfolioPoint } from "@/lib/portfolio-series";
import { spansMultipleDays } from "@/lib/portfolio-series";
import { rescaleFromStartingCapital } from "@/lib/rescale-starting-capital";
import { tradeVerbsPastCapitalized } from "@/lib/trade-math";
import { useReducedMotionAtMount } from "@/lib/use-reduced-motion-at-mount";
import { useTradeReplay, type ReplayEvent } from "@/lib/use-trade-replay";
import { HeroAndWorstCase } from "@/components/HeroAndWorstCase";
import {
  heroLabelClassName,
  heroMultiplierClassName,
  heroMultiplierColor,
  heroValueRowClassName,
} from "@/components/HeroStat";
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
  /** Rendered between the hero row and the chart (BenchmarkStat) -- unaffected by playback, always the same regardless of phase. */
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
 * the pre-existing spacing between `children` -- BenchmarkStat, plus the
 * per-view methodology paragraph before issue #104 moved it into
 * AboutSection -- and the chart, on *every* page load, not just during
 * replay).
 *
 * Idle and done both render the *real*, untouched `HeroAndWorstCase`
 * pairing -- `HeroStat` inside it reveals fresh (a genuinely new
 * `key`) only on a genuine new result (a fetch, or a mode switch) or
 * when playback actually *finishes* (see `completedRuns` below), never
 * merely because playback started or was aborted early. While `phase`
 * is `"rewinding"` or `"playing"` (issue #97 added the former, a brief
 * intro beat before the latter begins -- see use-trade-replay.ts's own
 * doc comment) the hero slot additionally overlays a date readout (the
 * rewind's own backward tween while `"rewinding"`, then a running
 * readout of whichever point is currently revealed once `"playing"` --
 * issue #107, see `useTradeReplay`'s own `displayDate` doc comment for
 * why the latter needs no tween of its own) plus, once `"playing"`, a
 * plain non-animated "$X -> $Y" figure (driven by the replay hook's own
 * tween, not useCountUp -- HeroStat's own count-up is mount-only and
 * can't be re-driven mid-mount) via `HeroAndWorstCase`'s own `heroSlot`
 * prop, and a truncated view of the same `PortfolioChart` instance
 * (`revealedCount`/`interactive`, not a pre-sliced `points` array --
 * see that component's own prop doc comments, code review issue #96
 * follow-up round 3) -- pinned at just the window's own opening point
 * throughout the rewind, since no trade has actually played yet.
 *
 * **The date readout (issue #107) sits at the same position -- the
 * label line, top-left of the hero slot -- in both `"rewinding"` and
 * `"playing"`, carried by the label text itself rather than a value row
 * of its own once `"playing"` begins.** During `"rewinding"` the date is
 * still the label's own big sibling value row (unchanged from #97 --
 * nothing else needs that row yet). Once `"playing"` starts, the
 * pre-existing "$X -> $Y (Nx)" figure (issue #96, the thing this issue
 * is additive to) needs that value row back for itself, so the date
 * folds into the label line instead: `"Watching " + displayDate`,
 * e.g. "Watching Aug 21, 2025." This is a **deliberate, layout-forced
 * choice, not the first design tried** -- see the playing branch's own
 * doc comment below for why a separate `<p>` (or sharing the value row
 * alongside the dollar figures) both broke `heroSlot`'s fixed box height
 * in a real screenshot, not just in theory. The label position and
 * styling (`heroLabelClassName`) never change across the transition,
 * which is what actually carries the "reads as a continuation" acceptance
 * criterion here -- the date's own visual size shrinking (giant while
 * alone during the rewind, small once folded into the label during
 * playback) is an accepted trade-off, not an oversight.
 *
 * **`heroKey` carries `useTradeReplay`'s own `completedRuns` counter as a
 * suffix, bumped only when phase *lands on* "done" (code review, issue
 * #96 follow-up rounds 3 and 4) -- this is the mechanism that decides
 * when HeroStat gets a fresh count-up/confetti reveal, now that
 * `HeroAndWorstCase` keeps HeroStat continuously mounted across every
 * phase (see that component's own `heroSlot` doc comment) instead of
 * unmounting it whenever playback starts.** Before this fix, the hero
 * slot swapped between two different *element types* (`<HeroStat>` vs. a
 * plain `<div>`) depending on phase -- any element-type change at a JSX
 * position is an unconditional fresh mount by React's own reconciliation
 * rules, independent of `key`, so *every* transition out of "playing"
 * (whether landing on "done" -- a genuine completion, meant to replay
 * the reveal as a reward -- or aborted back to "idle" by a live
 * points-reference change, e.g. a starting-capital edit mid-playback)
 * forced the exact same remount. That's exactly right for a genuine
 * completion (verified live: "Skip to end landing on the real final
 * state with a fresh HeroStat count-up/glow replaying"), but wrong for
 * an abort: a starting-capital edit mid-playback resetting
 * `use-trade-replay.ts`'s own `phase` to "idle" (its render-time
 * points-reference reset, see that hook's own doc comment) doesn't
 * change `heroKey` -- capital isn't part of it -- so the *type-swap*
 * alone was what forced the remount, re-triggering a full
 * reveal/celebration burst on a plain rescale and directly contradicting
 * `HeroStat.tsx`'s own documented contract ("rescale instantly ...
 * without re-triggering the count-up animation or the celebration
 * burst"). With HeroStat now always mounted, the *only* remaining
 * trigger for a fresh reveal is a `key` change -- either `heroKey` itself
 * changing upstream (a mode switch, which folds `mode` into `heroKey` --
 * see this prop's own doc comment, so a genuinely different trade
 * sequence still gets a fresh reveal exactly as before) or
 * `completedRuns`, bumped specifically (and only) when `phase`
 * transitions *to* "done" -- natural completion or "Skip to end," never
 * a mid-flight abort back to "idle." A starting-capital edit
 * mid-playback now aborts back to idle with HeroStat's already-settled
 * figure simply re-rendering at the new scale in place, exactly like an
 * edit made while never playing at all.
 *
 * **`completedRuns` is owned by `useTradeReplay` itself, not
 * shadow-tracked here (code review, issue #96 follow-up round four).**
 * An earlier version of this file kept its own `revealRun` counter,
 * bumped via a second `trackedPhase` state variable that existed purely
 * to detect "the hook's own `phase` just became `\"done\"`" -- but the
 * hook already owns that exact transition at its own three
 * `setPhase("done")` call sites, so it's the more natural (and simpler)
 * owner of counting them; see `UseTradeReplayResult.completedRuns`'s own
 * doc comment.
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
 * **The chart never carries its own `aria-hidden`/`inert` wrapper any
 * more -- `PortfolioChart`'s own `interactive` prop owns this instead
 * (code review, issue #96 follow-up round 3).** Per the ARIA spec,
 * `aria-hidden` must never be applied to a focusable element or an
 * ancestor of one -- `PortfolioChart`'s root `<svg>` is focusable
 * (`tabIndex={0}`, with an arrow-key point-inspection handler), and its
 * own `ChartDataTable` child renders a native `<details>`/`<summary>`
 * disclosure, whose `<summary>` is *also* natively focusable. This exact
 * concern needed rediscovering twice in this PR's own history before it
 * became a documented `PortfolioChart` prop instead of a wrapper idiom
 * this file had to get right on its own -- see that component's own
 * `interactive` prop doc comment for the full reasoning.
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
  const { phase, frame, displayDate, play, skipToEnd, completedRuns } = useTradeReplay(points);

  // Memoized (code-review finding, issue #96 follow-up): constant for
  // the whole result, but this component re-renders on every one of the
  // dozens of RAF-driven frames while playing.
  const includeDate = useMemo(() => spansMultipleDays(points), [points]);
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
  // Issue #97's rewinding intro beat is part of the same animated
  // stretch "playing" already was -- the hero slot/chart both need to
  // stay in their non-live, animated shape through the rewind too, not
  // just once real trade playback begins.
  const showLive = phase === "idle" || phase === "done";

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

  // Also memoized (code-review finding, issue #96 follow-up round 3) for
  // the same reason -- `displayStartingCapital` is constant for the
  // whole run, but this component re-renders on every RAF-driven frame
  // while playing, and the playing-phase hero slot below needs this
  // formatted string every one of those frames even though its own
  // value never changes across them.
  const displayStartingCapitalFormatted = useMemo(
    () => formatHeroCurrency(displayStartingCapital),
    [displayStartingCapital],
  );

  // The "(Nx)" multiplier badge HeroStat.tsx always renders alongside the
  // dollar figures (code-review finding, issue #96 follow-up round five)
  // -- omitted from the very first version of this playing-phase overlay,
  // so it visibly disappeared for the whole ~3-6s playback and popped
  // back in once phase returned to idle/done. Computed the exact same way
  // HeroStat.tsx computes its own (`endingBalance / startingCapital`, the
  // real final figures -- deliberately *not* tied to `frame.currentValue`,
  // matching HeroStat's own badge, which is never tied to its count-up
  // tween either), and rendered with that component's own exported
  // `heroMultiplierClassName`/`heroMultiplierColor` rather than
  // re-deriving the formatting/threshold logic a second time. Memoized
  // for the same reason as the other constant-per-run values above --
  // this component re-renders on every RAF-driven frame while playing,
  // but the multiplier itself never changes across those frames.
  const multiplier = useMemo(
    () => endingBalance / startingCapital,
    [endingBalance, startingCapital],
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

  // Computed once here rather than as a nested ternary inline in the
  // JSX below, matching this file's own established "compute once,
  // reuse" pattern for `activeCallout`/`announced` above. `undefined`
  // for `showLive` (idle/done) leaves `HeroAndWorstCase`'s own default
  // (the real HeroStat, no overlay) in place.
  let heroSlot: ReactNode = undefined;
  if (phase === "rewinding") {
    // Issue #97's rewind-to-start-date intro beat -- purely visual,
    // aria-hidden for the exact same reason the playing-phase figure
    // below is (the status region announces meaningful moments, not
    // this per-frame-changing readout). Reuses HeroStat.tsx's own
    // exported label/value-row classes so this reads as "the same hero
    // figure, mid-transition" the same way the playing-phase overlay
    // already does. The date is this row's *only* content, so it's free
    // to use the same giant value-row size the dollar figures normally
    // get -- there's no risk yet of outgrowing `heroSlot`'s own fixed box
    // height (see the "playing" branch's own doc comment below), since
    // nothing else is competing for space in this phase.
    heroSlot = (
      <div aria-hidden="true" className="absolute inset-0 flex flex-col items-start gap-1">
        <p className={heroLabelClassName}>Rewinding to</p>
        <p className={heroValueRowClassName}>
          <span>{displayDate}</span>
        </p>
      </div>
    );
  } else if (phase === "playing") {
    // Purely visual during playback -- aria-hidden, since the status
    // region below announces the meaningful moments (each trade event,
    // then the finished sentence) instead of this per-frame-changing
    // figure. Absolutely positioned over HeroAndWorstCase's own
    // (visually hidden, but still mounted) real HeroStat -- see that
    // component's own `heroSlot` doc comment for why this overlays
    // rather than replaces it. Reuses HeroStat.tsx's own exported
    // `heroLabelClassName`/`heroValueRowClassName` (code review, issue
    // #96 follow-up round four) rather than hand-copying those two
    // classes as literal strings, so this figure reads as "the same
    // hero figure, mid-transition" without risking drift if HeroStat's
    // own typography ever changes.
    //
    // **The date (issue #107) folds into the label line ("Watching " +
    // displayDate) rather than getting its own row or sharing the
    // dollar-figure row -- a real layout constraint found live, not a
    // style preference.** `heroSlot`'s own `absolute inset-0` sizes
    // itself against `HeroAndWorstCase`'s invisible, real `HeroStat` box
    // (see that component's own doc comment) -- whatever height *that*
    // content happens to need, including any wrapping its own "(Nx)"
    // badge does at a given viewport width (the app's own real
    // `max-w-3xl` layout width is narrow enough that this genuinely
    // happens). This overlay's own content must reproduce that exact
    // same wrapped height or its content visibly spills past whatever
    // renders next -- confirmed live with two rejected designs, not
    // just reasoned about: a separate third `<p>` for the date pushed
    // the "Skip to end" button down and out from underneath it in a real
    // screenshot; folding the date into the *value* row (prepending it
    // ahead of the dollar figures in the same `<p>`) still broke,
    // because a row now wider than the invisible box's own same-line
    // content wraps differently and no longer reproduces that box's
    // exact height either. The value row below is therefore left
    // **byte-for-byte identical to this branch's own pre-#107 shape** --
    // the one part of this overlay whose wrap behavior is proven to
    // track the invisible box's own (it renders the equivalent figures,
    // just tweened) -- and the date goes on the label line instead,
    // whose text stays short enough ("Watching Aug 21, 2025") to never
    // wrap at this app's own real content width, confirmed live. See
    // this function's own doc comment above for why this is an accepted
    // trade-off (the date visually shrinks at this exact transition, but
    // the label's own position/styling stays identical throughout).
    // `displayDate` tracks `frame.revealedCount` with no tween of its
    // own -- see `useTradeReplay`'s own doc comment for why "playing"
    // needs none.
    heroSlot = (
      <div aria-hidden="true" className="absolute inset-0 flex flex-col items-start gap-1">
        <p className={`${heroLabelClassName} flex items-baseline gap-2`}>
          <span>Watching</span>
          <span className="text-[var(--text-muted)]">{displayDate}</span>
        </p>
        <p className={heroValueRowClassName}>
          <span>{displayStartingCapitalFormatted}</span>
          <span className="text-[var(--text-muted)]">→</span>
          <span>{formatHeroCurrency(frame.currentValue)}</span>
          <span
            className={heroMultiplierClassName}
            style={{ color: heroMultiplierColor(multiplier) }}
          >
            ({formatMultiplier(multiplier)})
          </span>
        </p>
      </div>
    );
  }

  return (
    <>
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <HeroAndWorstCase
            heroKey={`${heroKey}:${completedRuns}`}
            startingCapital={startingCapital}
            endingBalance={endingBalance}
            worstCaseEndingBalance={worstCaseEndingBalance}
            worstCaseStartingCapital={worstCaseStartingCapital}
            displayStartingCapital={displayStartingCapital}
            heroSlot={heroSlot}
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

        {/* One wrapper, varying only the inner button (code-review
            finding, issue #96 follow-up round 3) -- an earlier version
            duplicated this identical `flex items-center gap-3` div in
            both branches of the ternary below. */}
        <div className="flex items-center gap-3">
          {!showLive ? (
            // Always available during the rewind intro beat or real
            // playback, regardless of `canReplay` -- see that variable's
            // own doc comment above for why this can't just reuse the
            // same gate the idle/done button below does. Issue #97's own
            // acceptance criterion: "Skip-to-end control works
            // identically whether triggered during this phase or during
            // trade playback" -- one shared button/handler for both,
            // not a second control. Reuses `showLive` (code-review
            // follow-up, real gap: this used to independently re-derive
            // `phase === "rewinding" || phase === "playing"`, the exact
            // logical complement of `showLive` -- two independently-
            // written expressions that must always stay opposites for
            // the chart/hero to go non-live exactly when this button
            // becomes available, with nothing enforcing that they do) --
            // `!showLive` instead, so there's one definition of "is this
            // an animated, non-live phase" instead of two kept in sync
            // by hand.
            <button type="button" onClick={skipToEnd} className={buttonClassName}>
              Skip to end
            </button>
          ) : (
            canReplay && (
              <button type="button" onClick={play} className={buttonClassName}>
                {phase === "done" ? "Replay" : "Watch it happen"}
              </button>
            )
          )}
        </div>

        {children}
      </div>

      <PortfolioChart
        key={heroKey}
        points={points}
        revealedCount={showLive ? undefined : frame.revealedCount}
        interactive={showLive}
      />
    </>
  );
}
