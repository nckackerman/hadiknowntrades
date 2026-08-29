"use client";

// The Lineup's real, playable surface (issue #208), replacing
// PlaceholderGameTile.tsx's own non-functional `TheLineup` export in
// place -- same grid position, same teal gradient/icon (unchanged,
// copied verbatim from that file's own `LINEUP_GRADIENT_AND_SHADOW_CLASSNAME`).
//
// **Read docs/design/order-lineup-2026-08/mockup-order-lineup.html's own
// <script> before touching this file** -- it's the executable spec this
// component ports, not just a screenshot reference. `lib/lineup-game.ts`
// is that port's pure logic half (classification, round submission,
// finished-board reconstruction); this file is the React/DOM half:
// layout, the autocomplete inputs, the letters-tried keyboard, and
// wiring `lib/lineup-storage.ts`'s persistence + `lib/use-lineup-result.ts`'s
// fetch together.
//
// Placement follows issue #122's standing decision, same as
// BeatTheBench.tsx/CallBoard.tsx: mounted by ResultsPage.tsx as a plain
// section, taking **no** PrecomputedResult/range/mode/selectedDay props.
// **Unlike those two, this tile is NOT wired into issue #196's
// game-tile-order history** -- issue #208's own Background explicitly
// says so (The Lineup has no play state to rank by and stays pinned at
// its current fixed grid position); `recordGameTileOpened` is never
// called here.
//
// **Two render depths for a finished day, not one** -- a real,
// deliberate scope call:
//   - **A live session** (still playing, or just finished this same
//     mount): the full mock experience -- the guess form, the "letters
//     tried" keyboard tracker, and the collapsible guess-history log all
//     stay visible throughout, exactly like the mock's own `finishLineup`
//     (which disables the inputs but leaves everything else on screen).
//   - **A reconstructed cold-reload view** (the day was already played
//     in an earlier session, so there's no live guess history to show):
//     just the finished grid, the legend, the result banner, and the
//     streak stats -- see `lib/lineup-storage.ts`'s own
//     `LineupPlayedResult.lockedColumns` and `lib/lineup-game.ts`'s
//     `reconstructFinishedCells` for how the grid is rebuilt without
//     needing to persist the full letter-by-letter history. The
//     "letters tried" tracker and the guess log both need that history,
//     which genuinely isn't there for this path -- rather than fake a
//     lighter version of either, they're simply omitted; the finished
//     grid itself already carries every letter that matters.

import { useEffect, useMemo, useRef, useState } from "react";

import { LINEUP_TICKER_POOL } from "@hadiknowntrades/core";

import {
  LINEUP_COLUMNS,
  LINEUP_MAX_ATTEMPTS,
  columnsSolvedCount,
  createLineupBoard,
  reconstructFinishedCells,
  submitLineupRound,
  tilesFilledCount,
  totalTilesCount,
  type LineupBoardState,
  type LineupCellState,
  type LineupLetterRank,
} from "@/lib/lineup-game";
import {
  computeLineupStreak,
  getLineupPlayedResult,
  saveLineupPlayedResult,
  type LineupStreak,
} from "@/lib/lineup-storage";
import { useLineupResult } from "@/lib/use-lineup-result";

/** Exact copy of PlaceholderGameTile.tsx's own teal gradient -- issue #208's own Scope: "don't touch those, they're already correct." */
const LINEUP_GRADIENT_AND_SHADOW_CLASSNAME =
  "bg-[linear-gradient(155deg,#297a72_0%,#246b64_55%,#1c544f_100%)] shadow-[0_8px_22px_rgba(36,107,100,0.35),0_6px_18px_rgba(0,0,0,0.35)]";
const CARD_CLASSNAME = `min-h-28 rounded-2xl text-white ${LINEUP_GRADIENT_AND_SHADOW_CLASSNAME}`;

const TILE_ICON = "🧩";
const TILE_TITLE = "The Lineup";
const TILE_SUBTITLE =
  "Fill in all 5 mystery tickers each round - 3 or 4 letters, hidden until play tells you.";

/**
 * A guess is legal for any (locked or not) column the instant it's a
 * real ticker from today's pool -- the same "never free text, never
 * labeled with its own length" rule spec-the-lineup.md's own
 * "Autocomplete/validation rule" section establishes, widened (per this
 * issue's own Scope) from the spec's original 3-letter-only pool to
 * every real 3- or 4-letter S&P 500 ticker.
 */
