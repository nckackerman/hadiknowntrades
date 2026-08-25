"use client";

// "Watch it happen" trade replay for the 1W whole-range balance (issue
// #105) -- extends #96/#97/#107/#108's window-model-only replay feature
// to the intraday-daily whole-range headline. Per docs/plans/issue-105-
// plan.md sections 1/5, this reuses use-trade-replay.ts's existing
// per-point walk machinery entirely unmodified -- no new segment-builder
// or chunking abstraction, just a tighter `pacing` parameter (that hook
// itself now supports as an optional argument) and two real, previously-
// undocumented date-formatting bugs fixed at the hook level (see that
// file's own doc comments on `toPortfolioTimestamp`/`formatDateTime`
// usage).
//
// Composes WholeRangeBalance.tsx (extended with its own `worstCase`/
// `revealSlot` props) instead of HeroAndWorstCase -- a deliberate
// divergence from issue #106's own sibling plan sketch, stated
// explicitly in docs/plans/issue-105-plan.md section 3.1:
// WholeRangeBalance.tsx already IS this range's one hero moment (the one
// place its ending balance is headlined, unlike the window model, which
// has no page-level equivalent outside HeroAndWorstCase). Composing
// through HeroAndWorstCase too would render the exact same "$X -> $Y"
// figure twice -- once in WholeRangeBalance's own already-revealed
// headline, again in a parallel HeroAndWorstCase.

import { useMemo, type ReactNode } from "react";

import { formatHeroCurrency } from "@/lib/format-currency";
import type { PortfolioPoint } from "@/lib/portfolio-series";
import { spansMultipleDays } from "@/lib/portfolio-series";
import { calloutText, chartLandingFor } from "@/lib/replay-callout";
import { useReducedMotionAtMount } from "@/lib/use-reduced-motion-at-mount";
import {
  canReplayFor,
  isReplayLive,
  useTradeReplay,
  type ReplayPacing,
} from "@/lib/use-trade-replay";
import { buttonClassName } from "@/components/TradeReplay";
import { PortfolioChart, type ChartLanding } from "@/components/PortfolioChart";
import {
  WholeRangeBalance,
  wholeRangeLabelClassName,
  wholeRangeValueRowClassName,
} from "@/components/WholeRangeBalance";

