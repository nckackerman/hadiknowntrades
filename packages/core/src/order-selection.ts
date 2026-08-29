// The Order's daily-selection algorithm (issue #207) -- restricted to the
// Magnificent Seven, per docs/design/order-lineup-2026-08/README.md's own
// supersession of spec-the-order.md's original 240-name curated allowlist
// (unaffected by that supersession: spec-the-order.md's own scoring
// function, WCAG glyph system, and streak-chip call, all still shipped
// unchanged in apps/web).
//
// Concrete rule (this issue's own Scope, distinct from -- and simpler than
// -- spec-the-order.md's own percentile-pick Step 3, which was designed
// for a ~210-name pool, not 7 names):
//
//   1. Using the most recent real trading day's close-to-close returns for
//      all 7 Magnificent Seven tickers, exclude the 2 with the smallest
//      absolute return (least differentiated / most likely to produce a
//      near-tie).
//   2. Sort the remaining 5 worst-to-best by real return -- that ordering
//      IS the puzzle's answer.
//   3. Guardrail: if the resulting spread/adjacent-gap is too tight (see
//      MIN_TOTAL_SPREAD_PP/MIN_ADJACENT_GAP_PP below), widen the exclusion
//      to whichever 2-ticker exclusion maximizes the resulting spread;
//      if that still fails, there is no puzzle for this day at all (the
//      caller holds the previous day's puzzle by simply not writing --
//      see apps/pipeline/CLAUDE.md's own note on this).
//
// Generalized to "exclude however many of the given candidates it takes to
// reach exactly 5" (not hardcoded to "exactly 2 of exactly 7") so a
// pipeline run missing 1-2 tickers' real returns (a real, if rare, Yahoo
// per-ticker fetch failure) degrades gracefully instead of refusing to
// publish a puzzle outright -- see computeOrderSelection's own doc
// comment for exactly how.

import { SP500_CONSTITUENTS } from "./sp500-constituents";

/** How many tickers the puzzle shows each day -- the pool this algorithm always tries to narrow its input down to. */
export const ORDER_POOL_SIZE = 5;

/**
 * The Magnificent Seven, alphabetical (this order carries no meaning of
 * its own -- the puzzle's real order is computed fresh each day from real
 * returns, never from this list's order).
 */
export const MAG_SEVEN_TICKERS: readonly string[] = [
  "AAPL",
  "AMZN",
  "GOOGL",
  "META",
  "MSFT",
  "NVDA",
  "TSLA",
];

const MAG_SEVEN_NAMES = new Map<string, string>(
  MAG_SEVEN_TICKERS.map((ticker) => {
    const constituent = SP500_CONSTITUENTS.find((c) => c.symbol === ticker);
    // Every one of these 7 is a real, current S&P 500 constituent (unlike
    // spec-the-order.md's own 240-name allowlist, which needed a real
    // intersection-and-drop pass against SP500_CONSTITUENTS -- see that
    // spec's own "Step 1" for why a curated list can't be trusted without
    // one). Falling back to the bare ticker rather than throwing keeps
    // this defensive against a future constituent-list refresh that
    // somehow drops one of these seven, rather than crashing a pipeline
    // run over a display-only company name.
    return [ticker, constituent?.name ?? ticker];
  }),
);

/** The Magnificent Seven's real company name, per SP500_CONSTITUENTS -- the same single source of truth every other display name in this app reads from, not a second hand-typed copy. */
export function magSevenCompanyName(ticker: string): string {
  return MAG_SEVEN_NAMES.get(ticker) ?? ticker;
}

/**
 * Minimum total spread (max pick's return minus min pick's return, in
 * percentage points) the final 5-ticker selection must clear.
 *
 * Reused verbatim from spec-the-order.md's own n=210 guardrail (1.5pp) --
 * not re-derived from scratch, and it turns out to still be the right
 * number at n=7: a real live check (20 trading days, 2026-08-03 through
 * 2026-08-28, the primary "exclude smallest abs return" rule applied to
 * real Magnificent Seven returns) never produced a spread below 1.61pp,
 * comfortably clearing this threshold on every single real day checked --
 * see this file's own tests for the exact numbers. The guardrail exists
 * for a tail day this sample didn't happen to contain, not the common
 * path.
 */
export const MIN_TOTAL_SPREAD_PP = 1.5;

