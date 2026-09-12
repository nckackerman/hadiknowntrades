"use client";

// The Cut (issue #233): guess how many of the real-weight-ranked S&P 500
// companies (held cap-weighted, #1..N) would have maximized hindsight
// profit over a chosen window -- see docs/design/the-cut-2026-09/README.md
// for the full mechanic this plays. Same grid position/tile pattern every
// other daily-hub game already establishes (issue #122's standing
// decision, GamePanelHeader/CallBoard.tsx's connector devices) -- this
// component takes no PrecomputedResult/range/mode/selectedDay props of
// its own; it owns its own range state instead (see below), independent
// of the outer page's ?range=.
//
// **Not a daily-rotating puzzle** (docs/design/the-cut-2026-09/README.md's
// own "Naming and scope" section rules that out for v1) -- a player can
// pick any of the 7 CUT_RANGES entries (the 6 shared PresetRange windows
// plus The Cut's own real 1-day window, "1D" -- issue #238, and the
// default range on load since that issue) and play (or replay) it at any
// time. The pure grading logic lives in the-cut-scoring.ts, the persisted
// per-range game state + streak history in the-cut-storage.ts, and the
// two are wired together for React in use-cut-game.ts -- this file is
// the one place either gets called from a component.
//
// **The main, always-visible game is 1D only -- every other range moved
// behind a nested "Explore other windows" disclosure (a direct user
// request, not a filed issue).** Two independent changes, both to this
// game's own presentation only (no pipeline/algorithm/schema change):
//
//   1. The default reveal (`CutReveal`'s `revealVariant="slide"` below)
//      replaces `TheCutChart` with `CutRevealStrip` -- an animated
//      continuation of the pre-guess `TickerStrip` (same rank+ticker chip
//      language) that slides to center on the real cut line and marks
//      every held company (#1..bestN) distinctly from every excluded
//      one, landing with a small bounce+glow flourish
//      (`globals.css`'s own `cut-line-settle`/`cut-line-glow`). The
//      existing `CelebrationBurst` confetti (issue #239) is untouched --
//      both variants gate and fire it identically.
//   2. `CutGamePanel`/`CutExploreOtherWindows`/`CutExplorePanel` below
//      split the single always-all-7-ranges game this file used to be
//      into a fixed-range main game (no visible picker at all,
//      `THE_CUT_DEFAULT_RANGE`) plus a nested `<details>` holding the
//      other six ranges' own picker and their own guess-then-reveal game
//      -- naming precedent: issue #165's own "Explore other windows"
//      section on the main results page (a distinct, new disclosure
//      local to The Cut, not the same DOM element). That sub-section
//      reuses the exact same `CutBoard` mechanic (not a lighter
//      read-only curve browser) and keeps `revealVariant="chart"` --
//      exploring the full historical curve across a much larger window
//      is a reasonable place for that chart to live, now that the main
//      game's own reveal has moved to the new slide animation. See
//      `CutExplorePanel`'s own doc comment for why it's lazily mounted.

import { memo, useEffect, useId, useMemo, useRef, useState } from "react";

import {
  CUT_RANGES,
  SP500_CONSTITUENTS,
  type CutRange,
  type Sp500PrefixCurvePoint,
  type Sp500PrefixResult,
} from "@hadiknowntrades/core";

import { formatHeroCurrency, formatMultiplier } from "@/lib/format-currency";
import { prefersReducedMotion } from "@/lib/prefers-reduced-motion";
import { shouldCelebrate } from "@/lib/should-celebrate";
import {
  CUT_MAX_ATTEMPTS,
  cutCelebrationIntensity,
  isValidSp500PrefixResult,
  meetsCutCelebrationGate,
  n500CurvePoint,
  type CutCloseness,
  type CutDirection,
  type CutGuessFeedback,
} from "@/lib/the-cut-scoring";
import type { CutStreakStats } from "@/lib/the-cut-storage";
import { useCountUp } from "@/lib/use-count-up";
import { useCutGame, type CutView } from "@/lib/use-cut-game";
import { useReducedMotionAtMount } from "@/lib/use-reduced-motion-at-mount";
import { useResetWhenChanged } from "@/lib/use-reset-when-changed";
import { useSp500Prefix } from "@/lib/use-sp500-prefix";
import { AnimatedFigure } from "@/components/AnimatedFigure";
import { CelebrationBurst } from "@/components/CelebrationBurst";
import { CutRangeSelector } from "@/components/CutRangeSelector";
import { GamePanelHeader } from "@/components/GamePanelHeader";
import { heroMultiplierColor } from "@/components/HeroStat";
import { TheCutChart } from "@/components/TheCutChart";

const ICON = "✂️";
const TITLE = "The Cut";
const SUBTITLE = "How many of the market's biggest names should you have held?";

/**
 * A green gradient distinct from every other daily-hub tile's own
 * accent (amber/Beat the Bench, blue/CallBoard, purple/The Order, teal/
 * The Lineup) -- "the cut" of the market's top slice. Every stop's
 * white-text contrast independently computed via the WCAG relative-
 * luminance formula and verified >= 4.5:1 AA before being committed
 * (5.01:1 / 6.12:1 / 8.52:1), matching this app's own established bar
 * for every other tile gradient (see e.g. PlaceholderGameTile.tsx's own
 * history, or CallBoard.tsx's issue #177 recolor).
 */
const TILE_GRADIENT_STYLE = {
  backgroundImage: "linear-gradient(155deg, #257e55 0%, #206f4a 55%, #19573a 100%)",
};
const TILE_SHADOW_CLASSNAME =
  "shadow-[0_8px_22px_rgba(32,111,74,0.35),0_6px_18px_rgba(0,0,0,0.35)]";
/** The gradient's own darkest stop -- the expanded panel's connector accent (matching CallBoard.tsx's/TheOrder.tsx's identical CONNECTOR_ACCENT device, issue #195). */
const CONNECTOR_ACCENT = "#19573a";

const CARD_BASE_CLASSNAME = "min-h-28 rounded-2xl text-white";

/**
 * Exported so ResultsPage.test.tsx (which asserts on the exact set of
 * `range=` fetches the whole page issues) can name this fetch without
 * hardcoding "1D" a second time.
 *
 * **"1D" (issue #238), not "1Y"** -- The Cut now defaults to a real
 * 1-day window on load, computed from real EOD data (the nightly
 * pipeline's own backward-resolved previous-trading-day boundary, see
 * apps/pipeline/src/pipeline.ts's buildSp500PrefixResults), rather than
 * requiring a player to pick it manually every time.
 */
