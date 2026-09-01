"use client";

// The Order: match 5 real Magnificent Seven stocks to the % each one
// actually moved yesterday, best mover on top. Same grid position, same
// purple gradient/🏁 icon (issue #197's own choices, unchanged by this
// redesign).
//
// **Redesigned from the original issue #207 mechanic (direct user
// feedback, not a filed issue -- apps/web/CLAUDE.md's own "'Today's
// recap' removed outright..." section is the precedent for documenting a
// direct-request change this way).** Two problems with the original:
//
//   1. **The ordering read backwards.** Slots ran worst-to-best top to
//      bottom, so the day's best mover -- the stock you'd most want to
//      have spotted -- sat at the *bottom* of the list, position 5. That
//      reads against the grain of every "#1 = best" leaderboard
//      convention (a top-N chart, a race podium, a high-score list).
//      Fixed by flipping the ordering: best mover is now slot 1, at the
//      top; worst is the last slot, at the bottom -- and both ends
//      carry an explicit "Best"/"Worst" tag (SlotRow, below) so the
//      direction is unambiguous even before reading a single row.
//   2. **The real % moves were hidden until the puzzle ended**, and the
//      only feedback along the way was an abstract Mastermind-style
//      exact/close/far glyph, across up to 4 attempts. Fixed by showing
//      every slot's real % move up front, always -- the ordering itself
//      is no longer something to guess, it's given. What's left is a
//      pure matching puzzle: which ticker actually had which of the 5
//      already-visible returns. There's no partial credit for "close"
//      any more (a slot's assignment is either the real ticker or it
//      isn't), so this is a free rearrange-then-submit round -- no
//      attempt limit, no locking, one real submission per day. See
//      order-scoring.ts's own top-of-file note for the full mechanics
//      rationale.
//
// **Read in this order before touching this file**: order-scoring.ts
// (the pure match/move/shuffle functions this component calls, and the
// redesign's own reasoning), order-storage.ts (the persisted
// `OrderDayState` shape), and use-order-game.ts (the hook wiring the two
// together). The original design references (issue #189's parked
// design, issue #197's placeholder, docs/design/order-lineup-2026-08/)
// describe the pre-redesign Mastermind mechanic and are historical only
// -- don't treat their screenshots/scripts as the current spec.
//
// **Placement follows issue #122's standing decision** (see
// apps/web/CLAUDE.md), unchanged by this redesign: a self-contained
// section, taking no PrecomputedResult/range/mode/selectedDay props --
// this game is not a function of the hindsight result. Mounted at the
// same fixed grid position ResultsPage.tsx's own game-tile grid already
// gives it.
//
// **The expand mechanism is a native `<details>`/`<summary>`**, matching
// CallBoard.tsx's own pattern -- unchanged by this redesign.
//
// **No replay/reset once a day is done** -- unchanged by this redesign:
// a real daily puzzle with one true answer; once submitted or revealed,
// that day's result stands.

import { useId } from "react";

import type { TheOrderPuzzle } from "@hadiknowntrades/core";

import {
  bestToWorstTickers,
  formatOrderPctReturn,
  isValidOrderPuzzle,
  type OrderFeedback,
} from "@/lib/order-scoring";
import type { OrderDayState } from "@/lib/order-storage";
import { useOrderGame, type OrderView } from "@/lib/use-order-game";
import { useTheOrderPuzzle } from "@/lib/use-the-order";
import { GamePanelHeader } from "@/components/GamePanelHeader";

const ICON = "🏁";
const TITLE = "The Order";
const SUBTITLE = "Match each stock to the % it moved yesterday -- best mover on top.";

/**
 * The same purple gradient/shadow PlaceholderGameTile.tsx's own
 * `ORDER_GRADIENT_AND_SHADOW_CLASSNAME` already established for this
 * tile (issue #197) -- copied here as a literal rather than imported,
 * since that file no longer exports a `TheOrder` symbol at all once this
 * issue replaces it (only `TheLineup`, still a placeholder, remains
 * there). Every stop's white-text contrast was already independently
 * verified >= 4.5:1 AA against white when this literal was first
 * introduced (7.06:1 / 8.37:1 / 10.68:1) -- unchanged here, since the
 * color values themselves are unchanged by this mechanic redesign.
 */
