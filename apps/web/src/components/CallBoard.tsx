"use client";

// The Call Board's player-facing surface (issue #129, restructured into a
// compact "Think you know the future?" teaser by issue #164).
//
// **All logic is issue #128's, consumed rather than reimplemented** --
// buckets, the +/-0.5% threshold, scoring, resolution, the rolling
// lookahead, the after-the-open lock and every storage read/write live in
// call-board-scoring.ts / call-board-storage.ts / market-calendar.ts,
// reached through lib/use-call-board.ts. The only logic that is genuinely
// this file's own is `callOutcomeFor` below: how a settled call's
// (score, bucket distance) pair maps onto the four *display* states the
// history strip needs, which is a presentation question the engine has no
// opinion about.
//
// Placement follows issue #122's standing decision: this is a section
// mounted by ResultsPage.tsx as a direct sibling of ResultsPanel, not
// something inside ResultsPanel's model branches, and it takes **no**
// PrecomputedResult/range/mode/selectedDay props -- it owns its own state
// and obtains the SPY close series it resolves against itself (see
// useCallBoardCloses).
//
// **Issue #164's restructuring**: this used to render the full 3-slot
// board, history strip and stats row unconditionally, full-size. It now
// renders a compact card by default -- an icon, "Think you know the
// future?", a subtitle, and a status line -- that expands in place to the
// exact same board on click, via a plain native `<details>`/`<summary>`
// (the same disclosure idiom "More options"/"Methodology & assumptions"/
// "View chart data as a table" already use elsewhere in this app). None of
// the engine calls, the four-outcome history classification, or the
// after-the-open lock changed at all -- purely presentational.
//
// **Issue #177's restyle**: the collapsed card's own look changed again,
// from a thin-left-border-accent surface card into a bold, solid-fill
// blue-gradient tile with a large icon, matching
// docs/design/gamified-hero-2026-08/mockup-gamified-hero.html's own
// `.game-tile.callboard` (99% visual fidelity, not pixel-perfect, per
// that folder's own README). Still the exact same `<details>`/`<summary>`
// mechanism and pre-hydration inert placeholder `<div>` -- this issue's
// own scope is purely the collapsed tile's colors/layout, not the
// expand mechanism or anything inside the expanded board.
//
// **Issue #186's condensation**: the compact card itself gained a small
// corner status badge (done/partial/todo, `lib/daily-ritual.ts`'s own
// `STEP_STYLES`/`callsState` -- see `CallBoardSummaryRow`'s own doc
// comment) plus a miniature version of the history strip/streak chip
// below, reusing `callOutcomeFor`/`OUTCOME_STYLES` unchanged, once
// `board.resolved` is non-empty. This replaces what used to be a
// separate, always-visible "Today, so far" status rail above every
// mechanic (`DailyRitual.tsx`) -- see that file's own doc comment.

import { useState } from "react";

import {
  CALL_BUCKETS,
  MAX_OPEN_CALLS,
  STRONG_MOVE_THRESHOLD,
  type CallBucket,
  type ResolvedCall,
} from "@/lib/call-board-scoring";
import {
  STATUS_BADGE_CLASSNAME,
  STEP_STYLES,
  callsState,
  type RitualStepState,
} from "@/lib/daily-ritual";
import { formatDate } from "@/lib/format-date";
import { formatPercent } from "@/lib/format-currency";
import { useCallBoard, useCallBoardCloses } from "@/lib/use-call-board";

/** How many settled calls the history strip shows, newest last. */
export const HISTORY_STRIP_LENGTH = 10;

/**
 * How many settled calls the *compact card's own* mini history strip
 * shows (issue #186) -- a smaller "handful" than the full board's own
 * `HISTORY_STRIP_LENGTH`, since this one has to fit inside a card
 * tile's own corner, not a full-width expanded row.
 */
export const SUMMARY_HISTORY_LENGTH = 5;

const BUCKET_LABELS: Record<CallBucket, string> = {
  "up-strong": "Up big",
  up: "Up",
  down: "Down",
  "down-strong": "Down big",
};

