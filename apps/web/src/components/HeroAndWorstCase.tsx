import { rescaleFromStartingCapital } from "@/lib/rescale-starting-capital";
import { HeroStat } from "@/components/HeroStat";
import { WorstCaseStat } from "@/components/WorstCaseStat";

export interface HeroAndWorstCaseProps {
  /**
   * Passed straight through as HeroStat's own `key` -- must change
   * whenever the underlying result changes (a newly-selected intraday
   * day, a new range/dataAsOf for the window model, or a fresh replay
   * run -- issue #96) so useCountUp's reveal animation remounts and
   * fires fresh instead of leaving the visible figure frozen at a stale
   * animated value. See each caller's own key expression for what
   * identifies "changed" for that model.
   */
  heroKey: string;
  /** This *track's* own starting capital (the same track endingBalance below was computed from) -- HeroStat rescales endingBalance from this value, never from a different track's. */
  startingCapital: number;
  endingBalance: number;
  worstCaseEndingBalance: number;
  /**
   * The worst-case track's *own* starting capital (issue #84) -- separate
   * from `startingCapital` above on purpose. Pre-chaining, every track
   * shared one identical flat `startingCapital`, so a single prop could
   * safely serve both `HeroStat` and `WorstCaseStat`'s rescale; once
   * apps/pipeline chains each of the four tracks independently (see
   * apps/pipeline/CLAUDE.md), the worst-case track's own chained capital
   * can genuinely differ from the (best-case) `startingCapital` above,
   * and rescaling `worstCaseEndingBalance` from the wrong track's capital
   * would silently produce a wrong number -- see
   * apps/web/CLAUDE.md's "Configurable starting capital" section (the
   * `effectiveStartingCapital`-miss history) for the exact class of bug
   * this field exists to prevent from recurring a fourth time. For the
   * window model (WorstCaseResult/LongShortResult), which has no
   * per-track startingCapital of its own (never chained -- see
   * results-schema.ts), this is always identical to `startingCapital`
   * itself; callers there just pass the same value twice.
   */
  worstCaseStartingCapital: number;
  /**
   * The user's chosen starting capital (issue #15) to display-rescale
   * both stats to -- defaults to `startingCapital` (a no-op ratio of 1)
   * at each call site, the same optional-in-spirit convention `HeroStat`
   * itself uses. Passed straight through to `HeroStat` as its own
   * `displayStartingCapital` prop (layered on top of, not fed into, its
   * count-up tween -- see that prop's own doc comment); `WorstCaseStat`
   * has no animation to protect, so it's simpler here: rescale
   * `worstCaseEndingBalance` directly via `rescaleFromStartingCapital`
   * and pass the rescaled pair straight in. The multiplier either
   * component derives (`endingBalance / startingCapital`) is unaffected
   * either way, since rescaling multiplies both sides by the same ratio.
   */
  displayStartingCapital: number;
}

/**
 * The HeroStat + WorstCaseStat pairing shared by every result view that
 * shows both -- the intraday-daily and window-model success branches in
 * ResultsPanel.tsx, and TradeReplay.tsx's own "live" (idle/done) state
 * (issue #96) -- same wrapper layout, same two stats side by side,
 * differing only in which day's/range's numbers feed them and what
 * identifies "the result changed" for `heroKey`. Extracted to its own
 * file (issue #96) once TradeReplay.tsx needed to import it too, rather
 * than staying a component private to ResultsPanel.tsx.
 */
export function HeroAndWorstCase({
  heroKey,
  startingCapital,
  endingBalance,
  worstCaseEndingBalance,
  worstCaseStartingCapital,
  displayStartingCapital,
}: HeroAndWorstCaseProps) {
  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:gap-8">
      <HeroStat
        key={heroKey}
        startingCapital={startingCapital}
        endingBalance={endingBalance}
        displayStartingCapital={displayStartingCapital}
      />
      <WorstCaseStat
        startingCapital={displayStartingCapital}
        endingBalance={rescaleFromStartingCapital(
          worstCaseEndingBalance,
          // The worst-case track's own starting capital -- NOT
          // `startingCapital` above (the best-case/hero track's), which
          // can genuinely differ once tracks chain independently (issue
          // #84). See worstCaseStartingCapital's own doc comment.
          worstCaseStartingCapital,
          displayStartingCapital,
        )}
      />
    </div>
  );
}