const TILE_GRADIENT_STYLE = {
  backgroundImage: "linear-gradient(155deg, #6a3db8 0%, #5d36a1 55%, #4b2b82 100%)",
};
const TILE_SHADOW_CLASSNAME =
  "shadow-[0_8px_22px_rgba(93,54,161,0.35),0_6px_18px_rgba(0,0,0,0.35)]";
/** The gradient's own darkest stop -- the expanded panel's connector accent (matching CallBoard.tsx's own `CONNECTOR_ACCENT` device, issue #195). */
const CONNECTOR_ACCENT = "#4b2b82";

const CARD_BASE_CLASSNAME = "min-h-28 rounded-2xl text-white";

/**
 * WCAG-1.4.1-compliant glyph system for the one-shot grading: every slot
 * carries a real glyph *and* visible label text once done, never color
 * alone. Gold ("correct") is --accent-reward's documented "earned state"
 * job (globals.css, issue #121); a correctly matched slot is exactly
 * that.
 */
const OUTCOME_STYLES: Record<
  OrderFeedback,
  { glyph: string; label: string; badgeClassName: string }
> = {
  correct: {
    glyph: "★",
    label: "Correct",
    badgeClassName: "bg-[var(--accent-reward)] text-[#241a08]",
  },
  incorrect: {
    glyph: "✕",
    label: "Incorrect",
    badgeClassName: "border border-[var(--status-critical)] text-[var(--status-critical)]",
  },
};

/** The compact tile's own status line, mirroring compactStatusLine's (BeatTheBench.tsx) shape for the identical "collapsed card names the state in a few words" job. */
function tileStatusLine(state: OrderDayState | null): string {
  if (state === null) return "Not played yet";
  if (!state.done) return "In progress";
  if (state.won) return "Solved -- every stock matched";
  if (state.feedback !== null) {
    const correct = state.feedback.filter((entry) => entry === "correct").length;
    return `${correct} of ${state.feedback.length} correct`;
  }
  return "Revealed";
}

interface TileSummaryProps {
  headingId: string;
  statusLine: string;
}

/**
 * Shared between the pre-hydration/pre-fetch placeholder and the real
 * `<summary>` so the two can never drift in size (mirroring CallBoard.tsx's
 * own CallBoardSummaryRow doc comment on why that matters).
 */
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

/**
 * What renders before the puzzle has both loaded and been read from
 * storage -- a plain `<div>`, not `<details>`/`<summary>`, so there is no
 * focusable/toggleable element in the tree yet, mirroring CallBoard.tsx's
 * own `CallBoardPlaceholder`. Genuinely safe here: `useFetchResultsState`
 * (use-results.ts) always starts every render, server and the client's
 * own hydration render alike, at `{status: "loading"}`, so this branch is
 * what both of those renders take regardless of anything storage-derived.
 *
 * `aria-hidden` on purpose -- there is nothing here yet for assistive tech
 * to read, and the same content, in the same shape, will replace it the
 * moment the fetch actually resolves. **Only ever rendered for a genuinely
 * pending fetch** (see `TheOrder`'s own `puzzleFetchFailed` branch, which
 * renders `OrderErrorState` -- a real, visible message -- instead of this
 * for an actual failure, so a real error is never silently indistinguishable
 * from "still loading" the way it used to be).
 */
function OrderPlaceholder() {
  return (
    <div
      aria-hidden="true"
      style={TILE_GRADIENT_STYLE}
      className={`${CARD_BASE_CLASSNAME} ${TILE_SHADOW_CLASSNAME}`}
    >
      <TileSummaryRow headingId="the-order-placeholder-heading" statusLine=" " />
    </div>
  );
}

