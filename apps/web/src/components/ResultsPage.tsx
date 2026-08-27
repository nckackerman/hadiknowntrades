"use client";

import { useRouter, useSearchParams } from "next/navigation";

import { PRESET_RANGES, type AnchorDate, type PresetRange } from "@hadiknowntrades/core";

import { useResults } from "@/lib/use-results";
import { useCustomResults } from "@/lib/use-custom-results";
import { useCustomAnchors } from "@/lib/use-custom-anchors";
import { useStartingCapital } from "@/lib/use-starting-capital";
import { parseAnchorDate, parseRange } from "@/lib/results-api";
import { headlineFigureFor } from "@/lib/headline-figure";
import { DEFAULT_MODE, parseMode, type Mode } from "@/lib/mode";
import { BeatTheBench } from "@/components/BeatTheBench";
import { CallBoard } from "@/components/CallBoard";
import { DailyHero } from "@/components/DailyHero";
import { DailyRitual } from "@/components/DailyRitual";
import { CustomRangeSelector } from "@/components/CustomRangeSelector";
import { ModeToggle } from "@/components/ModeToggle";
import { RangeSelector } from "@/components/RangeSelector";
import { ResultsPanel } from "@/components/ResultsPanel";

const DEFAULT_RANGE: PresetRange = "1W";

/**
 * "1W · 1M · 3M · 1Y · 5Y · Max" -- the demoted "Explore other windows"
 * section's own closed-summary subtitle (issue #165, matching the
 * mockup's `<span class="explorer-sub">` copy). Derived from
 * PRESET_RANGES rather than a second hardcoded list of range labels, so
 * this can't silently drift from the pills RangeSelector itself renders
 * inside that same section.
 */
