"use client";

// The React layer over The Order (issue #207): reads/writes today's game
// state against the daily puzzle -- the pure move/shuffle/score functions
// live in order-scoring.ts, the storage layer in order-storage.ts; this
// file is the only place either gets called from React.

import { useCallback, useEffect, useState } from "react";

import type { TheOrderPuzzle } from "@hadiknowntrades/core";

import {
  initialOrderGuess,
  isPermutationOf,
  isWinningFeedback,
  moveOrderGuess,
  scoreOrderGuess,
  shuffleUnlockedGuess,
  ORDER_MAX_ATTEMPTS,
  ORDER_SLOT_COUNT,
} from "./order-scoring";
import {
  computeOrderStreak,
  getOrderDayState,
  getOrderStreakHistory,
  recordOrderCompletion,
  saveOrderDayState,
  type OrderCompletedDay,
  type OrderDayState,
  type OrderStreakStats,
} from "./order-storage";

function freshDayState(answer: readonly string[], random: () => number): OrderDayState {
  return {
    guess: [...initialOrderGuess(answer, random)],
    attempt: 1,
    history: [],
    locked: Array<boolean>(ORDER_SLOT_COUNT).fill(false),
    done: false,
    won: false,
  };
}

export interface OrderView {
  /**
   * `false` on the first render (server, hydration, and every render
   * before the puzzle has both loaded and been read from storage).
   * Callers must render nothing clock/storage-derived while this is
   * `false` -- see this hook's own doc comment.
   */
  hydrated: boolean;
  state: OrderDayState | null;
  streak: OrderStreakStats;
}

const UNHYDRATED_VIEW: OrderView = {
  hydrated: false,
  state: null,
  streak: { currentStreak: 0, bestStreak: 0 },
};

function viewFor(state: OrderDayState, history: readonly OrderCompletedDay[]): OrderView {
  return { hydrated: true, state, streak: computeOrderStreak(history) };
}

export interface UseOrderGameResult {
  view: OrderView;
  move: (index: number, dir: 1 | -1) => void;
  shuffle: () => void;
  submit: () => void;
  reveal: () => void;
}

/**
 * `puzzle` is `null` until its own fetch resolves (use-the-order.ts) --
 * this hook stays at UNHYDRATED_VIEW the whole time, the same "nothing
 * clock/storage-derived before hydration" discipline use-call-board.ts's
 * own UNHYDRATED_VIEW establishes, extended here to also cover "before
 * the puzzle itself has loaded" (there's nothing to read stored state
 * *against* yet either way -- a stored OrderDayState is only meaningful
 * once the day's own real answer is known).
 *
 * **Safe to read localStorage the moment `puzzle` first becomes
 * non-null, with no further hydration boundary of its own needed**:
 * `puzzle` can only ever transition from `null` following a real
 * client-side fetch resolving (use-results.ts's `useFetchResultsState`
 * always starts every render -- server and the client's own hydration
 * render alike -- at `{status: "loading"}`), so by the time this
 * effect's own body ever runs with a non-null `puzzle`, the
 * server/hydration boundary has already safely passed -- the same
 * reasoning use-daily-guess.ts's own doc comment gives for its
 * identical synchronous-read shortcut, just reached one level removed
 * (through a fetch resolving, rather than a client-only render branch).
 */
