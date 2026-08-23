"use client";

import { useRouter, useSearchParams } from "next/navigation";

import type { AnchorDate, PresetRange } from "@hadiknowntrades/core";

import { useResults } from "@/lib/use-results";
import { useCustomResults } from "@/lib/use-custom-results";
import { useCustomAnchors } from "@/lib/use-custom-anchors";
import { useStartingCapital } from "@/lib/use-starting-capital";
import { parseAnchorDate, parseRange } from "@/lib/results-api";
import { DEFAULT_MODE, parseMode, type Mode } from "@/lib/mode";
import { AboutSection } from "@/components/AboutSection";
import { CustomRangeSelector } from "@/components/CustomRangeSelector";
import { ModeToggle } from "@/components/ModeToggle";
import { OnboardingIntro } from "@/components/OnboardingIntro";
import { RangeSelector } from "@/components/RangeSelector";
import { ResultsPanel } from "@/components/ResultsPanel";

const DEFAULT_RANGE: PresetRange = "1Y";

/**
 * Owns the selected range (?range=1Y, case-insensitive on read) or
 * custom start-date anchor (?anchor=YYYY-MM, issue #11) as URL state --
 * mutually exclusive view modes, not composable (see selectRange/
 * selectAnchor below) -- so a link to either is shareable/bookmarkable,
 * fetches whichever is active, and renders the loading/error/success
 * states.
 */
export function ResultsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();

  // Custom-range mode (issue #11, day-granularity anchors since issue
  // #75) wins when a well-formed ?anchor= is present; otherwise falls
  // back to the ordinary ?range= (or its own default). The two are
  // deliberately mutually exclusive -- see selectRange/selectAnchor,
  // which each clear the other on selection.
  const anchor: AnchorDate | null = parseAnchorDate(searchParams.get("anchor"));
  const range: PresetRange | null = anchor
    ? null
    : (parseRange(searchParams.get("range")) ?? DEFAULT_RANGE);

  // Exactly one of these two hooks is ever actually fetching at a time:
  // useResults(null) and useCustomResults(null) both idle without
  // firing a request (see each hook's own doc comment) for whichever
  // mode isn't currently active.
  const rangeState = useResults(range);
  const customState = useCustomResults(anchor);
  const state = anchor
    ? (customState ?? { status: "loading" as const })
    : (rangeState ?? { status: "loading" as const });

  // The published custom-range anchors manifest (issue #75) -- fetched
  // exactly **once** here and threaded down to both mounted
  // CustomRangeSelector instances as a prop (issue #63's own
  // desktop/mobile duplication, see the header JSX below), rather than
  // each instance calling useCustomAnchors() independently (a real bug,
  // found in code review, fixed): the old per-instance-fetch version
  // doubled the GET /api/custom-anchors request on every page load, and
  // risked visibly inconsistent UI if one request failed while the
  // other (a genuinely separate in-flight fetch) succeeded -- one
  // instance showing a working calendar, its sibling showing "Start-date
  // picker unavailable," on the same page. This is the same class of
  // "two mounted instances redo the same work independently" bug this
  // file's own CLAUDE.md already documents fixing once before for the
  // old month-scheme picker's purely local `customRangeAnchors(new
  // Date())` computation (a `useMemo` fix, issue #63) -- but a `useMemo`
  // *inside* the component can't fix this one, since the duplicated work
  // here is a real network fetch, not a pure computation two mounted
  // instances could each memoize away on their own.
  const anchorsState = useCustomAnchors();

  // Which day is selected for the intraday model (issue #28) -- null
  // means "none set," and ResultsPanel falls back to the most recent
  // day. Shareable/bookmarkable the same way ?range= already is. Not
  // meaningful in custom-range mode (that model is never intraday-daily)
  // but harmless to keep passing through.
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
    // A custom anchor is a mutually-exclusive alternate view mode, not
    // composable with a preset range -- clear it on selecting a range.
    params.delete("anchor");
    // A day selected under the previous range's data isn't meaningful
    // for a different range's day list -- drop it, falling back to that
    // range's own most recent day.
    params.delete("day");
    router.replace(`/?${params.toString()}`, { scroll: false });
  }

  function selectAnchor(next: AnchorDate) {
    const params = new URLSearchParams(searchParams);
    params.set("anchor", next);
    // Mutually exclusive with a preset range -- see selectRange's
    // identical reasoning in the other direction.
    params.delete("range");
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
      <OnboardingIntro />

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
          {/* Below 640px, RangeSelector alone already fills most of the
              row's width, so CustomRangeSelector and ModeToggle used to
              each wrap onto their own near-full-width line -- confirmed
              via a real screenshot (apps/web/CLAUDE.md's "Mobile layout
              pass" section, issue #63) to push the actual result (chart,
              trade list) below the fold on a real phone viewport. Fixed
              by collapsing this group behind a "More options" disclosure
              on narrow viewports only, matching the collapsed-by-default
              pattern PortfolioChart.tsx's own "View chart data as a
              table" disclosure already establishes.

              This renders CustomRangeSelector/ModeToggle **twice** --
              once here (visible at sm and up, hidden below it) and once
              inside the <details> below (visible only below sm) --
              rather than one shared instance toggled by CSS alone. A
              single-instance version (a <details> forced open via CSS at
              sm and up, overriding its native "closed hides content"
              behavior) was tried first and reverted: a real, live-
              verified Chromium bug (not a hypothetical) fails to paint
              (and fails hit-testing on) a closed <details>'s content even
              when every computed style says it should render -- see
              apps/web/CLAUDE.md's "Mobile layout pass" section for the
              full repro. Two real controlled-component instances with
              identical props/handlers, gated by plain `hidden`/`sm:`
              utilities (the ordinary, well-supported responsive-nav
              duplication pattern), sidesteps that bug entirely -- neither
              instance's own state or behavior can drift from the other
              since both are driven by the same `anchor`/`mode` props and
              `selectAnchor`/`selectMode` handlers. */}
          <div
            data-testid="controls-more-desktop"
            className="hidden flex-wrap items-center gap-3 sm:flex"
          >
            <span className="text-sm text-[var(--text-muted)]">or</span>
            <CustomRangeSelector
              selected={anchor}
              onSelect={selectAnchor}
              anchorsState={anchorsState}
            />
            <ModeToggle selected={mode} onSelect={selectMode} />
          </div>
        </div>
        <details className="sm:hidden">
          <summary className="cursor-pointer text-sm text-[var(--text-secondary)]">
            More options
          </summary>
          <div
            data-testid="controls-more-mobile"
            className="mt-3 flex flex-wrap items-center gap-3"
          >
            <span className="text-sm text-[var(--text-muted)]">or</span>
            <CustomRangeSelector
              selected={anchor}
              onSelect={selectAnchor}
              anchorsState={anchorsState}
            />
            <ModeToggle selected={mode} onSelect={selectMode} />
          </div>
        </details>
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
