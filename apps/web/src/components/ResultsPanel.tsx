import { useMemo, type ReactNode } from "react";

import type {
  BenchmarkResult,
  CustomWindowResult,
  IntradayTrade,
  LongShortResult,
  PrecomputedResult,
  PresetRange,
  Trade,
  WorstCaseResult,
} from "@hadiknowntrades/core";

import type { ClientErrorCode, ResultsState } from "@/lib/use-results";
import {
  deriveWholeRangeIntradaySeries,
  derivePortfolioSeries,
  type PortfolioPoint,
} from "@/lib/portfolio-series";
import { formatDate } from "@/lib/format-date";
import { DEFAULT_MODE, MODE_LABELS, type Mode } from "@/lib/mode";
import { rescaleFromStartingCapital } from "@/lib/rescale-starting-capital";
import { useRangeGuess } from "@/lib/use-range-guess";
import { useReducedMotionAtMount } from "@/lib/use-reduced-motion-at-mount";
import { BenchmarkStat } from "@/components/BenchmarkStat";
import { DayOverview } from "@/components/DayOverview";
import { HeroAndWorstCase } from "@/components/HeroAndWorstCase";
import { IntradayTradeList } from "@/components/IntradayTradeList";
import { PortfolioChart } from "@/components/PortfolioChart";
import { StartingCapitalInput } from "@/components/StartingCapitalInput";
import { TradeList } from "@/components/TradeList";
import { TradeReplay } from "@/components/TradeReplay";
import { WholeRangeBalance } from "@/components/WholeRangeBalance";

const RANGE_COPY: Record<PresetRange, string> = {
  "1W": "the past week",
  "1M": "the past month",
  "3M": "the past 3 months",
  "1Y": "the past year",
  "5Y": "the past 5 years",
  MAX: "all available history",
};

/** The three fields every dollar-figure/trade-list consumer below actually reads, shared by the window model's WindowResult/LongShortResult and the intraday-daily model's IntradayDayResult/IntradayLongShortResult -- both pairs have this exact shape. */
interface Variant<T> {
  endingBalance: number;
  trades: T[];
  worstCase: { endingBalance: number; trades: T[] };
}

/**
 * Picks which of a result's two computed variants (issue #13) every
 * dollar-figure/trade-list consumer below should read: the long-only
 * fields (unchanged since before this issue) or the sibling `longShort`
 * fields, both always present on a real pipeline-written result. This is
 * the single place that decision is made -- every consumer downstream
 * (HeroAndWorstCase, PortfolioChart via portfolio-series.ts,
 * TradeList/IntradayTradeList) is threaded this function's result instead
 * of reading the raw top-level fields directly, the same class of mistake
 * apps/web/CLAUDE.md documents happening *twice* for
 * `effectiveStartingCapital` (issue #15) -- a component quietly reading
 * the un-rescaled/wrong-variant field instead of the thread-through value.
 *
 * **Every call site below passes a `WindowResult`/`IntradayDayResult`
 * (or its own `longShort` field) straight through as `base`/`longShort`,
 * with no intermediate `{endingBalance, trades, worstCase}` object
 * construction (code review follow-up)** -- an earlier version of this
 * file built that object independently at each of the four call sites
 * below, exactly the duplication-drift risk this doc comment already
 * warned about. That construction was always redundant: `WindowResult`/
 * `IntradayDayResult`/`LongShortResult`/`IntradayLongShortResult` already
 * have `endingBalance`/`trades`/`worstCase` as own top-level fields with
 * these exact names and shapes, so passing the real result object
 * satisfies `Variant<T>` structurally (TypeScript's excess-property
 * check only applies to fresh object literals, not existing typed
 * variables) with nothing to keep in sync -- one fewer place to drift,
 * not just one shared helper to remember to call.
 */
function selectVariant<T>(base: Variant<T>, longShort: Variant<T>, mode: Mode): Variant<T> {
  return mode === "long" ? base : longShort;
}

/** A human error message per API error code (see ../app/api/results/route.ts's errorResponse calls) -- the API's own `message` is logged/available too, but these read better as UI copy for each specific, known failure shape. */
function errorCopy(error: ClientErrorCode, apiMessage: string): { title: string; body: string } {
  switch (error) {
    case "not_found":
      return {
        title: "Not published yet",
        body: "This range hasn't been computed yet. The nightly pipeline publishes results for every range on a schedule -- check back soon.",
      };
    case "invalid_range":
      return { title: "Unsupported range", body: apiMessage };
    case "invalid_anchor":
      return { title: "Unsupported start date", body: apiMessage };
    case "server_misconfigured":
      return {
        title: "Results are temporarily unavailable",
        body: "The server isn't configured to serve results right now. This is on us, not you.",
      };
    case "upstream_error":
      return {
        title: "Couldn't load results",
        body: "We couldn't reach storage to fetch this range's results. Try again in a moment.",
      };
    case "corrupt_data":
    case "schema_mismatch":
      return {
        title: "Results look corrupted",
        body: "The stored results for this range are in an unexpected format. This is a bug on our end -- try a different range for now.",
      };
    case "network_error":
      return {
        title: "Couldn't reach the server",
        body: "Check your connection and try again.",
      };
    default:
      return { title: "Something went wrong", body: apiMessage };
  }
}

