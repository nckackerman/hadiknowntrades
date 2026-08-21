"use client";

import { useRouter, useSearchParams } from "next/navigation";

import type { PresetRange } from "@hadiknowntrades/core";

import { useResults } from "@/lib/use-results";
import { parseRange } from "@/lib/results-api";
import { AboutSection } from "@/components/AboutSection";
import { RangeSelector } from "@/components/RangeSelector";
import { ResultsPanel } from "@/components/ResultsPanel";

const DEFAULT_RANGE: PresetRange = "1Y";

/**
 * Owns the selected range as URL state (?range=1Y, case-insensitive on
 * read) so a link to a specific range is shareable/bookmarkable, fetches
 * that range's results, and renders the loading/error/success states.
 */
export function ResultsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const range = parseRange(searchParams.get("range")) ?? DEFAULT_RANGE;
  const state = useResults(range);
  // Which day is selected for the intraday model (issue #28) -- null
  // means "none set," and ResultsPanel falls back to the most recent
  // day. Shareable/bookmarkable the same way ?range= already is.
  const selectedDay = searchParams.get("day");

  function selectRange(next: PresetRange) {
    const params = new URLSearchParams(searchParams);
    params.set("range", next);
    // A day selected under the previous range's data isn't meaningful
    // for a different range's day list -- drop it, falling back to that
    // range's own most recent day.
    params.delete("day");
    router.replace(`/?${params.toString()}`, { scroll: false });
  }

  function selectDay(next: string) {
    const params = new URLSearchParams(searchParams);
    params.set("day", next);
    router.replace(`/?${params.toString()}`, { scroll: false });
  }

  return (
    <div className="flex w-full max-w-3xl flex-col gap-8 px-6 py-16 sm:px-8">
      <header className="flex flex-col gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-[var(--text-primary)]">Had I Known Trades</h1>
          <p className="text-sm text-[var(--text-secondary)]">
            A hindsight toy, not investment advice: the best possible outcome from $20 with at most
            3 sequential trades, in hindsight.
          </p>
        </div>
        <RangeSelector selected={range} onSelect={selectRange} />
      </header>

      <ResultsPanel range={range} state={state} selectedDay={selectedDay} onSelectDay={selectDay} />

      <AboutSection />
    </div>
  );
}
