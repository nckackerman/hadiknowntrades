"use client";

import { useRouter, useSearchParams } from "next/navigation";

import { PRESET_RANGES, type PresetRange } from "@hadiknowntrades/core";

import { useResults } from "@/lib/use-results";
import { RangeSelector } from "@/components/RangeSelector";
import { ResultsPanel } from "@/components/ResultsPanel";

const DEFAULT_RANGE: PresetRange = "1Y";

function parseRangeParam(raw: string | null): PresetRange {
  if (!raw) return DEFAULT_RANGE;
  const upper = raw.toUpperCase();
  return (PRESET_RANGES as readonly string[]).includes(upper)
    ? (upper as PresetRange)
    : DEFAULT_RANGE;
}

/**
 * Owns the selected range as URL state (?range=1Y, case-insensitive on
 * read) so a link to a specific range is shareable/bookmarkable, fetches
 * that range's results, and renders the loading/error/success states.
 */
export function ResultsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const range = parseRangeParam(searchParams.get("range"));
  const state = useResults(range);

  function selectRange(next: PresetRange) {
    const params = new URLSearchParams(searchParams);
    params.set("range", next);
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

      <ResultsPanel range={range} state={state} />
    </div>
  );
}
