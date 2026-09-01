"use client";

// The React layer over The Order: reads/writes today's game state
// against the daily puzzle -- the pure move/shuffle/score functions live
// in order-scoring.ts, the storage layer in order-storage.ts; this file
// is the only place either gets called from React.
//
// Rewritten for the one-shot matching mechanic (see order-scoring.ts's
// own top-of-file note): `submit()` now always ends the day (there's
// only one guess to grade, not up to ORDER_MAX_ATTEMPTS of them), and
// `move`/`shuffle` no longer thread a `locked` array through, since
// nothing locks mid-game any more.

import { useCallback, useEffect, useState } from "react";

import type { TheOrderPuzzle } from "@hadiknowntrades/core";

import {
  bestToWorstTickers,
  initialOrderGuess,
  isPermutationOf,
  isWinningFeedback,
  moveOrderGuess,
  scoreOrderMatch,
  shuffleGuess,
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
    done: false,
    won: false,
    feedback: null,
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
      const answer = bestToWorstTickers(puzzle.tickers).map((t) => t.ticker);
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
      const nextGuess = moveOrderGuess(view.state.guess, index, dir);
      if (nextGuess === view.state.guess) return; // no legal move -- no-op
      persist({ ...view.state, guess: [...nextGuess] });
    },
    [puzzle, view.state, persist],
  );

  const shuffle = useCallback(() => {
    if (puzzle === null || view.state === null || view.state.done) return;
    const nextGuess = shuffleGuess(view.state.guess, Math.random);
    persist({ ...view.state, guess: [...nextGuess] });
  }, [puzzle, view.state, persist]);

  // The one and only submission -- always ends the day, whether it wins
  // or not (no more "attempts remaining" to carry forward).
  const submit = useCallback(() => {
    if (puzzle === null || view.state === null || view.state.done) return;
    const answer = bestToWorstTickers(puzzle.tickers).map((t) => t.ticker);
    const feedback = scoreOrderMatch(view.state.guess, answer);
    const won = isWinningFeedback(feedback);
    persist({ guess: [...view.state.guess], done: true, won, feedback });
  }, [puzzle, view.state, persist]);

  // A bail-out: replaces the guess with the real answer (rather than
  // leaving whatever the player last arranged), so every slot shows the
  // real ticker that belongs there -- feedback stays `null` since
  // nothing was actually graded, this is a flat reveal, not a scored
  // guess. Without this, `SlotRow` would just keep displaying the
  // player's own last arrangement with no per-slot correctness shown at
  // all (feedback === null renders no badge), which left a "Reveal
  // answer" click ending the day without ever actually revealing which
  // ticker belongs at which %.
  const reveal = useCallback(() => {
    if (puzzle === null || view.state === null || view.state.done) return;
    const answer = bestToWorstTickers(puzzle.tickers).map((t) => t.ticker);
    persist({ guess: [...answer], done: true, won: false, feedback: null });
  }, [puzzle, view.state, persist]);

  return { view, move, shuffle, submit, reveal };
}