interface WholeRangeReplayProps {
  /** Human-readable phrase for the range being guessed, e.g. "the past week" (RANGE_COPY[range]) -- passed straight through to WholeRangeBalance's own guess-prompt copy. */
  rangeLabel: string;
  /** The user's chosen display starting capital (issue #15) -- passed straight through to WholeRangeBalance. */
  startingCapital: number;
  /** The range's true final chained ending balance (issue #84), already rescaled to `startingCapital` -- see ResultsPanel's own `wholeRangeFinalBalance` doc comment. Passed straight through to WholeRangeBalance. */
  finalBalance: number;
  /** wholeRangePoints, from ResultsPanel -- `[]` pre-reveal (see this component's own doc comment on the guess-then-reveal gate below). */
  points: readonly PortfolioPoint[];
  /** Total trades across the whole range, this mode -- gates the "Watch it happen" button the same way TradeReplay.tsx's own `canReplay` does. */
  tradeCount: number;
  /** The whole range's own worst-case ending balance, raw/native-root -- see WholeRangeBalance's own `worstCase` prop doc comment for the exact rescale contract. */
  worstCaseEndingBalance: number;
  worstCaseStartingCapital: number;
  guess: number | null;
  guessStartingCapital: number | null;
  onSubmitGuess: (guess: number, startingCapital: number) => void;
  /**
   * Whether this range actually supports replay at all (issue #105 code
   * review finding, fixed) -- `range === "1W"`, computed by
   * `ResultsPanel.tsx`. This component itself has no notion of "range"
   * otherwise (every other prop is range-agnostic), so it can't derive
   * this on its own; the caller must say so explicitly. **Load-bearing,
   * not cosmetic**: `WHOLE_RANGE_REPLAY_PACING` below is tuned and
   * live-verified only against 1W's own worst case (15 trades/50 points).
   * 1M/3M/1Y's own whole-range series can run into the hundreds of
   * points (see `ResultsPanel.tsx`'s own `wholeRangePoints` doc comment),
   * for which this pacing has no duration ceiling at all -- issue #105's
   * own scope, and issue #106's sibling plan, both explicitly defer
   * those three ranges to their own future build. ANDed with
   * `canReplayFor`'s own tradeCount/reduced-motion gate below, so the
   * "Watch it happen" button never renders for an unsupported range
   * regardless of trade count or motion preference. Does **not** gate
   * `WholeRangeBalance`/the chart/`children` themselves -- 1M/3M/1Y keep
   * rendering their own whole-range headline and (non-animated) chart
   * exactly as they did before this issue, only without a replay button.
   */
  replaySupported: boolean;
  /**
   * Rendered between the button row and the chart, inside the same
   * `guess !== null` gate -- e.g. the methodology paragraph +
   * `BenchmarkStat`, unaffected by playback. Mirrors `TradeReplay.tsx`'s
   * own `children` prop exactly (see that component's own doc comment):
   * without this slot, `ResultsPanel.tsx` would have nowhere to put that
   * content except before or after this component's own two top-level
   * blocks, silently reordering it relative to the chart from what the
   * pre-#105 layout had (a real regression caught in code review, not a
   * design this component invented on its own).
   */
  children?: ReactNode;
  /**
   * Identifies "this result" for the whole-range `PortfolioChart`
   * instance's own `key` -- must stay stable across every phase
   * transition within one playback run (idle/rewinding/playing/done
   * never remount the chart) and change only on a genuine new result (a
   * fetch, a mode switch), the same "stable across phase transitions,
   * changes on a genuine new result" contract `TradeReplay.tsx`'s own
   * `heroKey` establishes for its identical chart instance -- see that
   * component's own doc comment (issue #96 follow-up round two's
   * key-stability fix, one of the most-relitigated bugs in this whole
   * feature's review history) for the full reasoning this reuses
   * without re-deriving. The same string the bare `<PortfolioChart>`
   * call this component replaces already used as its own key:
   * `` `${range}-${data.dataAsOf}-${mode}` ``.
   */
  chartKey: string;
}

// Tuned specifically for 1W's own worst case (docs/plans/issue-105-plan.md
// section 2): up to 15 trades across 5 trading days -> 50 points / 49
// segments / 30 event-pauses, against deriveWholeRangeIntradaySeries's
// own point shape (one leading boundary point *per trading day*, no
// trailing boundary point at all -- a genuinely different layout than
// derivePortfolioSeries, the window model's own shape use-trade-replay.ts's
// default pacing was tuned against). Unmodified window-model pacing would
// run this worst case in ~32.7s; these tightened constants bring it to
// ~13.0s -- real but not generous margin under the issue's own 10-15s
// ceiling, deliberately: `eventPauseMs` is the one constant whose job is
// "stay on screen long enough to read a callout sentence," and this
// pacing runs up to 30 of those pauses in a single run (5x the window
// model's own worst case), so tightening it further than this to buy
// back more margin trades real readability for a number on paper -- see
// the plan's own section 2.3 for the full worked tradeoff. A module-level
// constant, not an inline object literal -- its identity must stay
// stable across renders (this component's own call to useTradeReplay
// depends on it -- see that hook's own `pacing` parameter doc comment),
// or its RAF effects would restart on every WholeRangeReplay render.
//
// **This pacing is only ever exercised for 1W** -- see `replaySupported`
// above; a caller not gating on `range === "1W"` would let this untested-
// at-scale pacing loose on 1M/3M/1Y's own much larger point series.
const WHOLE_RANGE_REPLAY_PACING: ReplayPacing = {
  transitionMs: 130,
  eventPauseMs: 220,
  rewindMs: 700,
};