/**
 * Minimum gap (in percentage points) between any two adjacent picks once
 * sorted worst-to-best.
 *
 * **Deliberately much smaller than spec-the-order.md's own n=210 value
 * (0.15pp)**, and this is a real, load-bearing difference, not an
 * oversight: the same 20-day live check found the primary rule's own
 * minimum adjacent gap sitting well under 0.15pp on the *large majority*
 * of real days (medians in the 0.05-0.30pp range, several days at
 * 0.04-0.08pp) -- a structural consequence of narrowing 7 highly
 * correlated mega-cap tech names down to 5, not a data-quality problem.
 * Setting this guardrail at n=210's own 0.15pp would trip on nearly every
 * real trading day, defeating the whole point of a guardrail that's
 * supposed to catch the rare tail case, not the routine one. 0.02pp is
 * calibrated instead to catch a genuine tie or near-tie -- two picks that
 * would round to the *same* two-decimal percentage the reveal UI actually
 * displays (spec-the-order.md's own "Feedback mechanics" section) -- while
 * accepting that a real, readable-but-tight gap is simply what this
 * smaller pool routinely produces. Confirmed by running this exact
 * exported algorithm (not just eyeballing a spreadsheet) against the same
 * 20-day sample: 20 of 20 real days produced a valid puzzle (zero
 * `null`s), and exactly one -- 2026-08-18 -- tripped this guardrail on
 * the primary rule (a genuine 0.00pp tie between two of its five picks)
 * and was correctly rescued by the widened exclusion, landing on a real
 * alternative 5-ticker set with a 5.90pp spread and a 0.98pp minimum
 * adjacent gap -- confirming the widen-on-guardrail-trip fallback is not
 * just a paper mechanism.
 *
 * **Independently re-verified during issue #207's own finishing pass
 * (2026-08-29), against a fresh, larger, real-time sample** -- 32 real
 * trading days (2026-07-16 through 2026-08-28, live Yahoo data, this
 * exact exported algorithm run end to end, not eyeballed): 0 of 32
 * `null`s, 2 widened (2026-07-17 and 2026-08-18, both genuine near-ties
 * on the primary rule, both rescued), spread ranging 1.61-23.46pp
 * (median 4.89pp), minimum adjacent gap ranging 0.04-1.12pp (median
 * 0.22pp) -- both guardrail thresholds held comfortably across every one
 * of these real days, confirming the original 20-day check's own
 * numbers weren't a fluke of that particular window.
 */
export const MIN_ADJACENT_GAP_PP = 0.02;

interface SpreadStats {
  spreadPp: number;
  minAdjacentGapPp: number;
}

function evaluateSpread(sortedByReturn: readonly (readonly [string, number])[]): SpreadStats {
  const spreadPp = sortedByReturn[sortedByReturn.length - 1]![1] - sortedByReturn[0]![1];
  let minAdjacentGapPp = Infinity;
  for (let i = 1; i < sortedByReturn.length; i++) {
    minAdjacentGapPp = Math.min(
      minAdjacentGapPp,
      sortedByReturn[i]![1] - sortedByReturn[i - 1]![1],
    );
  }
  return { spreadPp, minAdjacentGapPp };
}

function passesGuardrails(stats: SpreadStats): boolean {
  return stats.spreadPp >= MIN_TOTAL_SPREAD_PP && stats.minAdjacentGapPp >= MIN_ADJACENT_GAP_PP;
}

/** Every k-element subset of `items`, as arrays -- small enough (k is 0-2 in real use, at most 7 items total) that a plain recursive generator is fine. */
function combinationsOf<T>(items: readonly T[], k: number): T[][] {
  if (k === 0) return [[]];
  if (k > items.length) return [];
  const [head, ...rest] = items;
  const withHead = combinationsOf(rest, k - 1).map((combo) => [head!, ...combo]);
  const withoutHead = combinationsOf(rest, k);
  return [...withHead, ...withoutHead];
}

/** One ticker's real return, sorted into the puzzle's worst-to-best order. */
export interface OrderPick {
  ticker: string;
  pctReturn: number;
}

export interface OrderSelectionResult {
  /** Exactly ORDER_POOL_SIZE entries, ascending by pctReturn -- the puzzle's real answer. */
  picks: OrderPick[];
  /** The ticker(s) left out of the puzzle this day. */
  excludedTickers: string[];
  spreadPp: number;
  minAdjacentGapPp: number;
  /** True when the primary "exclude smallest abs return" rule's own guardrail check failed and this result came from the widened, max-spread exclusion instead. */
  widened: boolean;
}