export function useOrderGame(puzzle: TheOrderPuzzle | null): UseOrderGameResult {
  const [view, setView] = useState<OrderView>(UNHYDRATED_VIEW);

  useEffect(() => {
    if (puzzle === null) return;
    // Deferred into a microtask rather than run as the effect's first
    // statement, the same shape use-hydrated-local-storage-state.ts uses
    // to stay clear of react-hooks/set-state-in-effect.
    queueMicrotask(() => {
      const answer = puzzle.tickers.map((t) => t.ticker);
      const existing = getOrderDayState(puzzle.date, ORDER_SLOT_COUNT);
      // A stored OrderDayState is only trusted if its own guess is
      // actually a permutation of *this* puzzle's tickers -- matched by
      // date+slot-count alone (getOrderDayState's own check) isn't
      // enough, since a nightly rewrite of the same date's puzzle (e.g.
      // a manual backfill) with a different 5-ticker set would otherwise
      // leave stale persisted state silently misscoring against the new
      // answer array. Falling back to a fresh state here is the same
      // "treat unrecognized/inconsistent stored data as nothing stored"
      // discipline order-storage.ts's own malformed-shape handling
      // already applies -- just for a consistency check that shape
      // validation alone can't catch.
      const state =
        existing !== null && isPermutationOf(existing.guess, answer)
          ? existing
          : freshDayState(answer, Math.random);
      setView(viewFor(state, getOrderStreakHistory()));
    });
  }, [puzzle]);

  // Every action funnels through this: writes the next state through to
  // storage, records a streak-history entry the instant `done` first
  // goes true (recordOrderCompletion is idempotent per date, so calling
  // it again later on the same finished day is harmless).
  //
  // **`getOrderStreakHistory()` (a full localStorage read + JSON.parse +
  // filter over up to MAX_STORED_ORDER_DAYS stored days) is only called
  // on the `done` transition, not on every move/shuffle/submit** --
  // `currentStreak`/`bestStreak` can only actually change once, at that
  // transition (see OrderStreakStats/computeOrderStreak's own doc
  // comment), so re-reading it on every intermediate interaction was
  // unconditional wasted work. Every other call keeps the already-known
  // streak from `view` untouched via a functional setView update, rather
  // than re-deriving it from storage for a value that provably hasn't
  // changed.
  const persist = useCallback(
    (nextState: OrderDayState) => {
      if (puzzle === null) return;
      saveOrderDayState(puzzle.date, nextState);
      if (nextState.done) {
        recordOrderCompletion(puzzle.date, nextState.won);
        setView(viewFor(nextState, getOrderStreakHistory()));
        return;
      }
      setView((current) => ({ hydrated: true, state: nextState, streak: current.streak }));
    },
    [puzzle],
  );

  const move = useCallback(
    (index: number, dir: 1 | -1) => {
      if (puzzle === null || view.state === null || view.state.done) return;
      const nextGuess = moveOrderGuess(view.state.guess, view.state.locked, index, dir);
      if (nextGuess === view.state.guess) return; // no legal move -- no-op
      persist({ ...view.state, guess: [...nextGuess] });
    },
    [puzzle, view.state, persist],
  );

  const shuffle = useCallback(() => {
    if (puzzle === null || view.state === null || view.state.done) return;
    const nextGuess = shuffleUnlockedGuess(view.state.guess, view.state.locked, Math.random);
    persist({ ...view.state, guess: [...nextGuess] });
  }, [puzzle, view.state, persist]);

  const submit = useCallback(() => {
    if (puzzle === null || view.state === null || view.state.done) return;
    const answer = puzzle.tickers.map((t) => t.ticker);
    const { guess, attempt, history, locked } = view.state;
    const feedback = scoreOrderGuess(guess, answer);
    // A slot locks the instant it scores exact, for every remaining
    // attempt this day -- once locked, it stays locked even if a later
    // (impossible, since it can't move) guess would have scored it
    // differently.
    const nextLocked = locked.map((isLocked, i) => isLocked || feedback[i] === "exact");
    const won = isWinningFeedback(feedback);
    const outOfAttempts = attempt >= ORDER_MAX_ATTEMPTS;
    const done = won || outOfAttempts;
    persist({
      // The next editable row is seeded from the just-submitted
      // arrangement, not a fresh shuffle -- this is what lets a player
      // incrementally adjust rather than re-enter all 5 slots each time.
      guess: [...guess],
      attempt: done ? attempt : attempt + 1,
      history: [...history, { guess: [...guess], feedback }],
      locked: nextLocked,
      done,
      won,
    });
  }, [puzzle, view.state, persist]);

  const reveal = useCallback(() => {
    if (puzzle === null || view.state === null || view.state.done) return;
    persist({ ...view.state, done: true, won: false });
  }, [puzzle, view.state, persist]);

  return { view, move, shuffle, submit, reveal };
}
