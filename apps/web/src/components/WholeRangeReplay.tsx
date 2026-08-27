"use client";

// "Watch it happen" trade replay for the intraday-daily whole-range
// balance -- 1W shipped first (issue #105), reusing use-trade-replay.ts's
// existing per-point walk machinery unmodified (a tighter `pacing`
// parameter, two date-formatting bug fixes at the hook level). Issue
// #118 extends this same component to 1M/3M/1Y via that hook's new
// day/chunk-based `segmentMode` (see use-trade-replay.ts's own doc
// comment) -- per docs/plans/issue-106-plan.md section 3.3, this is the
// real, shipped component that build extends, not a second, parallel
// one: both `pacing` and `segmentMode` are now real props instead of a
// single hardcoded module constant, threaded per range group by
// ResultsPanel.tsx (WHOLE_RANGE_REPLAY_PACING/"point" for 1W,
// CHUNKED_WHOLE_RANGE_REPLAY_PACING/"chunk" for 1M/3M/1Y, both exported
// below).
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
import { calloutText, chartLandingFor, chunkSummaryText } from "@/lib/replay-callout";
import { useReducedMotionAtMount } from "@/lib/use-reduced-motion-at-mount";
import {
  canReplayFor,
  isReplayLive,
  useTradeReplay,
  type ReplayPacing,
  type ReplaySegmentMode,
} from "@/lib/use-trade-replay";
import { AnimatedFigure } from "@/components/AnimatedFigure";
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
  /**
   * The whole range's own worst-case ending balance, raw/native-root --
   * see WholeRangeBalance's own `worstCase` prop doc comment for the
   * exact rescale contract. Always passed as a real number regardless of
   * range (cheap to compute alongside `wholeRangeFinalBalance`), but only
   * ever forwarded to `WholeRangeBalance` when `replaySupported` is true
   * -- see that prop's own doc comment for why. Callers don't need to
   * gate this themselves.
   */
  worstCaseEndingBalance: number;
  worstCaseStartingCapital: number;
  guess: number | null;
  guessStartingCapital: number | null;
  onSubmitGuess: (guess: number, startingCapital: number) => void;
  /**
   * Whether this range actually supports replay at all -- computed by
   * `ResultsPanel.tsx`, since this component has no other notion of
   * "range" to derive it from on its own (every other prop is
   * range-agnostic). Every intraday-daily range (1W/1M/3M/1Y) now
   * supports it (issue #118 widened this from 1W-only, per issue #105's
   * own scope) -- kept as an explicit prop rather than assumed `true`
   * unconditionally so a future intraday-daily range that genuinely
   * isn't ready yet (untested pacing at a new scale, say) has somewhere
   * to say so without this component needing to know about ranges at
   * all. ANDed with `canReplayFor`'s own tradeCount/reduced-motion gate
   * below, so the "Watch it happen" button never renders regardless of
   * trade count or motion preference when this is `false`. Does **not**
   * gate `WholeRangeBalance`/the chart/`children` themselves -- an
   * unsupported range would still render its own whole-range headline
   * and (non-animated) chart, only without a replay button.
   *
   * **Also gates the `worstCase` object forwarded to `WholeRangeBalance`**
   * (an independent-review finding on issue #105's own PR, preserved
   * here) -- the same prop that gates the button also gates the "Worst
   * case, same budget" stat, so the two can never drift apart (a
   * `replaySupported: true` range always gets both, `false` gets
   * neither).
   */
  replaySupported: boolean;
  /**
   * How fast the RAF loops move -- required, no default (the same
   * "no silent fallback by omission" convention `trade-math.ts`'s own
   * `direction` parameter established): `WHOLE_RANGE_REPLAY_PACING`
   * (1W, point segment mode) or `CHUNKED_WHOLE_RANGE_REPLAY_PACING`
   * (1M/3M/1Y, chunk segment mode), both exported below, chosen by
   * `ResultsPanel.tsx` per range group. See `use-trade-replay.ts`'s own
   * `pacing` parameter doc comment for the stable-identity requirement.
   */
  pacing: ReplayPacing;
  /**
   * Which of `useTradeReplay`'s two segment-builders to walk with --
   * required, same "no silent default" reasoning as `pacing` above (a
   * caller must decide deliberately, not fall back to "point" by
   * omission for a range whose trade count that mode was never tuned
   * for). `"point"` for 1W (per-point walk, unchanged since issue #105);
   * `"chunk"` for 1M/3M/1Y (issue #118's day/chunk-based reveal -- see
   * `use-trade-replay.ts`'s own `ReplaySegmentMode` doc comment).
   */
  segmentMode: ReplaySegmentMode;
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