function LoadingSkeleton() {
  return (
    <div className="flex animate-pulse flex-col gap-8" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading results…</span>
      <div className="h-16 w-72 rounded-lg bg-[var(--surface-2)]" />
      <div className="h-[400px] w-full rounded-lg bg-[var(--surface-2)]" />
      <div className="flex flex-col gap-3">
        <div className="h-16 w-full rounded-lg bg-[var(--surface-2)]" />
        <div className="h-16 w-full rounded-lg bg-[var(--surface-2)]" />
        <div className="h-16 w-full rounded-lg bg-[var(--surface-2)]" />
      </div>
    </div>
  );
}

/**
 * Wraps a success-branch's outer content and applies the range/custom-
 * anchor switch fade-in (issue #65) exactly once per genuine *mount* of
 * this wrapper, not once per render of whatever already-mounted instance
 * happens to be showing.
 *
 * **A real bug (found in `high` code review, fixed) with the first version
 * of this feature is why this reads reduced-motion via
 * `useReducedMotionAtMount` (`lib/use-reduced-motion-at-mount.ts`), not
 * a plain `prefersReducedMotion() ? "" : " results-fade-in"` expression
 * computed inline in `ResultsPanel`'s render body.** That plain-
 * expression version re-evaluated `prefersReducedMotion()` on *every*
 * render of `ResultsPanel`, including the mode/day/starting-capital
 * re-renders that leave this wrapper's own div instance mounted the
 * whole time (see the "Two result models" section in apps/web/CLAUDE.md
 * for why those never remount it). If the OS-level reduced-motion
 * preference actually changed value *between* two such re-renders --
 * toggled mid-session, then the user clicks ModeToggle -- the computed
 * className string would flip too, adding or removing the
 * `results-fade-in` class on an element that's already on screen. Per
 * the CSS Animations spec, an element's `animation-name` newly entering
 * its computed style (even via a plain class-attribute change on an
 * existing DOM node) starts that animation fresh -- so an "instant,
 * always" mode/day switch could suddenly flash opacity 0 -> 1 on
 * already-visible content, exactly the replay this issue's own out-of-
 * scope section says must never happen.
 *
 * `useReducedMotionAtMount`'s `useState` lazy initializer runs exactly
 * once, at the moment React actually creates a new instance of this
 * component -- which, given where this is used below (only ever swapped
 * in for `LoadingSkeleton` on a genuine `"loading"` -> `"success"`
 * transition), only happens on a real range/custom-anchor switch or
 * first load, never a mode/day/starting-capital change. No extra
 * key/memoization bookkeeping is needed to replicate that "was this a
 * genuine mount?" check by hand -- it falls straight out of React's own
 * reconciliation rules for this component's call sites. **Shared with
 * `HeroStat.tsx`'s own reveal-accent gate (issue #77), which hit the
 * identical bug independently** -- see the hook's own doc comment for
 * the full argument, extracted rather than left as two copies of the
 * same fix.
 */
function FadeInWrapper({ children }: { children: ReactNode }) {
  const shouldFadeIn = !useReducedMotionAtMount();
  return (
    <div className={`flex flex-col gap-8${shouldFadeIn ? " results-fade-in" : ""}`}>{children}</div>
  );
}

/**
 * The fields WindowResultBody actually reads -- satisfied structurally by
 * both WindowResult (5Y/MAX) and CustomWindowResult (issue #11's custom
 * start-date anchors, day-granularity since issue #75), which share this
 * exact shape apart from their own identifying field (`range` vs.
 * `anchorDate`). Neither `range` nor `anchorDate` is read here at all --
 * the caller derives its own `rangeLabel`/`heroKey`/`emptyCopy` from
 * whichever identifying field it has, so this component never needs to
 * know which one it got.
 *
 * **Includes `longShort` (issue #13/#11 integration)**: CustomWindowResult
 * gained the same long+short sibling field WindowResult already had, once
 * apps/pipeline's buildCustomWindowResults started calling the same
 * optimizeAllVariants-backed computeWindowOptimization buildWindowResults
 * does (see packages/core/src/results-schema.ts's own doc comment on
 * CustomWindowResult) -- so both models satisfy this shape unchanged, and
 * WindowResultBody can select a variant (see selectVariant) the same way
 * for either.
 */
