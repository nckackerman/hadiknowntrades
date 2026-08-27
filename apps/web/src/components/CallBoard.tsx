"use client";

// The Call Board's player-facing surface (issue #129): three editable
// slots for the next three trading sessions, a history strip of recently
// settled calls, and the stats row.
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

import { useState } from "react";

import {
  CALL_BUCKETS,
  MAX_OPEN_CALLS,
  STRONG_MOVE_THRESHOLD,
  type CallBucket,
  type ResolvedCall,
} from "@/lib/call-board-scoring";
import { formatDate } from "@/lib/format-date";
import { formatPercent } from "@/lib/format-currency";
import { useCallBoard, useCallBoardCloses } from "@/lib/use-call-board";

/** How many settled calls the history strip shows, newest last. */
export const HISTORY_STRIP_LENGTH = 10;

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

/** One slot on the board. A `null` date is a pre-hydration placeholder (see `PLACEHOLDER_SLOTS`). */
interface BoardSlot {
  date: string | null;
  pick: CallBucket | null;
}

/**
 * What the board renders before `useCallBoard`'s mount-time correction:
 * `MAX_OPEN_CALLS` inert slots, identical in size to the real ones.
 *
 * The first render deliberately reads neither the clock nor localStorage
 * (see `UNHYDRATED_VIEW`'s own doc comment for the full reasoning), so
 * there is genuinely nothing to put in the slots yet -- and rendering the
 * section without them would collapse its height and shift the page the
 * instant the real board arrived.
 */
const PLACEHOLDER_SLOTS: readonly BoardSlot[] = Array.from({ length: MAX_OPEN_CALLS }, () => ({
  date: null,
  pick: null,
}));

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

/**
 * The Call Board section.
 *
 * Takes no props on purpose (issue #122) -- it is not a function of the
 * hindsight result, and keeping it result-independent is what lets it
 * mount above ResultsPanel's own fetch gate and stay playable when
 * /api/results is slow or failing.
 */
export function CallBoard() {
  const closes = useCallBoardCloses();
  const { view, makeCall } = useCallBoard(closes);
  const { board, marketClosedToday } = view;
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

  const slots: readonly BoardSlot[] = view.hydrated ? board.openCalls : PLACEHOLDER_SLOTS;
  const recent = board.resolved.slice(-HISTORY_STRIP_LENGTH);
  // The issue's own spec for the first-visit state is "0/0%/0/0", so a
  // null win rate (nothing resolved yet) renders as 0% rather than a dash
  // -- there is no history for it to misrepresent, and a placeholder in
  // one of four otherwise-numeric tiles reads as broken rather than
  // honest. `winRate` stays null in the engine; only this display coerces.
  const winRateLabel = `${Math.round((stats.winRate ?? 0) * 100)}%`;

  return (
    <section
      aria-labelledby="call-board-heading"
      className="surface-card flex flex-col gap-6 rounded-lg border border-[var(--gridline)] bg-[var(--surface-1)] px-4 py-5"
    >
      {/* Always mounted, never conditionally rendered alongside the thing
          it announces -- the same idiom issue #67 established for the
          reveal announcement in ResultsPanel.tsx and WholeRangeBalance.tsx
          (a live region generally has to already exist in the
          accessibility tree before the mutation it should announce).
          aria-label disambiguates it from the other status regions on the
          page. */}
      <div role="status" aria-live="polite" aria-label="Call Board status" className="sr-only">
        {announcement}
      </div>

      <header className="flex flex-col gap-2">
        <h2
          id="call-board-heading"
          className="font-display text-lg font-semibold text-[var(--text-primary)]"
        >
          The Call Board
        </h2>
        <p className="text-sm text-[var(--text-secondary)]">
          Call the next {MAX_OPEN_CALLS} trading sessions before they open. A move of{" "}
          {(STRONG_MOVE_THRESHOLD * 100).toFixed(1)}% or more counts as &ldquo;big.&rdquo; Tap a
          bucket and it saves straight away; you can change it right up until that session opens.
        </p>
        {/* The disclaimer/methodology footer (AboutSection) carries the
            full version of this; the short form belongs here too, where
            the prediction game actually is. */}
        <p className="text-xs text-[var(--text-muted)]">
          A practice game for seeing how hard short-term calls are -- not a prediction, and not
          advice.
        </p>
      </header>

      {marketClosedToday ? (
        <p className="text-sm text-[var(--text-secondary)]">
          Markets are closed today, so the board is already looking ahead: these are the next{" "}
          {MAX_OPEN_CALLS} sessions.
        </p>
      ) : null}

      {/* One column at phone widths, three across from `sm` up -- the 3-slot
          board must stack rather than squeeze four ~44px buckets into a
          third of a 375px viewport. */}
      <ul className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {slots.map((call, index) => {
          // `date === null` is a pre-hydration placeholder (see
          // PLACEHOLDER_SLOTS): the same markup at the same size, with the
          // whole <li> out of the accessibility tree and every button
          // `disabled` -- so nothing focusable ever sits inside an
          // aria-hidden subtree, the ARIA-spec violation issue #96's own
          // review caught once for the truncated replay chart.
          const { date } = call;
          const isPlaceholder = date === null;
          // A non-breaking space, not an empty string: a whitespace-only
          // text node collapses away, which would leave a placeholder's own
          // date line zero-tall and defeat the point of reserving height.
          const dateLabel = date === null ? " " : formatDate(date);
          return (
            <li
              key={date ?? `placeholder-${index}`}
              aria-hidden={isPlaceholder || undefined}
              className="flex flex-col gap-2 rounded-lg border border-[var(--gridline)] bg-[var(--surface-2)] p-3"
            >
              <p className="text-sm font-medium text-[var(--text-primary)]">{dateLabel}</p>
              <div
                role="group"
                aria-label={isPlaceholder ? undefined : `Your call for ${dateLabel}`}
                // Two across at phone widths (where a slot spans the full
                // column and each button lands around 130px), one per row
                // from `sm` up (where three slots share the row and a
                // two-across grid leaves only ~90px -- narrow enough that
                // "Down big" wrapped onto a second line, making the 2x2
                // grid visibly ragged; caught by a real screenshot, not by
                // the DOM assertions). A single column at that width also
                // reads as a bullish-to-bearish ladder, which is the order
                // CALL_BUCKETS is already in.
                className="grid grid-cols-2 gap-2 sm:grid-cols-1"
              >
                {CALL_BUCKETS.map((bucket) => {
                  const isSelected = call.pick === bucket;
                  return (
                    <button
                      key={bucket}
                      type="button"
                      disabled={isPlaceholder}
                      // Same aria-pressed toggle idiom RangeSelector and
                      // ModeToggle already use for their own pill groups.
                      aria-pressed={isSelected}
                      onClick={date === null ? undefined : () => handleCall(date, bucket)}
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
          <Stat label="Win rate" value={winRateLabel} colorClassName="text-[var(--text-primary)]" />
          {/* Streak figures are --accent-reward's other documented job
              (globals.css, issue #121) -- gold as a *glyph* colour, which
              measures 8.08:1 on --surface-1, not as a fill. */}
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
            Nothing has settled yet. Your calls show up here the day after each session closes.
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
                    <span aria-hidden="true" className="mt-1 text-[10px] leading-none opacity-80">
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
    </section>
  );
}
