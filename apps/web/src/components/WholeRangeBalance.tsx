"use client";

import { useId, useState } from "react";
import type { FormEvent } from "react";

import { formatHeroCurrency } from "@/lib/format-currency";
import { rescaleFromStartingCapital } from "@/lib/rescale-starting-capital";

interface WholeRangeBalanceProps {
  /** Human-readable phrase for the range being guessed, e.g. "the past month" (RANGE_COPY[range]) -- used in the guess prompt's copy. */
  rangeLabel: string;
  /** The user's chosen display starting capital (issue #15). */
  startingCapital: number;
  /** The range's true final chained ending balance (issue #84), already rescaled to `startingCapital` from the range's own root -- see ResultsPanel's own `wholeRangeFinalBalance` doc comment for the exact (non-per-day) rescale this must use. */
  finalBalance: number;
  /** The user's stored guess for this (range, mode) pair, or `null` if they haven't guessed yet (see use-range-guess.ts). Non-null is what unlocks the reveal. */
  guess: number | null;
  /** The starting capital that was in effect when `guess` was submitted -- used to rescale the displayed "You guessed" figure if `startingCapital` has since changed (issue #15). */
  guessStartingCapital: number | null;
  /** Records a submitted guess, made while the prompt showed `startingCapital` above. */
  onSubmitGuess: (guess: number, startingCapital: number) => void;
}

/**
 * The whole-range running-balance headline (issue #84), and -- since
 * issue #91 -- this page's *only* guess-then-reveal control. "If you'd
 * time-traveled back to day one with $[X] and rode the *entire* window,
 * carrying each day's real result into the next, what would it actually
 * have become?"
 *
 * **Replaces per-day guessing entirely (issue #91).** Before this issue,
 * every individual day had its own guess-then-reveal prompt (removed:
 * see git history's DailyGuessForm.tsx), and this component was merely a
 * *count*-gated summary that unlocked once every day had been guessed.
 * That made browsing the range's own day-by-day breadth tedious --
 * guessing N things to see one summary. Now there is exactly one guess,
 * scoped to the whole range (backed by range-guess-storage.ts, keyed
 * per (range, mode) with no date dimension), and every individual day in
 * DayOverview/the day drill-down below is freely browsable without any
 * guessing at all. Revealing this headline is also what unlocks
 * `BenchmarkStat` and the whole-range chart in ResultsPanel.tsx -- the
 * only other two things on the page that would otherwise spoil this
 * same answer.
 *
 * **Announces its own masked -> unlocked transition to screen readers**:
 * an always-present `role="status" aria-live="polite"` `sr-only` region,
 * the same established shape issue #67's own per-day reveal announcement
 * used. A static sentence, not wired to any per-frame/animating value --
 * this component has no animation to guard against in the first place.
 */
export function WholeRangeBalance({
  rangeLabel,
  startingCapital,
  finalBalance,
  guess,
  guessStartingCapital,
  onSubmitGuess,
}: WholeRangeBalanceProps) {
  const [draft, setDraft] = useState("");
  const inputId = useId();

  const parsed = Number(draft);
  // Empty string coerces to 0 via Number(), which is a legitimate guess a
  // user might actually want to submit ("all-in trade wiped it out") --
  // the `draft.trim() !== ""` check is what actually distinguishes "field
  // left blank" from "typed 0", not the parsed value itself (same
  // reasoning the removed DailyGuessForm used).
  const isValid = draft.trim() !== "" && Number.isFinite(parsed) && parsed >= 0;

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!isValid) return;
    onSubmitGuess(parsed, startingCapital);
  }

  const revealed = guess !== null;

  return (
    <div className="surface-card flex flex-col gap-2 rounded-lg border border-[var(--gridline)] bg-[var(--surface-1)] px-4 py-4">
      <p className="text-sm font-medium text-[var(--text-muted)]">
        Whole-range running balance -- carried day to day, start to finish
      </p>
      {/* aria-label disambiguates this region from any other status region on the page. */}
      <div
        role="status"
        aria-live="polite"
        aria-label="Whole-range reveal status"
        className="sr-only"
      >
        {revealed
          ? `Whole-range running balance revealed: ${formatHeroCurrency(startingCapital)} to ${formatHeroCurrency(finalBalance)}.`
          : ""}
      </div>
      {revealed ? (
        <>
          <p className="flex flex-wrap items-baseline gap-3 text-xl font-semibold leading-none tracking-tight text-[var(--text-primary)] sm:text-2xl">
            <span>{formatHeroCurrency(startingCapital)}</span>
            <span aria-hidden="true" className="text-[var(--text-muted)]">
              →
            </span>
            <span className="text-[var(--series-1)]">{formatHeroCurrency(finalBalance)}</span>
          </p>
          <p className="text-sm text-[var(--text-muted)]">
            {/* guessStartingCapital may go stale relative to `startingCapital`
                if the user edits starting capital after revealing -- rescale
                the same way every other dollar figure on this page does
                (see ResultsPanel.tsx's identical per-day pattern this
                replaces). */}
            You guessed{" "}
            {formatHeroCurrency(
              rescaleFromStartingCapital(
                guess,
                guessStartingCapital ?? startingCapital,
                startingCapital,
              ),
            )}
            .
          </p>
        </>
      ) : (
        <form onSubmit={handleSubmit} className="flex flex-col gap-2">
          <label htmlFor={inputId} className="text-sm text-[var(--text-secondary)]">
            Before you look: starting from {formatHeroCurrency(startingCapital)}, riding{" "}
            {rangeLabel} start to finish -- day after day, each day&apos;s real result carried into
            the next -- what do you think it became?
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <span aria-hidden="true" className="text-xl font-semibold text-[var(--text-muted)]">
              $
            </span>
            <input
              id={inputId}
              type="number"
              inputMode="decimal"
              min="0"
              step="any"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="Your guess"
              className="w-44 rounded-md border border-[var(--gridline)] bg-[var(--surface-1)] px-3 py-2 text-lg font-semibold text-[var(--text-primary)]"
            />
            <button
              type="submit"
              disabled={!isValid}
              className="rounded-md bg-[var(--series-1)] px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
            >
              Reveal the answer
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