interface WindowLikeResult {
  dataAsOf: string;
  maxTrades: number;
  startingCapital: number;
  endingBalance: number;
  trades: Trade[];
  worstCase: WorstCaseResult;
  longShort: LongShortResult;
  benchmark: BenchmarkResult | null;
}

interface WindowResultBodyProps {
  data: WindowLikeResult;
  points: PortfolioPoint[];
  /** The full phrase following "Best possible outcome " -- e.g. "over the past year" (a preset range) or "since Mar 1, 2019" (a custom anchor). Includes its own preposition since the two forms need different ones. */
  descriptionPhrase: string;
  /** Passed straight through as HeroAndWorstCase's own heroKey -- see that component's prop doc comment for why this must change whenever the underlying result does. Callers must fold `mode` into this string themselves (see each call site) -- switching modes surfaces a genuinely different trade sequence, the same "remount, don't just update props" reasoning the intraday-daily branch's own heroKey comment gives. */
  heroKey: string;
  emptyCopy: string;
  /**
   * Long-only vs. long+short (issue #13) -- which of `data`'s two
   * computed variants (see selectVariant's own doc comment) this body
   * reads for its hero figures/trade list/empty check. Required, not
   * optional/defaulted: both call sites below (the "window" and
   * "custom-window" branches) always have a real mode from
   * ResultsPanel's own prop by the time either renders, so there's no
   * meaningful default to fall back to here the way ResultsPanel's own
   * top-level `mode` prop falls back to "long" for a caller that predates
   * this issue.
   */
  mode: Mode;
  startingCapital?: number;
  onStartingCapitalChange?: (value: number) => void;
}

/**
 * The whole-window result body (HeroStat/WorstCaseStat + chart + trade
 * list) shared by both the "window" (5Y/MAX) and "custom-window" (issue
 * #11) branches of ResultsPanel's success render below -- the two models
 * are the exact same underlying computation (packages/core's
 * optimizeAllVariants over a daily-close window, issue #13), so
 * extracting this once avoids the two branches' JSX silently drifting
 * apart over time, the same "shared, not copy-pasted" discipline this
 * codebase applies elsewhere (e.g. trade-math.ts's compoundBalance/
 * computeTradeReturn). Long-only vs. long+short variant selection (see
 * selectVariant) happens once, here, rather than being left to each
 * caller -- the same "one place decides" reasoning selectVariant's own
 * doc comment already argues for at the top of this file.
 *
 * The hero row + chart pairing is delegated to TradeReplay (issue #96),
 * which renders the same HeroAndWorstCase + PortfolioChart this body
 * rendered directly before that issue, plus an opt-in "Watch it happen"
 * replay button -- see that component's own doc comment. The methodology
 * paragraph and BenchmarkStat are passed as `children`, rendered between
 * TradeReplay's own hero row and chart exactly where they sat before,
 * unaffected by playback.
 */
function WindowResultBody({
  data,
  points,
  descriptionPhrase,
  heroKey,
  emptyCopy,
  mode,
  startingCapital,
  onStartingCapitalChange,
}: WindowResultBodyProps) {
  const variant = selectVariant<Trade>(data, data.longShort, mode);
  const isEmpty = variant.trades.length === 0;
  const effectiveStartingCapital = startingCapital ?? data.startingCapital;

  return (
    <FadeInWrapper>
      <TradeReplay
        points={points}
        tradeCount={variant.trades.length}
        heroKey={heroKey}
        startingCapital={data.startingCapital}
        endingBalance={variant.endingBalance}
        worstCaseEndingBalance={variant.worstCase.endingBalance}
        // The window model (WorstCaseResult/LongShortResult) has no
        // per-track startingCapital of its own -- it's never chained
        // (only the intraday-daily model is, issue #84), so every track
        // always shares this same flat data.startingCapital.
        worstCaseStartingCapital={data.startingCapital}
        displayStartingCapital={effectiveStartingCapital}
        startingCapitalInput={
          onStartingCapitalChange && (
            <StartingCapitalInput
              value={effectiveStartingCapital}
              onChange={onStartingCapitalChange}
            />
          )
        }
      >
        <p className="text-sm text-[var(--text-secondary)]">
          Best possible outcome {descriptionPhrase}, with at most {data.maxTrades} sequential all-in
          trades across the S&amp;P 500, using only closed (EOD) prices. As of {data.dataAsOf}.
        </p>
        <BenchmarkStat
          benchmark={data.benchmark}
          startingCapital={data.startingCapital}
          displayStartingCapital={effectiveStartingCapital}
        />
      </TradeReplay>

      <div className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold text-[var(--text-primary)]">Trades</h2>
        {isEmpty ? (
          <div className="surface-card rounded-lg border border-[var(--gridline)] bg-[var(--surface-1)] px-4 py-6 text-center text-sm text-[var(--text-secondary)]">
            {emptyCopy}
          </div>
        ) : (
          <TradeList trades={variant.trades} startingCapital={effectiveStartingCapital} />
        )}
      </div>
    </FadeInWrapper>
  );
}