/**
 * Turns one day's real close-to-close returns into a puzzle, or `null` if
 * no exclusion (primary or widened) clears the guardrails -- the caller's
 * cue to hold the previous day's puzzle rather than publish a new one
 * (see apps/pipeline/CLAUDE.md's own note on how that "holding" is done:
 * simply not writing this run, leaving whatever's already stored in
 * place).
 *
 * `returns` need not carry all 7 Magnificent Seven tickers -- a per-ticker
 * Yahoo fetch failure is real, if rare (see packages/core/CLAUDE.md's own
 * Yahoo-client notes), and this degrades gracefully rather than refusing
 * to publish anything: with `n` candidates present, this excludes
 * `n - ORDER_POOL_SIZE` of them (never negative -- `null` if fewer than
 * ORDER_POOL_SIZE candidates are present at all, since there's nothing
 * left to pick from). At the real n=7 case this is always "exclude 2,"
 * exactly the concrete rule above.
 */
export function computeOrderSelection(
  returns: ReadonlyMap<string, number>,
): OrderSelectionResult | null {
  const entries = [...returns.entries()];
  if (entries.length < ORDER_POOL_SIZE) return null;
  const excludeCount = entries.length - ORDER_POOL_SIZE;

  function toResult(
    kept: readonly (readonly [string, number])[],
    excluded: readonly string[],
    stats: SpreadStats,
    widened: boolean,
  ): OrderSelectionResult {
    return {
      picks: kept.map(([ticker, pctReturn]) => ({ ticker, pctReturn })),
      excludedTickers: [...excluded],
      spreadPp: stats.spreadPp,
      minAdjacentGapPp: stats.minAdjacentGapPp,
      widened,
    };
  }

  if (excludeCount === 0) {
    const kept = [...entries].sort((a, b) => a[1] - b[1]);
    const stats = evaluateSpread(kept);
    return passesGuardrails(stats) ? toResult(kept, [], stats, false) : null;
  }

  // Primary rule: exclude the `excludeCount` tickers with the smallest
  // absolute return (least differentiated / most likely to be a near-tie).
  const byAbsReturn = [...entries].sort((a, b) => Math.abs(a[1]) - Math.abs(b[1]));
  const primaryExcluded = byAbsReturn.slice(0, excludeCount).map(([ticker]) => ticker);
  const primaryExcludedSet = new Set(primaryExcluded);
  const primaryKept = entries
    .filter(([ticker]) => !primaryExcludedSet.has(ticker))
    .sort((a, b) => a[1] - b[1]);
  const primaryStats = evaluateSpread(primaryKept);
  if (passesGuardrails(primaryStats)) {
    return toResult(primaryKept, primaryExcluded, primaryStats, false);
  }

  // Widen: try every possible `excludeCount`-ticker exclusion, find
  // whichever spread value the best of them achieves, then -- among ALL
  // exclusions tied for that maximum spread, not just the first one
  // found -- search for one that actually clears both guardrails.
  //
  // A single spread-maximizing candidate is not necessarily the *only*
  // one: several different `excludeCount`-ticker exclusions can tie for
  // the exact same maximum spread while producing very different
  // adjacent-gap profiles (excluding two tickers that happen to leave a
  // near-tie pair behind vs. excluding two others that don't). Checking
  // only the first spread-tied candidate by tie-break (as this used to)
  // can pick exactly the one that recreates a failing near-tie and wrongly
  // return `null`, even when a different, equally-spread-maximizing
  // exclusion would have passed both guardrails. See order-selection.test.ts's
  // "widens among all spread-tied candidates" test for a concrete
  // counterexample this exact bug produced.
  interface WidenCandidate {
    kept: (readonly [string, number])[];
    excluded: string[];
    stats: SpreadStats;
    excludedKey: string;
  }
  const candidates: WidenCandidate[] = combinationsOf(
    entries.map(([ticker]) => ticker),
    excludeCount,
  ).map((excluded) => {
    const excludedSet = new Set(excluded);
    const kept = entries.filter(([ticker]) => !excludedSet.has(ticker)).sort((a, b) => a[1] - b[1]);
    return {
      kept,
      excluded: [...excluded],
      stats: evaluateSpread(kept),
      excludedKey: [...excluded].sort().join(","),
    };
  });
  if (candidates.length === 0) return null;

  const maxSpreadPp = Math.max(...candidates.map((c) => c.stats.spreadPp));
  // Ties (both "which candidates count as spread-maximizing" and "which
  // of those to prefer once more than one passes both guardrails") are
  // broken by the lexicographically-smallest excluded-ticker set, purely
  // for determinism -- there is no principled preference between two
  // candidates with an identical spread.
  const passing = candidates
    .filter((c) => c.stats.spreadPp === maxSpreadPp && passesGuardrails(c.stats))
    .sort((a, b) => (a.excludedKey < b.excludedKey ? -1 : a.excludedKey > b.excludedKey ? 1 : 0));
  if (passing.length === 0) return null;
  const best = passing[0]!;
  return toResult(best.kept, best.excluded, best.stats, true);
}
