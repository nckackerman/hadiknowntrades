import { useMemo } from "react";

import type { PresetRange } from "@hadiknowntrades/core";

import type { ClientErrorCode, ResultsState } from "@/lib/use-results";
import { deriveIntradayPortfolioSeries, derivePortfolioSeries } from "@/lib/portfolio-series";
import { formatDate } from "@/lib/format-date";
import { DaySelector } from "@/components/DaySelector";
import { HeroStat } from "@/components/HeroStat";
import { IntradayTradeList } from "@/components/IntradayTradeList";
import { PortfolioChart } from "@/components/PortfolioChart";
import { TradeList } from "@/components/TradeList";

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

interface ResultsPanelProps {
  range: PresetRange;
  state: ResultsState;
  /** The day currently selected in the URL for the intraday model (issue #28), or null if none is set (or the range/data is window-model) -- ResultsPanel falls back to the most recent day in that case. */
  selectedDay?: string | null;
  /** Called when the user picks a different day from the DaySelector. Required whenever the data can be intraday-model; omit only where a caller (e.g. a window-only test) never needs it. */
  onSelectDay?: (day: string) => void;
}

/** Switches on the fetch state to render loading / error / (empty or full) success -- see useResults for the state machine this drives off of. Success further switches on the result's `model` (issue #28): the original whole-window model, or the per-day intraday model. */
export function ResultsPanel({ range, state, selectedDay = null, onSelectDay }: ResultsPanelProps) {
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
  const points = useMemo(() => {
    if (state.status !== "success") return [];
    const { data } = state;
    if (data.model === "window") {
      return derivePortfolioSeries(data.startingCapital, data.startDate, data.endDate, data.trades);
    }
    if (!activeDay) return [];
    return deriveIntradayPortfolioSeries(
      activeDay.startingCapital,
      activeDay.date,
      activeDay.trades,
    );
  }, [state, activeDay]);

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

    return (
      <div className="flex flex-col gap-8">
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <HeroStat
              // Keyed on the active day so switching days (via
              // DaySelector) remounts HeroStat instead of just updating
              // its props in place -- useCountUp's reveal animation only
              // fires on mount (see HeroStat's own doc comment), so
              // without this key the visible figure would stay frozen
              // at the previous day's animated value while the sr-only
              // figure (driven directly by the prop) correctly updated,
              // silently disagreeing with each other.
              key={activeDay.date}
              startingCapital={activeDay.startingCapital}
              endingBalance={activeDay.endingBalance}
            />
            {onSelectDay && (
              <DaySelector
                days={data.days.map((d) => d.date)}
                selected={activeDay.date}
                onSelect={onSelectDay}
              />
            )}
          </div>
          <p className="text-sm text-[var(--text-secondary)]">
            Best possible outcome on {formatDate(activeDay.date)}, with at most{" "}
            {data.maxTradesPerDay} same-day all-in trades across the S&amp;P 500, using real
            60-minute intraday prices. As of {data.dataAsOf}.
          </p>
        </div>

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
      </div>
    );
  }

  const isEmpty = data.trades.length === 0;

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-2">
        <HeroStat startingCapital={data.startingCapital} endingBalance={data.endingBalance} />
        <p className="text-sm text-[var(--text-secondary)]">
          Best possible outcome over {RANGE_COPY[range]}, with at most {data.maxTrades} sequential
          all-in trades across the S&amp;P 500, using only closed (EOD) prices. As of{" "}
          {data.dataAsOf}.
        </p>
      </div>

      <PortfolioChart points={points} />

      <div className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold text-[var(--text-primary)]">Trades</h2>
        {isEmpty ? (
          <div className="rounded-lg border border-[var(--gridline)] bg-[var(--surface-1)] px-4 py-6 text-center text-sm text-[var(--text-secondary)]">
            No trade would have beaten holding cash over {RANGE_COPY[range]}.
          </div>
        ) : (
          <TradeList trades={data.trades} />
        )}
      </div>
    </div>
  );
}