interface ResultsPanelProps {
  /**
   * The active preset range, or `null` when a custom start-date anchor
   * (issue #11) is active instead -- reflects the real invariant
   * directly in the type rather than forcing the caller (ResultsPage) to
   * pass a placeholder PresetRange that's silently never read (a real
   * code-review finding, fixed): `range` is only ever actually read
   * below once `state.data.model` has narrowed to "window" or
   * "intraday-daily", at which point it's asserted non-null (see those
   * branches) rather than assumed so via type-widening/comments alone --
   * a real invariant violation there throws instead of silently reading
   * `RANGE_COPY[null]`.
   */
  range: PresetRange | null;
  /**
   * Generic over the success payload so this same component can render
   * either a preset-range result (PrecomputedResult) or a custom
   * start-date anchor's result (CustomWindowResult, issue #11) -- the
   * caller picks whichever hook's state is currently active (see
   * ResultsPage.tsx).
   */
  state: ResultsState<PrecomputedResult | CustomWindowResult>;
  /** The day currently selected in the URL for the intraday model (issue #28), or null if none is set (or the range/data is window-model) -- ResultsPanel falls back to the most recent day in that case. */
  selectedDay?: string | null;
  /** Called when the user picks a different day from DayOverview (issue #80; DaySelector before it). Required whenever the data can be intraday-model; omit only where a caller (e.g. a window-only test) never needs it. */
  onSelectDay?: (day: string) => void;
  /**
   * Long-only vs. long+short (issue #13) -- which of a result's two
   * computed variants (see selectVariant above) every dollar-figure/
   * trade-list consumer below reads. Defaults to "long" (the pre-#13
   * behavior), keeping default rendering (and every existing caller/test
   * that doesn't pass this) pixel-identical to before this prop existed --
   * same convention startingCapital/onStartingCapitalChange already use.
   */
  mode?: Mode;
  /**
   * The user's chosen starting dollar amount (issue #15) to rescale
   * every displayed dollar figure to -- omit (along with
   * onStartingCapitalChange) to fall back to whatever the precomputed
   * result's own startingCapital already is. The input control itself
   * only renders when onStartingCapitalChange is provided, the same
   * optional-pair convention selectedDay/onSelectDay already uses.
   *
   * **In the real deployed app this prop is never actually omitted** --
   * ResultsPage.tsx always passes a real number from
   * `useStartingCapital()` (defaults to $20, persisted) -- so the
   * fallback below only matters for a caller/test that constructs
   * `<ResultsPanel>` directly without it.
   *
   * **The fallback's own meaning changed once issue #84 shipped per-day
   * chaining, worth being precise about**: pre-#84, every day's own
   * `startingCapital` was the identical flat root constant, so omitting
   * this prop always meant "show the raw $20 baseline, no rescale,"
   * range-wide. Post-#84, `activeDay.startingCapital` (the intraday-daily
   * branch's own fallback target) is itself a chained, day-varying real
   * dollar amount -- omitting this prop still produces a mathematically
   * correct no-op rescale (every figure renders exactly as the
   * precomputed result already has it, the same literal promise this
   * prop has always kept), but "as the precomputed result already has
   * it" now means "as if this specific day started fresh at its own
   * chained capital," not a flat $20 across every day.
   */
  startingCapital?: number;
  onStartingCapitalChange?: (value: number) => void;
}