export const THE_CUT_DEFAULT_RANGE: CutRange = "1D";

/**
 * Every CUT_RANGES entry except "1D" -- the main game's own fixed range,
 * hidden from the default play experience by this change. Rendered
 * inside "Explore other windows" (`CutExplorePanel` below), in the same
 * order CUT_RANGES already establishes.
 */
const EXPLORE_RANGES: readonly CutRange[] = CUT_RANGES.filter((range) => range !== "1D");
const EXPLORE_DEFAULT_RANGE: CutRange = EXPLORE_RANGES[0]!;

/**
 * `CutBoardProps.accessibleNameSuffix`'s real value for the Explore
 * panel's own game -- a module constant (not a literal at the one call
 * site) so it can never drift from the disclosure's own visible label
 * ("Explore other windows").
 */
const EXPLORE_ACCESSIBLE_NAME_SUFFIX = "Explore other windows";

/** Ranked #1..#universeSize by real S&P weight, descending -- the exact ordering apps/pipeline's own buildSp500PrefixResults ranks against (packages/core/CLAUDE.md's "The Cut" section), computed once at module scope since SP500_CONSTITUENTS is a static, versioned snapshot (see that file's own header comment). */
const RANKED_TICKERS = [...SP500_CONSTITUENTS].sort((a, b) => b.weight - a.weight);

/**
 * WCAG-1.4.1-compliant glyph system for the directional half of each
 * guess's feedback -- a glyph and visible label, never color alone, the
 * same convention TheOrder.tsx's own OUTCOME_STYLES already establishes.
 *
 * Labels say "held"/"hold", not "higher"/"lower" (a direct user request,
 * not a filed issue -- see apps/web/CLAUDE.md's "The Cut" section for the
 * dated writeup of the alternatives considered): N is a *count* of
 * companies to hold, not a price level, so "guess higher"/"guess lower"
 * read like a stock-price-direction hint rather than "hold more/fewer of
 * the 500." Mirrors this component's own already-established "held"/
 * "hold" vocabulary (`SUBTITLE` above, and the in-progress instruction
 * copy's "Holding companies #1..N").
 */
const DIRECTION_STYLES: Record<CutDirection, { glyph: string; label: string }> = {
  "too-high": { glyph: "▼", label: "Too many held -- hold fewer" },
  "too-low": { glyph: "▲", label: "Too few held -- hold more" },
};

/** The four named closeness bands (docs/design/the-cut-2026-09/README.md's own "ice cold"/"cold"/"warm"/"hot" wording), each with its own visible label -- never color alone. */
const CLOSENESS_STYLES: Record<CutCloseness, { label: string; className: string }> = {
  hot: { label: "Hot", className: "bg-[var(--accent-selection)] text-white" },
  warm: {
    label: "Warm",
    className: "border border-[var(--accent-selection)] text-[var(--accent-selection)]",
  },
  cold: {
    label: "Cold",
    className: "border border-[var(--text-secondary)] text-[var(--text-secondary)]",
  },
  "ice-cold": {
    label: "Ice cold",
    className: "border border-[var(--text-muted)] text-[var(--text-muted)]",
  },
};

interface TileSummaryProps {
  headingId: string;
  statusLine: string;
}

/** Shared between the pre-hydration placeholder and the real `<summary>`, mirroring TheOrder.tsx's own TileSummaryRow so the two can never drift in size. */
function TileSummaryRow({ headingId, statusLine }: TileSummaryProps) {
  return (
    <span className="relative flex flex-col justify-between gap-4 p-5">
      <span className="flex flex-col gap-2">
        <span
          aria-hidden="true"
          className="flex h-11 w-11 items-center justify-center rounded-full bg-white/[0.16]"
        >
          <span className="text-3xl leading-none drop-shadow-[0_2px_4px_rgba(0,0,0,0.25)]">
            {ICON}
          </span>
        </span>
        <span className="flex flex-col gap-1">
          <span
            id={headingId}
            className="font-display text-lg leading-tight font-extrabold tracking-tight"
          >
            {TITLE}
          </span>
          <span className="text-xs font-medium text-white/85">{SUBTITLE}</span>
        </span>
      </span>
      <span className="flex items-center justify-between gap-2">
        <span className="font-numeric rounded-full bg-white/20 px-2.5 py-1 text-[0.6875rem] font-bold">
          {statusLine}
        </span>
        <span aria-hidden="true" className="shrink-0 text-xs font-semibold text-white/70">
          ▸
        </span>
      </span>
    </span>
  );
}

/** Pre-hydration/pre-fetch placeholder, mirroring TheOrder.tsx's own OrderPlaceholder -- a plain `<div>`, not `<details>`/`<summary>`, so there's no focusable/toggleable element before there's anything real to show. */
function CutPlaceholder() {
  return (
    <div
      aria-hidden="true"
      style={TILE_GRADIENT_STYLE}
      className={`${CARD_BASE_CLASSNAME} ${TILE_SHADOW_CLASSNAME}`}
    >
      <TileSummaryRow headingId="the-cut-placeholder-heading" statusLine=" " />
    </div>
  );
}

/** A real fetch failure -- mirroring TheOrder.tsx's own OrderErrorState. */
function CutErrorState() {
  return (
    <div
      data-testid="the-cut-error"
      style={TILE_GRADIENT_STYLE}
      className={`${CARD_BASE_CLASSNAME} ${TILE_SHADOW_CLASSNAME} flex flex-col gap-2 p-5`}
    >
      <div className="flex items-center gap-3">
        <span
          aria-hidden="true"
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-white/[0.16]"
        >
          <span className="text-3xl leading-none drop-shadow-[0_2px_4px_rgba(0,0,0,0.25)]">
            {ICON}
          </span>
        </span>
        <span className="font-display text-lg leading-tight font-extrabold tracking-tight">
          {TITLE}
        </span>
      </div>
      <p className="text-xs font-medium text-white/85">
        Couldn&apos;t load The Cut for this range. It&apos;s published by the nightly run -- try a
        different range, or reload in a bit.
      </p>
    </div>
  );
}