/**
 * A purely decorative direction glyph on each bucket button. Marked
 * aria-hidden everywhere it's rendered -- the button's own visible text
 * label is what carries the meaning, so this never has to be announced.
 */
const BUCKET_GLYPHS: Record<CallBucket, string> = {
  "up-strong": "▲▲",
  up: "▲",
  down: "▼",
  "down-strong": "▼▼",
};

/**
 * The four outcomes the history strip distinguishes, exactly as issue
 * #129's scope names them.
 *
 * **Deliberately a display classification, not a second scoring model.**
 * `score` comes straight from the engine (`scoreCall`: 2 exact / 1 right
 * direction / 0 wrong direction); the only thing added here is splitting
 * the engine's single 0 into "just missed" and "way off" by how far apart
 * the two buckets sit in `CALL_BUCKETS`' own most-bullish-first order.
 * That distance is a real, meaningful difference to a player -- calling
 * "Up" on a mild down day is a near miss, calling "Up big" on a hard down
 * day is not -- but it is worth no extra points, and nothing here feeds
 * back into `computeCallBoardStats`.
 */
export type CallOutcome = "exact" | "right-direction" | "near-miss" | "far-miss";

interface OutcomeStyle {
  /**
   * A real visible glyph, not a color-only cue. WCAG 1.4.1 requires the
   * four states be distinguishable by something other than hue, and a
   * `title` attribute does not count -- assistive tech doesn't reliably
   * announce it. Every cell therefore carries this glyph *and* an sr-only
   * sentence, on top of the color.
   */
  glyph: string;
  /** Short label used in the cell's sr-only sentence and the strip's legend. */
  label: string;
  className: string;
  legendClassName: string;
}

const OUTCOME_STYLES: Record<CallOutcome, OutcomeStyle> = {
  // Gold is --accent-reward's documented job (globals.css, issue #121):
  // earned/outcome state only. An exact call is the one thing on this
  // board a player actually earns, so it is the one thing painted gold.
  exact: {
    glyph: "★",
    label: "Exact call",
    className:
      "border-[var(--accent-reward)] bg-[var(--accent-reward-wash)] text-[var(--accent-reward)]",
    legendClassName: "text-[var(--accent-reward)]",
  },
  "right-direction": {
    glyph: "✓",
    label: "Right direction",
    className: "border-[var(--status-good)] bg-[var(--surface-2)] text-[var(--status-good)]",
    legendClassName: "text-[var(--status-good)]",
  },
  "near-miss": {
    glyph: "~",
    label: "Just missed",
    className: "border-[var(--baseline)] bg-[var(--surface-2)] text-[var(--text-secondary)]",
    legendClassName: "text-[var(--text-secondary)]",
  },
  "far-miss": {
    glyph: "✕",
    label: "Way off",
    className:
      "border-[var(--status-critical)] bg-[var(--surface-2)] text-[var(--status-critical)]",
    legendClassName: "text-[var(--status-critical)]",
  },
};

/** Every outcome, in the order the legend lists them (best first). */
const OUTCOME_ORDER: readonly CallOutcome[] = ["exact", "right-direction", "near-miss", "far-miss"];

/**
 * Which of the four display states a settled call lands in.
 *
 * Score is checked first and distance only breaks the engine's `0` apart:
 * a distance of 1 can mean either a right-direction confidence miss
 * ("Up big" vs. "Up") or a wrong-direction near miss ("Up" vs. "Down"),
 * so distance alone would conflate two genuinely different results.
 */
export function callOutcomeFor(call: ResolvedCall): CallOutcome {
  if (call.score === 2) return "exact";
  if (call.score === 1) return "right-direction";
  const distance = Math.abs(CALL_BUCKETS.indexOf(call.pick) - CALL_BUCKETS.indexOf(call.actual));
  return distance <= 1 ? "near-miss" : "far-miss";
}