/**
 * What renders for a genuine fetch failure (a real HTTP/network error, or
 * a 200 response whose body doesn't actually satisfy `isValidOrderPuzzle`)
 * -- deliberately NOT `aria-hidden` and NOT the same element as
 * `OrderPlaceholder`, so a real failure is distinguishable both visually
 * (a visible message, not a silent shell) and for a screen-reader user
 * (who would otherwise get nothing at all from an `aria-hidden` node on a
 * real error). Mirrors BeatTheBench.tsx's own mystery-pool error branch
 * (`mysteryState.status === "error"`) -- same "no session to play right
 * now, published by the nightly run" framing, no retry button (there is
 * no refetch mechanism on `useFetchResultsState` to wire one to; a page
 * reload is the same recovery path BeatTheBench's own sibling error state
 * relies on too).
 */
function OrderErrorState() {
  return (
    <div
      data-testid="the-order-error"
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
        Couldn&apos;t load today&apos;s puzzle. The Order is published by the nightly run, shortly
        after the close -- try reloading in a bit.
      </p>
    </div>
  );
}

interface SlotRowProps {
  /** 1-based, slot 1 is the best mover (top). */
  rank: number;
  totalSlots: number;
  /** This slot's real % move -- always visible, the whole point of the redesign. */
  targetPctReturn: number;
  /** The ticker currently assigned to this slot by the player. */
  ticker: string;
  companyName: string;
  done: boolean;
  /** This slot's own grading, once `done` and a real guess was submitted -- `null` while still playing, or if the day ended via a bail-out reveal instead. */
  feedback: OrderFeedback | null;
  /** The ticker that actually belongs in this slot -- shown only when `feedback === "incorrect"`, so a player learns what they missed. */
  correctTicker: string;
  canMoveUp: boolean;
  canMoveDown: boolean;
  disabled: boolean;
  onMoveUp: () => void;
  onMoveDown: () => void;
}

function SlotRow({
  rank,
  totalSlots,
  targetPctReturn,
  ticker,
  companyName,
  done,
  feedback,
  correctTicker,
  canMoveUp,
  canMoveDown,
  disabled,
  onMoveUp,
  onMoveDown,
}: SlotRowProps) {
  const isGain = targetPctReturn >= 0;
  const isBest = rank === 1;
  const isWorst = rank === totalSlots;
  const outcome = feedback !== null ? OUTCOME_STYLES[feedback] : null;

  return (
    <li
      className={`flex items-center gap-3 rounded-lg border p-3 ${
        feedback === "correct"
          ? "border-[var(--accent-reward)] bg-[var(--accent-reward-wash)]"
          : feedback === "incorrect"
            ? "border-[var(--status-critical)] bg-[var(--surface-2)]"
            : "border-[var(--gridline)] bg-[var(--surface-2)]"
      }`}
    >
      <span className="flex w-9 shrink-0 flex-col items-center gap-0.5">
        <span
          aria-hidden="true"
          className="flex h-7 w-7 items-center justify-center rounded-full bg-[var(--surface-1)] text-xs font-bold text-[var(--text-secondary)]"
        >
          {rank}
        </span>
        {(isBest || isWorst) && (
          <span
            aria-hidden="true"
            className="text-center text-[0.5625rem] leading-none font-bold tracking-wide text-[var(--text-muted)] uppercase"
          >
            {isBest ? "Best" : "Worst"}
          </span>
        )}
      </span>

      <span
        className={`font-numeric w-[4.5rem] shrink-0 text-right text-sm font-bold ${
          isGain ? "text-[var(--status-good)]" : "text-[var(--status-critical)]"
        }`}
      >
        {formatOrderPctReturn(targetPctReturn)}
      </span>

      <span className="flex min-w-0 flex-1 flex-col">
        <span className="font-numeric text-sm font-semibold text-[var(--text-primary)]">
          {ticker}
        </span>
        <span className="truncate text-xs text-[var(--text-muted)]">{companyName}</span>
      </span>

      {done ? (
        outcome !== null && (
          <span className="flex shrink-0 flex-col items-end gap-0.5">
            <span
              className={`flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-bold ${outcome.badgeClassName}`}
            >
              <span aria-hidden="true">{outcome.glyph}</span>
              {outcome.label}
            </span>
            {feedback === "incorrect" && (
              <span className="text-[0.6875rem] text-[var(--text-muted)]">
                Actually {correctTicker}
              </span>
            )}
          </span>
        )
      ) : (
        <span className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={onMoveUp}
            disabled={disabled || !canMoveUp}
            aria-label={`Move ${ticker} toward best`}
            className="flex min-h-11 min-w-11 items-center justify-center rounded-md bg-[var(--surface-1)] text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-40"
          >
            <span aria-hidden="true">▲</span>
          </button>
          <button
            type="button"
            onClick={onMoveDown}
            disabled={disabled || !canMoveDown}
            aria-label={`Move ${ticker} toward worst`}
            className="flex min-h-11 min-w-11 items-center justify-center rounded-md bg-[var(--surface-1)] text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-40"
          >
            <span aria-hidden="true">▼</span>
          </button>
        </span>
      )}
    </li>
  );
}