/**
 * Wraps `WholeRangeBalance` (extended with its own `worstCase`/
 * `revealSlot` props) plus the whole-range `PortfolioChart` with an
 * opt-in "Watch it happen" replay, for the 1W preset range specifically
 * (issue #105, gated via `replaySupported` -- see that prop's own doc
 * comment) -- the intraday-daily model's own equivalent of
 * `TradeReplay.tsx`, composing a different hero component for the
 * reason stated in this file's own header comment.
 *
 * **Guess-then-reveal sequencing is gated by construction, not by a
 * second check (docs/plans/issue-105-plan.md section 3.4).**
 * `ResultsPanel.tsx`'s own `wholeRangePoints` memo already returns `[]`
 * whenever the whole-range guess hasn't been submitted -- with
 * `points.length < 2`, `useTradeReplay`'s own `play()` guard already
 * makes the hook permanently inert, and the button row/`children`/chart
 * below are rendered only once `guess !== null` (the same value already
 * threaded to `WholeRangeBalance`), so they never even mount pre-reveal.
 * Reading the same `guess` value at two places in this one component
 * isn't a second, independent gate -- it's the identical value
 * `ResultsPanel.tsx` already reads twice today (the `<WholeRangeBalance>`
 * call and the `rangeGuess !== null` block wrapping `BenchmarkStat`/the
 * chart).
 *
 * **A `DayOverview` day switch never disturbs an in-flight replay**
 * (plan section 3.4) -- `ResultsPanel.tsx`'s `wholeRangePoints` memo's
 * dependency array (`[state, startingCapital, mode, rangeGuess]`) never
 * includes `activeDay`/`selectedDay`, so browsing to a different day
 * mid-replay leaves `points`' own identity untouched, and
 * `useTradeReplay`'s own `useResetWhenChanged([points], ...)` reset
 * never fires for it -- unlike a `ModeToggle`/`StartingCapitalInput`
 * edit, which *does* change `points` and correctly resets, the same
 * mechanism `TradeReplay.tsx` already relies on for the window model.
 *
 * **No confetti/count-up reward moment on completion, a considered
 * tradeoff (plan section 7, item 4), not an oversight.**
 * `WholeRangeBalance` has none of `HeroStat`'s reveal machinery (no
 * `useCountUp`, no `CelebrationBurst`, no reveal-accent glow) -- the
 * guess-then-reveal moment (issue #91) is already this range's own
 * "reward" beat, and issue #105's own acceptance criteria never asked
 * for a second one specifically for the *replay*. Landing on `"done"`
 * simply returns to the same static, unanimated headline the guess
 * reveal itself already showed -- see this repo's PR history for the
 * explicit sign-off this tradeoff was flagged for.
 */
