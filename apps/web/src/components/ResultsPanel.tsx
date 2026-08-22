import { useMemo } from "react";

import type { PresetRange } from "@hadiknowntrades/core";

import type { ClientErrorCode, ResultsState } from "@/lib/use-results";
import { deriveIntradayPortfolioSeries, derivePortfolioSeries } from "@/lib/portfolio-series";
import { formatDate } from "@/lib/format-date";
import { formatHeroCurrency } from "@/lib/format-currency";
import { rescaleFromStartingCapital } from "@/lib/rescale-starting-capital";
import { useDailyGuess } from "@/lib/use-daily-guess";
import { BenchmarkStat } from "@/components/BenchmarkStat";
import { DailyGuessForm } from "@/components/DailyGuessForm";
import { DaySelector } from "@/components/DaySelector";
import { HeroStat } from "@/components/HeroStat";
import { IntradayTradeList } from "@/components/IntradayTradeList";
import { PortfolioChart } from "@/components/PortfolioChart";
import { StartingCapitalInput } from "@/components/StartingCapitalInput";
import { TradeList } from "@/components/TradeList";
import { WorstCaseStat } from "@/components/WorstCaseStat";

const RANGE_COPY: Record<PresetRange, string> = {
  "1M": "the past month",
  "3M": "the past 3 months",
  "1Y": "the past year",
  "5Y": "the past 5 years",
  MAX: "all available history",
};

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

interface ResultsPanelProps {
  range: PresetRange;
  state: ResultsState;
  /** The day currently selected in the URL for the intraday model (issue #28), or null if none is set (or the range/data is window-model) -- ResultsPanel falls back to the most recent day in that case. */
  selectedDay?: string | null;
  /** Called when the user picks a different day from the DaySelector. Required whenever the data can be intraday-model; omit only where a caller (e.g. a window-only test) never needs it. */
  onSelectDay?: (day: string) => void;
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
    if (data.model === "window") {
      return derivePortfolioSeries(
        startingCapital ?? data.startingCapital,
        data.startDate,
        data.endDate,
        data.trades,
      );
    }
    if (!activeDay) return [];
    return deriveIntradayPortfolioSeries(
      startingCapital ?? activeDay.startingCapital,
      activeDay.date,
      activeDay.trades,
    );
  }, [state, activeDay, startingCapital]);

  // Called unconditionally (Rules of Hooks) even when there's no active
  // intraday day yet -- an empty-string date is never actually read from
  // storage in that case, since the guess UI below only ever renders once
  // `activeDay` exists. See use-daily-guess.ts for why reading storage
  // directly here (rather than deferring to an effect) is safe.
  const { guess, guessStartingCapital, submitGuess } = useDailyGuess(range, activeDay?.date ?? "");

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
    if (data.days.length === 0 || !activeDay) {
      return (
        <div className="rounded-lg border border-[var(--gridline)] bg-[var(--surface-1)] px-4 py-6 text-center text-sm text-[var(--text-secondary)]">
          No trading days are available yet for {RANGE_COPY[range]}.
        </div>
      );
    }

    const isEmptyDay = activeDay.trades.length === 0;
    const effectiveStartingCapital = startingCapital ?? activeDay.startingCapital;

    return (
      <div className="flex flex-col gap-8">
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
              // day's date so switching days (via DaySelector) remounts
              // HeroStat instead of just updating its props in place --
              // useCountUp's reveal animation only fires on mount (see
              // HeroStat's own doc comment), so without this key the
              // visible figure would stay frozen at the previous day's
              // animated value while the sr-only figure (driven directly
              // by the prop) correctly updated, silently disagreeing with
              // each other. Deliberately not keyed on startingCapital too
              // (issue #15) -- a capital edit should rescale the figures
              // instantly, not replay the reveal/celebration.
              <HeroAndWorstCase
                heroKey={activeDay.date}
                startingCapital={activeDay.startingCapital}
                endingBalance={activeDay.endingBalance}
                worstCaseEndingBalance={activeDay.worstCase.endingBalance}
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
              {onSelectDay && (
                <DaySelector
                  days={data.days.map((d) => d.date)}
                  selected={activeDay.date}
                  onSelect={onSelectDay}
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
                <div className="rounded-lg border border-[var(--gridline)] bg-[var(--surface-1)] px-4 py-6 text-center text-sm text-[var(--text-secondary)]">
                  No trade would have beaten holding cash on {formatDate(activeDay.date)}.
                </div>
              ) : (
                <IntradayTradeList trades={activeDay.trades} />
              )}
            </div>
          </>
        )}
      </div>
    );
  }

  const isEmpty = data.trades.length === 0;
  const effectiveStartingCapital = startingCapital ?? data.startingCapital;

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <HeroAndWorstCase
            // Keyed on range + dataAsOf for the same reason the
            // intraday-daily branch above keys on activeDay.date: remount
            // HeroStat (not just update its props) whenever the underlying
            // result actually changes, so useCountUp's reveal animation
            // fires fresh instead of leaving the visible figure frozen at a
            // stale animated value. Today this is also accidentally covered
            // by useResults always passing through a loading state between
            // results (see use-results.ts), which unmounts HeroStat itself
            // -- but that's an implementation detail of the current fetch
            // state machine, not a guarantee; an explicit key here doesn't
            // depend on it holding. Deliberately not keyed on
            // startingCapital too (issue #15) -- see the intraday-daily
            // branch's identical comment above.
            heroKey={`${data.range}-${data.dataAsOf}`}
            startingCapital={data.startingCapital}
            endingBalance={data.endingBalance}
            worstCaseEndingBalance={data.worstCase.endingBalance}
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
          Best possible outcome over {RANGE_COPY[range]}, with at most {data.maxTrades} sequential
          all-in trades across the S&amp;P 500, using only closed (EOD) prices. As of{" "}
          {data.dataAsOf}.
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
          <div className="rounded-lg border border-[var(--gridline)] bg-[var(--surface-1)] px-4 py-6 text-center text-sm text-[var(--text-secondary)]">
            No trade would have beaten holding cash over {RANGE_COPY[range]}.
          </div>
        ) : (
          <TradeList trades={data.trades} startingCapital={effectiveStartingCapital} />
        )}
      </div>
    </div>
  );
}