function isLegalGuess(guess: string): boolean {
  return LINEUP_TICKER_POOL.includes(guess);
}

// --- Tile visuals (glyph + color + sr-only text, WCAG 1.4.1) ----------

interface TileStyle {
  /** A small, always-visible corner glyph -- distinguishes rowmatch from colmatch (both otherwise dashed) without relying on color alone, on top of the border-style/color pairing below. */
  glyph: string;
  className: string;
}

const TILE_STYLES: Record<LineupCellState, TileStyle> = {
  mystery: {
    glyph: "",
    className:
      "border border-dashed border-[var(--gridline)] bg-[var(--surface-2)] text-[var(--text-muted)]",
  },
  exact: {
    glyph: "✓",
    className:
      "border border-[var(--status-good)] bg-[var(--status-good-wash,rgba(74,184,111,0.14))] text-[var(--status-good)]",
  },
  rowmatch: {
    glyph: "↔",
    className:
      "border border-dashed border-[var(--series-1)] bg-[var(--series-1-wash,rgba(57,135,229,0.12))] text-[var(--series-1)]",
  },
  colmatch: {
    glyph: "~",
    className:
      "border border-dashed border-[var(--text-muted)] bg-[var(--surface-3)] text-[var(--text-secondary)]",
  },
  absent: {
    glyph: "✕",
    className:
      "border border-[var(--status-critical)] bg-[var(--status-critical-wash,rgba(228,107,100,0.14))] text-[var(--text-muted)] line-through decoration-[var(--status-critical)]",
  },
  reveal: {
    glyph: "",
    className:
      "border border-dashed border-[var(--text-muted)] bg-[var(--surface-3)] text-[var(--text-secondary)]",
  },
  empty: {
    glyph: "–",
    className:
      "border border-[var(--gridline)] bg-[var(--surface-1)] text-[var(--text-muted)] opacity-60 font-normal",
  },
};

const CELL_STATE_LABEL: Record<LineupCellState, string> = {
  mystery: "not yet guessed",
  exact: "right ticker, right spot",
  rowmatch: "right spot, wrong ticker",
  colmatch: "right ticker, wrong spot",
  absent: "not in today's lineup",
  reveal: "revealed",
  empty: "this ticker has no letter here",
};

/** Legend order, matching the mock's own legend row -- best/most-informative first. */
const LEGEND_ORDER: readonly LineupCellState[] = [
  "exact",
  "rowmatch",
  "colmatch",
  "absent",
  "empty",
];
const LEGEND_LABEL: Record<LineupCellState, string> = {
  mystery: "",
  exact: "Right ticker, right spot",
  rowmatch: "Right spot, wrong ticker",
  colmatch: "Right ticker, wrong spot",
  absent: "Not in today's lineup",
  reveal: "",
  empty: "No letter here - solved, and shorter than 4",
};

function LineupTile({
  colIndex,
  rowIndex,
  state,
  letter,
}: {
  colIndex: number;
  rowIndex: number;
  state: LineupCellState;
  letter: string;
}) {
  const style = TILE_STYLES[state];
  const displayText = state === "mystery" ? "?" : state === "empty" ? "–" : letter;
  const srText =
    state === "mystery" || state === "empty"
      ? `Column ${colIndex + 1}, slot ${rowIndex + 1}: ${CELL_STATE_LABEL[state]}.`
      : `Column ${colIndex + 1}, slot ${rowIndex + 1}: letter ${letter}, ${CELL_STATE_LABEL[state]}.`;
  return (
    <div
      className={`font-numeric relative flex aspect-square w-full items-center justify-center rounded-md text-sm font-extrabold sm:text-base ${style.className}`}
    >
      <span aria-hidden="true">{displayText}</span>
      {style.glyph && (
        <span
          aria-hidden="true"
          className="absolute top-0.5 right-0.5 text-[0.55rem] leading-none opacity-80"
        >
          {style.glyph}
        </span>
      )}
      <span className="sr-only">{srText}</span>
    </div>
  );
}

// --- Letters-tried keyboard tracker ------------------------------------