// 1W's own pacing (issue #105, docs/plans/issue-105-plan.md section 2):
// tuned for 1W's own worst case -- up to 15 trades across 5 trading days
// -> 50 points / 49 segments / 30 event-pauses, against
// deriveWholeRangeIntradaySeries's own point shape (one leading boundary
// point *per trading day*, no trailing boundary point at all -- a
// genuinely different layout than derivePortfolioSeries, the window
// model's own shape use-trade-replay.ts's default pacing was tuned
// against). Unmodified window-model pacing would run this worst case in
// ~32.7s; these tightened constants bring it to ~13.0s -- real but not
// generous margin under the issue's own 10-15s ceiling, deliberately:
// `eventPauseMs` is the one constant whose job is "stay on screen long
// enough to read a callout sentence," and this pacing runs up to 30 of
// those pauses in a single run (5x the window model's own worst case),
// so tightening it further than this to buy back more margin trades
// real readability for a number on paper -- see the plan's own section
// 2.3 for the full worked tradeoff. Paired with segmentMode "point" only
// (see WholeRangeReplayProps' own `pacing`/`segmentMode` doc comments) --
// exported so ResultsPanel.tsx can pass it explicitly for 1W.
export const WHOLE_RANGE_REPLAY_PACING: ReplayPacing = {
  transitionMs: 130,
  eventPauseMs: 220,
  rewindMs: 700,
};