/** The sr-only sentence behind one history cell -- the whole story, not just the glyph. */
function historyCellDescription(call: ResolvedCall, outcome: CallOutcome): string {
  return `${formatDate(call.date)}: called ${BUCKET_LABELS[call.pick].toLowerCase()}, closed ${formatPercent(call.moveFraction)} (${BUCKET_LABELS[call.actual].toLowerCase()}). ${OUTCOME_STYLES[outcome].label}.`;
}

// `font-display` per globals.css's type roles (issue #121): Geist Sans for
// big *static* figures, which these are -- nothing here animates digit by
// digit the way `font-numeric`'s intended callers do.
//
// The colour is deliberately NOT baked in here and is passed per-Stat
// instead: two arbitrary-value `text-[...]` utilities on the same element
// are the same CSS property at the same specificity, so which one wins
// comes down to Tailwind's own emitted source order rather than the order
// they appear in the className string. An earlier version appended the
// gold onto a base that already set `--text-primary` and the streak
// figures silently rendered white -- caught by a screenshot, not by any
// DOM assertion, since both classes really were present on the element.
const statFigureClassName = "font-display text-2xl font-semibold tabular-nums";
const statLabelClassName = "text-xs text-[var(--text-muted)]";

function Stat({ label, value, colorClassName }: StatProps) {
  return (
    <div className="flex flex-col gap-1">
      <span className={`${statFigureClassName} ${colorClassName}`}>{value}</span>
      <span className={statLabelClassName}>{label}</span>
    </div>
  );
}

interface StatProps {
  label: string;
  value: string;
  /** The figure's own colour, the only `text-[...]` utility this figure ever carries. */
  colorClassName: string;
}

// ---------------------------------------------------------------------
// The compact "Think you know the future?" card (issue #164)
// ---------------------------------------------------------------------

/** Exact copy from docs/design/ui-simplification-2026-08/mockup-simplified.html. */
const CTA_ICON = "🔮";
const CTA_TITLE = "Think you know the future?";
const CTA_SUBTITLE = `Call the next ${MAX_OPEN_CALLS} sessions, up or down, before they open.`;

/**
 * Shared between the pre-hydration inert placeholder and the real,
 * interactive `<summary>` so the two can never drift in size -- the whole
 * point of a placeholder is that swapping it for the real thing causes no
 * layout shift, which only holds if both render byte-for-byte the same
 * markup (differing only in `statusLine`/`badgeState`/`filledCount`/
 * `recentCalls`/`currentStreak`'s own values, per the placeholder's own
 * always-`"todo"`/always-empty call site below).
 *
 * A tile layout (issue #177), not the pre-#177 horizontal row: a large
 * icon up top, the title/subtitle stacked below it, and a status pill
 * anchored to the bottom, matching the mockup's own `.game-tile`
 * icon-title-subtitle/status-pill structure. `text-white`/`text-white/…`
 * throughout (not this app's usual `var(--text-primary)`/
 * `var(--text-secondary)` tokens) is deliberate -- this tile's own fixed
 * blue-gradient fill (`CARD_CLASSNAME` below) isn't part of the
 * dark-surface token system the rest of the app paints against, the same
 * way `OgCard.tsx`'s share-card palette is its own standalone thing (see
 * `apps/web/CLAUDE.md`'s "Dark mode only" section).
 *
 * **The corner status badge, mini history strip and streak chip (issue
 * #186)**: `badgeState` (from `callsState`, `lib/daily-ritual.ts`) shows
 * nothing for `"todo"` (no calls made yet), the filled call count for
 * `"partial"`, or `STEP_STYLES.done`'s own gold checkmark for `"done"`
 * (every open call made) -- matching the design reference's own
 * `.status-badge`. `recentCalls` (the board's own `resolved` history,
 * sliced to `SUMMARY_HISTORY_LENGTH` by the caller) reuses
 * `callOutcomeFor`/`OUTCOME_STYLES` unchanged, just rendered smaller and
 * only once there's any history at all -- the mini pips are purely
 * decorative (`aria-hidden`; the full, accessible history strip with its
 * own sr-only descriptions is one click away in the expanded board
 * below), but the streak chip carries a real accessible name of its own
 * (`aria-label`) since nothing else on this collapsed card states the
 * streak in words.
 */
