"use client";

// The Order (issue #207): rearrange 5 real Magnificent Seven stocks into
// yesterday's actual worst-to-best performance order, with Mastermind-
// style per-slot feedback and a locking mechanic -- replacing
// PlaceholderGameTile.tsx's non-functional `TheOrder` export in place.
// Same grid position, same purple gradient/🏁 icon (issue #197's own
// choices, unchanged by this issue).
//
// **Read in this order before touching this file**: issue #189 (the
// original parked design), issue #197 (the placeholder this replaces),
// docs/design/order-lineup-2026-08/{README.md,spec-the-order.md} (the
// real design reference -- README.md states what changed after the spec
// was written), and critically mockup-order-lineup.html's own `<script>`
// (the "THE ORDER" section), which every scoring/locking/move function in
// lib/order-scoring.ts is ported from directly -- treated as executable
// spec, not just its screenshots.
//
// **Placement follows issue #122's standing decision**, the same as
// BeatTheBench/CallBoard: a self-contained section, taking no
// PrecomputedResult/range/mode/selectedDay props -- this game is not a
// function of the hindsight result. Mounted at the same fixed grid
// position ResultsPage.tsx's own game-tile grid already gives it (issue
// #196's own Out of scope: this game has no play state to rank by and
// stays pinned there, not part of that sibling issue's reordering).
//
// **The expand mechanism is a native `<details>`/`<summary>`, matching
// CallBoard.tsx's own pattern** -- not BeatTheBench.tsx's stateful
// `useState` toggle. Unlike Beat the Bench, there's no running interval
// to stop on collapse; this game's own React state is fine left mounted
// (just `display: none`'d) while the tile is collapsed, and localStorage
// already persists progress across a real unmount/remount regardless.
//
// **No replay/reset once a day is done** -- a deliberate scope call, not
// an oversight: unlike Beat the Bench (whose own Judgment-calls section
// explicitly allows a replay to overwrite the stored record), this is a
// real daily puzzle with one true answer; once solved, out of guesses,
// or revealed, that day's result stands. The mockup's own "Try another
// shuffle" button exists purely for demo repeatability and is not
// reproduced here.

import { useId } from "react";

import type { TheOrderPuzzle } from "@hadiknowntrades/core";

import {
  formatOrderPctReturn,
  isValidOrderPuzzle,
  nextOpenSlot,
  ORDER_MAX_ATTEMPTS,
  type OrderFeedback,
} from "@/lib/order-scoring";
import type { OrderDayState } from "@/lib/order-storage";
import { useOrderGame, type OrderView } from "@/lib/use-order-game";
import { useTheOrderPuzzle } from "@/lib/use-the-order";
import { GamePanelHeader } from "@/components/GamePanelHeader";

const ICON = "🏁";
const TITLE = "The Order";
const SUBTITLE = "Rearrange 5 real stocks into yesterday's actual worst-to-best order.";

/**
 * The same purple gradient/shadow PlaceholderGameTile.tsx's own
 * `ORDER_GRADIENT_AND_SHADOW_CLASSNAME` already established for this
 * tile (issue #197) -- copied here as a literal rather than imported,
 * since that file no longer exports a `TheOrder` symbol at all once this
 * issue replaces it (only `TheLineup`, still a placeholder, remains
 * there). Every stop's white-text contrast was already independently
 * verified >= 4.5:1 AA against white when this literal was first
 * introduced (7.06:1 / 8.37:1 / 10.68:1) -- unchanged here, since the
 * color values themselves are unchanged.
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
 * WCAG-1.4.1-compliant glyph system (spec-the-order.md's own "Feedback
 * mechanics" table), directly modeled on CallBoard.tsx's own
 * OUTCOME_STYLES: every cell carries a real glyph *and* an sr-only
 * sentence, on top of color -- never color alone. Gold ("exact") is
 * --accent-reward's documented "earned state" job (globals.css, issue
 * #121); an exact slot is exactly that.
 */
const OUTCOME_STYLES: Record<
  OrderFeedback,
  { glyph: string; label: string; className: string; legendClassName: string }