// 1M/3M/1Y's own pacing (issue #118, docs/plans/issue-106-plan.md
// section 3.1) -- paired with segmentMode "chunk" only. `transitionMs`/
// `eventPauseMs` here are the same shape as the plan's own
// CHUNK_TRANSITION_MS/CHUNK_PAUSE_MS, reused as a real ReplayPacing
// object rather than a separate ad hoc constant pair (per that plan
// section's own explicit instruction).
//
// **The real (not just NUM_CHUNKS-capped) worst-case chunk count per
// range, worked out precisely (code review finding, fixed -- an earlier
// version of this comment claimed 3M and 1Y always land on "the
// identical ceiling," which use-trade-replay.ts's own NUM_CHUNKS
// comment now explains is false):** `chunkSize =
// ceil(dayCount / min(dayCount, NUM_CHUNKS))`, and the actual chunk
// count is `ceil(dayCount / chunkSize)` -- at NUM_CHUNKS = 30, 1M's ~21
// trading days -> chunkSize 1 -> 21 chunks (one per day, under the cap
// by construction); 3M's ~62 -> chunkSize 3 -> 21 chunks (coincidentally
// equal to 1M's own count, not by design); 1Y's ~250 -> chunkSize 9 ->
// 28 chunks. Analytical worst-case duration is `chunkCount *
// (transitionMs + eventPauseMs)`.
//
// **Both this pacing and NUM_CHUNKS were retuned from the plan's own
// first-draft numbers (pacing 120/220, NUM_CHUNKS 40) against real
// live-browser measurement, not just the analytical formula above --
// the plan's own section 6 flagged both as an implementer/reviewer call
// to finalize live, and the first-draft numbers genuinely missed their
// own targets once measured for real.** The old NUM_CHUNKS=40 baseline's
// own real chunk counts (code review finding, fixed -- an earlier
// version of this comment reused the *new*, NUM_CHUNKS=30 chunk counts
// [21/21/28] and mislabeled them as the 40-cap numbers, and separately
// cited a "~13.6s" 1Y analytical estimate that was actually just
// `NUM_CHUNKS * pacing` [40 * 340ms], i.e. NUM_CHUNKS treated as if it
// were the real chunk count -- exactly the "identical ceiling" mistake
// this comment block is otherwise correcting): at NUM_CHUNKS = 40, 1M's
// ~21 days -> chunkSize 1 -> 21 chunks (unchanged from the 30-cap case,
// since 21 is already under either cap); 3M's ~62 -> chunkSize
// `ceil(62/40)` = 2 -> 31 chunks; 1Y's ~250 -> chunkSize `ceil(250/40)`
// = 7 -> 36 chunks. Confirmed via the no-root-headless-Chromium
// technique (apps/web/CLAUDE.md's own established workaround) against
// this issue's own worst-case synthetic fixture (every trading day
// maxed at `maxTradesPerDay` = 3 trades): the first-draft 120/220 pacing
// at NUM_CHUNKS=40 measured **~8.95s for 1M** (target 4-7s, ~25% over
// its own correct 21-chunk, ~7.1s analytical estimate) and **~20.1s for
// 1Y** (target 7-14s, ~64% over its own correct 36-chunk, ~12.2s
// analytical estimate) -- both real overages, not just margin erosion,
// and 1Y's own overhead percentage running well past 1M's own. The
// overhead itself scales with a range's own total point count in a way
// 1W's own ~50-point worst case never exercised: `PortfolioChart`
// (`React.memo`'d, but still recomputing `linePath`/`areaPath`/
// `eventMarkers` over the *revealed* prefix on every landing) does
// genuinely more work per landing as point count grows into the
// hundreds/thousands (1Y's own worst case is ~2,500 points, vs. 1W's
// ~50) -- so tightening `pacing` alone wasn't enough; `NUM_CHUNKS`
// itself (how many times that per-landing cost gets paid) needed
// lowering too, from 40 to 30, alongside a tighter pacing (80/160).
// Re-measured live at 80/160 + NUM_CHUNKS=30 (chunk counts of 21/21/28,
// the section above's own math), across two separate runs for
// stability: **1M ~6.4s, 3M ~6.8-6.9s, 1Y ~13.6-13.7s** -- all inside
// their own stated targets. 1M and 3M share nearly the same chunk count
// (21) yet 3M still measures slightly higher (more total points behind
// each of those 21 landings); 1Y's own real ~2x-of-3M total reflects
// both a higher chunk count (28 vs. 21) and a higher per-chunk cost
// compounding together, not one single mechanism. 1Y's own margin under
// its 14s ceiling is real but modest (~350ms) -- a similar tightness to
// 1W's own live-measured ~14.4s against its own ~15s ceiling, see
// WHOLE_RANGE_REPLAY_PACING's own comment -- this codebase's established
// tolerance for a close-but-compliant margin, not a red flag).
export const CHUNKED_WHOLE_RANGE_REPLAY_PACING: ReplayPacing = {
  transitionMs: 80,
  eventPauseMs: 160,
  rewindMs: 700,
};

