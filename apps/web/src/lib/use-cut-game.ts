"use client";

// The React layer over The Cut: reads/writes a range's game state
// against the real, precomputed Sp500PrefixResult -- the pure grading
// logic lives in the-cut-scoring.ts, the storage layer in
// the-cut-storage.ts; this file is the only place either gets called
// from React. Mirrors use-order-game.ts's own shape closely, adapted for
// a range-keyed (not date-keyed) game with a real attempt limit.

import { useCallback, useEffect, useState } from "react";

import type { PresetRange, Sp500PrefixResult } from "@hadiknowntrades/core";

import {
  CUT_MAX_ATTEMPTS,
  n500CurvePoint,
  scoreCutGuess,
  type CutGuessFeedback,
} from "./the-cut-scoring";
import {
  clearCutGameState,
  computeCutStreak,
  getCutGameHistory,
  getCutGameState,
  recordCutCompletion,
  saveCutGameState,
  type CutCompletedGame,
  type CutGameState,
  type CutStreakStats,
} from "./the-cut-storage";

export interface CutView {
  /**
   * `false` on the first render (server, hydration, and every render
   * before both the result has loaded and its range's own stored state
   * has been read) -- callers must render nothing storage-derived while
   * this is `false`, the same discipline use-order-game.ts's own
   * OrderView.hydrated already documents.
   */
  hydrated: boolean;
  state: CutGameState | null;
  /** This guess's grading for every guess already submitted this game, in the same order -- recomputed fresh from `result`/`state.guesses` on every render, never persisted itself (see use-cut-game.ts's own module header). */
  feedback: CutGuessFeedback[];
  streak: CutStreakStats;
  attemptsRemaining: number;
}

const UNHYDRATED_VIEW: CutView = {
  hydrated: false,
  state: null,
  feedback: [],
  streak: { currentStreak: 0, bestStreak: 0 },
  attemptsRemaining: CUT_MAX_ATTEMPTS,
};

function freshGameState(): CutGameState {
  return { guesses: [], done: false, won: false };
}

function gradeGuesses(guesses: readonly number[], result: Sp500PrefixResult): CutGuessFeedback[] {
  if (result.bestN === null) return [];
  const n500Point = n500CurvePoint(result.curve, result.universeSize);
  if (n500Point === null || result.bestEndingBalance === null) return [];
  return guesses.map((guess) =>
    scoreCutGuess({
      guess,
      bestN: result.bestN!,
      curve: result.curve,
      n500EndingBalance: n500Point.endingBalance,
      bestEndingBalance: result.bestEndingBalance!,
      universeSize: result.universeSize,
      startingCapital: result.startingCapital,
    }),
  );
}

function viewFor(
  state: CutGameState,
  result: Sp500PrefixResult,
  history: readonly CutCompletedGame[],
): CutView {
  const feedback = gradeGuesses(state.guesses, result);
  return {
    hydrated: true,
    state,
    feedback,
    streak: computeCutStreak(history),
    attemptsRemaining: Math.max(0, CUT_MAX_ATTEMPTS - state.guesses.length),
  };
}

export interface UseCutGameResult {
  view: CutView;
  submitGuess: (guess: number) => void;
  playAgain: () => void;
}

/**
 * `range`/`result` together identify which game to read/write --
 * `result` is `null` until its own fetch resolves (use-sp500-prefix.ts),
 * and this hook stays at UNHYDRATED_VIEW the whole time (there's nothing
 * to grade a stored guess against yet, and no real bestN to submit a new
 * one toward). Re-reads storage fresh whenever `range` changes (a new
 * range picked, or `result` itself changing because the range's own
 * fetch just resolved) -- the same "adjust state during render when a
 * value changes" idiom this app already uses in several places
 * (use-results.ts's trackedUrl, use-range-guess.ts's tracked), reached
 * here via re-running the same mount effect on every `[range, result]`
 * change rather than a bespoke render-time comparison, since (unlike
 * those two) there's a real async read (localStorage) to do, not just a
 * value to compare.
 */
export function useCutGame(range: PresetRange, result: Sp500PrefixResult | null): UseCutGameResult {
  const [view, setView] = useState<CutView>(UNHYDRATED_VIEW);

  useEffect(() => {
    // The whole body -- including the `result === null` reset -- is
    // deferred into a microtask rather than run as the effect's first
    // statement, the same shape use-hydrated-local-storage-state.ts/
    // use-order-game.ts both use to stay clear of
    // react-hooks/set-state-in-effect (which flags an unconditional
    // setState call synchronously at the top of an effect body,
    // regardless of which branch it's in).
    queueMicrotask(() => {
      if (result === null) {
        setView(UNHYDRATED_VIEW);
        return;
      }
      const existing = getCutGameState(range);
      setView(viewFor(existing ?? freshGameState(), result, getCutGameHistory()));
    });
  }, [range, result]);

  const submitGuess = useCallback(
    (guess: number) => {
      if (result === null || result.bestN === null || view.state === null || view.state.done) {
        return;
      }
      const guesses = [...view.state.guesses, guess];
      const correct = guess === result.bestN;
      const done = correct || guesses.length >= CUT_MAX_ATTEMPTS;
      const nextState: CutGameState = { guesses, done, won: correct };
      saveCutGameState(range, nextState);

      if (done) {
        const feedback = gradeGuesses(guesses, result);
        const lastEdgeCapturedPct = feedback.at(-1)?.edgeCapturedPct ?? 0;
        recordCutCompletion(range, correct, lastEdgeCapturedPct);
        setView(viewFor(nextState, result, getCutGameHistory()));
        return;
      }
      // Not done yet -- the streak history is unaffected, so there's no
      // need to re-read it; just recompute this game's own feedback/state.
      setView((current) => ({
        hydrated: true,
        state: nextState,
        feedback: gradeGuesses(guesses, result),
        streak: current.streak,
        attemptsRemaining: Math.max(0, CUT_MAX_ATTEMPTS - guesses.length),
      }));
    },
    [range, result, view.state],
  );

  const playAgain = useCallback(() => {
    clearCutGameState(range);
    if (result !== null) {
      setView(viewFor(freshGameState(), result, getCutGameHistory()));
    }
  }, [range, result]);

  return { view, submitGuess, playAgain };
}
