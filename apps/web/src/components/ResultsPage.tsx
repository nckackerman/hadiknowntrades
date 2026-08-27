"use client";

import { useRouter, useSearchParams } from "next/navigation";

import type { AnchorDate, PresetRange } from "@hadiknowntrades/core";

import { useResults } from "@/lib/use-results";
import { useCustomResults } from "@/lib/use-custom-results";
import { useCustomAnchors } from "@/lib/use-custom-anchors";
import { useStartingCapital } from "@/lib/use-starting-capital";
import { parseAnchorDate, parseRange } from "@/lib/results-api";
import { headlineFigureFor } from "@/lib/headline-figure";
import { DEFAULT_MODE, parseMode, type Mode } from "@/lib/mode";
import { BeatTheBench } from "@/components/BeatTheBench";
import { CallBoard } from "@/components/CallBoard";
import { DailyRitual } from "@/components/DailyRitual";
import { CustomRangeSelector } from "@/components/CustomRangeSelector";
import { ModeToggle } from "@/components/ModeToggle";
import { OnboardingIntro } from "@/components/OnboardingIntro";
import { RangeSelector } from "@/components/RangeSelector";
import { ResultsPanel } from "@/components/ResultsPanel";

const DEFAULT_RANGE: PresetRange = "1W";

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
  // exactly **once** here and threaded down to CustomRangeSelector as a
  // prop, rather than that component calling useCustomAnchors() itself.
  // This matters even now that CustomRangeSelector is mounted only once
  // (issue #103 collapsed the old desktop/mobile duplication -- see this
  // file's own CLAUDE.md), since ResultsPage owning the fetch keeps the
  // component itself a plain prop-driven consumer with no fetch/loading
  // logic of its own to duplicate if a future change ever needed a
  // second mount point. This is the same class of "don't let two mounted
  // instances redo the same work independently" lesson this file's own
  // CLAUDE.md already documents once before for the old month-scheme
  // picker's purely local `customRangeAnchors(new Date())` computation
  // (a `useMemo` fix, issue #63).
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

  // The one figure the active view headlines (issue #133) -- the window
  // model's HeroStat figure for 5Y/Max/a custom anchor, the whole-range
  // chained balance for the intraday-daily ranges. Computed here, once,
  // from the same helper ResultsPanel itself uses, and handed to the daily
  // ritual's recap so the two can't disagree about the day's number. `null`
  // until the fetch succeeds; the recap simply omits the line rather than
  // stubbing it (see buildRecapText).
  const headline =
    state.status === "success" ? headlineFigureFor(state.data, range, mode, startingCapital) : null;

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
        <h1 className="text-2xl font-semibold text-[var(--text-primary)]">Had I Known Trades</h1>
        <RangeSelector selected={range} onSelect={selectRange} />
        {/* CustomRangeSelector and ModeToggle collapse behind this one
            "More options" disclosure at every viewport width (issue
            #103), not just below 640px -- so the only always-visible
            control in the header, at any screen size, is RangeSelector
            itself. This used to be two real rendered instances (one
            `hidden sm:flex` div always visible at desktop widths, one
            inside a `sm:hidden` <details> for narrow viewports -- see
            git history / apps/web/CLAUDE.md's "Mobile layout pass"
            section for the full issue #63 story, including a real,
            live-verified Chromium bug that ruled out a single instance
            forced open via CSS at desktop widths back then). That
            forced-open trick is no longer needed at all: neither
            breakpoint wants an always-expanded state any more, both want
            the same native closed-by-default/opens-on-click behavior, so
            there's nothing left to force open via CSS and no reason to
            keep two copies in sync -- one plain, always-rendered
            <details> collapses this group identically at every width. */}
        <details>
          <summary className="cursor-pointer text-sm text-[var(--text-secondary)]">
            More options
          </summary>
          <div data-testid="controls-more" className="mt-3 flex flex-wrap items-center gap-3">
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

      {/* Beat the Bench (issue #131) then The Call Board (issue #129),
          both *sections*, both mounted here as direct siblings of
          ResultsPanel rather than inside one of its model branches --
          issue #122's standing decision, see apps/web/CLAUDE.md's "Page
          structure" section, including this exact order. Two reasons it
          matters: ResultsPanel renders nothing but a skeleton or an error
          box until /api/results succeeds, and the daily ritual shouldn't
          disappear when that fetch is slow or failing; and "inside" would
          mean duplicating each mount into both WindowResultBody and the
          intraday-daily branch, i.e. two state owners to keep in sync.
          Neither takes any props at all -- neither is a function of the
          hindsight result. Issue #133 may later move them into
          ResultsPanel's `afterHero` slot; that changes where they render,
          not who owns them. */}
      <BeatTheBench />
      <CallBoard />

      {/* The Daily Ritual (issue #133): the "today, so far" rail plus the
          shareable recap, the capstone on the two mechanics directly above
          it -- so the locked copy's "Play Beat the Bench above" is
          literally true, and the recap sits at the end of the day's run
          rather than interrupting it. Mounted at this level for exactly the
          reasons the two mechanics are (issue #122): it reads state those
          two own, and it must not vanish when /api/results is slow or
          failing. It takes the headline figure the page is already
          rendering rather than a result to re-derive one from -- see
          lib/headline-figure.ts, which ResultsPanel computes its own
          whole-range figure through too. */}
      <DailyRitual range={range} mode={mode} headline={headline} />
    </div>
  );
}