function tileStatusLine(view: CutView, fetchFailed: boolean): string {
  if (!view.hydrated || view.state === null) return fetchFailed ? "Couldn't load" : "Loading…";
  if (!view.state.done) return `Attempt ${view.state.guesses.length + 1} of ${CUT_MAX_ATTEMPTS}`;
  return view.state.won ? "Solved" : "Revealed";
}

interface TickerStripProps {
  universeSize: number;
  activeRank: number;
}

/**
 * Pre-guess info (docs/design/the-cut-2026-09/README.md's own
 * "Interaction" section): a horizontally-scrollable strip of rank +
 * ticker symbol only -- no company names or logos, this app has never
 * shown logos anywhere -- that auto-scrolls to keep `activeRank` (the
 * live, not-yet-submitted slider value) in view.
 */
function TickerStrip({ universeSize, activeRank }: TickerStripProps) {
  const activeRef = useRef<HTMLLIElement | null>(null);

  useEffect(() => {
    const el = activeRef.current;
    if (!el || typeof el.scrollIntoView !== "function") return;
    el.scrollIntoView({
      inline: "center",
      block: "nearest",
      behavior: prefersReducedMotion() ? "auto" : "smooth",
    });
  }, [activeRank]);

  return (
    <ol
      aria-label="S&P 500 companies ranked by real index weight"
      className="flex gap-1.5 overflow-x-auto rounded-lg bg-[var(--surface-2)] p-2"
    >
      {RANKED_TICKERS.slice(0, universeSize).map((ticker, index) => {
        const rank = index + 1;
        const isActive = rank === activeRank;
        return (
          <li
            key={ticker.symbol}
            ref={isActive ? activeRef : undefined}
            aria-current={isActive}
            className={`flex shrink-0 flex-col items-center gap-0.5 rounded-md px-2 py-1 text-center ${
              isActive
                ? "bg-[var(--accent-selection)] text-white"
                : "bg-[var(--surface-1)] text-[var(--text-secondary)]"
            }`}
          >
            <span className="font-numeric text-[0.625rem] leading-none opacity-80">#{rank}</span>
            <span className="font-numeric text-xs leading-none font-semibold">{ticker.symbol}</span>
          </li>
        );
      })}
    </ol>
  );
}

interface CutBoardProps {
  range: CutRange;
  view: CutView;
  universeSize: number;
  startingCapital: number;
  bestN: number | null;
  bestEndingBalance: number | null;
  n500EndingBalance: number | null;
  curve: Sp500PrefixCurvePoint[];
  /** Which reveal this game's own `CutReveal` renders once done -- see this file's own top-of-file comment for the full "why here, not there" reasoning. */
  revealVariant: CutRevealVariant;
  /**
   * Disambiguates this board's own guess controls' accessible names from
   * any other `CutBoard` instance that might be mounted simultaneously
   * -- a real code-review-found bug: the main game (fixed "1D") and
   * "Explore other windows" (its own independent game, any other range)
   * can both be on screen, not-yet-done, at once, and their guess
   * `<input>`/"Submit guess" `<button>` used to share the exact same
   * accessible name ("Your guess, as a number" / "Submit guess") --
   * ambiguous for a screen-reader user's own forms/buttons list, and
   * literally unresolvable by any `getByRole` query that isn't scoped to
   * one panel's own subtree. `null` for the main game (keeps its
   * existing, un-suffixed accessible name unchanged, matching every
   * pre-existing test's own query); a real string ("Explore other
   * windows") for the Explore panel's own instance.
   */
  accessibleNameSuffix: string | null;
  onSubmit: (guess: number) => void;
  onPlayAgain: () => void;
}

/**
 * `"slide"`: the new animated ticker-strip reveal (`CutRevealStrip`),
 * used by the main, always-visible 1D game. `"chart"`: the original
 * `TheCutChart` reveal, kept for "Explore other windows" -- see this
 * file's own top-of-file comment.
 */
type CutRevealVariant = "slide" | "chart";

interface CutRevealProps {
  bestN: number;
  bestEndingBalance: number;
  n500EndingBalance: number;
  startingCapital: number;
  universeSize: number;
  curve: Sp500PrefixCurvePoint[];
  revealVariant: CutRevealVariant;
  won: boolean;
  /** Computed once by CutBoard (which also feeds it to its own always-rendered sr-only status region) and passed down rather than re-derived here -- see this component's own "Deliberately NOT a second role=status region" comment below for why. */
  resultSentence: string;
  lastFeedback: CutGuessFeedback;
  streak: CutStreakStats;
  onPlayAgain: () => void;
}

interface CutRevealStripProps {
  universeSize: number;
  bestN: number;
  guessedN: number;
}

/** How long the "slide" (a real `scrollIntoView({behavior: "smooth"})` call, the exact mechanism `TickerStrip` above already uses to keep the live guess in view) takes to settle on the cut line, before the bounce+glow flourish fires. No browser API reports when a smooth scroll actually finishes, so this is a fixed delay tuned to comfortably outlast a typical short smooth-scroll -- the same "pick a duration, don't try to observe completion" call `WholeRangeReplay.tsx`'s own chunk pacing already makes elsewhere in this app. */
const SLIDE_SETTLE_MS = 650;

/**
 * The main game's own default reveal (a direct user request, not a
 * filed issue) -- an animated continuation of `TickerStrip` above,
 * rather than a second, unrelated visual: the exact same rank+ticker
 * chip language, auto-scrolled ("slid") to center on the real cut line
 * (`bestN`), landing with a small bounce+glow flourish
 * (`globals.css`'s own `cut-line-settle`/`cut-line-glow`). Companies
 * #1..bestN render as held (full brightness); the rest render dimmed --
 * that abrupt style change *is* the "held vs not held" divider, plus an
 * explicit small "✂️ CUT" chip inserted at the boundary itself, which is
 * also the element the slide scrolls to and the one that bounces/glows
 * once settled.
 *
 * **Purely decorative, matching `TheCutChart`'s own established
 * accessibility shape**: the whole strip is `aria-hidden`, with a plain
 * `sr-only` paragraph stating the same facts in words -- nothing here is
 * new information a screen-reader user doesn't already get from
 * `CutReveal`'s own visible result sentence and stat row just above it.
 *
 * **Reduced motion**: no slide, no delay -- `settled` starts (and stays)
 * `true` on the very first render, so the cut-line chip's own bounce+glow
 * classes are present immediately and the divider never has to be
 * scrolled into view at all (it renders wherever it naturally falls in
 * the strip). `useReducedMotionAtMount`'s own precondition (only safe
 * from a component that never renders during SSR) holds here for the
 * identical reason `CutReveal`'s own doc comment already establishes for
 * this whole subtree: this component only ever mounts once a real guess
 * has been submitted, which cannot happen before hydration.
 *
 * **`memo`'d (code-review finding)**: `CutReveal`'s own four
 * `useCountUp` tweens re-render it on every one of the dozens of RAF
 * ticks their ~1.2s reveal drives, and this component's own props
 * (`universeSize`/`bestN`/`guessedN`, all primitives) never change
 * across that whole reveal -- without `memo`, every one of those ticks
 * would needlessly re-run this component's own `RANKED_TICKERS.slice(...).flatMap(...)`
 * and re-create up to ~500 `<li>` elements, the same class of hot-path
 * waste this codebase's own `PortfolioChart`/`TradeEventTimeline`
 * `React.memo` fixes already exist to avoid elsewhere (see this file's
 * own "Trade replay"/"Window-model result: a trade-event timeline..."
 * sections). Default shallow comparison is sufficient here since every
 * prop is a plain number.
 */