/** Switches on the fetch state to render loading / error / (empty or full) success -- see useResults for the state machine this drives off of. Success further switches on the result's `model` (issue #28): the original whole-window model, or the per-day intraday model. */
export function ResultsPanel({
  range,
  state,
  selectedDay = null,
  onSelectDay,
  mode = DEFAULT_MODE,
  startingCapital,
  onStartingCapitalChange,
}: ResultsPanelProps) {
  // Must run unconditionally (before the early returns below) per the
  // Rules of Hooks. Computed once here (not re-derived again later in
  // the intraday render branch below) so there's a single source of
  // truth for "which day is active" -- two independent copies of this
  // fallback logic previously risked drifting (e.g. a future change to
  // the fallback rule applied to one copy and missed the other).
  const activeDay = useMemo(() => {
    if (state.status !== "success" || state.data.model !== "intraday-daily") return null;
    const { days } = state.data;
    if (days.length === 0) return null;
    return days.find((d) => d.date === selectedDay) ?? days[days.length - 1]!;
  }, [state, selectedDay]);

  // Memoized so PortfolioChart's own useMemo (keyed on this array's
  // reference) doesn't get defeated by a fresh `points` array on every
  // ResultsPanel render that isn't actually a new fetch result or day
  // selection.
  //
  // Rescaling to the user's chosen starting capital (issue #15) needs no
  // separate math here: derivePortfolioSeries is already a pure linear
  // scaling of whatever startingCapital it's handed (every point is that
  // value times a chain of price ratios), so simply passing
  // `startingCapital ?? <the precomputed one>` in produces an
  // already-correctly-rescaled series for free -- see
  // rescale-starting-capital.ts's own doc comment for why that's safe.
  //
  // Only ever populated for the "window"/"custom-window" models -- the
  // intraday-daily model's own chart uses wholeRangePoints below instead
  // (issue #91 removed the intraday-daily model's per-day chart
  // entirely, so there's nothing for this memo to compute there).
  const points = useMemo(() => {
    if (state.status !== "success") return [];
    const { data } = state;
    // "window" (5Y/MAX) and "custom-window" (issue #11's custom
    // start-date anchors) share the exact same whole-window portfolio
    // series derivation -- both are the same underlying model
    // (packages/core's optimizeAllVariants over a daily-close window,
    // issue #13), just keyed differently (range vs. anchorDate). See
    // WindowResultBody below for the same "shared rendering" reasoning
    // applied to the JSX, not just this derivation.
    if (data.model === "window" || data.model === "custom-window") {
      const variant = selectVariant<Trade>(data, data.longShort, mode);
      return derivePortfolioSeries(
        startingCapital ?? data.startingCapital,
        data.startDate,
        data.endDate,
        variant.trades,
      );
    }
    return [];
  }, [state, startingCapital, mode]);

  // The page's one remaining guess-then-reveal control (issue #91),
  // scoped to the whole range instead of any individual day -- see
  // use-range-guess.ts for why reading storage directly here (rather
  // than deferring to an effect) is safe. `mode` is threaded through as
  // part of the guess key (issue #13) -- the same range can carry a
  // genuinely different chained result depending on mode, exactly the
  // argument range-guess-storage.ts's own doc comment makes. Called
  // ahead of wholeRangePoints below (not just for readability) so that
  // memo can gate its own work on `rangeGuess`.
  const {
    guess: rangeGuess,
    guessStartingCapital: rangeGuessStartingCapital,
    submitGuess: submitRangeGuess,
  } = useRangeGuess(range, mode);

  // The intraday-daily model's own chart series (issue #91): every day in
  // the currently-viewed range chained into one continuous series, real
  // intraday spacing preserved within each day -- the whole-range
  // counterpart to `points` above, which only ever covers the window
  // model. Each day's trades are its own mode-selected variant (issue
  // #13), the same selectVariant call dayOverviewRows below makes per
  // day.
  //
  // **Gated on `rangeGuess !== null` (found in `high` code review,
  // fixed)**: `PortfolioChart` only ever renders this once the
  // whole-range guess is revealed (see the JSX below) -- computing the
  // full chained series (every trade across every day in the range, up
  // to ~252 days for 1Y) on *every* render regardless, including every
  // StartingCapitalInput keystroke before the user has even guessed,
  // was real wasted work for a chart that isn't mounted yet. The same
  // "recomputes on every render, not just an actual change" cost
  // dayOverviewRows' own doc comment above already documents fixing
  // once for an analogous case.
  const wholeRangePoints = useMemo(() => {
    if (state.status !== "success" || state.data.model !== "intraday-daily") return [];
    if (rangeGuess === null) return [];
    const { days } = state.data;
    return deriveWholeRangeIntradaySeries(
      startingCapital ?? state.data.startingCapital,
      days.map((day) => ({
        date: day.date,
        trades: selectVariant<IntradayTrade>(day, day.longShort, mode).trades,
      })),
    );
  }, [state, startingCapital, mode, rangeGuess]);

  // One row per trading day in the window (issue #80) -- feeds
  // DayOverview below, which is what makes the per-day breadth of this
  // range's result ("N independently-computed days, not just this one")
  // visible at a glance, not just whichever single day `activeDay`
  // happens to be. Both `tradeCount` and `endingBalance` are shown
  // unconditionally (issue #91 removed per-day guessing entirely -- the
  // only remaining guess-then-reveal gate on this page is
  // WholeRangeBalance's own, scoped to the whole range).
  //
  // **Memoized (found in `high` code review, fixed)**: a plain
  // computation inside the intraday-daily render branch below would
  // recompute on *every* ResultsPanel render, including every keystroke
  // in StartingCapitalInput. Hoisted to a top-level `useMemo`
  // (unconditional, per the Rules of Hooks -- the same reason
  // `activeDay`/`points` above are hooks too) so it only recomputes when
  // one of its real inputs actually changes.
  const dayOverviewRows = useMemo(() => {
    if (state.status !== "success" || state.data.model !== "intraday-daily") return [];
    if (!activeDay) return [];
    const { days } = state.data;
    const effectiveStartingCapital = startingCapital ?? activeDay.startingCapital;
    return days.map((day) => {
      const variant = selectVariant<IntradayTrade>(day, day.longShort, mode);
      // This day's own mode-selected track's own startingCapital --
      // NOT day.startingCapital unconditionally, which is only correct
      // under mode "long". Under "long-short", day.longShort now carries
      // its own chained startingCapital (issue #84) that can genuinely
      // differ from day.startingCapital's -- see
      // apps/web/CLAUDE.md's "Configurable starting capital" section.
      const variantStartingCapital =
        mode === "long" ? day.startingCapital : day.longShort.startingCapital;
      return {
        date: day.date,
        tradeCount: variant.trades.length,
        endingBalance: rescaleFromStartingCapital(
          variant.endingBalance,
          variantStartingCapital,
          effectiveStartingCapital,
        ),
      };
    });
  }, [state, activeDay, startingCapital, mode]);

  if (state.status === "loading") {
    return <LoadingSkeleton />;
  }

  if (state.status === "error") {
    const copy = errorCopy(state.error, state.message);
    return (
      <div
        role="alert"
        className="flex flex-col gap-2 rounded-lg border border-[var(--status-critical)]/30 bg-[var(--status-critical)]/5 px-5 py-4"
      >
        <p className="font-semibold text-[var(--status-critical)]">{copy.title}</p>
        <p className="text-sm text-[var(--text-secondary)]">{copy.body}</p>
      </div>
    );
  }

  const { data } = state;

  if (data.model === "intraday-daily") {
    if (range === null) {
      // Invariant violation, not a reachable product state: an
      // "intraday-daily" result only ever comes from useResults(range)
      // (see ResultsPage.tsx), which requires a non-null PresetRange --
      // there is no code path that fetches this model under custom-range
      // mode. Throwing surfaces a real bug loudly via this app's own
      // render-crash boundaries (app/error.tsx / app/global-error.tsx,
      // issue #46) instead of silently indexing RANGE_COPY[null].
      throw new Error("intraday-daily result rendered without an active preset range");
    }

    if (data.days.length === 0 || !activeDay) {
      return (
        <div className="surface-card rounded-lg border border-[var(--gridline)] bg-[var(--surface-1)] px-4 py-6 text-center text-sm text-[var(--text-secondary)]">
          No trading days are available yet for {RANGE_COPY[range]}.
        </div>
      );
    }

    // Which variant (long-only or long+short, issue #13) every dollar
    // figure/trade-list below reads -- see selectVariant's own doc
    // comment.
    const dayVariant = selectVariant<IntradayTrade>(activeDay, activeDay.longShort, mode);
    const isEmptyDay = dayVariant.trades.length === 0;
    const effectiveStartingCapital = startingCapital ?? activeDay.startingCapital;
    // This day's own mode-selected track's own startingCapital, and that
    // same track's own nested worst-case startingCapital (issue #84) --
    // NOT activeDay.startingCapital unconditionally, which is only the
    // correct "from" value under mode "long". Under "long-short",
    // activeDay.longShort (and its own nested worstCase) now carry their
    // own independently-chained startingCapital, which can genuinely
    // differ from activeDay.startingCapital's -- see
    // HeroAndWorstCaseProps' own worstCaseStartingCapital doc comment.
    const dayStartingCapital =
      mode === "long" ? activeDay.startingCapital : activeDay.longShort.startingCapital;
    const dayWorstCaseStartingCapital =
      mode === "long"
        ? activeDay.worstCase.startingCapital
        : activeDay.longShort.worstCase.startingCapital;

    // dayOverviewRows itself is computed once, unconditionally, above
    // (a top-level useMemo alongside activeDay/points -- see its own
    // comment there for why it's hoisted out of this branch and memoized).

    const finalDay = data.days.at(-1);
    // The range's true final chained balance for whichever track `mode`
    // currently selects, rescaled from the range's own root startingCapital
    // -- deliberately NOT the per-day rescale pattern (variant.endingBalance
    // paired with that *same day's own* startingCapital), which would
    // algebraically cancel the chaining back out and silently show the
    // "as if this day started fresh" figure instead of the real
    // carried-over one. See apps/web/CLAUDE.md's "rescaleFromStartingCapital's
    // per-day pattern silently cancels out..." section for the exact trap
    // this call deliberately avoids -- do not "simplify" this to reuse
    // that per-day pattern.
    const wholeRangeFinalBalance = finalDay
      ? rescaleFromStartingCapital(
          selectVariant<IntradayTrade>(finalDay, finalDay.longShort, mode).endingBalance,
          data.startingCapital,
          effectiveStartingCapital,
        )
      : 0;

    return (
      <FadeInWrapper>
        {/* This page's one guess-then-reveal control (issue #91), scoped
            to the whole range -- see WholeRangeBalance's own doc comment
            for why per-day guessing was removed entirely. Revealing it
            is also what unlocks BenchmarkStat and the whole-range chart
            below -- both would otherwise spoil the same answer. */}
        <WholeRangeBalance
          rangeLabel={RANGE_COPY[range]}
          startingCapital={effectiveStartingCapital}
          finalBalance={wholeRangeFinalBalance}
          guess={rangeGuess}
          guessStartingCapital={rangeGuessStartingCapital}
          onSubmitGuess={submitRangeGuess}
        />

        {rangeGuess !== null && (
          <>
            <p className="text-sm text-[var(--text-secondary)]">
              Every trading day&apos;s own best possible outcome, chained day to day across{" "}
              {RANGE_COPY[range]} -- up to {data.maxTradesPerDay} same-day all-in trades per day
              across the S&amp;P 500, using real 60-minute intraday prices. As of {data.dataAsOf}.
            </p>
            <BenchmarkStat
              benchmark={data.benchmark}
              startingCapital={data.startingCapital}
              displayStartingCapital={effectiveStartingCapital}
              rangeLabel={RANGE_COPY[range]}
            />
            {/* The whole-range chart (issue #91) -- spans every day in
                the currently-viewed range, chained continuously, rather
                than the single active day's own intraday movement this
                replaced. Keyed on range/dataAsOf/mode (not activeDay),
                since it no longer depends on which day is selected
                below -- switching days must not remount/replay this
                chart's own reveal animation. */}
            <PortfolioChart key={`${range}-${data.dataAsOf}-${mode}`} points={wholeRangePoints} />
          </>
        )}

        <DayOverview
          rows={dayOverviewRows}
          selected={activeDay.date}
          // Unlike DaySelector (removed by issue #80), DayOverview always
          // renders even when onSelectDay is omitted -- the whole point of
          // this component is making the range's per-day breadth visible
          // regardless of whether a caller wired up day-switching (in
          // practice, only tests that don't care about it omit this prop;
          // ResultsPage always provides a real handler). The no-op
          // fallback just means a click is inert in that case, not that
          // the list itself disappears.
          onSelect={onSelectDay ?? (() => {})}
          maxTradesPerDay={data.maxTradesPerDay}
        />

        {/* Announces which day/mode's content is now showing (issue #67,
            restored by issue #91 -- found in `high` code review). Before
            issue #91, this region only had something to announce at the
            one-time per-day guess-then-reveal moment; deleted along with
            that gate, but issue #91 also made switching days (via
            DayOverview) or modes (via ModeToggle) something that
            genuinely swaps HeroAndWorstCase's/the trade list's own
            content *unconditionally*, on every browse -- not just a
            one-time reveal -- so this needs to keep announcing that swap.
            Unlike the old per-day version, this one is unconditional (no
            `guess !== null` check) since there's no gate left to wait
            on -- always reflects whichever day/mode is currently showing. */}
        <div role="status" aria-live="polite" aria-label="Selected day status" className="sr-only">
          {`Showing results for ${formatDate(activeDay.date)} (${MODE_LABELS[mode].toLowerCase()}).`}
        </div>

        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-end justify-between gap-4">
            {/* Individual days are freely browsable, no guessing required
                (issue #91) -- HeroAndWorstCase always renders for
                whichever day is selected. `heroKey` is the active day's
                date plus mode (issue #13) so switching days (via
                DayOverview, issue #80) or modes (via ModeToggle) remounts
                HeroStat instead of just updating its props in place --
                useCountUp's reveal animation only fires on mount (see
                HeroStat's own doc comment), so without this key the
                visible figure would stay frozen at the previous
                day's/mode's animated value while the sr-only figure
                (driven directly by the prop) correctly updated, silently
                disagreeing with each other. Deliberately not keyed on
                startingCapital too (issue #15) -- a capital edit should
                rescale the figures instantly, not replay the reveal. */}
            <HeroAndWorstCase
              heroKey={`${activeDay.date}-${mode}`}
              startingCapital={dayStartingCapital}
              endingBalance={dayVariant.endingBalance}
              worstCaseEndingBalance={dayVariant.worstCase.endingBalance}
              worstCaseStartingCapital={dayWorstCaseStartingCapital}
              displayStartingCapital={effectiveStartingCapital}
            />
            <div className="flex flex-wrap items-end gap-4">
              {onStartingCapitalChange && (
                <StartingCapitalInput
                  value={effectiveStartingCapital}
                  onChange={onStartingCapitalChange}
                />
              )}
            </div>
          </div>
          <p className="text-sm text-[var(--text-secondary)]">
            Best possible outcome on {formatDate(activeDay.date)}, with at most{" "}
            {data.maxTradesPerDay} same-day all-in trades across the S&amp;P 500, using real
            60-minute intraday prices. As of {data.dataAsOf}.
          </p>
        </div>

        <div className="flex flex-col gap-3">
          <h2 className="text-lg font-semibold text-[var(--text-primary)]">Trades</h2>
          {isEmptyDay ? (
            <div className="surface-card rounded-lg border border-[var(--gridline)] bg-[var(--surface-1)] px-4 py-6 text-center text-sm text-[var(--text-secondary)]">
              No trade would have beaten holding cash on {formatDate(activeDay.date)}.
            </div>
          ) : (
            <IntradayTradeList trades={dayVariant.trades} />
          )}
        </div>
      </FadeInWrapper>
    );
  }

  if (data.model === "custom-window") {
    // Issue #11's coarsened custom-date-range feature (day-granularity
    // anchors since issue #75): the exact same whole-window model as
    // "window" below (see WindowResultBody's own doc comment), just
    // keyed by anchorDate instead of range -- so
    // rangeLabel/heroKey/emptyCopy are derived from the anchor's own
    // startDate rather than RANGE_COPY[range] (the `range` prop is a
    // harmless placeholder in this mode -- see ResultsPanelProps' own
    // doc comment). `mode` (issue #13) is threaded through and folded
    // into heroKey exactly like the "window" branch below -- a custom
    // anchor's long+short variant is just as real a different trade
    // sequence as a preset range's, not something this mode is out of
    // scope for.
    return (
      <WindowResultBody
        data={data}
        points={points}
        descriptionPhrase={`since ${formatDate(data.startDate)}`}
        heroKey={`custom-${data.anchorDate}-${data.dataAsOf}-${mode}`}
        emptyCopy={`No trade would have beaten holding cash since ${formatDate(data.startDate)}.`}
        mode={mode}
        startingCapital={startingCapital}
        onStartingCapitalChange={onStartingCapitalChange}
      />
    );
  }

  // The remaining case is "window" (5Y/MAX) -- TypeScript narrows `data`
  // to WindowResult here since every other PrecomputedResult |
  // CustomWindowResult member has already been handled by an earlier
  // return above.
  if (range === null) {
    // Same invariant as the "intraday-daily" branch above: a "window"
    // result only ever comes from useResults(range), never custom-range
    // mode -- see that branch's own comment for the full reasoning.
    throw new Error("window result rendered without an active preset range");
  }
  return (
    <WindowResultBody
      data={data}
      points={points}
      descriptionPhrase={`over ${RANGE_COPY[range]}`}
      // Keyed on range + dataAsOf + mode for the same reason the
      // intraday-daily branch above keys on activeDay.date + mode:
      // remount HeroStat (not just update its props) whenever the
      // underlying result actually changes, so useCountUp's reveal
      // animation fires fresh instead of leaving the visible figure
      // frozen at a stale animated value. Mode (issue #13) is keyed the
      // same as range/dataAsOf here, not treated like startingCapital
      // below -- switching to long+short surfaces a genuinely different
      // trade sequence, not an instant rescale of the same one. Today
      // this is also accidentally covered by useResults always passing
      // through a loading state between results (see use-results.ts),
      // which unmounts HeroStat itself -- but that's an implementation
      // detail of the current fetch state machine, not a guarantee; an
      // explicit key here doesn't depend on it holding. Deliberately not
      // keyed on startingCapital too (issue #15) -- see the
      // intraday-daily branch's identical comment above.
      heroKey={`${data.range}-${data.dataAsOf}-${mode}`}
      emptyCopy={`No trade would have beaten holding cash over ${RANGE_COPY[range]}.`}
      mode={mode}
      startingCapital={startingCapital}
      onStartingCapitalChange={onStartingCapitalChange}
    />
  );
}
