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
  deriveIntradayPortfolioSeries,
  derivePortfolioSeries,
  type PortfolioPoint,
} from "@/lib/portfolio-series";
import { getDailyGuess } from "@/lib/daily-guess-storage";
import { formatDate } from "@/lib/format-date";
import { formatHeroCurrency } from "@/lib/format-currency";
import { DEFAULT_MODE, MODE_LABELS, type Mode } from "@/lib/mode";
import { rescaleFromStartingCapital } from "@/lib/rescale-starting-capital";
import { useDailyGuess } from "@/lib/use-daily-guess";
import { useReducedMotionAtMount } from "@/lib/use-reduced-motion-at-mount";
import { BenchmarkStat } from "@/components/BenchmarkStat";
import { DailyGuessForm } from "@/components/DailyGuessForm";
import { DayOverview } from "@/components/DayOverview";
import { HeroStat } from "@/components/HeroStat";
import { IntradayTradeList } from "@/components/IntradayTradeList";
import { PortfolioChart } from "@/components/PortfolioChart";
import { StartingCapitalInput } from "@/components/StartingCapitalInput";
import { TradeList } from "@/components/TradeList";
import { WorstCaseStat } from "@/components/WorstCaseStat";

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

interface HeroAndWorstCaseProps {
  /**
   * Passed straight through as HeroStat's own `key` -- must change
   * whenever the underlying result changes (a newly-selected intraday
   * day, or a new range/dataAsOf for the window model) so useCountUp's
   * reveal animation remounts and fires fresh instead of leaving the
   * visible figure frozen at a stale animated value. See each call
   * site's own key expression for what identifies "changed" for that
   * model.
   */
  heroKey: string;
  startingCapital: number;
  endingBalance: number;
  worstCaseEndingBalance: number;
  /**
   * The user's chosen starting capital (issue #15) to display-rescale
   * both stats to -- defaults to `startingCapital` (a no-op ratio of 1)
   * at each call site, the same optional-in-spirit convention `HeroStat`
   * itself uses. Passed straight through to `HeroStat` as its own
   * `displayStartingCapital` prop (layered on top of, not fed into, its
   * count-up tween -- see that prop's own doc comment); `WorstCaseStat`
   * has no animation to protect, so it's simpler here: rescale
   * `worstCaseEndingBalance` directly via `rescaleFromStartingCapital`
   * and pass the rescaled pair straight in. The multiplier either
   * component derives (`endingBalance / startingCapital`) is unaffected
   * either way, since rescaling multiplies both sides by the same ratio.
   */
  displayStartingCapital: number;
}

/**
 * The HeroStat + WorstCaseStat pairing shared by both the intraday-daily
 * and window-model success branches below -- same wrapper layout, same
 * two stats side by side, differing only in which day's or range's
 * numbers feed them and what identifies "the result changed" for
 * `heroKey`.
 */
function HeroAndWorstCase({
  heroKey,
  startingCapital,
  endingBalance,
  worstCaseEndingBalance,
  displayStartingCapital,
}: HeroAndWorstCaseProps) {
  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:gap-8">
      <HeroStat
        key={heroKey}
        startingCapital={startingCapital}
        endingBalance={endingBalance}
        displayStartingCapital={displayStartingCapital}
      />
      <WorstCaseStat
        startingCapital={displayStartingCapital}
        endingBalance={rescaleFromStartingCapital(
          worstCaseEndingBalance,
          startingCapital,
          displayStartingCapital,
        )}
      />
    </div>
  );
}