/**
 * Wraps `WholeRangeBalance` (extended with its own `worstCase`/
 * `revealSlot` props) plus the whole-range `PortfolioChart` with an
 * opt-in "Watch it happen" replay -- the intraday-daily model's own
 * equivalent of `TradeReplay.tsx`, composing a different hero component
 * for the reason stated in this file's own header comment. Shared by
 * every intraday-daily range (1W/1M/3M/1Y); `pacing`/`segmentMode`
 * (both required props, see their own doc comments) are what actually
 * differ per range group, chosen by `ResultsPanel.tsx`.
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
 *
 * **Chunk-mode callout has two voices (issue #118), point mode always
 * has one.** `frame.activeEvent`/`frame.activeChunk` are mutually
 * exclusive (see `ReplayFrame`'s own doc comment in
 * use-trade-replay.ts) -- `activeEvent` (a single real trade) reuses the
 * exact same `calloutText`/chart-anchored marker-bubble treatment 1W
 * already has, including for chunk mode's own one-day/one-trade
 * degenerate case; `activeChunk` (a genuine multi-trade chunk summary)
 * has no single marker to anchor a speech bubble to (a chunk can span
 * several days, and its own terminal point doesn't necessarily carry a
 * trade event -- see use-trade-replay.ts's own `buildChunkLanding` doc
 * comment), so it renders as a plain visible callout line below the
 * button row instead, alongside the identical sentence already reaching
 * the sr-only status region.
 *
 * **The chart doesn't mount at all until "Watch it happen" is clicked
 * (issue #162), on top of the pre-existing `guess !== null` gate.**
 * Before this issue, once the whole-range guess was revealed, the chart
 * still rendered immediately and statically in its idle phase -- this
 * issue adds a second gate (`chartRevealed`, below) so there's nothing
 * to scroll past until the user actually opts in, matching the same
 * treatment the new daily-hero chart (`DailyHero.tsx`) got from the
 * start. The one case that still shows the chart immediately: no
 * "Watch it happen" button exists to click at all (`canReplay` false --
 * zero trades, reduced motion, or `replaySupported` false) -- the same
 * "zero information loss" precedent `TradeReplay.tsx`'s own reduced-
 * motion note already establishes.
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
  pacing,
  segmentMode,
  children,
  chartKey,
}: WholeRangeReplayProps) {
  const reducedMotionAtMount = useReducedMotionAtMount();
  const { phase, frame, displayDate, play, skipToEnd } = useTradeReplay(
    points,
    pacing,
    segmentMode,
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

  // Issue #162: the chart itself doesn't mount at all until "Watch it
  // happen" is clicked (i.e. once `phase` leaves "idle") -- before this
  // issue it rendered statically the moment the guess was revealed,
  // defeating the point of a click-to-reveal replay. When there's no
  // button to ever click at all (`canReplay` false: zero trades,
  // reduced motion, or an unsupported range), the chart still renders
  // immediately, unconditionally -- the same "zero information loss"
  // precedent TradeReplay.tsx's own reduced-motion note already
  // establishes for the window model; a chart with no possible way to
  // reveal it would be a real regression, not this issue's intent. A
  // genuine `points`-identity reset (a mode/capital edit) takes `phase`
  // back to "idle", so the chart re-hides until watched again -- treated
  // the same as a fresh, not-yet-revealed result.
  const chartRevealed = phase !== "idle" || !canReplay;

  // Two mutually-exclusive callout voices (issue #118) -- see this
  // component's own doc comment for the full "why two" reasoning.
  // `frame.activeEvent`/`frame.activeChunk` never both hold a value at
  // once (use-trade-replay.ts's own ReplayFrame doc comment).
  const activeCallout = frame.activeEvent
    ? calloutText(frame.activeEvent, includeDate)
    : frame.activeChunk
      ? chunkSummaryText(frame.activeChunk)
      : null;

  // Issue #108-style marker pulse/shake/speech-bubble wiring for
  // PortfolioChart -- `chartLandingFor` is shared with TradeReplay.tsx
  // (issue #105 code review finding). Only ever non-null when
  // `frame.activeEvent` is set (chartLandingFor's own gate), so a
  // genuine multi-trade chunk summary never tries to anchor a bubble to
  // a marker that may not exist -- see this component's own doc comment.
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
  //
  // Gated by `replaySupported` -- see that prop's own doc comment for
  // why the button and this stat must never drift apart.
  const worstCase = useMemo(
    () =>
      replaySupported
        ? { startingCapital: worstCaseStartingCapital, endingBalance: worstCaseEndingBalance }
        : undefined,
    [replaySupported, worstCaseStartingCapital, worstCaseEndingBalance],
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
  // `finalBalance`. Works identically for chunk mode (issue #118):
  // `displayDate` reads as "the end date of whichever chunk is currently
  // revealed" (see use-trade-replay.ts's own `displayDate` doc comment),
  // still a real, meaningful date with no separate handling needed here.
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
          {/* Issue #147: the exact same reserved box
              WholeRangeBalance.tsx gives its own headline figure, from
              the exact same two endpoint values -- this overlay is only
              ever the same height as the invisible real headline behind
              it while the two wrap identically. */}
          <AnimatedFigure
            className="text-[var(--series-1)]"
            from={startingCapital}
            to={finalBalance}
            value={formatHeroCurrency(frame.currentValue)}
          />
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

          {/* A genuine multi-trade chunk summary (issue #118) has no
              single marker to anchor a chart-side speech bubble to (see
              this component's own doc comment) -- shown as a plain
              visible line instead, identical wording to the sr-only
              status region above. Never rendered for point mode (which
              never populates activeChunk at all) or once live again --
              only for the whole `!showLive` (rewinding/playing) stretch
              of a chunk-mode run.

              **Always mounted for the whole `!showLive` stretch, not
              conditionally on `frame.activeChunk` alone (independent-
              review finding, fixed) -- toggled via `invisible`, the
              same idiom `WholeRangeBalance.tsx`'s own revealSlot pairing
              already establishes, not a ternary swap.** This is a plain
              flow element (unlike the chart-anchored bubble, not
              absolutely positioned), sitting between the button row and
              `children`/the chart -- and `tick()`'s own logic sets
              `activeChunk` back to `null` on every intervening tween
              frame between two chunk landings (see ReplayFrame's own doc
              comment), so a naive `{frame.activeChunk && <p>...}` mounts
              and unmounts this element on every single chunk boundary
              during a real multi-chunk run, visibly shifting the chart/
              children block down and back up each time (confirmed live,
              via a real pixel measurement across a genuine multi-trade
              chunk landing and its clearing, before this fix). Reserving
              the line's height for the whole run instead means the "make
              room" shift happens at most once, when playback starts (or
              never, in the common case where the first landing is
              already the empty-string frame before any user has had a
              chance to notice) -- not once per chunk boundary. */}
          {segmentMode === "chunk" && !showLive && (
            <p
              aria-hidden="true"
              className={`min-h-10 text-sm text-[var(--text-secondary)] ${
                frame.activeChunk ? "line-clamp-2" : "invisible"
              }`}
            >
              {/* Only ever real text for a genuine chunk summary -- a
                  plain space placeholder otherwise (including the
                  one-day/one-trade degenerate case, which already
                  narrates via the chart-anchored bubble/status region
                  above; duplicating that same sentence a third time
                  here, just invisible, would be pointless -- caught by
                  exactly this scenario in a test regression).

                  `min-h-10` (2 lines' worth at text-sm) + `line-clamp-2`
                  together give this line a genuinely *fixed* height,
                  not just a minimum (independent-review finding, fixed
                  -- a first attempt at this fix used only a plain-space
                  placeholder with no min-height/clamp at all, which
                  reserved however many lines *that* render's content
                  happened to wrap to; a real chunk summary sentence's
                  own length varies chunk to chunk, so some genuinely
                  wrap to a second line and some don't, live-verified via
                  a real chart-position measurement across an entire
                  worst-case run -- confirmed a real, if smaller, residual
                  shift between 1-line and 2-line chunk summaries even
                  after that first fix). `line-clamp-2` caps the rare
                  chunk whose own summary sentence would need a third
                  line (a real trade count into the hundreds, on 1Y);
                  the sr-only status region right above carries the full,
                  untruncated sentence regardless, so no information is
                  lost, only this decorative line's own display. */}
              {frame.activeChunk ? activeCallout : " "}
            </p>
          )}

          {children}

          {chartRevealed && (
            <PortfolioChart
              key={chartKey}
              points={points}
              revealedCount={showLive ? undefined : frame.revealedCount}
              interactive={showLive}
              landing={landing}
            />
          )}
        </>
      )}
    </>
  );
}