const CutRevealStrip = memo(function CutRevealStrip({
  universeSize,
  bestN,
  guessedN,
}: CutRevealStripProps) {
  const cutLineRef = useRef<HTMLLIElement | null>(null);
  const reducedMotionAtMount = useReducedMotionAtMount();
  const [settled, setSettled] = useState(reducedMotionAtMount);

  useEffect(() => {
    if (reducedMotionAtMount) return; // already rendered in its final, settled state -- nothing to slide
    const el = cutLineRef.current;
    if (el && typeof el.scrollIntoView === "function") {
      el.scrollIntoView({ inline: "center", block: "nearest", behavior: "smooth" });
    }
    const timeoutId = window.setTimeout(() => setSettled(true), SLIDE_SETTLE_MS);
    return () => window.clearTimeout(timeoutId);
  }, [reducedMotionAtMount]);

  const chips = RANKED_TICKERS.slice(0, universeSize).flatMap((ticker, index) => {
    const rank = index + 1;
    const held = rank <= bestN;
    const isGuess = rank === guessedN;
    const chip = (
      <li
        key={ticker.symbol}
        data-testid="cut-reveal-chip"
        data-held={held}
        data-guess={isGuess}
        className={`flex shrink-0 flex-col items-center gap-0.5 rounded-md px-2 py-1 text-center ${
          held
            ? "bg-[var(--surface-1)] text-[var(--text-primary)]"
            : "bg-[var(--surface-2)] text-[var(--text-muted)] opacity-35"
        } ${isGuess ? "ring-2 ring-[var(--accent-selection)]" : ""}`}
      >
        <span className="font-numeric text-[0.625rem] leading-none opacity-80">#{rank}</span>
        <span className="font-numeric text-xs leading-none font-semibold">{ticker.symbol}</span>
        {isGuess && (
          <span
            aria-hidden="true"
            className="text-[0.5rem] font-bold text-[var(--accent-selection)]"
          >
            YOU
          </span>
        )}
      </li>
    );
    if (rank !== bestN) return [chip];
    // The cut-line divider itself: always rendered right after the last
    // held company, always visibly marked (a gold border), but the
    // bounce+glow classes only apply once `settled` -- so it reads as
    // "this is where the strip is sliding to" first, then "this is the
    // answer, and it just landed" once the slide actually lands.
    return [
      chip,
      <li
        key="cut-line"
        ref={cutLineRef}
        data-testid="cut-reveal-cutline"
        aria-hidden="true"
        className={`flex shrink-0 flex-col items-center justify-center gap-0.5 rounded-md border border-[var(--accent-reward)] px-1.5 text-[var(--accent-reward)] ${
          settled ? "cut-line-glow cut-line-settle" : ""
        }`}
      >
        <span className="text-sm leading-none">✂️</span>
        <span className="text-[0.5rem] font-bold leading-none">CUT</span>
      </li>,
    ];
  });

  return (
    <div data-testid="cut-reveal-strip" className="flex flex-col gap-2">
      <ol
        aria-hidden="true"
        className="flex gap-1.5 overflow-x-auto rounded-lg bg-[var(--surface-2)] p-2"
      >
        {chips}
      </ol>
      <p className="sr-only">
        The best cut held companies #1 through #{bestN} by real S&amp;P 500 weight.{" "}
        {bestN < universeSize
          ? `The rest, #${bestN + 1} through #${universeSize}, would not have been held.`
          : "Every company in the universe would have been held."}{" "}
        Your final guess was N={guessedN}.
      </p>
    </div>
  );
});

// Long enough to read as a deliberate count rather than a flicker, short
// enough not to make people wait for the numbers they came for -- the
// same duration HeroStat.tsx's own count-up reveal uses (issue #35).
const COUNT_UP_DURATION_MS = 1200;

/**
 * The Cut's reveal panel (issue #239) -- wires HeroStat.tsx's own
 * count-up/celebration-burst toolkit into this game's own reveal moment,
 * rather than reinventing it: the score, the streak figures, and the
 * best-possible-result figures all count up via `use-count-up.ts`, and a
 * celebration burst fires (`CelebrationBurst`/`shouldCelebrate.ts`) when
 * the result is genuinely good, scaled to how good it was
 * (`the-cut-scoring.ts`'s own `cutCelebrationIntensity`/
 * `meetsCutCelebrationGate` -- see that module's own doc comment for the
 * full gating decision and why it isn't a literal copy of HeroStat's own
 * dollar-gain-based gate).
 *
 * **A dedicated component, not inline JSX inside CutBoard's own
 * conditional render** -- the same reason HeroStat is its own component:
 * `useCountUp`/`shouldCelebrate` are hooks, so they can only be called
 * from a component that's unconditionally mounted, not from inside an
 * `if`/`&&` branch of an already-mounted one. This also happens to be
 * exactly what makes the reveal replay correctly on its own, with no
 * explicit `key` needed: `state.done` can only ever transition
 * `false -> true` (a fresh completion) or `true -> false` (Play again,
 * via `the-cut-storage.ts`'s `clearCutGameState`) -- never stay `true`
 * with different feedback underneath it -- so `CutBoard`'s own
 * `{done && lastFeedback && <CutReveal ... />}` conditional already mounts
 * a genuinely new `CutReveal` instance exactly once per completed game,
 * the identical "mount lines up with reveal" property HeroStat.tsx's own
 * doc comment relies on `ResultsPanel` remounting it fresh per result.
 *
 * Reuses `AnimatedFigure` (issue #147) for the best-possible dollar
 * figure specifically -- unlike the score/streak figures (plain integers
 * with no compact-unit ladder to cross), a dollar amount can jump from
 * e.g. "$994.72" to "$1K" mid-tween, which would otherwise re-wrap this
 * prose sentence's own width mid-count the same way issue #147 found and
 * fixed for HeroStat's row.
 */