function CallBoardSummaryRow({
  statusLine,
  badgeState,
  filledCount,
  recentCalls,
  currentStreak,
}: {
  statusLine: string;
  badgeState: RitualStepState;
  filledCount: number;
  recentCalls: readonly ResolvedCall[];
  currentStreak: number;
}) {
  return (
    <span className="relative flex flex-col justify-between gap-4 p-5">
      {badgeState !== "todo" && (
        // aria-hidden: statusLine below already states this same count in
        // full, readable text -- this badge is a purely visual
        // at-a-glance duplicate of it.
        <span
          aria-hidden="true"
          className={`${STATUS_BADGE_CLASSNAME} ${STEP_STYLES[badgeState].colorClassName}`}
        >
          {badgeState === "done" ? STEP_STYLES.done.glyph : filledCount}
        </span>
      )}
      <span className="flex flex-col gap-2">
        {/* Icon plate (issue #188): a soft circular translucent backdrop
            behind the emoji, matching the design reference's own
            `.tile-icon-plate` -- 2.75rem (44px, this app's own established
            touch-target size) housing the existing text-3xl emoji, with the
            same subtle drop-shadow the reference gives the icon itself for
            a little lift off the plate. */}
        <span
          aria-hidden="true"
          className="flex h-11 w-11 items-center justify-center rounded-full bg-white/[0.16]"
        >
          <span className="text-3xl leading-none drop-shadow-[0_2px_4px_rgba(0,0,0,0.25)]">
            {CTA_ICON}
          </span>
        </span>
        <span className="flex flex-col gap-1">
          <span className="font-display text-lg leading-tight font-extrabold tracking-tight">
            {CTA_TITLE}
          </span>
          <span className="text-xs font-medium text-white/85">{CTA_SUBTITLE}</span>
        </span>
      </span>
      {recentCalls.length > 0 && (
        <span className="flex flex-wrap items-center gap-1">
          <span aria-hidden="true" className="flex flex-wrap items-center gap-1">
            {recentCalls.map((call) => {
              const outcome = callOutcomeFor(call);
              const style = OUTCOME_STYLES[outcome];
              return (
                <span
                  key={call.date}
                  className={`flex h-4 w-4 items-center justify-center rounded-full border text-[9px] font-bold ${style.className}`}
                >
                  {style.glyph}
                </span>
              );
            })}
          </span>
          <span
            aria-label={`Current streak: ${currentStreak}`}
            className="font-numeric ml-1 rounded-full bg-white/20 px-1.5 py-0.5 text-[0.65rem] font-bold"
          >
            <span aria-hidden="true">🔥 {currentStreak}</span>
          </span>
        </span>
      )}
      <span className="flex items-center justify-between gap-2">
        <span className="font-numeric rounded-full bg-white/20 px-2.5 py-1 text-[0.6875rem] font-bold">
          {statusLine}
        </span>
        {/* A purely visual "this expands" affordance -- the same small
            chevron "Explore other windows"/other <details> disclosures in
            this app already use, just relocated to sit next to the status
            pill instead of at the row's far end (there's no room left at
            the tile's own trailing edge once the layout became a
            column). */}
        <span aria-hidden="true" className="shrink-0 text-xs font-semibold text-white/70">
          ▸
        </span>
      </span>
    </span>
  );
}

