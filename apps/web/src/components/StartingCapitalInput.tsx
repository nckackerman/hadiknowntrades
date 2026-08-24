"use client";

import { useState } from "react";

import {
  MAX_STARTING_CAPITAL,
  MIN_STARTING_CAPITAL,
  parseStartingCapital,
} from "@/lib/starting-capital";

interface StartingCapitalInputProps {
  /** The currently-committed starting capital (issue #15) -- a
   * controlled component, same pattern as RangeSelector/DayOverview: the
   * caller (ResultsPanel, via ResultsPage's useStartingCapital) owns the
   * value and, if it wants persistence, is responsible for it. */
  value: number;
  onChange: (value: number) => void;
}

/**
 * A "Starting capital" text field next to HeroStat (issue #15) -- lets
 * the user rescale every dollar figure on the page without a server
 * round-trip (see ResultsPanel, which feeds this value into HeroStat's
 * displayStartingCapital and straight into
 * derivePortfolioSeries/deriveWholeRangeIntradaySeries for the chart).
 *
 * Keeps its own local "draft" text state, separate from the committed
 * `value` prop, so the user can freely clear/backspace/retype mid-edit
 * without every keystroke being clamped or rejected out from under
 * them -- onChange only fires once the draft actually parses to a
 * usable positive number (parseStartingCapital), and onBlur snaps the
 * visible text back to the last committed value if the draft was left
 * empty or otherwise invalid, so the field never gets stuck showing
 * something that was never actually applied.
 */
export function StartingCapitalInput({ value, onChange }: StartingCapitalInputProps) {
  const [draft, setDraft] = useState(String(value));
  // Tracks the last `value` the draft was synced from, so a change to
  // `value` for a reason *other* than this input's own onChange below
  // (e.g. use-starting-capital.ts's post-mount localStorage-hydration
  // correction, or some future programmatic reset) re-syncs the visible
  // text -- computed during render, React's own "adjusting state when a
  // prop changes" pattern (same shape as use-results.ts's
  // `trackedRange`), not in a useEffect, which would trip the
  // react-hooks/set-state-in-effect lint for exactly this "mirror a prop
  // into state" shape. This was a real bug caught by live-verifying a
  // page reload, not the unit tests: without it, the field kept showing
  // its hydration-safe default text forever after the hook silently
  // corrected the actual value out from under it.
  const [trackedValue, setTrackedValue] = useState(value);
  // The parsed value from this input's own most recently fired onChange
  // call, if any -- lets the resync below tell "value changed because
  // the parent just round-tripped my own edit back to me" apart from "a
  // genuinely external value change." Plain state, not a ref: handleChange
  // sets this in the same event handler as its own onChange/setDraft
  // calls below, so React batches all three together into the one
  // re-render where the parent's updated `value` prop actually lands --
  // by the time that render runs, this state is already updated too, so
  // reading it here (a normal state read during render) sees the correct
  // value. A ref would read as stale-looking to the react-hooks/refs
  // lint (refs aren't meant to be read during render at all, even though
  // the timing would happen to work here).
  const [lastEmitted, setLastEmitted] = useState<number | null>(null);
  if (value !== trackedValue) {
    setTrackedValue(value);
    // Only resync the visible draft when this value change didn't
    // originate from this input's own onChange -- otherwise a keystroke
    // that changes the *parsed* number (e.g. typing the "2" in "02",
    // which commits `onChange(2)`) would round-trip back through `value`
    // and snap the draft from "02" to "2", silently eating the leading
    // zero the user just typed. Found in code review: the field's own
    // doc comment claimed draft only ever changes on blur or an external
    // change, but this reproduced on nearly every keystroke that changed
    // the parsed value, not just an edge case.
    if (value !== lastEmitted) {
      setDraft(String(value));
    }
  }

  function handleChange(event: React.ChangeEvent<HTMLInputElement>): void {
    const raw = event.target.value;
    setDraft(raw);
    const parsed = parseStartingCapital(raw);
    if (parsed !== null) {
      setLastEmitted(parsed);
      onChange(parsed);
    }
  }

  function handleBlur(): void {
    // Re-sync the visible text to the actual committed value -- covers
    // a draft left blank, negative, zero, or non-numeric (never
    // committed above), and a value that was clamped to
    // MIN/MAX_STARTING_CAPITAL on the way in.
    setDraft(String(value));
  }

  return (
    <label className="flex items-center gap-2 text-sm text-[var(--text-secondary)]">
      <span>Starting capital</span>
      <span className="relative inline-flex items-center">
        <span
          aria-hidden="true"
          className="pointer-events-none absolute left-2 text-[var(--text-muted)]"
        >
          $
        </span>
        <input
          type="number"
          inputMode="decimal"
          min={MIN_STARTING_CAPITAL}
          max={MAX_STARTING_CAPITAL}
          step="any"
          value={draft}
          onChange={handleChange}
          onBlur={handleBlur}
          className="w-28 rounded-md border border-[var(--gridline)] bg-[var(--surface-1)] py-1.5 pl-5 pr-2 text-sm font-medium text-[var(--text-primary)]"
        />
      </span>
    </label>
  );
}