function CutReveal({
  bestN,
  bestEndingBalance,
  n500EndingBalance,
  startingCapital,
  universeSize,
  curve,
  revealVariant,
  won,
  resultSentence,
  lastFeedback,
  streak,
  onPlayAgain,
}: CutRevealProps) {
  const animatedScorePct = useCountUp(0, lastFeedback.edgeCapturedPct, COUNT_UP_DURATION_MS);
  const animatedBestEndingBalance = useCountUp(
    startingCapital,
    bestEndingBalance,
    COUNT_UP_DURATION_MS,
  );
  const animatedCurrentStreak = useCountUp(0, streak.currentStreak, COUNT_UP_DURATION_MS);
  const animatedBestStreak = useCountUp(0, streak.bestStreak, COUNT_UP_DURATION_MS);

  // `settled` compares the score tween against its own exact final
  // value -- safe because useCountUp always snaps to the exact `to` once
  // its tween lands (see that hook's own doc comment), the identical
  // property HeroStat.tsx's own `settled` relies on. The *score* (not
  // the dollar figure) is what gates the celebration burst, since
  // `edgeCapturedPct` is the one signal driving both the gate and the
  // intensity ladder -- see the-cut-scoring.ts's own doc comment.
  const settled = animatedScorePct === lastFeedback.edgeCapturedPct;
  // The gate/tier decision is made against the *rounded* score -- the
  // same integer the player actually sees (both the landed visible
  // figure, `Math.round(animatedScorePct)`, and the sr-only twin,
  // `.toFixed(0)`, round identically for a non-negative value). Gating
  // against the raw, unrounded `edgeCapturedPct` instead would let a
  // value just under a tier boundary (e.g. 59.6%) visibly read as
  // "60%" while `meetsCutCelebrationGate` still said no (59.6 < 60) --
  // a real, found-in-review mismatch between what's on screen and what
  // the celebration actually keys off. Rounding once, here, and reusing
  // that same integer for both the gate and the intensity ladder is
  // what keeps the two from ever disagreeing with the display again.
  // `celebrationGateMet`/`celebrationIntensity` are both derived purely
  // from `lastFeedback.edgeCapturedPct`, a prop that never changes after
  // mount -- but `CutReveal` re-renders on every one of the dozens of
  // RAF ticks the four `useCountUp` calls above drive over the ~1.2s
  // reveal. Memoized so that per-run-constant work isn't redone on every
  // tick, the same pattern this app's own `TradeReplay.tsx`/
  // `HeroStat.tsx` already establish for the identical class of value
  // (see e.g. TradeReplay.tsx's own `endingBalanceDisplayValue`/
  // `multiplier` memoization).
  const { celebrationGateMet, celebrationIntensity } = useMemo(() => {
    const roundedEdgeCapturedPct = Math.round(lastFeedback.edgeCapturedPct);
    return {
      celebrationGateMet: meetsCutCelebrationGate(roundedEdgeCapturedPct),
      celebrationIntensity: cutCelebrationIntensity(roundedEdgeCapturedPct),
    };
  }, [lastFeedback.edgeCapturedPct]);
  const celebrate = shouldCelebrate(celebrationGateMet, settled);

  const multiplier = useMemo(
    () => bestEndingBalance / startingCapital,
    [bestEndingBalance, startingCapital],
  );

  return (
    <div className="flex flex-col gap-4 rounded-lg border border-[var(--gridline)] bg-[var(--surface-2)] p-4">
      {/* No `role="status"` region here -- CutBoard's own top-level one
          (always rendered, even before `done`, so the mutation it
          announces has an existing region to mutate into rather than a
          freshly-mounted one) already announces `resultSentence`. This
          `<p>` is the sighted, visible copy, matching TheOrder.tsx's own
          identical two-copy (sr-only status + visible banner) shape. */}
      <p className="text-sm font-semibold text-[var(--text-primary)]">
        <span aria-hidden="true">{won ? "★ " : ""}</span>
        {resultSentence}
      </p>

      {/* relative + the burst overlay are scoped to just this stat row
          (not the sentence above or the prose below), the same scoping
          HeroStat.tsx's own doc comment establishes for the identical
          reason -- so the confetti bursts from around the figures
          themselves, not an unrelated caption. */}
      <div className="relative flex flex-wrap gap-6">
        <span className="flex flex-col gap-1">
          {/* Animated (aria-hidden) + a static sr-only twin holding the
              final value -- the same accessibility pairing HeroStat.tsx's
              own doc comment establishes: an aria-live region wired to a
              per-frame value would spam assistive tech with every
              intermediate number, so the sr-only twin is what assistive
              tech actually reads instead. */}
          <span
            aria-hidden="true"
            className={`font-numeric text-3xl font-bold tabular-nums ${
              won ? "text-[var(--accent-reward)]" : "text-[var(--text-primary)]"
            }`}
          >
            {Math.round(animatedScorePct)}%
          </span>
          <span className="sr-only">{lastFeedback.edgeCapturedPct.toFixed(0)}%</span>
          <span className="text-xs text-[var(--text-muted)]">Edge captured</span>
        </span>
        <span className="flex flex-col gap-1">
          <span className="font-numeric text-2xl font-semibold text-[var(--text-primary)]">
            {lastFeedback.rankDistance}
          </span>
          <span className="text-xs text-[var(--text-muted)]">Ranks off</span>
        </span>
        <span className="flex flex-col gap-1">
          <span
            aria-hidden="true"
            className="font-numeric text-2xl font-semibold tabular-nums text-[var(--accent-reward)]"
          >
            {Math.round(animatedCurrentStreak)}
          </span>
          <span className="sr-only">{streak.currentStreak}</span>
          <span className="text-xs text-[var(--text-muted)]">Current streak</span>
        </span>
        <span className="flex flex-col gap-1">
          <span
            aria-hidden="true"
            className="font-numeric text-2xl font-semibold tabular-nums text-[var(--accent-reward)]"
          >
            {Math.round(animatedBestStreak)}
          </span>
          <span className="sr-only">{streak.bestStreak}</span>
          <span className="text-xs text-[var(--text-muted)]">Best streak</span>
        </span>

        <CelebrationBurst active={celebrate} intensity={celebrationIntensity} />
      </div>

      <p className="flex flex-wrap items-baseline gap-1 text-xs text-[var(--text-muted)]">
        <span>
          Best possible: N={bestN}, {formatHeroCurrency(startingCapital)} became
        </span>
        <AnimatedFigure
          aria-hidden="true"
          from={startingCapital}
          to={bestEndingBalance}
          value={formatHeroCurrency(animatedBestEndingBalance)}
          className="font-numeric text-sm font-semibold tabular-nums text-[var(--text-primary)]"
        />
        <span className="sr-only">{formatHeroCurrency(bestEndingBalance)}</span>
        {/* The multiplier badge and the rest of the sentence share one
            flex item (rather than being two separate ones) specifically
            so the parent row's own `gap-1` doesn't insert a visible gap
            between the badge's closing ")" and the sentence's trailing
            "." right after it -- found by screenshot, not by reading the
            JSX (`gap` applies between every flex item regardless of
            what text they hold, so two adjacent items reading "(1x)"
            and ". The whole-index..." rendered as "(1x) . The
            whole-index...", an awkward space before the period). */}
        <span>
          <span className="font-semibold" style={{ color: heroMultiplierColor(multiplier) }}>
            ({formatMultiplier(multiplier)})
          </span>
          . The whole-index (N={universeSize}) baseline made {formatHeroCurrency(n500EndingBalance)}
          .
        </span>
      </p>

      {revealVariant === "chart" ? (
        <TheCutChart
          curve={curve}
          universeSize={universeSize}
          bestN={bestN}
          n500EndingBalance={n500EndingBalance}
          guessedN={lastFeedback.guess}
        />
      ) : (
        <CutRevealStrip universeSize={universeSize} bestN={bestN} guessedN={lastFeedback.guess} />
      )}

      <div>
        <button
          type="button"
          onClick={onPlayAgain}
          className="min-h-11 rounded-md border border-[var(--gridline)] bg-[var(--surface-1)] px-4 text-sm font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
        >
          Play again
        </button>
      </div>
    </div>
  );
}