/**
 * The collapsed tile's shared visual chrome (issue #177) -- one
 * gradient-fill/rounded-corner/shadow treatment applied to both the real,
 * interactive `<summary>` and the pre-hydration inert placeholder `<div>`,
 * so the two can never drift in size. The gradient angle and "lighter to
 * darker blue" sweep match the mockup's own `.game-tile.callboard`
 * (docs/design/gamified-hero-2026-08/mockup-gamified-hero.html), at that
 * folder's own stated "99% fidelity, not pixel-perfect" bar -- but the
 * three stop *colors* are deliberately NOT the mockup's own literal hex
 * values (`#5c9cf0`/`#3987e5`/`#2b6fc4`). Those measured at 2.81:1 /
 * 3.64:1 / 5.03:1 against white text (WCAG relative-luminance formula);
 * only the darkest stop cleared 4.5:1 AA. Replaced with
 * `#4374cf`/`#3568c2`/`#2a58ab` -- every stop independently verified at
 * >= 4.5:1 against white (4.53:1 / 5.37:1 / 6.81:1, recomputed
 * independently from the same formula, not just trusted) -- same 155deg
 * angle, same "lighter to darker blue" sweep, still clearly the same hue
 * family as this app's real `--accent-selection`/`--series-1` (#3987e5).
 * `min-h-28` (7rem/112px) is a defensive floor, not a measured value --
 * the tile's real content (icon + two-line title + subtitle + status
 * pill) is already comfortably taller than the 44px touch-target floor
 * on its own, but this guarantees it regardless of how short a future
 * copy edit makes any of those lines.
 *
 * **Deliberately applied to the `<summary>` itself, not the outer
 * `<details>`** -- unlike the pre-#177 `CARD_CLASSNAME`, which wrapped
 * the *whole* `<details>` (summary + expanded board) in one shared
 * style, since both states shared the same subdued surface-card look.
 * Putting this tile's bold gradient on `<details>` instead would paint
 * the *expanded* board (the picker/stats/history) blue too, once
 * opened -- a real regression against this issue's own acceptance
 * criterion ("clicking it still expands to the exact same full Call
 * Board experience as before this issue"). The expanded body below gets
 * its own separate, ordinary dark surface-card wrapper instead (see the
 * render return below) -- visually identical either way while the
 * `<details>` is closed (a closed `<details>`'s box is exactly its
 * `<summary>`'s own box), and this way there's no risk of the parent's
 * background leaking around the body's edges once open.
 *
 * **Colored ambient glow (issue #188)**: the outer `shadow-[...]` gained a
 * second, blue-tinted layer (`rgba(57,135,229,0.35)`, the same
 * `--series-1`/`--accent-selection` hue this tile's own gradient stops
 * already sit in) ahead of the pre-existing plain black drop shadow -- both
 * layers render together in one `box-shadow`, not one replacing the other.
 */
const CARD_CLASSNAME =
  "min-h-28 rounded-2xl bg-[linear-gradient(155deg,#4374cf_0%,#3568c2_55%,#2a58ab_100%)] text-white shadow-[0_8px_22px_rgba(57,135,229,0.35),0_6px_18px_rgba(0,0,0,0.35)]";

/**
 * What renders before `useCallBoard`'s mount-time correction: the same
 * summary row, sized identically to the real card, but genuinely inert --
 * a plain `<div>`, not a `<details>`/`<summary>`, so there is no
 * focusable or toggleable element in the tree yet, and the whole thing is
 * `aria-hidden`.
 *
 * The status line is a non-breaking space rather than a real "0 of N
 * called" figure (mirroring the deleted `PLACEHOLDER_SLOTS`' own blank
 * date label, issue #129) -- it is exactly as clock/storage-derived as
 * the full board's own slots were, and a real-looking but possibly-wrong
 * count is worse than none. The title and subtitle are plain constants,
 * not derived from anything, so showing them here early is safe and is
 * what lets the placeholder actually look like the real card rather than
 * an empty box.
 *
 * This is the same hydration-safety story `use-call-board.ts`'s
 * `UNHYDRATED_VIEW` already tells one level down, just applied to the
 * *whole collapsed card* instead of the expanded board's slots -- see
 * that module's own doc comment for the full reasoning (this board's
 * clock-derived output changes at two boundaries a day, not once a
 * month, and 9:30 AM Eastern is a high-traffic moment for this page).
 *
 * `badgeState="todo"`/`filledCount={0}`/`recentCalls={[]}`/
 * `currentStreak={0}` for the identical reason `statusLine=" "` already
 * is: every one of those is exactly as clock/storage-derived as the full
 * board's own slots, so there is nothing real to show yet -- and `"todo"`
 * plus an empty history are also `CallBoardSummaryRow`'s own quietest
 * rendering (no badge, no strip), which happens to match the single most
 * common real state (a first visit) too.
 */
