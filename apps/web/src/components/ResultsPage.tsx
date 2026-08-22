"use client";

import { useRouter, useSearchParams } from "next/navigation";

import type { PresetRange } from "@hadiknowntrades/core";

import { useResults } from "@/lib/use-results";
import { useStartingCapital } from "@/lib/use-starting-capital";
import { parseRange } from "@/lib/results-api";
import { DEFAULT_MODE, parseMode, type Mode } from "@/lib/mode";
import { AboutSection } from "@/components/AboutSection";
import { ModeToggle } from "@/components/ModeToggle";
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
  // Long-only vs. long+short (issue #13) -- URL state (?mode=), not a
  // localStorage preference (unlike use-starting-capital.ts): "which
  // trade set is being shown" is core, shareable content state, the same
  // category ?range=/?day= already occupy, not a personal display
  // preference. A missing/unrecognized param defaults to "long" (the
  // pre-#13 behavior), so an existing shared link with no mode param
  // keeps showing exactly what it shows today.
  const mode = parseMode(searchParams.get("mode")) ?? DEFAULT_MODE;
  // The user's chosen starting dollar amount (issue #15) -- a
  // page-level preference, not URL/range/day state: it should survive a
  // range or day switch (unlike selectedDay, which is deliberately
  // cleared on range change) since "how much money to start with" isn't
  // tied to which window of data is being viewed.
  const [startingCapital, setStartingCapital] = useStartingCapital();

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

  function selectMode(next: Mode) {
    const params = new URLSearchParams(searchParams);
    params.set("mode", next);
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
        <div className="flex flex-wrap items-center gap-3">
          <RangeSelector selected={range} onSelect={selectRange} />
          <ModeToggle selected={mode} onSelect={selectMode} />
        </div>
      </header>

      <ResultsPanel
        range={range}
        state={state}
        selectedDay={selectedDay}
        onSelectDay={selectDay}
        mode={mode}
        startingCapital={startingCapital}
        onStartingCapitalChange={setStartingCapital}
      />

      <AboutSection />
    </div>
  );
}