export function WholeRangeReplay({
  rangeLabel,
  startingCapital,
  finalBalance,
  points,
  tradeCount,
  worstCaseEndingBalance,
  worstCaseStartingCapital,
  guess,
  guessStartingCapital,
  onSubmitGuess,
  replaySupported,
  children,
  chartKey,
}: WholeRangeReplayProps) {
  const reducedMotionAtMount = useReducedMotionAtMount();
  const { phase, frame, displayDate, play, skipToEnd } = useTradeReplay(
    points,
    WHOLE_RANGE_REPLAY_PACING,
  );

  // Memoized (matching TradeReplay.tsx's own identical fix) -- constant
  // for the whole result, but this component re-renders on every one of
  // the dozens of RAF-driven frames while playing.
  const includeDate = useMemo(() => spansMultipleDays(points), [points]);
  // Gates the *idle*/*done* button only, mirroring TradeReplay.tsx's own
  // `canReplay` (via the shared `canReplayFor`, issue #105 code review
  // finding) plus this range's own `replaySupported` restriction --
  // "Skip to end" stays available throughout "rewinding"/"playing"
  // regardless (see the button row below).
  const canReplay = canReplayFor(tradeCount, reducedMotionAtMount) && replaySupported;
  const showLive = isReplayLive(phase);

  const activeCallout = frame.activeEvent ? calloutText(frame.activeEvent, includeDate) : null;

  // Issue #108-style marker pulse/shake/speech-bubble wiring for
  // PortfolioChart -- `chartLandingFor` is shared with TradeReplay.tsx
  // (issue #105 code review finding).
  const landing: ChartLanding | null = useMemo(
    () => chartLandingFor(phase, frame.activeEvent, activeCallout),
    [phase, frame.activeEvent, activeCallout],
  );

  const announced =
    phase === "done"
      ? `Replay finished. Ending balance ${formatHeroCurrency(finalBalance)}.`
      : (activeCallout ?? "");

  // Memoized (issue #105 code review finding) -- constant for the whole
  // run, but this component re-renders on every RAF-driven frame while
  // playing, and `revealSlot` below needs this formatted string every
  // one of those frames even though its own value never changes across
  // them. Matches TradeReplay.tsx's own identical
  // `displayStartingCapitalFormatted` fix.
  const startingCapitalFormatted = useMemo(
    () => formatHeroCurrency(startingCapital),
    [startingCapital],
  );

  // Memoized (issue #105 code review finding) -- WholeRangeBalance's own
  // `worstCaseDisplayValue` memo is keyed on this object by reference,
  // which only actually skips recomputation across RAF-driven re-renders
  // if this object's own identity stays stable when neither of its two
  // numeric inputs has changed; a fresh object literal passed inline on
  // every render would defeat that memo entirely.
  const worstCase = useMemo(
    () => ({ startingCapital: worstCaseStartingCapital, endingBalance: worstCaseEndingBalance }),
    [worstCaseStartingCapital, worstCaseEndingBalance],
  );

  // One overlay design for both "rewinding" and "playing" (unlike
  // TradeReplay.tsx, which needs two: a giant date-only rewind figure,
  // then a compact "Watching {date}" label once the dollar-figure value
  // row needs its own space back). WholeRangeBalance's headline has no
  // multiplier badge competing for room, so there's no equivalent
  // layout-forced split here -- the label folds in the date
  // ("Watching {date}", replacing the caption for the overlay's
  // duration, per docs/plans/issue-105-plan.md section 3.2's own
  // instruction to reuse issue #107's proven pattern rather than
  // rediscovering its overflow lesson a second time) and the value row
  // stays byte-for-byte the same three-span shape as the real headline's
  // own markup, just with `frame.currentValue` substituted for
  // `finalBalance`.
  let revealSlot: ReactNode = undefined;
  if (phase === "rewinding" || phase === "playing") {
    revealSlot = (
      <div aria-hidden="true" className="absolute inset-0 flex flex-col gap-2">
        <p className={`${wholeRangeLabelClassName} flex items-baseline gap-2`}>
          <span>Watching</span>
          <span className="text-[var(--text-muted)]">{displayDate}</span>
        </p>
        <p className={wholeRangeValueRowClassName}>
          <span>{startingCapitalFormatted}</span>
          <span aria-hidden="true" className="text-[var(--text-muted)]">
            →
          </span>
          <span className="text-[var(--series-1)]">{formatHeroCurrency(frame.currentValue)}</span>
        </p>
      </div>
    );
  }

  return (
    <>
      <WholeRangeBalance
        rangeLabel={rangeLabel}
        startingCapital={startingCapital}
        finalBalance={finalBalance}
        guess={guess}
        guessStartingCapital={guessStartingCapital}
        onSubmitGuess={onSubmitGuess}
        worstCase={worstCase}
        revealSlot={revealSlot}
      />

      {guess !== null && (
        <>
          <div
            role="status"
            aria-live="polite"
            aria-label="Whole-range replay status"
            className="sr-only"
          >
            {announced}
          </div>

          <div className="flex items-center gap-3">
            {!showLive ? (
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

          <PortfolioChart
            key={chartKey}
            points={points}
            revealedCount={showLive ? undefined : frame.revealedCount}
            interactive={showLive}
            landing={landing}
          />
        </>
      )}
    </>
  );
}