function CutBoard({
  range,
  view,
  universeSize,
  startingCapital,
  bestN,
  bestEndingBalance,
  n500EndingBalance,
  curve,
  revealVariant,
  accessibleNameSuffix,
  onSubmit,
  onPlayAgain,
}: CutBoardProps) {
  const sliderId = useId();
  // See CutBoardProps.accessibleNameSuffix's own doc comment -- `null`
  // (the main game) keeps the original, unsuffixed accessible names
  // byte-for-byte; a real suffix (Explore) appends a disambiguating
  // parenthetical. The *visible* button text always stays plain "Submit
  // guess" -- an `aria-label` override changes the accessible name
  // without changing what a sighted user reads, since the two boards
  // are already visually separated by which panel they sit in.
  const guessInputLabel = accessibleNameSuffix
    ? `Your guess, as a number (${accessibleNameSuffix})`
    : "Your guess, as a number";
  const submitButtonLabel = accessibleNameSuffix
    ? `Submit guess (${accessibleNameSuffix})`
    : undefined;
  const [draft, setDraft] = useState(() => Math.ceil(universeSize / 2));
  // A different range (a different universeSize, and a fresh game to
  // guess against) resets the draft to a sensible midpoint -- via the
  // shared use-reset-when-changed.ts helper (the "adjust state during
  // render when a value changes" idiom this app uses elsewhere,
  // centralized after being hand-copied at six sites -- see that
  // file's own doc comment), not a useEffect (which
  // react-hooks/set-state-in-effect correctly flags for an
  // unconditional setState at the top of its body).
  useResetWhenChanged([range], () => setDraft(Math.ceil(universeSize / 2)));

  if (bestN === null || bestEndingBalance === null || n500EndingBalance === null) {
    return (
      <p className="text-sm text-[var(--text-muted)]">
        The Cut has no usable result for this range yet -- try a different one.
      </p>
    );
  }

  const state = view.state;
  if (state === null) {
    return <p className="text-sm text-[var(--text-muted)]">Loading…</p>;
  }

  const done = state.done;
  const lastFeedback = view.feedback.at(-1) ?? null;

  function clamp(n: number): number {
    return Math.min(universeSize, Math.max(1, Math.round(n)));
  }

  const resultSentence = done
    ? state.won
      ? `Correct -- N=${bestN} was the real best.`
      : `Out of attempts. The real best was N=${bestN}.`
    : "";

  return (
    <div className="flex flex-col gap-5">
      <div role="status" aria-live="polite" aria-label="The Cut status" className="sr-only">
        {resultSentence}
      </div>

      {!done && (
        <>
          <p className="text-sm text-[var(--text-secondary)]">
            Holding companies #1..N (cap-weighted, real S&amp;P weight) over {range}, which prefix
            length N would have maximized hindsight profit? You have {view.attemptsRemaining} guess
            {view.attemptsRemaining === 1 ? "" : "es"} left.
          </p>

          <TickerStrip universeSize={universeSize} activeRank={draft} />

          <div className="flex flex-col gap-2">
            <label htmlFor={sliderId} className="text-sm text-[var(--text-secondary)]">
              Your guess: N={draft}
            </label>
            <input
              id={sliderId}
              type="range"
              min={1}
              max={universeSize}
              value={draft}
              onChange={(event) => setDraft(clamp(Number(event.target.value)))}
              className="w-full"
            />
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={1}
                max={universeSize}
                value={draft}
                onChange={(event) => setDraft(clamp(Number(event.target.value) || 1))}
                aria-label={guessInputLabel}
                className="font-numeric w-24 rounded-md border border-[var(--gridline)] bg-[var(--surface-1)] px-2 py-1.5 text-sm text-[var(--text-primary)]"
              />
              <button
                type="button"
                onClick={() => onSubmit(draft)}
                aria-label={submitButtonLabel}
                className="min-h-11 rounded-md bg-[var(--accent-selection)] px-4 text-sm font-semibold text-white"
              >
                Submit guess
              </button>
            </div>
          </div>
        </>
      )}

      {view.feedback.length > 0 && (
        <ol className="flex flex-col gap-1.5">
          {view.feedback.map((entry, index) => {
            if (entry.correct) {
              return (
                <li
                  key={index}
                  className="flex items-center gap-2 rounded-lg border border-[var(--accent-reward)] bg-[var(--accent-reward-wash)] px-3 py-2 text-sm"
                >
                  <span aria-hidden="true" className="text-[var(--accent-reward)]">
                    ★
                  </span>
                  <span className="font-numeric font-semibold text-[var(--text-primary)]">
                    N={entry.guess}
                  </span>
                  <span className="text-[var(--accent-reward)]">Correct!</span>
                </li>
              );
            }
            const direction = DIRECTION_STYLES[entry.direction!];
            const closeness = CLOSENESS_STYLES[entry.closeness!];
            return (
              <li
                key={index}
                className="flex flex-wrap items-center gap-2 rounded-lg border border-[var(--gridline)] bg-[var(--surface-2)] px-3 py-2 text-sm"
              >
                <span className="font-numeric font-semibold text-[var(--text-primary)]">
                  N={entry.guess}
                </span>
                <span className="flex items-center gap-1 text-[var(--text-secondary)]">
                  <span aria-hidden="true">{direction.glyph}</span>
                  {direction.label}
                </span>
                <span
                  className={`rounded-full px-2 py-0.5 text-xs font-semibold ${closeness.className}`}
                >
                  {closeness.label}
                </span>
              </li>
            );
          })}
        </ol>
      )}

      {done && lastFeedback && (
        <CutReveal
          bestN={bestN}
          bestEndingBalance={bestEndingBalance}
          n500EndingBalance={n500EndingBalance}
          startingCapital={startingCapital}
          universeSize={universeSize}
          curve={curve}
          revealVariant={revealVariant}
          won={state.won}
          resultSentence={resultSentence}
          lastFeedback={lastFeedback}
          streak={view.streak}
          onPlayAgain={onPlayAgain}
        />
      )}
    </div>
  );
}

