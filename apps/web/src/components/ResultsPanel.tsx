import type { PresetRange } from "@hadiknowntrades/core";

import type { ResultsState } from "@/lib/use-results";
import { derivePortfolioSeries } from "@/lib/portfolio-series";
import { HeroStat } from "@/components/HeroStat";
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
function errorCopy(error: string, apiMessage: string): { title: string; body: string } {
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
}

/** Switches on the fetch state to render loading / error / (empty or full) success -- see useResults for the state machine this drives off of. */
export function ResultsPanel({ range, state }: ResultsPanelProps) {
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
  const points = derivePortfolioSeries(
    data.startingCapital,
    data.startDate,
    data.endDate,
    data.trades,
  );
  const isEmpty = data.trades.length === 0;

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-2">
        <HeroStat startingCapital={data.startingCapital} endingBalance={data.endingBalance} />
        <p className="text-sm text-[var(--text-secondary)]">
          Best possible outcome over {RANGE_COPY[range]}, with at most 3 sequential all-in trades
          across the S&amp;P 500, using only closed (EOD) prices. As of {data.dataAsOf}.
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