> = {
  exact: {
    glyph: "★",
    label: "Exact position",
    className:
      "border-[var(--accent-reward)] bg-[var(--accent-reward-wash)] text-[var(--accent-reward)]",
    legendClassName: "text-[var(--accent-reward)]",
  },
  close: {
    glyph: "~",
    label: "Close -- off by one",
    className: "border-[var(--baseline)] bg-[var(--surface-2)] text-[var(--text-secondary)]",
    legendClassName: "text-[var(--text-secondary)]",
  },
  far: {
    glyph: "✕",
    label: "Far off",
    className:
      "border-[var(--status-critical)] bg-[var(--surface-2)] text-[var(--status-critical)]",
    legendClassName: "text-[var(--status-critical)]",
  },
};

const OUTCOME_ORDER: readonly OrderFeedback[] = ["exact", "close", "far"];

/** The compact tile's own status line, mirroring compactStatusLine's (BeatTheBench.tsx) shape for the identical "collapsed card names the state in a few words" job. */
function tileStatusLine(state: OrderDayState | null): string {
  if (state === null) return "Not played yet";
  if (!state.done) return `Attempt ${state.attempt} of ${ORDER_MAX_ATTEMPTS}`;
  return state.won
    ? `Solved in ${state.history.length} of ${ORDER_MAX_ATTEMPTS}`
    : "Out of guesses";
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

function SlotRow({
  rank,
  ticker,
  companyName,
  locked,
  canMoveUp,
  canMoveDown,
  disabled,
  onMoveUp,
  onMoveDown,
}: {
  rank: number;
  ticker: string;
  companyName: string;
  locked: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  disabled: boolean;
  onMoveUp: () => void;
  onMoveDown: () => void;
}) {
  return (
    <li
      className={`flex items-center gap-3 rounded-lg border p-3 ${
        locked
          ? "border-[var(--accent-reward)] bg-[var(--accent-reward-wash)]"
          : "border-[var(--gridline)] bg-[var(--surface-2)]"
      }`}
    >
      <span
        aria-hidden="true"
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--surface-1)] text-xs font-bold text-[var(--text-secondary)]"
      >
        {rank}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="font-numeric text-sm font-semibold text-[var(--text-primary)]">
          {ticker}
        </span>
        <span className="truncate text-xs text-[var(--text-muted)]">{companyName}</span>
      </span>
      {locked ? (
        <span className="flex shrink-0 items-center gap-1 rounded-full bg-[var(--accent-reward)] px-2.5 py-1 text-xs font-bold text-[#241a08]">
          <span aria-hidden="true">★</span> Locked
        </span>
      ) : (
        <span className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={onMoveUp}
            disabled={disabled || !canMoveUp}
            aria-label={`Move ${ticker} toward worst`}
            className="flex min-h-11 min-w-11 items-center justify-center rounded-md bg-[var(--surface-1)] text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-40"
          >
            <span aria-hidden="true">▲</span>
          </button>
          <button
            type="button"
            onClick={onMoveDown}
            disabled={disabled || !canMoveDown}
            aria-label={`Move ${ticker} toward best`}
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

  const companyNameByTicker = new Map(puzzle.tickers.map((t) => [t.ticker, t.companyName]));
  const answer = puzzle.tickers.map((t) => t.ticker);
  const done = state.done;

  return (
    <div className="flex flex-col gap-5">
      <div role="status" aria-live="polite" aria-label="The Order status" className="sr-only">
        {done
          ? state.won
            ? `Solved in ${state.history.length} of ${ORDER_MAX_ATTEMPTS}.`
            : "Out of guesses. The real order is revealed below."
          : state.history.length > 0
            ? `Attempt ${state.history.length} submitted.`
            : ""}
      </div>

      <p className="text-sm text-[var(--text-secondary)]">
        A slot that scores exact stays put for every attempt after that -- locked and highlighted
        gold, so each remaining guess only reorders what&apos;s still actually unresolved.
      </p>

      <ol className="flex flex-col gap-2">
        {state.guess.map((ticker, index) => (
          <SlotRow
            key={ticker}
            rank={index + 1}
            ticker={ticker}
            companyName={companyNameByTicker.get(ticker) ?? ticker}
            locked={state.locked[index] ?? false}
            canMoveUp={nextOpenSlot(state.locked, index, -1) !== -1}
            canMoveDown={nextOpenSlot(state.locked, index, 1) !== -1}
            disabled={done}
            onMoveUp={() => move(index, -1)}
            onMoveDown={() => move(index, 1)}
          />
        ))}
      </ol>

      {!done && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="font-numeric text-sm text-[var(--text-secondary)]">
            {/* One text node, deliberately -- an earlier version wrapped
                the two numbers in their own <b> tags for emphasis, which
                splits "Attempt 1 of 4" across three text nodes and breaks
                a plain getByText/toHaveTextContent match against the
                whole phrase (found live, by a real component test, not
                assumed). Not worth chasing the visual emphasis back with
                a custom text-matcher function at every call site either
                -- one plain string is simpler and exactly as readable. */}
            Attempt {state.attempt} of {ORDER_MAX_ATTEMPTS}
          </span>
          <div className="flex gap-2">
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
        </div>
      )}

      {state.history.length > 0 && (
        <div className="flex flex-col gap-2">
          <p className="text-xs font-medium text-[var(--text-muted)]">Past guesses</p>
          <ol className="flex flex-col gap-1">
            {state.history.map((entry, attemptIndex) => (
              <li key={attemptIndex} className="flex items-center gap-2">
                <span className="font-numeric w-5 shrink-0 text-xs text-[var(--text-muted)]">
                  #{attemptIndex + 1}
                </span>
                <span className="flex gap-1">
                  {entry.feedback.map((feedback, slotIndex) => {
                    const style = OUTCOME_STYLES[feedback];
                    const ticker = entry.guess[slotIndex]!;
                    return (
                      <span
                        key={slotIndex}
                        className={`flex h-6 w-6 items-center justify-center rounded-full border text-xs font-bold ${style.className}`}
                      >
                        <span aria-hidden="true">{style.glyph}</span>
                        <span className="sr-only">{historyCellDescription(ticker, feedback)}</span>
                      </span>
                    );
                  })}
                </span>
              </li>
            ))}
          </ol>
        </div>
      )}

      <ul aria-label="What each mark means" className="flex flex-wrap gap-x-4 gap-y-1">
        {OUTCOME_ORDER.map((feedback) => {
          const style = OUTCOME_STYLES[feedback];
          return (
            <li
              key={feedback}
              className={`flex items-center gap-1 text-xs ${style.legendClassName}`}
            >
              <span aria-hidden="true">{style.glyph}</span>
              {style.label}
            </li>
          );
        })}
      </ul>

      {done && (
        <div className="flex flex-col gap-4 rounded-lg border border-[var(--gridline)] bg-[var(--surface-2)] p-4">
          <p className="text-sm font-semibold text-[var(--text-primary)]">
            <span aria-hidden="true">{state.won ? "★" : "⏱"}</span>{" "}
            {state.won
              ? `Solved in ${state.history.length} of ${ORDER_MAX_ATTEMPTS}.`
              : "Out of guesses."}
            <br />
            <span className="text-xs font-normal text-[var(--text-secondary)]">
              Here&apos;s how yesterday actually ranked, worst to best.
            </span>
          </p>
          <ol className="flex flex-col gap-1">
            {answer.map((ticker, index) => {
              const info = puzzle.tickers.find((t) => t.ticker === ticker)!;
              const isGain = info.pctReturn >= 0;
              return (
                <li key={ticker} className="flex items-center gap-3 text-sm">
                  <span className="font-numeric w-5 shrink-0 text-[var(--text-muted)]">
                    {index + 1}
                  </span>
                  <span className="font-numeric font-semibold text-[var(--text-primary)]">
                    {ticker}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[var(--text-muted)]">
                    {info.companyName}
                  </span>
                  <span
                    className={`font-numeric font-semibold ${
                      isGain ? "text-[var(--status-good)]" : "text-[var(--status-critical)]"
                    }`}
                  >
                    {formatOrderPctReturn(info.pctReturn)}
                  </span>
                </li>
              );
            })}
          </ol>
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

function historyCellDescription(ticker: string, feedback: OrderFeedback): string {
  if (feedback === "exact") return `${ticker}: exact position.`;
  if (feedback === "close") return `${ticker}: close, off by one position.`;
  return `${ticker}: far off.`;
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