interface CutGamePanelProps {
  range: CutRange;
  revealVariant: CutRevealVariant;
  /** Passed straight through to `CutBoard` -- see `CutBoardProps.accessibleNameSuffix`'s own doc comment. */
  accessibleNameSuffix: string | null;
  result: Sp500PrefixResult | null;
  fetchFailed: boolean;
  view: CutView;
  onSubmit: (guess: number) => void;
  onPlayAgain: () => void;
}

/**
 * The disclaimer paragraph + the loading/error/board ternary, shared by
 * the main (fixed "1D") game and every range picked inside "Explore
 * other windows" -- extracted so the two don't hand-duplicate this JSX
 * (both TheCut() and CutExplorePanel below already own their own
 * useSp500Prefix/useCutGame calls independently, since each also needs
 * its own fetch/game state for its own purpose -- TheCut() for its
 * collapsed tile's status line and hasOpenedPanel latch, which have no
 * equivalent in the explore sub-section at all).
 */
function CutGamePanel({
  range,
  revealVariant,
  accessibleNameSuffix,
  result,
  fetchFailed,
  view,
  onSubmit,
  onPlayAgain,
}: CutGamePanelProps) {
  const n500Point = result ? n500CurvePoint(result.curve, result.universeSize) : null;

  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-[var(--text-muted)]">
        Today&apos;s S&amp;P 500 weight snapshot applied retroactively -- a real, explainable
        limitation, not investment advice.{" "}
        {result?.truncated &&
          "This range's own window was truncated to how far back the fetched data reaches."}
      </p>

      {result ? (
        <CutBoard
          range={range}
          view={view}
          universeSize={result.universeSize}
          startingCapital={result.startingCapital}
          bestN={result.bestN}
          bestEndingBalance={result.bestEndingBalance}
          n500EndingBalance={n500Point?.endingBalance ?? null}
          curve={result.curve}
          revealVariant={revealVariant}
          accessibleNameSuffix={accessibleNameSuffix}
          onSubmit={onSubmit}
          onPlayAgain={onPlayAgain}
        />
      ) : fetchFailed ? (
        <p className="text-sm text-[var(--text-muted)]">
          Couldn&apos;t load The Cut for this range -- try a different one, or reload in a bit.
        </p>
      ) : (
        <p className="text-sm text-[var(--text-muted)]">Loading…</p>
      )}
    </div>
  );
}

/**
 * The other six CUT_RANGES entries, behind their own picker and their
 * own independent guess-then-reveal game -- see this file's own
 * top-of-file comment for the naming precedent and the "chart, not
 * slide" reveal choice.
 *
 * **Lazily mounted `CutExplorePanel`, not always-mounted** -- the
 * `<details>` shell itself is always present (so its own open/closed
 * state is never lost, the same reasoning TheCut()'s own `hasOpenedPanel`
 * doc comment already gives one level up), but its content only mounts
 * -- and therefore only fetches `/api/sp500-prefix?range=` for its own
 * default explore range -- once a player has actually opened it at
 * least once. Mirrors issue #209's own lazy `PortfolioChart` mount
 * (`TradeReplay.tsx`'s `{chartOpen && <PortfolioChart .../>}`) for the
 * identical reason: fetching this unconditionally on every page load
 * would add a second `/api/sp500-prefix?range=` request nobody asked
 * for yet, and `ResultsPage.test.tsx`'s own fetch-order assertion
 * already expects exactly one such request (`THE_CUT_DEFAULT_RANGE`'s)
 * on a normal page load.
 */