const LETTER_RANK_STYLE: Record<LineupLetterRank, string> = {
  exact:
    "border-[var(--status-good)] bg-[var(--status-good-wash,rgba(74,184,111,0.14))] text-[var(--status-good)]",
  rowmatch:
    "border-[var(--series-1)] bg-[var(--series-1-wash,rgba(57,135,229,0.12))] text-[var(--series-1)]",
  colmatch:
    "border-dashed border-[var(--text-muted)] bg-[var(--surface-3)] text-[var(--text-secondary)]",
  absent:
    "border-[var(--status-critical)] bg-[var(--status-critical-wash,rgba(228,107,100,0.14))] text-[var(--text-muted)] opacity-60",
};

const LETTER_RANK_LABEL: Record<LineupLetterRank, string> = {
  exact: "right ticker, right spot.",
  rowmatch: "right spot, wrong ticker.",
  colmatch: "right ticker, wrong spot.",
  absent: "not in today's lineup.",
};

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");

function LineupKeyboard({ letterBest }: { letterBest: Partial<Record<string, LineupLetterRank>> }) {
  return (
    <div>
      <p className="mb-2 text-xs font-bold tracking-wide text-[var(--text-muted)] uppercase">
        Letters tried - best result seen anywhere on the board
      </p>
      <div className="flex flex-wrap gap-1">
        {ALPHABET.map((letter) => {
          const best = letterBest[letter];
          const label = best
            ? `Letter ${letter}, best result so far: ${LETTER_RANK_LABEL[best]}`
            : `Letter ${letter}: not tried yet.`;
          return (
            <span
              key={letter}
              role="img"
              aria-label={label}
              className={`font-numeric flex h-7 w-7 items-center justify-center rounded border text-xs font-bold ${
                best
                  ? LETTER_RANK_STYLE[best]
                  : "border-[var(--gridline)] bg-[var(--surface-2)] text-[var(--text-muted)]"
              }`}
            >
              {letter}
            </span>
          );
        })}
      </div>
    </div>
  );
}

// --- Compact card -------------------------------------------------------

function LineupSummaryRow({ statusLine, streak }: { statusLine: string; streak: LineupStreak }) {
  return (
    <span className="relative flex flex-col justify-between gap-4 p-5">
      <span className="flex flex-col gap-2">
        <span
          aria-hidden="true"
          className="flex h-11 w-11 items-center justify-center rounded-full bg-white/[0.16]"
        >
          <span className="text-3xl leading-none drop-shadow-[0_2px_4px_rgba(0,0,0,0.25)]">
            {TILE_ICON}
          </span>
        </span>
        <span className="flex flex-col gap-1">
          <span className="font-display text-lg leading-tight font-extrabold tracking-tight">
            {TILE_TITLE}
          </span>
          <span className="text-xs font-medium text-white/85">{TILE_SUBTITLE}</span>
        </span>
      </span>
      <span className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-2">
          <span className="font-numeric rounded-full bg-white/20 px-2.5 py-1 text-[0.6875rem] font-bold">
            {statusLine}
          </span>
          {/* Gold streak chip, matching CallBoard.tsx's own shipped precedent -- shown only once a real streak exists (spec-the-lineup.md's own retention-mechanic recommendation). */}
          {streak.bestStreak > 0 && (
            <span
              aria-label={`Current streak: ${streak.currentStreak}`}
              className="font-numeric rounded-full bg-white/20 px-1.5 py-0.5 text-[0.65rem] font-bold"
            >
              <span aria-hidden="true">🔥 {streak.currentStreak}</span>
            </span>
          )}
        </span>
        <span aria-hidden="true" className="shrink-0 text-xs font-semibold text-white/70">
          ▸
        </span>
      </span>
    </span>
  );
}

function LineupPlaceholder() {
  return (
    <div aria-hidden="true" className={CARD_CLASSNAME}>
      <LineupSummaryRow statusLine=" " streak={{ currentStreak: 0, bestStreak: 0 }} />
    </div>
  );
}

/**
 * What renders for a genuine fetch failure (a real HTTP/network error,
 * or a 200 response whose own tickers field doesn't actually carry
 * LINEUP_COLUMNS real tickers) -- deliberately NOT `aria-hidden` and NOT
 * the same element as `LineupPlaceholder`, so a real failure is
 * distinguishable both visually (a visible message, not a silent shell)
 * and for a screen-reader user (who would otherwise get nothing at all
 * from an `aria-hidden` node on a real error). Mirrors TheOrder.tsx's
 * own `OrderErrorState` (issue #207) / BeatTheBench.tsx's own
 * mystery-pool error branch -- same "no puzzle to play right now,
 * published by the nightly run" framing, no retry button (there is no
 * refetch mechanism on useFetchResultsState to wire one to; a page
 * reload is the same recovery path those siblings rely on too).
 */