/**
 * The fields WindowResultBody actually reads -- satisfied structurally by
 * both WindowResult (5Y/MAX) and CustomWindowResult (issue #11's custom
 * start-date anchors), which share this exact shape apart from their own
 * identifying field (`range` vs. `anchorMonth`). Neither `range` nor
 * `anchorMonth` is read here at all -- the caller derives its own
 * `rangeLabel`/`heroKey`/`emptyCopy` from whichever identifying field it
 * has, so this component never needs to know which one it got.
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
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <HeroAndWorstCase
            heroKey={heroKey}
            startingCapital={data.startingCapital}
            endingBalance={variant.endingBalance}
            worstCaseEndingBalance={variant.worstCase.endingBalance}
            displayStartingCapital={effectiveStartingCapital}
          />
          {onStartingCapitalChange && (
            <StartingCapitalInput
              value={effectiveStartingCapital}
              onChange={onStartingCapitalChange}
            />
          )}
        </div>
        <p className="text-sm text-[var(--text-secondary)]">
          Best possible outcome {descriptionPhrase}, with at most {data.maxTrades} sequential all-in
          trades across the S&amp;P 500, using only closed (EOD) prices. As of {data.dataAsOf}.
        </p>
        <BenchmarkStat
          benchmark={data.benchmark}
          startingCapital={data.startingCapital}
          displayStartingCapital={effectiveStartingCapital}
        />
      </div>

      <PortfolioChart points={points} />

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
   * result's own startingCapital already is, which keeps default
   * rendering (and every existing caller/test that doesn't pass this)
   * pixel-identical to before this prop existed. The input control
   * itself only renders when onStartingCapitalChange is provided, the
   * same optional-pair convention selectedDay/onSelectDay already uses.
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
  // separate math here: derivePortfolioSeries/deriveIntradayPortfolioSeries
  // are already pure linear scalings of whatever startingCapital they're
  // handed (every point is that value times a chain of price ratios), so
  // simply passing `startingCapital ?? <the precomputed one>` in produces
  // an already-correctly-rescaled series for free -- see
  // rescale-starting-capital.ts's own doc comment for why that's safe.
  const points = useMemo(() => {
    if (state.status !== "success") return [];
    const { data } = state;
    // "window" (5Y/MAX) and "custom-window" (issue #11's custom
    // start-date anchors) share the exact same whole-window portfolio
    // series derivation -- both are the same underlying model
    // (packages/core's optimizeAllVariants over a daily-close window,
    // issue #13), just keyed differently (range vs. anchorMonth). See
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
    if (!activeDay) return [];
    const variant = selectVariant<IntradayTrade>(activeDay, activeDay.longShort, mode);
    return deriveIntradayPortfolioSeries(
      startingCapital ?? activeDay.startingCapital,
      activeDay.date,
      variant.trades,
    );
  }, [state, activeDay, startingCapital, mode]);

  // Called unconditionally (Rules of Hooks) even when there's no active
  // intraday day yet -- an empty-string date is never actually read from
  // storage in that case, since the guess UI below only ever renders once
  // `activeDay` exists. See use-daily-guess.ts for why reading storage
  // directly here (rather than deferring to an effect) is safe. `mode` is
  // threaded through as part of the guess key (issue #13) -- the same
  // (range, date) pair can carry a genuinely different result depending on
  // mode, exactly the argument daily-guess-storage.ts's own doc comment
  // already makes for why `range` alone wasn't enough either.
  const { guess, guessStartingCapital, submitGuess } = useDailyGuess(
    range,
    activeDay?.date ?? "",
    mode,
  );

  // One row per trading day in the window (issue #80) -- feeds
  // DayOverview below, which is what makes the per-day breadth of this
  // range's result ("N independently-computed days, not just this one")
  // visible at a glance, not just whichever single day `activeDay`
  // happens to be. Trade count is read straight off each day's own
  // selected variant (unconditionally -- see DayOverview's own doc
  // comment for why that's never a guess-gate spoiler); endingBalance
  // stays `null` (a locked placeholder) unless a stored guess already
  // exists for that exact (range, date, mode) triple, the same
  // guess-then-reveal protection the single-day drill-down below already
  // gives its own `dayVariant.endingBalance`.
  //
  // **Memoized (found in `high` code review, fixed)**: this used to be a
  // plain computation inside the intraday-daily render branch below,
  // recomputed on *every* ResultsPanel render -- including every
  // keystroke in StartingCapitalInput, since each successfully-parsed
  // keystroke changes the `startingCapital` prop and re-renders this
  // whole panel. Each recompute does one `getDailyGuess` (a synchronous
  // `localStorage.getItem` + `JSON.parse`) per day, up to ~252 for 1Y --
  // real, needless work on every keystroke, not just on an actual
  // day/mode/guess change. Hoisted to a top-level `useMemo` (unconditional,
  // per the Rules of Hooks -- the same reason `activeDay`/`points` above
  // are hooks too, not plain computations inside the branch below) so it
  // only recomputes when one of its real inputs actually changes.
  //
  // **`guess` is a deliberate dependency even though it's never read
  // directly in the body below** -- each row re-derives its own guessed
  // status independently via `getDailyGuess`, so `guess` (the *active*
  // day's own guess, from `useDailyGuess` above) isn't itself part of the
  // computation. It's still required in the dependency array: submitting
  // a guess changes `guess` from `null` to a value without changing
  // `state`/`activeDay`/`startingCapital`/`mode`/`range`, and without
  // `guess` here, this memo would keep returning the stale pre-guess rows
  // array (the just-revealed day's row would keep showing "Guess to
  // reveal") until some unrelated dependency happened to change too.
  const dayOverviewRows = useMemo(() => {
    if (state.status !== "success" || state.data.model !== "intraday-daily") return [];
    if (!activeDay) return [];
    const { days } = state.data;
    const effectiveStartingCapital = startingCapital ?? activeDay.startingCapital;
    return days.map((day) => {
      const variant = selectVariant<IntradayTrade>(day, day.longShort, mode);
      const alreadyGuessed = range !== null && getDailyGuess(range, day.date, mode) !== null;
      return {
        date: day.date,
        tradeCount: variant.trades.length,
        endingBalance: alreadyGuessed
          ? rescaleFromStartingCapital(
              variant.endingBalance,
              day.startingCapital,
              effectiveStartingCapital,
            )
          : null,
      };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `guess` is intentionally listed despite not being read in the body above; see this hook's own doc comment for why it still has to be a dependency.
  }, [state, activeDay, startingCapital, mode, range, guess]);

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

    // dayOverviewRows itself is computed once, unconditionally, above
    // (a top-level useMemo alongside activeDay/points -- see its own
    // comment there for why it's hoisted out of this branch and memoized).

    return (
      <FadeInWrapper>
        <DayOverview
          rows={dayOverviewRows}
          selected={activeDay.date}
          // Unlike DaySelector (removed by this issue), DayOverview always
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

        {/* Announces the guess -> reveal swap below to screen reader users
            (issue #67) -- always present in the DOM (not conditionally
            mounted alongside the revealed content) so assistive tech has
            already registered this region before the swap happens, the
            same always-present-container pattern PortfolioChart's own
            aria-live tooltip readout uses. Deliberately a static "the
            reveal happened" sentence, not wired to HeroStat's per-frame
            count-up value -- see apps/web/CLAUDE.md's "Client-side
            animation" section on why that would spam assistive tech with
            every intermediate number.

            Includes mode (issue #13), not just the date (found in code
            review): the day's own content genuinely changes when
            switching between an already-guessed day's long-only and
            long+short variants (a different trade sequence, same as
            HeroStat's own heroKey treats a mode switch -- see that
            comment below), even though `guess` stays non-null across
            the switch and the date itself doesn't change -- without
            mode in the announcement text, that swap produced no DOM
            mutation for assistive tech to notice at all. */}
        <div role="status" aria-live="polite" className="sr-only">
          {guess !== null
            ? `Results revealed for ${formatDate(activeDay.date)} (${MODE_LABELS[mode].toLowerCase()}).`
            : ""}
        </div>
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-end justify-between gap-4">
            {guess === null ? (
              // Guess-then-reveal (issue #34): the actual result stays
              // hidden behind this prompt until the user guesses (or a
              // stored guess for this exact date is already found -- see
              // use-daily-guess.ts) -- at which point the branch below
              // mounts the real HeroStat for the first time, so its
              // existing count-up/celebration choreography fires right
              // at the moment of reveal instead of on page load. Prompted
              // against the user's chosen starting capital (issue #15),
              // not the raw per-day precomputed one, so the guess prompt
              // stays consistent with every other dollar figure on the
              // page (see effectiveStartingCapital above).
              <DailyGuessForm
                date={activeDay.date}
                startingCapital={effectiveStartingCapital}
                onSubmit={(value) => submitGuess(value, effectiveStartingCapital)}
              />
            ) : (
              // Gated behind the same guess-then-reveal condition as the
              // rest of this day's content (issue #34) -- showing
              // WorstCaseStat's worst-case figure before the guess is
              // submitted would partially spoil "the real answer" the
              // guessing game is built around. `heroKey` is the active
              // day's date plus mode (issue #13) so switching days (via
              // DayOverview, issue #80) or modes (via ModeToggle) remounts HeroStat
              // instead of just updating its props in place -- useCountUp's
              // reveal animation only fires on mount (see HeroStat's own
              // doc comment), so without this key the visible figure would
              // stay frozen at the previous day's/mode's animated value
              // while the sr-only figure (driven directly by the prop)
              // correctly updated, silently disagreeing with each other.
              // Deliberately not keyed on startingCapital too (issue #15)
              // -- a capital edit should rescale the figures instantly, not
              // replay the reveal/celebration.
              <HeroAndWorstCase
                heroKey={`${activeDay.date}-${mode}`}
                startingCapital={activeDay.startingCapital}
                endingBalance={dayVariant.endingBalance}
                worstCaseEndingBalance={dayVariant.worstCase.endingBalance}
                displayStartingCapital={effectiveStartingCapital}
              />
            )}
            <div className="flex flex-wrap items-end gap-4">
              {onStartingCapitalChange && (
                <StartingCapitalInput
                  value={effectiveStartingCapital}
                  onChange={onStartingCapitalChange}
                />
              )}
            </div>
          </div>
          {guess !== null && (
            <>
              <p className="text-sm text-[var(--text-secondary)]">
                Best possible outcome on {formatDate(activeDay.date)}, with at most{" "}
                {data.maxTradesPerDay} same-day all-in trades across the S&amp;P 500, using real
                60-minute intraday prices. As of {data.dataAsOf}.
              </p>
              {/* The benchmark is a whole-{range} figure (issue #12), not
                  scoped to the currently-selected day the way HeroStat/the
                  chart/trade list below are -- a real, deliberate
                  juxtaposition, spelled out in BenchmarkStat's own copy
                  ("over the full {range}") rather than left ambiguous. */}
              <BenchmarkStat
                benchmark={data.benchmark}
                startingCapital={data.startingCapital}
                displayStartingCapital={effectiveStartingCapital}
                rangeLabel={RANGE_COPY[range]}
              />
              <p className="text-sm text-[var(--text-muted)]">
                {/* guess/guessStartingCapital are the raw dollar amount the
                    user typed and whatever effectiveStartingCapital the
                    prompt was showing at that moment (see the
                    DailyGuessForm submission above and
                    use-daily-guess.ts's own doc comment) -- if the user
                    edits starting capital *after* revealing, that stored
                    pair goes stale relative to the now-current
                    effectiveStartingCapital driving HeroStat/the chart
                    below. Rescale it the same way every other dollar
                    figure on this page rescales (real bug, found in code
                    review: this used to render the raw stored guess
                    unrescaled, silently comparing against the wrong
                    baseline once starting capital changed post-reveal). */}
                You guessed{" "}
                {formatHeroCurrency(
                  rescaleFromStartingCapital(
                    guess,
                    guessStartingCapital ?? effectiveStartingCapital,
                    effectiveStartingCapital,
                  ),
                )}
                .
              </p>
            </>
          )}
        </div>

        {guess !== null && (
          <>
            <PortfolioChart points={points} />

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
          </>
        )}
      </FadeInWrapper>
    );
  }

  if (data.model === "custom-window") {
    // Issue #11's coarsened custom-date-range feature: the exact same
    // whole-window model as "window" below (see WindowResultBody's own
    // doc comment), just keyed by anchorMonth instead of range -- so
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
        heroKey={`custom-${data.anchorMonth}-${data.dataAsOf}-${mode}`}
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
