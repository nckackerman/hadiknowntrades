"use client";

import { useId, useState } from "react";
import type { FormEvent } from "react";

import { formatHeroCurrency } from "@/lib/format-currency";
import { formatDate } from "@/lib/format-date";

interface DailyGuessFormProps {
  /** The intraday day being guessed on (issue #34) -- a plain YYYY-MM-DD calendar date. */
  date: string;
  startingCapital: number;
  /**
   * The previous trading day in this range, if any -- `null` for a
   * range's own first day (a genuine fresh start, nothing carried over
   * to disclose). When present, adds one honest clause acknowledging
   * that this day's *real* starting balance actually chained from that
   * previous day's own result (issue #84), without changing what's
   * being guessed or leaking any dollar amount -- the previous day's
   * *date* is already fully visible, ungated information (DayOverview
   * shows every row's date regardless of guess status), so naming it
   * here reveals nothing new.
   */
  previousDate: string | null;
  onSubmit: (guess: number) => void;
}

/**
 * The guess-before-reveal prompt for one intraday day's result (issue
 * #34). ResultsPanel renders this in HeroStat's slot in the top row until
 * the user submits a guess (or a stored guess for this date is already
 * found, see use-daily-guess.ts) -- at that point ResultsPanel swaps this
 * out for the real HeroStat, so its existing count-up/celebration reveal
 * choreography (see HeroStat.tsx) fires naturally at the moment of first
 * mount, exactly the way it already does on a fresh page load. This
 * component owns no reveal-animation logic of its own -- it only decides
 * *when* HeroStat gets mounted, by handing the parsed guess up to the
 * caller.
 */
export function DailyGuessForm({
  date,
  startingCapital,
  previousDate,
  onSubmit,
}: DailyGuessFormProps) {
  const [draft, setDraft] = useState("");
  const inputId = useId();

  const parsed = Number(draft);
  // Empty string coerces to 0 via Number(), which is a legitimate guess a
  // user might actually want to submit ("all-in trade wiped it out") --
  // the `draft.trim() !== ""` check is what actually distinguishes "field
  // left blank" from "typed 0", not the parsed value itself.
  const isValid = draft.trim() !== "" && Number.isFinite(parsed) && parsed >= 0;

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!isValid) return;
    onSubmit(parsed);
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-2">
      <label htmlFor={inputId} className="text-sm font-medium text-[var(--text-secondary)]">
        {previousDate !== null && (
          <span className="mb-1 block text-xs font-normal text-[var(--text-muted)]">
            This day&apos;s real starting balance actually carried over from{" "}
            {formatDate(previousDate)}&apos;s result -- but for this guess, picture it starting
            fresh:
          </span>
        )}
        Before you look: on {formatDate(date)}, what do you think{" "}
        {formatHeroCurrency(startingCapital)} turned into?
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
  );
}