function LineupErrorState() {
  return (
    <div data-testid="the-lineup-error" className={`${CARD_CLASSNAME} flex flex-col gap-2 p-5`}>
      <div className="flex items-center gap-3">
        <span
          aria-hidden="true"
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-white/[0.16]"
        >
          <span className="text-3xl leading-none drop-shadow-[0_2px_4px_rgba(0,0,0,0.25)]">
            {TILE_ICON}
          </span>
        </span>
        <span className="font-display text-lg leading-tight font-extrabold tracking-tight">
          {TILE_TITLE}
        </span>
      </div>
      <p className="text-xs font-medium text-white/85">
        Couldn&apos;t load today&apos;s lineup. The Lineup is published by the nightly run, shortly
        after the close - try reloading in a bit.
      </p>
    </div>
  );
}

// --- Autocomplete input --------------------------------------------------

function ColumnInput({
  index,
  value,
  disabled,
  onChange,
  onSubmit,
}: {
  index: number;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
  onSubmit: () => void;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const matches = useMemo(() => {
    const query = value.toUpperCase();
    if (query.length === 0) return [];
    return LINEUP_TICKER_POOL.filter((ticker) => ticker.startsWith(query)).slice(0, 6);
  }, [value]);

  useEffect(() => {
    if (!open) return;
    function onDocumentClick(event: MouseEvent) {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("click", onDocumentClick);
    return () => document.removeEventListener("click", onDocumentClick);
  }, [open]);

  return (
    <div ref={containerRef} className="relative">
      <label htmlFor={`lineup-input-${index}`} className="sr-only">
        Column {index + 1} guess
      </label>
      <input
        id={`lineup-input-${index}`}
        maxLength={4}
        autoComplete="off"
        disabled={disabled}
        value={value}
        placeholder={`Col ${index + 1}`}
        onChange={(event) => {
          onChange(event.target.value.toUpperCase());
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            setOpen(false);
            onSubmit();
          }
        }}
        className={`font-numeric w-full rounded-md border px-2 py-2 text-center text-sm tracking-wider uppercase ${
          disabled
            ? "border-[var(--status-good)] bg-[var(--status-good-wash,rgba(74,184,111,0.14))] text-[var(--status-good)]"
            : "border-[var(--gridline)] bg-[var(--surface-2)] text-[var(--text-primary)]"
        }`}
      />
      {open && matches.length > 0 && (
        <div className="absolute top-[calc(100%+0.3rem)] right-0 left-0 z-10 max-h-44 overflow-y-auto rounded-md border border-[var(--gridline)] bg-[var(--surface-2)] shadow-lg">
          {matches.map((ticker) => (
            <button
              key={ticker}
              type="button"
              className="font-numeric block w-full px-3 py-2 text-left text-sm text-[var(--text-primary)] hover:bg-[var(--surface-3)]"
              onClick={() => {
                onChange(ticker);
                setOpen(false);
                const next = document.getElementById(`lineup-input-${index + 1}`);
                if (next && !(next as HTMLInputElement).disabled) next.focus();
              }}
            >
              {ticker}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// --- Main component -------------------------------------------------------

interface LoadedState {
  date: string;
  tickers: readonly string[];
  board: LineupBoardState;
  /** True only for a board built fresh this mount (createLineupBoard) -- see this file's own header comment for what this gates. */
  liveSession: boolean;
  /**
   * Set at mount (before today's game is decided) and re-set by
   * handleSubmit the instant a round finishes the game (board.done) --
   * never left stale across that transition. A win/lose banner showing
   * yesterday's streak instead of the streak today's own outcome just
   * produced (extended, or broke) would be a visibly wrong number on
   * the exact screen making the claim.
   */
  streak: LineupStreak;
}

export function TheLineup() {
  const result = useLineupResult();
  const [loaded, setLoaded] = useState<LoadedState | null>(null);
  const [drafts, setDrafts] = useState<string[]>(["", "", "", "", ""]);
  const [shakeToken, setShakeToken] = useState<number | null>(null);
  const [malformedTickers, setMalformedTickers] = useState(false);
  const initializedForDate = useRef<string | null>(null);

  // Runs once per newly-fetched day (guarded by initializedForDate so a
  // re-render doesn't stomp an in-progress session): reads storage for
  // today's date, and either reconstructs a finished view or starts a
  // fresh interactive board. Safe with no extra hydration ceremony --
  // `useLineupResult` never resolves to "success" before a client-only
  // effect runs (see use-results.ts), so this always runs well after
  // hydration, the same precondition use-daily-guess.ts's own shortcut
  // documents.
  useEffect(() => {
    if (result?.status !== "success") return;
    const { date, tickers } = result.data;
    // Defensive, not merely paranoid: getLineupResponse (results-api.ts)
    // already 502s server-side on a malformed tickers field, so a real
    // 200 response is guaranteed well-formed -- but this component still
    // shouldn't crash the whole page if that guarantee is ever violated
    // (a schema drift, a test fixture standing in for an unrelated
    // route's fetch). Renders a distinguishable, visible error state
    // instead (see `fetchFailed`/`LineupErrorState` below) rather than
    // silently staying on the placeholder forever -- a real regression
    // here must not ship silently indistinguishable from "still
    // loading."
    if (!Array.isArray(tickers) || tickers.length !== LINEUP_COLUMNS) {
      console.error(
        `[TheLineup] /api/lineup returned a malformed tickers field (expected ${LINEUP_COLUMNS} real tickers): ${JSON.stringify(tickers)}`,
      );
      // Deferred into a microtask, same reasoning as the "well-formed"
      // branch's own queueMicrotask below -- calling setState directly
      // in the effect body trips react-hooks/set-state-in-effect.
      queueMicrotask(() => setMalformedTickers(true));
      return;
    }
    if (initializedForDate.current === date) return;
    initializedForDate.current = date;

    // Deferred into a microtask rather than called as the effect's own
    // first statement -- the same shape use-call-board.ts's own sync
    // effect uses to stay clear of react-hooks/set-state-in-effect.
    queueMicrotask(() => {
      const stored = getLineupPlayedResult(date);
      const streak = computeLineupStreak();
      if (stored) {
        setLoaded({
          date,
          tickers,
          streak,
          liveSession: false,
          board: {
            answers: tickers,
            attempt: stored.guessesUsed,
            locked: stored.lockedColumns,
            lastGuess: tickers.map((t, i) => (stored.lockedColumns[i] ? t : "")),
            cells: reconstructFinishedCells(tickers, stored.lockedColumns),
            letterBest: {},
            log: [],
            done: true,
            won: stored.outcome === "won",
          },
        });
      } else {
        setLoaded({ date, tickers, streak, liveSession: true, board: createLineupBoard(tickers) });
      }
    });
  }, [result]);

  function handleSubmit() {
    if (!loaded || loaded.board.done) return;
    const attemptResult = submitLineupRound(loaded.board, drafts, isLegalGuess);
    if (!attemptResult.valid) {
      setShakeToken(Date.now());
      return;
    }
    const board = attemptResult.state;
    // Keep each column's own last-submitted text visible, matching the
    // mock's own refreshLineupInputs -- an unlocked column echoes its
    // last guess; a newly-locked column's own input takes over from the
    // grid instead (disabled, showing the real answer).
    setDrafts(board.lastGuess.map((guess, i) => (board.locked[i] ? "" : guess)));

    if (board.done) {
      saveLineupPlayedResult({
        date: loaded.date,
        outcome: board.won ? "won" : "lost",
        guessesUsed: board.attempt,
        columnsSolved: columnsSolvedCount(board),
        tilesFilled: tilesFilledCount(board),
        totalTiles: totalTilesCount(board.answers),
        lockedColumns: board.locked,
      });
      // The win/lose banner's own streak stats must reflect *today's*
      // just-finished outcome, not just whatever streak existed before
      // this round started -- `loaded.streak` was computed once at
      // mount, before today's game was decided, so it's stale the
      // instant a round finishes (a win that extends a streak, or a
      // loss that breaks one, both need to show immediately, not only
      // after a reload). Recomputed fresh from storage now that
      // saveLineupPlayedResult above has actually written today's
      // result into the history computeLineupStreak reads.
      setLoaded({ ...loaded, board, streak: computeLineupStreak() });
    } else {
      setLoaded({ ...loaded, board });
    }
  }

  // Derived straight from the board itself, live or reconstructed alike
  // -- both shapes already carry everything the pill needs
  // (won/attempt/locked), so there's no reason to re-read storage here.
  const statusLine = !loaded
    ? " "
    : !loaded.board.done
      ? "Not played yet today"
      : loaded.board.won
        ? `Solved in ${loaded.board.attempt}`
        : `${columnsSolvedCount(loaded.board)} of ${LINEUP_COLUMNS} solved`;
  const streak = loaded?.streak ?? { currentStreak: 0, bestStreak: 0 };

  // A genuine fetch failure (a real HTTP/network error) or a 200 that
  // came back with a malformed/wrong-shaped tickers field (caught by the
  // effect above, which is why `loaded` alone can't distinguish "still
  // pending" from "resolved to garbage") -- either way, this is not a
  // fetch that will ever resolve into a real board on its own, so it
  // must not render the same aria-hidden, indefinitely-pending
  // LineupPlaceholder a genuinely in-flight fetch shows.
  const fetchFailed = result?.status === "error" || malformedTickers;

  return (
    <section>
      <h2 id="the-lineup-heading" className="sr-only">
        The Lineup
      </h2>

      {fetchFailed ? (
        <LineupErrorState />
      ) : !loaded ? (
        <LineupPlaceholder />
      ) : (
        <details className="group">
          <summary
            data-testid="the-lineup-summary"
            className={`${CARD_CLASSNAME} cursor-pointer list-none transition-transform duration-150 group-open:rounded-b-none hover:-translate-y-0.5 hover:scale-[1.015] group-open:hover:translate-y-0 group-open:hover:scale-100 active:translate-y-0 active:scale-[0.99]`}
          >
            <LineupSummaryRow statusLine={statusLine} streak={streak} />
          </summary>

          <div
            data-testid="the-lineup-panel"
            className="flex flex-col gap-4 rounded-t-none rounded-b-2xl border-x border-b border-t-4 border-[var(--gridline)] bg-[var(--surface-1)] px-4 pt-4 pb-5"
            style={{ borderTopColor: "#1c544f" }}
          >
            <div
              role="status"
              aria-live="polite"
              aria-label="The Lineup status"
              className="sr-only"
            >
              {loaded.board.done
                ? loaded.board.won
                  ? `Solved all 5 in ${loaded.board.attempt} of ${LINEUP_MAX_ATTEMPTS} rounds.`
                  : `Out of guesses -- ${columnsSolvedCount(loaded.board)} of ${LINEUP_COLUMNS} solved.`
                : ""}
            </div>

            <div className="flex items-center gap-2">
              <span
                aria-hidden="true"
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-lg"
                style={{ backgroundColor: "#1c544f26" }}
              >
                {TILE_ICON}
              </span>
              <h3 className="text-sm font-medium text-[var(--text-primary)]">The Lineup</h3>
            </div>

            {loaded.liveSession && !loaded.board.done && (
              <p className="text-sm text-[var(--text-secondary)]">
                Each column hides a real ticker - 3 letters or 4, and you won&apos;t know which
                until play tells you. Guess all 5 at once each round: a letter can be right for this
                exact spot, right for this ticker but the wrong spot, right for this spot but a
                different ticker, or just not there. A slot that refuses to turn green no matter
                what you try is how you find out a ticker was shorter than you thought.
              </p>
            )}

            <div
              key={shakeToken ?? "no-shake"}
              className={`grid gap-1.5 sm:gap-2 ${shakeToken !== null ? "lineup-inputs-shake" : ""}`}
              style={{ gridTemplateColumns: `repeat(${LINEUP_COLUMNS}, 1fr)` }}
            >
              {loaded.board.cells.map((column, colIndex) => (
                <div key={colIndex} className="flex flex-col items-center gap-1">
                  <span className="font-numeric text-xs font-bold text-[var(--text-muted)]">
                    Col {colIndex + 1}
                  </span>
                  <div className="flex w-full flex-col gap-1">
                    {column.map((cell, rowIndex) => (
                      <LineupTile
                        key={rowIndex}
                        colIndex={colIndex}
                        rowIndex={rowIndex}
                        state={cell.state}
                        letter={cell.letter}
                      />
                    ))}
                  </div>
                </div>
              ))}
            </div>

            {loaded.liveSession && !loaded.board.done && (
              <form
                className="flex flex-col gap-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  handleSubmit();
                }}
              >
                <div
                  className="grid gap-1.5 sm:gap-2"
                  style={{ gridTemplateColumns: `repeat(${LINEUP_COLUMNS}, 1fr)` }}
                >
                  {loaded.board.answers.map((_, colIndex) => (
                    <ColumnInput
                      key={colIndex}
                      index={colIndex}
                      value={
                        loaded.board.locked[colIndex]
                          ? loaded.board.answers[colIndex]!
                          : (drafts[colIndex] ?? "")
                      }
                      disabled={loaded.board.locked[colIndex]}
                      onChange={(next) =>
                        setDrafts((prev) => prev.map((d, i) => (i === colIndex ? next : d)))
                      }
                      onSubmit={handleSubmit}
                    />
                  ))}
                </div>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <span className="font-numeric text-sm text-[var(--text-secondary)]">
                    Attempt <b className="text-[var(--text-primary)]">{loaded.board.attempt}</b> of{" "}
                    {LINEUP_MAX_ATTEMPTS}
                  </span>
                  <button
                    type="submit"
                    className="min-h-11 rounded-full bg-[var(--series-1)] px-5 py-2 text-sm font-bold text-white hover:bg-[#2f78d1]"
                  >
                    Submit guess
                  </button>
                </div>
              </form>
            )}

            <ul className="flex flex-wrap gap-x-4 gap-y-1 border-t border-[var(--gridline)] pt-3">
              {LEGEND_ORDER.map((state) => (
                <li
                  key={state}
                  className="flex items-center gap-1.5 text-xs text-[var(--text-secondary)]"
                >
                  <span
                    aria-hidden="true"
                    className={`flex h-5 w-5 items-center justify-center rounded text-[10px] font-bold ${TILE_STYLES[state].className}`}
                  >
                    {TILE_STYLES[state].glyph}
                  </span>
                  {LEGEND_LABEL[state]}
                </li>
              ))}
            </ul>

            {loaded.liveSession && <LineupKeyboard letterBest={loaded.board.letterBest} />}

            {loaded.liveSession && loaded.board.log.length > 0 && (
              <details className="text-xs text-[var(--text-secondary)]">
                <summary className="cursor-pointer font-semibold text-[var(--text-secondary)] hover:text-[var(--text-primary)]">
                  Guess history
                </summary>
                <div className="mt-2 flex max-h-32 flex-col gap-1 overflow-y-auto">
                  {[...loaded.board.log].reverse().map((entry) => (
                    <div key={entry.attempt} className="flex gap-2">
                      <b className="font-numeric w-9 shrink-0 text-[var(--text-primary)]">
                        #{entry.attempt}
                      </b>
                      <span>
                        {entry.guesses.join(", ")} - {entry.counts.exact} exact,{" "}
                        {entry.counts.rowmatch} right spot/wrong ticker, {entry.counts.colmatch}{" "}
                        right ticker/wrong spot, {entry.counts.absent} absent
                      </span>
                    </div>
                  ))}
                </div>
              </details>
            )}

            {loaded.board.done && (
              <div className="flex flex-col gap-3">
                <div
                  className={`flex items-center gap-3 rounded-lg p-3 ${
                    loaded.board.won
                      ? "border border-[rgba(232,163,61,0.4)] bg-[var(--accent-reward-wash)]"
                      : "border border-[var(--gridline)] bg-[var(--surface-2)]"
                  }`}
                >
                  <span aria-hidden="true" className="text-2xl">
                    {loaded.board.won ? "🎉" : "⏰"}
                  </span>
                  <p className="text-sm font-semibold text-[var(--text-primary)]">
                    {loaded.board.won
                      ? `Solved all 5 in ${loaded.board.attempt} of ${LINEUP_MAX_ATTEMPTS} rounds.`
                      : `Out of guesses - ${columnsSolvedCount(loaded.board)} of ${LINEUP_COLUMNS} solved.`}
                  </p>
                </div>
                <div className="flex gap-6">
                  <div className="flex flex-col gap-1">
                    <span className="font-display text-xl font-semibold text-[var(--accent-reward)]">
                      {streak.currentStreak}
                    </span>
                    <span className="text-xs text-[var(--text-muted)]">Current streak</span>
                  </div>
                  <div className="flex flex-col gap-1">
                    <span className="font-display text-xl font-semibold text-[var(--accent-reward)]">
                      {streak.bestStreak}
                    </span>
                    <span className="text-xs text-[var(--text-muted)]">Best streak</span>
                  </div>
                </div>
              </div>
            )}
          </div>
        </details>
      )}
    </section>
  );
}
