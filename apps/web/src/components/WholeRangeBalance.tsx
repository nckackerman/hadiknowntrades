import { formatHeroCurrency } from "@/lib/format-currency";

interface WholeRangeBalanceProps {
  /** How many of this range's days the user has already individually guessed/revealed (issue #34/#80) -- the same per-day guess data DayOverview's own rows read. */
  revealedCount: number;
  /** Total trading days in the currently-viewed range. */
  totalDays: number;
  /** The user's chosen display starting capital (issue #15). */
  startingCapital: number;
  /** The range's true final chained ending balance (issue #84), already rescaled to `startingCapital` from the range's own root -- see ResultsPanel's own `wholeRangeFinalBalance` doc comment for the exact (non-per-day) rescale this must use. */
  finalBalance: number;
}

/**
 * The whole-range running-balance headline (issue #84) -- "if you'd
 * time-traveled back to day one with $[X] and rode the *entire* window,
 * carrying each day's real result into the next, what would it actually
 * have become?" The actual product premise this issue's own Background
 * frames (see docs/plans/issue-84-plan.md section 4.2), parallel to the
 * window model's single HeroStat, but deliberately simpler: no count-up
 * animation, no celebration burst -- this is a summary/payoff figure
 * shown once per range, not a per-reveal moment the way HeroStat's own
 * mount-triggered choreography is.
 *
 * **Deliberately count-gated, not order-gated (a real, documented spoiler
 * concern -- see apps/web/CLAUDE.md's own note on this issue)**: masked
 * until `revealedCount === totalDays`, regardless of which order those
 * reveals happened in -- a user can still guess days in any order
 * (issue #80's free-browsing design is untouched). While masked, this
 * renders a neutral progress placeholder, not a fake number and not a
 * hidden element -- the whole point is communicating *that* this figure
 * exists and how to unlock it, without leaking any part of its actual
 * magnitude (which, once chained, would otherwise let a user back out
 * every prior day's own answer from a single later reveal).
 *
 * **Announces its own masked -> unlocked transition to screen readers**
 * (issue #84 code review finding, fixed) -- an always-present `role="status"
aria-live="polite"` `sr-only` region, the same established shape issue
 * #67's own per-day reveal announcement in `ResultsPanel.tsx` already
 * uses (see that section in apps/web/CLAUDE.md): a static sentence, not
 * wired to any per-frame/animating value, since this component has no
 * animation to guard against in the first place. Without this, revealing
 * the range's final day swaps the masked placeholder for the real figure
 * with no live-region announcement at all -- a screen reader user would
 * have no indication the headline just unlocked unless they manually
 * re-navigated up to it.
 */
export function WholeRangeBalance({
  revealedCount,
  totalDays,
  startingCapital,
  finalBalance,
}: WholeRangeBalanceProps) {
  if (totalDays === 0) return null;
  const allRevealed = revealedCount === totalDays;

  return (
    <div className="surface-card flex flex-col gap-1 rounded-lg border border-[var(--gridline)] bg-[var(--surface-1)] px-4 py-4">
      <p className="text-sm font-medium text-[var(--text-muted)]">
        Whole-range running balance -- carried day to day, start to finish
      </p>
      {/* aria-label disambiguates this region from ResultsPanel's own
          sibling `role="status"` per-day reveal region (issue #67) --
          see that region's own comment for why two live regions on one
          page need distinguishing labels. */}
      <div
        role="status"
        aria-live="polite"
        aria-label="Whole-range reveal status"
        className="sr-only"
      >
        {allRevealed
          ? `Whole-range running balance revealed: ${formatHeroCurrency(startingCapital)} to ${formatHeroCurrency(finalBalance)}.`
          : ""}
      </div>
      {allRevealed ? (
        <p className="flex flex-wrap items-baseline gap-3 text-xl font-semibold leading-none tracking-tight text-[var(--text-primary)] sm:text-2xl">
          <span>{formatHeroCurrency(startingCapital)}</span>
          <span aria-hidden="true" className="text-[var(--text-muted)]">
            →
          </span>
          <span className="text-[var(--series-1)]">{formatHeroCurrency(finalBalance)}</span>
        </p>
      ) : (
        <p className="text-sm text-[var(--text-secondary)]">
          Reveal all {totalDays} day{totalDays === 1 ? "" : "s"} below to see the range&apos;s full
          running balance -- {revealedCount} of {totalDays} revealed so far.
        </p>
      )}
    </div>
  );
}