function CutExploreOtherWindows() {
  const [opened, setOpened] = useState(false);

  return (
    <details
      // `group/explore`, not the bare `group` TheCut()'s own outer
      // <details> already uses -- a real code-review-found bug: Tailwind's
      // default (unnamed) `.group`/`group-open:` variant is a plain
      // descendant selector with no nearest-ancestor scoping
      // (`:where(.group):is([open]) *`, not `:where(.group[open])
      // :where(:not(.group) *)`), so an unnamed `group-open:` on this
      // chevron would react to ANY ancestor `.group[open]` -- including
      // the OUTER details, which is always open whenever this nested one
      // is even visible at all (this whole subtree only renders once
      // TheCut's own tile is expanded). The chevron would therefore have
      // rendered permanently rotated ("expanded") from the moment the
      // outer tile opened, regardless of whether this inner disclosure
      // was actually open or closed. A named group scopes the selector
      // to specifically this `<details>`'s own `[open]` state.
      className="group/explore"
      onToggle={(event) => {
        if (event.currentTarget.open) setOpened(true);
      }}
    >
      <summary className="flex cursor-pointer list-none items-center gap-1.5 text-sm font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)]">
        <span
          aria-hidden="true"
          className="text-xs transition-transform group-open/explore:rotate-90"
        >
          ▸
        </span>
        {/* Its own `<span>`, not a bare text node -- matches
            ResultsPage.tsx's own "Explore other windows" convention
            (issue #165) so `screen.getByText("Explore other windows")`
            resolves to one isolated node whose own textContent is
            exactly this label, not the summary's combined "▸Explore
            other windows". */}
        <span>Explore other windows</span>
      </summary>
      <div className="mt-3 flex flex-col gap-4 border-t border-[var(--gridline)] pt-3">
        {opened && <CutExplorePanel />}
      </div>
    </details>
  );
}

function CutExplorePanel() {
  const [range, setRange] = useState<CutRange>(EXPLORE_DEFAULT_RANGE);
  const resultState = useSp500Prefix(range);
  const result =
    resultState?.status === "success" && isValidSp500PrefixResult(resultState.data)
      ? resultState.data
      : null;
  const { view, submitGuess, playAgain } = useCutGame(range, result);
  const fetchFailed =
    resultState !== null &&
    resultState.status !== "loading" &&
    !(resultState.status === "success" && isValidSp500PrefixResult(resultState.data));

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-[var(--text-muted)]">Window:</span>
        <CutRangeSelector selected={range} onSelect={setRange} ranges={EXPLORE_RANGES} />
      </div>

      <CutGamePanel
        range={range}
        revealVariant="chart"
        accessibleNameSuffix={EXPLORE_ACCESSIBLE_NAME_SUFFIX}
        result={result}
        fetchFailed={fetchFailed}
        view={view}
        onSubmit={submitGuess}
        onPlayAgain={playAgain}
      />
    </div>
  );
}

/**
 * The Cut section. Takes no props (issue #122) -- fetches independently
 * of /api/results, against its own fixed default range
 * (`THE_CUT_DEFAULT_RANGE`, currently "1D") -- **no visible range picker
 * in the main play experience** (a direct user request, not a filed
 * issue): every other CUT_RANGES entry lives behind the nested "Explore
 * other windows" disclosure this component renders inside its own panel
 * (`CutExploreOtherWindows` above), not here.
 *
 * **`hasOpenedPanel` is a one-way latch, not a plain `ready` check --
 * this is the fix for a real regression found in review.** Even with no
 * range picker to switch away from any more, the underlying shape this
 * guards against is still real: `useSp500Prefix`'s fetch state starts at
 * `{status: "loading"}` on mount, so `result` is `null` and `ready` is
 * `false` for at least one render regardless -- and if that also
 * controlled which top-level element renders, a `<details>` that only
 * ever mounts once `ready` is first observed `true` would (in a world
 * where anything ever caused a second render before that point) risk
 * mounting a brand-new `<details>` with no `open` attribute at exactly
 * the wrong moment. `hasOpenedPanel` latches `true` the first time real
 * data ever loads and never goes back to `false`, so the `<details>`
 * shell -- and therefore its own native open/closed state -- stays
 * mounted from that point on regardless of any later transient fetch
 * failure; only the panel's *inner* content (the summary status line,
 * and the board vs. a loading/error message) reacts to `ready`/
 * `fetchFailed` from here on. Only the very first load (before anything
 * has ever rendered) still shows the separate `CutPlaceholder`/
 * `CutErrorState` elements, matching every other daily-hub game's own
 * "no `<details>` in the tree until there's something real to show"
 * convention.
 */
export function TheCut() {
  const headingId = useId();
  const range = THE_CUT_DEFAULT_RANGE;
  const resultState = useSp500Prefix(range);
  const result =
    resultState?.status === "success" && isValidSp500PrefixResult(resultState.data)
      ? resultState.data
      : null;
  const { view, submitGuess, playAgain } = useCutGame(range, result);

  const ready = result !== null && view.hydrated;
  const fetchFailed =
    resultState !== null &&
    resultState.status !== "loading" &&
    !(resultState.status === "success" && isValidSp500PrefixResult(resultState.data));

  const [hasOpenedPanel, setHasOpenedPanel] = useState(false);
  if (ready && !hasOpenedPanel) {
    setHasOpenedPanel(true);
  }

  return (
    <section aria-labelledby={headingId}>
      <h2 id={headingId} className="sr-only">
        {TITLE}
      </h2>

      {!hasOpenedPanel ? (
        fetchFailed ? (
          <CutErrorState />
        ) : (
          <CutPlaceholder />
        )
      ) : (
        <details className="group">
          <summary
            data-testid="the-cut-summary"
            style={TILE_GRADIENT_STYLE}
            className={`${CARD_BASE_CLASSNAME} ${TILE_SHADOW_CLASSNAME} cursor-pointer list-none transition-transform duration-150 group-open:rounded-b-none hover:-translate-y-0.5 hover:scale-[1.015] group-open:hover:translate-y-0 group-open:hover:scale-100 active:translate-y-0 active:scale-[0.99]`}
          >
            <TileSummaryRow
              headingId={`${headingId}-tile`}
              statusLine={tileStatusLine(view, fetchFailed)}
            />
          </summary>

          <div
            data-testid="the-cut-panel"
            className="flex flex-col gap-6 rounded-t-none rounded-b-2xl border-x border-b border-t-4 border-[var(--gridline)] bg-[var(--surface-1)] px-4 pt-4 pb-5"
            style={{ borderTopColor: CONNECTOR_ACCENT }}
          >
            <GamePanelHeader icon={ICON} accentColor={CONNECTOR_ACCENT} title={TITLE} />

            <CutGamePanel
              range={range}
              revealVariant="slide"
              accessibleNameSuffix={null}
              result={result}
              fetchFailed={fetchFailed}
              view={view}
              onSubmit={submitGuess}
              onPlayAgain={playAgain}
            />

            <CutExploreOtherWindows />
          </div>
        </details>
      )}
    </section>
  );
}