function CallBoardPlaceholder() {
  return (
    <div aria-hidden="true" className={CARD_CLASSNAME}>
      <CallBoardSummaryRow
        statusLine=" "
        badgeState="todo"
        filledCount={0}
        recentCalls={[]}
        currentStreak={0}
      />
    </div>
  );
}

/**
 * The Call Board section.
 *
 * Takes no props on purpose (issue #122) -- it is not a function of the
 * hindsight result, and keeping it result-independent is what lets it
 * mount above ResultsPanel's own fetch gate and stay playable when
 * /api/results is slow or failing.
 *
 * Renders a compact "Think you know the future?" card by default
 * (issue #164); clicking it expands, in place, to the exact same 3-slot
 * picker / history strip / stats row this component always rendered --
 * unchanged in substance, just no longer auto-rendered full-size. The
 * outer `<section>` + sr-only heading render unconditionally (even before
 * hydration), so this section's own placement in the page never depends
 * on `useCallBoard`'s state; only the card content inside it does.
 */
export function CallBoard() {
  const closes = useCallBoardCloses();
  const { view, makeCall } = useCallBoard(closes);
  const { board, marketClosedToday, hydrated } = view;
  const { stats } = board;

  // Announcement text for the always-present live region below. Held in
  // state rather than derived, because what changed is an *event* (a call
  // was saved, or refused) rather than a property of the current board --
  // two calls of the same bucket on different days must each announce.
  const [announcement, setAnnouncement] = useState("");

  function handleCall(date: string, bucket: CallBucket) {
    const saved = makeCall(date, bucket);
    setAnnouncement(
      saved
        ? `Called ${BUCKET_LABELS[bucket].toLowerCase()} for ${formatDate(date)}.`
        : `Your call for ${formatDate(date)} could not be saved -- that session has already opened.`,
    );
  }

  const recent = board.resolved.slice(-HISTORY_STRIP_LENGTH);
  // The compact card's own mini strip (a smaller "handful", issue #186)
  // -- the same `resolved` history the full strip above slices from,
  // just to a shorter length so it fits inside the card's own corner.
  const summaryHistory = board.resolved.slice(-SUMMARY_HISTORY_LENGTH);
  // The issue's own spec for the first-visit state is "0/0%/0/0", so a
  // null win rate (nothing resolved yet) renders as 0% rather than a dash
  // -- there is no history for it to misrepresent, and a placeholder in
  // one of four otherwise-numeric tiles reads as broken rather than
  // honest. `winRate` stays null in the engine; only this display coerces.
  const winRateLabel = `${Math.round((stats.winRate ?? 0) * 100)}%`;
  const calledCount = board.openCalls.filter((call) => call.pick !== null).length;
  // The compact card's own corner badge state (issue #186) -- the same
  // done/partial/todo split `callsState` already gives the rest of this
  // app's status badges, applied here to "how many of the open calls are
  // filled in."
  const badgeState = callsState({ filled: calledCount, total: MAX_OPEN_CALLS });
  // e.g. "2 of 3 called this week" -- issue #164's own example status
  // line. `board.openCalls` is always `[]` before hydration (see
  // `UNHYDRATED_VIEW`), so this component never actually needs to branch
  // on `hydrated` to compute it; the branch below decides whether this
  // card (vs. the inert placeholder) renders at all.
  const statusLine = `${calledCount} of ${MAX_OPEN_CALLS} called this week`;

  return (
    <section aria-labelledby="call-board-heading" className="flex flex-col">
      {/* The mockup's own visible copy is the CTA title/subtitle below,
          not this string -- kept as a stable, sr-only landmark name so
          this section is always independently reachable/nameable
          regardless of whether the card has hydrated yet. */}
      <h2 id="call-board-heading" className="sr-only">
        The Call Board
      </h2>

      {!hydrated ? (
        <CallBoardPlaceholder />
      ) : (
        <details>
          <summary
            data-testid="call-board-summary"
            className={`${CARD_CLASSNAME} cursor-pointer list-none transition-transform duration-150 hover:-translate-y-0.5 hover:scale-[1.015] active:translate-y-0 active:scale-[0.99]`}
          >
            <CallBoardSummaryRow
              statusLine={statusLine}
              badgeState={badgeState}
              filledCount={calledCount}
              recentCalls={summaryHistory}
              currentStreak={stats.currentStreak}
            />
          </summary>

          {/* The expanded board's own, ordinary dark surface-card wrapper
              (see CARD_CLASSNAME's own doc comment above for why this
              isn't blue too) -- the same border/background treatment the
              collapsed tile used pre-#177, just now scoped to the body
              alone instead of the whole <details>. */}
          <div className="surface-card mt-3 flex flex-col gap-6 rounded-lg border border-[var(--gridline)] bg-[var(--surface-1)] px-4 pt-4 pb-5">
            {/* Always mounted, never conditionally rendered alongside the
                thing it announces -- the same idiom issue #67 established
                for the reveal announcement in ResultsPanel.tsx and
                WholeRangeBalance.tsx (a live region generally has to
                already exist in the accessibility tree before the
                mutation it should announce). aria-label disambiguates it
                from the other status regions on the page. */}
            <div
              role="status"
              aria-live="polite"
              aria-label="Call Board status"
              className="sr-only"
            >
              {announcement}
            </div>

            <p className="text-sm text-[var(--text-secondary)]">
              Call the next {MAX_OPEN_CALLS} trading sessions before they open. A move of{" "}
              {(STRONG_MOVE_THRESHOLD * 100).toFixed(1)}% or more counts as &ldquo;big.&rdquo; Tap a
              bucket and it saves straight away; you can change it right up until that session
              opens.
            </p>
            {/* The disclaimer/methodology footer (AboutSection) carries the
                full version of this; the short form belongs here too, where
                the prediction game actually is. */}
            <p className="text-xs text-[var(--text-muted)]">
              A practice game for seeing how hard short-term calls are -- not a prediction, and not
              advice.
            </p>

            {marketClosedToday ? (
              <p className="text-sm text-[var(--text-secondary)]">
                Markets are closed today, so the board is already looking ahead: these are the next{" "}
                {MAX_OPEN_CALLS} sessions.
              </p>
            ) : null}

            {/* One column at phone widths, three across from `sm` up -- the
                3-slot board must stack rather than squeeze four ~44px
                buckets into a third of a 375px viewport. */}
            <ul className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              {board.openCalls.map((call) => {
                const dateLabel = formatDate(call.date);
                return (
                  <li
                    key={call.date}
                    className="flex flex-col gap-2 rounded-lg border border-[var(--gridline)] bg-[var(--surface-2)] p-3"
                  >
                    <p className="text-sm font-medium text-[var(--text-primary)]">{dateLabel}</p>
                    <div
                      role="group"
                      aria-label={`Your call for ${dateLabel}`}
                      // Two across at phone widths (where a slot spans the
                      // full column and each button lands around 130px),
                      // one per row from `sm` up (where three slots share
                      // the row and a two-across grid leaves only ~90px --
                      // narrow enough that "Down big" wrapped onto a
                      // second line, making the 2x2 grid visibly ragged;
                      // caught by a real screenshot, not by the DOM
                      // assertions). A single column at that width also
                      // reads as a bullish-to-bearish ladder, which is the
                      // order CALL_BUCKETS is already in.
                      className="grid grid-cols-2 gap-2 sm:grid-cols-1"
                    >
                      {CALL_BUCKETS.map((bucket) => {
                        const isSelected = call.pick === bucket;
                        return (
                          <button
                            key={bucket}
                            type="button"
                            // Same aria-pressed toggle idiom RangeSelector and
                            // ModeToggle already use for their own pill groups.
                            aria-pressed={isSelected}
                            onClick={() => handleCall(call.date, bucket)}
                            // min-h-11/min-w-11 is 44px at this app's default
                            // root font size -- the touch-target floor issue
                            // #129 requires at a 375px viewport, set explicitly
                            // rather than left to whatever the padding happens
                            // to produce.
                            className={`flex min-h-11 min-w-11 items-center justify-center gap-1 rounded-md px-2 py-2 text-sm font-medium whitespace-nowrap transition-colors ${
                              isSelected
                                ? // --accent-selection, not --accent-reward: a
                                  // filled slot means "you picked", not "you
                                  // earned" (globals.css, issue #121).
                                  "bg-[var(--accent-selection)] text-white"
                                : "bg-[var(--surface-1)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                            }`}
                          >
                            <span aria-hidden="true" className="text-xs">
                              {BUCKET_GLYPHS[bucket]}
                            </span>
                            {BUCKET_LABELS[bucket]}
                          </button>
                        );
                      })}
                    </div>
                  </li>
                );
              })}
            </ul>

            <div className="flex flex-col gap-3">
              <h3 className="text-sm font-medium text-[var(--text-primary)]">Your record</h3>
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                <Stat
                  label="Calls resolved"
                  value={String(stats.resolvedCalls)}
                  colorClassName="text-[var(--text-primary)]"
                />
                <Stat
                  label="Win rate"
                  value={winRateLabel}
                  colorClassName="text-[var(--text-primary)]"
                />
                {/* Streak figures are --accent-reward's other documented job
                    (globals.css, issue #121) -- gold as a *glyph* colour,
                    which measures 8.08:1 on --surface-1, not as a fill. */}
                <Stat
                  label="Current streak"
                  value={String(stats.currentStreak)}
                  colorClassName="text-[var(--accent-reward)]"
                />
                <Stat
                  label="Best streak"
                  value={String(stats.bestStreak)}
                  colorClassName="text-[var(--accent-reward)]"
                />
              </div>
            </div>

            <div className="flex flex-col gap-3">
              <h3 className="text-sm font-medium text-[var(--text-primary)]">Recent calls</h3>
              {recent.length === 0 ? (
                <p className="text-sm text-[var(--text-muted)]">
                  Nothing has settled yet. Your calls show up here the day after each session
                  closes.
                </p>
              ) : (
                <>
                  <ol aria-label="Recently settled calls" className="flex flex-wrap gap-2">
                    {recent.map((call) => {
                      const outcome = callOutcomeFor(call);
                      const style = OUTCOME_STYLES[outcome];
                      return (
                        <li
                          key={call.date}
                          data-outcome={outcome}
                          className={`flex min-h-11 min-w-11 flex-col items-center justify-center rounded-md border px-2 py-1 ${style.className}`}
                        >
                          <span aria-hidden="true" className="text-base leading-none">
                            {style.glyph}
                          </span>
                          <span
                            aria-hidden="true"
                            className="mt-1 text-[10px] leading-none opacity-80"
                          >
                            {call.date.slice(5)}
                          </span>
                          <span className="sr-only">{historyCellDescription(call, outcome)}</span>
                        </li>
                      );
                    })}
                  </ol>
                  {/* The legend repeats each glyph next to its meaning, so the
                      strip is readable without relying on colour at all. */}
                  <ul aria-label="What each mark means" className="flex flex-wrap gap-x-4 gap-y-1">
                    {OUTCOME_ORDER.map((outcome) => {
                      const style = OUTCOME_STYLES[outcome];
                      return (
                        <li
                          key={outcome}
                          className={`flex items-center gap-1 text-xs ${style.legendClassName}`}
                        >
                          <span aria-hidden="true">{style.glyph}</span>
                          {style.label}
                        </li>
                      );
                    })}
                  </ul>
                </>
              )}
            </div>
          </div>
        </details>
      )}
    </section>
  );
}
