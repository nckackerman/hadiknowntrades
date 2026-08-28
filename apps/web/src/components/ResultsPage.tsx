"use client";

import { useRouter, useSearchParams } from "next/navigation";

import { PRESET_RANGES, type AnchorDate, type PresetRange } from "@hadiknowntrades/core";

import { useResults } from "@/lib/use-results";
import { useCustomResults } from "@/lib/use-custom-results";
import { useCustomAnchors } from "@/lib/use-custom-anchors";
import { useStartingCapital } from "@/lib/use-starting-capital";
import { useDailyChallenge } from "@/lib/use-daily-challenge";
import { formatDate } from "@/lib/format-date";
import { parseAnchorDate, parseRange } from "@/lib/results-api";
import { headlineFigureFor } from "@/lib/headline-figure";
import { DEFAULT_MODE, parseMode, type Mode } from "@/lib/mode";
import { BeatTheBench } from "@/components/BeatTheBench";
import { CallBoard } from "@/components/CallBoard";
import { DailyHero } from "@/components/DailyHero";
import { DailyRitual } from "@/components/DailyRitual";
import { TheLineup, TheOrder } from "@/components/PlaceholderGameTile";
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

  // The header's own date chip (issue #187) -- reads only `.dailyChallenge?.date`
  // to show "YESTERDAY · AUG 27, 2026" next to the `<h1>`. `<header>` has
  // no access to `DailyHero`'s own fetched data (that component fetches
  // independently, by its own design -- see use-daily-challenge.ts's own
  // doc comment), so this is a third independent caller of the same
  // hook, resolving the same way this codebase already resolves the
  // identical problem for CallBoard.tsx's `useCallBoardCloses()`
  // (relying on the browser's own HTTP cache to make the second, and now
  // third, call cheap). Degrades to rendering nothing while loading or
  // on a fetch error -- see the header JSX below.
  const { dailyChallenge: headerDailyChallenge } = useDailyChallenge(mode);

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
      {/* Micro-header (issue #165, condensed further by issue #187): one
          wordmark plus a small date-chip pill next to it -- no
          RangeSelector/"More options" here any more, both demoted into
          "Explore other windows" below. The issue #165 tagline paragraph
          that used to sit under the `<h1>` (itself OnboardingIntro's
          former one-sentence banner, issue #64, folded in rather than
          kept as a second dismissible element) is gone -- replaced by
          the short footer note at the very bottom of the page, pointing
          at "Explore other windows" for the full methodology, so a
          first-time visitor still gets *some* pre-scroll framing rather
          than zero (see this issue's own Background section). The date
          chip reads "Yesterday · Aug 27, 2026" (styled uppercase via
          CSS, matching the design reference's "YESTERDAY · AUG 27,
          2026") -- headerDailyChallenge is `null` while loading or on a
          fetch error, so the chip simply doesn't render then rather than
          showing a broken/empty pill. */}
      <header className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-2">
        <h1 className="text-2xl font-semibold text-[var(--text-primary)]">Had I Known Trades</h1>
        {headerDailyChallenge !== null && (
          <span className="font-numeric shrink-0 rounded-full border border-[var(--gridline)] px-3 py-1 text-xs font-semibold tracking-wide whitespace-nowrap text-[var(--text-muted)] uppercase">
            Yesterday · {formatDate(headerDailyChallenge.date)}
          </span>
        )}
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

          **The Order / The Lineup (issue #197) fill out the same
          container's second row, after the two real tiles -- making this
          the full 2x2 grid the daily-hub-condensed mockup was originally
          sketched with, not a new grid of its own.** Both are
          non-functional "coming soon" placeholders (read issue #189 in
          full before touching either -- both games were designed, mocked,
          then explicitly parked pending a daily-selection-mechanism design
          pass neither this issue nor #197 attempts). They render
          unconditionally as the grid's 3rd/4th children, always after
          BeatTheBench/CallBoard: the sibling play-history-ordering issue
          in this milestone (#196) is scoped to reordering only the two
          real, playable tiles by their own play state -- these two have no
          play state to rank by, and stay pinned in place regardless of
          whatever order #196 puts the first two in.

          `has-[details[open]]:grid-cols-1` and
          `has-[[data-bench-expanded]]:grid-cols-1` collapse the grid to
          one column the instant either real tile expands into its full
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
          live rather than assumed. Neither real tile's own expanded
          content (CallBoard's 3-slot picker/history strip, BeatTheBench's
          playback controls) was ever designed to fit in a 50%-width
          column -- both already rendered full-width, stacked, before
          issue #178; the two `has-*` rules just keep that true once
          they're grid children too, instead of squeezing a fully
          expanded game into an unreadably narrow half-column. The Order/
          The Lineup have no expanded state of their own to worry about
          here -- when the grid collapses to one column (either real tile
          expanded), they simply stack full-width below it like any other
          grid child, which is harmless since neither is interactive.

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
        <TheOrder />
        <TheLineup />
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

      {/* Footer note (issue #187): the page's own last element, replacing
          the deleted tagline paragraph under the `<h1>` -- a deliberate,
          considered replacement (not a silent cut) so a first-time
          visitor still gets some pre-interaction framing, pointing at
          "Explore other windows" above for the full methodology/
          disclaimer rather than restating it here. */}
      <footer className="max-w-md self-center text-center text-xs text-[var(--text-muted)]">
        Hindsight only, from at most 3 trades across the S&amp;P 500 using closed daily prices --
        not a predictor. Full methodology inside &quot;Explore other windows.&quot;
      </footer>
    </div>
  );
}