const EXPLORER_RANGE_SUMMARY = PRESET_RANGES.map((preset) =>
  preset === "MAX" ? "Max" : preset,
).join(" · ");

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
      {/* Micro-header (issue #165): one wordmark, one caption line -- no
          RangeSelector/"More options" here any more, both demoted into
          "Explore other windows" below. The caption folds in
          OnboardingIntro's former one-sentence banner (issue #64) rather
          than keeping that as a second, separate always-visible/
          dismissible element above the header; OnboardingIntro.tsx and
          its own storage module (lib/onboarding-storage.ts,
          lib/use-onboarding-dismissed.ts) are deleted outright, not left
          in place unused -- nothing else in the app referenced any of
          the three beyond their own doc comments/tests, confirmed via a
          repo-wide grep before deleting. */}
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold text-[var(--text-primary)]">Had I Known Trades</h1>
        <p className="text-sm text-[var(--text-secondary)]">
          This is a hindsight toy: starting from $20, it finds the best possible outcome from at
          most 3 trades across the whole S&amp;P 500, using only closed daily prices -- not a
          predictor of what happens next.
        </p>
      </header>

      {/* The daily hero (issue #161): the previous market day's own
          "had you known" result, leading with a direct statement rather
          than the 1W range view's guess-then-reveal gate -- the page's
          top-of-page content. Mounted above the range explorer (not
          inside it, and not inside ResultsPanel) so it renders
          regardless of how the range explorer's own /api/results?range=1W
          fetch goes -- the same "a section, not a branch inside
          ResultsPanel" reasoning issue #122 already established for
          BeatTheBench/CallBoard below. */}
      <DailyHero mode={mode} />

      {/* Beat the Bench (issue #131; collapsed-by-default "Can you do
          better?" card since issue #163) and The Call Board (issue
          #129/#164) render as a 2-up grid (issue #178), matching the
          mockup's own `.game-row` (`docs/design/gamified-hero-2026-08/
          mockup-gamified-hero.html`) -- two bold NYT-Games-style tiles
          (issues #176/#177) side by side, directly below the daily hero,
          rather than two full-width stacked siblings. Still per issue
          #122's standing "section, not a route/branch inside
          ResultsPanel" decision -- neither takes PrecomputedResult/range/
          mode/selectedDay props, and both render regardless of how
          /api/results goes, same reasoning DailyHero above relies on.

          `has-[details[open]]:grid-cols-1` and
          `has-[[data-bench-expanded]]:grid-cols-1` collapse the grid to
          one column the instant either tile expands into its full real
          game/board -- CallBoard's own expanded state is a native
          `<details open>`, detectable directly via `:has()`; BeatTheBench
          has no native disclosure element to key off (its "expanded"
          flag is a plain useState, issue #163), so its own
          `BeatTheBenchFrame` wrapper carries a `data-bench-expanded`
          marker attribute for the identical purpose. Two independent
          `has-*` variants rather than one comma-joined selector,
          deliberately -- this app has already been bitten once by
          Tailwind's own bracket-value class-name parsing choking on an
          unexpected character inside `[...]` (see BeatTheBench.tsx's own
          doc comment on why its amber gradient is an inline `style`, not
          a bracket class), so two simple single-selector variants were
          chosen over one compound selector as the safer bet, verified
          live rather than assumed. Neither tile's own expanded content
          (CallBoard's 3-slot picker/history strip, BeatTheBench's
          playback controls) was ever designed to fit in a 50%-width
          column -- both already rendered full-width, stacked, before
          this issue; the two `has-*` rules just keep that true once
          they're grid children too, instead of squeezing a fully
          expanded game into an unreadably narrow half-column.

          `game-row-grid` is a plain marker class (no styling of its
          own) so `globals.css` can target this exact container with a
          `@supports not selector(:has(a))` fallback rule -- a browser
          with no `:has()` support at all would otherwise never match
          either `has-*` rule above and could keep the grid at two
          columns forever, permanently squeezing an expanded game into
          an unreadably narrow half-column with no error or console
          signal. See that rule's own doc comment for the full
          reasoning. */}
      <div className="game-row-grid grid grid-cols-2 gap-4 has-[[data-bench-expanded]]:grid-cols-1 has-[details[open]]:grid-cols-1">
        <BeatTheBench />
        <CallBoard />
      </div>

      {/* The Daily Ritual (issue #133): the "today, so far" rail plus the
          shareable recap, the capstone on the daily hero + two mechanics
          directly above it -- so the locked copy's "Play Beat the Bench
          above" is literally true, and the recap sits at the end of the
          day's run rather than interrupting it. Repositioned here, ahead
          of the demoted range explorer below, by issue #165 -- a
          mount-order change only, no functional change to DailyRitual.tsx
          itself (that issue's own Background section is explicit about
          this). Mounted at this level for exactly the reasons the two
          mechanics are (issue #122): it reads state those two own, and it
          must not vanish when /api/results is slow or failing. It takes
          the headline figure the page is already rendering rather than a
          result to re-derive one from -- see lib/headline-figure.ts,
          which ResultsPanel computes its own whole-range figure through
          too. */}
      <DailyRitual range={range} mode={mode} headline={headline} />

      {/* "Explore other windows" (issue #165): the entire pre-existing
          1W/1M/3M/1Y/5Y/Max range-explorer experience -- RangeSelector,
          the "More options" disclosure (CustomRangeSelector/ModeToggle),
          and ResultsPanel itself (including its own nested AboutSection
          disclaimer/methodology disclosure, per result view) -- demoted
          into one collapsed <details> at the bottom of the page, below
          DailyRitual. Everything inside moves unchanged (this issue's own
          Out of scope: no change to ResultsPanel's internal model
          branching, WholeRangeReplay/TradeReplay, DayOverview,
          CustomRangeSelector, ModeToggle, or BenchmarkStat) -- same
          range/anchor/mode/day URL state, same guess-then-reveal gate,
          same window-model chart. This <details> only changes whether
          that whole experience shares the landing screen with the daily
          game, not anything about how it behaves once expanded. */}
      <details className="surface-card rounded-lg border border-[var(--gridline)] bg-[var(--surface-1)]">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-4">
          <span className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <span className="font-display text-base font-semibold text-[var(--text-primary)]">
              Explore other windows
            </span>
            <span className="text-sm text-[var(--text-muted)]">{EXPLORER_RANGE_SUMMARY}</span>
          </span>
          <span aria-hidden="true" className="shrink-0 text-xs text-[var(--text-muted)]">
            ▸ expand
          </span>
        </summary>

        <div className="flex flex-col gap-6 px-4 pb-5">
          <div className="flex flex-col gap-4">
            <RangeSelector selected={range} onSelect={selectRange} />
            {/* CustomRangeSelector and ModeToggle collapse behind this one
                "More options" disclosure at every viewport width (issue
                #103), not just below 640px -- so the only always-visible
                control here is RangeSelector itself. This used to be two
                real rendered instances (one `hidden sm:flex` div always
                visible at desktop widths, one inside a `sm:hidden`
                <details> for narrow viewports -- see git history /
                apps/web/CLAUDE.md's "Mobile layout pass" section for the
                full issue #63 story, including a real, live-verified
                Chromium bug that ruled out a single instance forced open
                via CSS at desktop widths back then). That forced-open
                trick is no longer needed at all: neither breakpoint wants
                an always-expanded state any more, both want the same
                native closed-by-default/opens-on-click behavior, so
                there's nothing left to force open via CSS and no reason
                to keep two copies in sync -- one plain, always-rendered
                <details> collapses this group identically at every
                width. */}
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
          </div>

          <ResultsPanel
            range={range}
            state={state}
            selectedDay={selectedDay}
            onSelectDay={selectDay}
            mode={mode}
            startingCapital={startingCapital}
            onStartingCapitalChange={setStartingCapital}
          />
        </div>
      </details>
    </div>
  );
}