interface OrderBoardProps {
  puzzle: TheOrderPuzzle;
  view: OrderView;
  move: (index: number, dir: 1 | -1) => void;
  shuffle: () => void;
  submit: () => void;
  reveal: () => void;
}

function OrderBoard({ puzzle, view, move, shuffle, submit, reveal }: OrderBoardProps) {
  const state = view.state;
  if (state === null) {
    return <p className="text-sm text-[var(--text-muted)]">Loading today&apos;s puzzle…</p>;
  }

  const targets = bestToWorstTickers(puzzle.tickers);
  const companyNameByTicker = new Map(puzzle.tickers.map((t) => [t.ticker, t.companyName]));
  const done = state.done;
  const correctCount = state.feedback?.filter((entry) => entry === "correct").length ?? null;

  const resultSentence = done
    ? state.won
      ? "Every stock matched -- perfect."
      : state.feedback !== null
        ? `${correctCount} of ${targets.length} correct.`
        : "Revealed. Here's how yesterday actually moved."
    : "";

  return (
    <div className="flex flex-col gap-5">
      <div role="status" aria-live="polite" aria-label="The Order status" className="sr-only">
        {resultSentence}
      </div>

      {!done && (
        <p className="text-sm text-[var(--text-secondary)]">
          Each row is real: yesterday&apos;s actual move, best to worst. Rearrange the five tickers
          until each one sits on the % you think it moved, then submit -- one guess, that&apos;s it.
        </p>
      )}

      <ol className="flex flex-col gap-2">
        {state.guess.map((ticker, index) => {
          const target = targets[index]!;
          return (
            <SlotRow
              key={ticker}
              rank={index + 1}
              totalSlots={targets.length}
              targetPctReturn={target.pctReturn}
              ticker={ticker}
              companyName={companyNameByTicker.get(ticker) ?? ticker}
              done={done}
              feedback={state.feedback?.[index] ?? null}
              correctTicker={target.ticker}
              canMoveUp={index > 0}
              canMoveDown={index < targets.length - 1}
              disabled={done}
              onMoveUp={() => move(index, -1)}
              onMoveDown={() => move(index, 1)}
            />
          );
        })}
      </ol>

      {!done && (
        <div className="flex flex-wrap items-center justify-end gap-2">
          <button
            type="button"
            onClick={shuffle}
            className="min-h-11 rounded-md border border-[var(--gridline)] bg-[var(--surface-1)] px-3 text-sm font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
          >
            Shuffle
          </button>
          <button
            type="button"
            onClick={submit}
            className="min-h-11 rounded-md bg-[var(--accent-selection)] px-3 text-sm font-semibold text-white"
          >
            Submit guess
          </button>
          <button
            type="button"
            onClick={reveal}
            className="min-h-11 rounded-md border border-[var(--gridline)] px-3 text-sm font-medium text-[var(--text-muted)] hover:text-[var(--text-secondary)]"
          >
            Reveal answer
          </button>
        </div>
      )}

      {done && (
        <div className="flex flex-col gap-4 rounded-lg border border-[var(--gridline)] bg-[var(--surface-2)] p-4">
          <p className="text-sm font-semibold text-[var(--text-primary)]">
            <span aria-hidden="true">{state.won ? "★" : state.feedback === null ? "⏱" : ""}</span>{" "}
            {resultSentence}
          </p>
          <div className="flex gap-6">
            <span className="flex flex-col gap-1">
              <span className="font-display text-2xl font-semibold tabular-nums text-[var(--accent-reward)]">
                {view.streak.currentStreak}
              </span>
              <span className="text-xs text-[var(--text-muted)]">Current streak</span>
            </span>
            <span className="flex flex-col gap-1">
              <span className="font-display text-2xl font-semibold tabular-nums text-[var(--accent-reward)]">
                {view.streak.bestStreak}
              </span>
              <span className="text-xs text-[var(--text-muted)]">Best streak</span>
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * The Order section.
 *
 * Takes no props on purpose (issue #122) -- not a function of the
 * hindsight result, so it mounts and plays regardless of how
 * /api/results goes.
 */
export function TheOrder() {
  const headingId = useId();
  const puzzleState = useTheOrderPuzzle();
  // Defensively re-checked client-side (see isValidOrderPuzzle's own doc
  // comment) rather than trusted purely from useFetchResultsState<TheOrderPuzzle>'s
  // static type -- a malformed/wrong-shaped 200 response must fall back
  // to the same "still loading" placeholder a genuinely pending fetch
  // already shows, not crash.
  const puzzle: TheOrderPuzzle | null =
    puzzleState?.status === "success" && isValidOrderPuzzle(puzzleState.data)
      ? (puzzleState.data as TheOrderPuzzle)
      : null;
  const { view, move, shuffle, submit, reveal } = useOrderGame(puzzle);

  const ready = puzzle !== null && view.hydrated;
  // A genuine fetch failure (a real HTTP/network error) or a 200 that came
  // back with a malformed/wrong-shaped body (caught by isValidOrderPuzzle
  // above, which is why `puzzle` alone can't distinguish "still pending"
  // from "resolved to garbage") -- either way, this is not a fetch that
  // will ever resolve into a real puzzle on its own, so it must not render
  // the same aria-hidden, indefinitely-pending OrderPlaceholder a genuinely
  // in-flight fetch shows.
  const puzzleFetchFailed =
    puzzleState !== null &&
    puzzleState.status !== "loading" &&
    !(puzzleState.status === "success" && isValidOrderPuzzle(puzzleState.data));

  return (
    <section aria-labelledby={headingId}>
      <h2 id={headingId} className="sr-only">
        {TITLE}
      </h2>

      {puzzleFetchFailed ? (
        <OrderErrorState />
      ) : !ready ? (
        <OrderPlaceholder />
      ) : (
        <details className="group">
          <summary
            data-testid="the-order-summary"
            style={TILE_GRADIENT_STYLE}
            className={`${CARD_BASE_CLASSNAME} ${TILE_SHADOW_CLASSNAME} cursor-pointer list-none transition-transform duration-150 group-open:rounded-b-none hover:-translate-y-0.5 hover:scale-[1.015] group-open:hover:translate-y-0 group-open:hover:scale-100 active:translate-y-0 active:scale-[0.99]`}
          >
            <TileSummaryRow
              headingId={`${headingId}-tile`}
              statusLine={tileStatusLine(view.state)}
            />
          </summary>

          <div
            data-testid="the-order-panel"
            className="flex flex-col gap-6 rounded-t-none rounded-b-2xl border-x border-b border-t-4 border-[var(--gridline)] bg-[var(--surface-1)] px-4 pt-4 pb-5"
            style={{ borderTopColor: CONNECTOR_ACCENT }}
          >
            <GamePanelHeader icon={ICON} accentColor={CONNECTOR_ACCENT} title={TITLE} />

            <OrderBoard
              puzzle={puzzle}
              view={view}
              move={move}
              shuffle={shuffle}
              submit={submit}
              reveal={reveal}
            />
          </div>
        </details>
      )}
    </section>
  );
}
