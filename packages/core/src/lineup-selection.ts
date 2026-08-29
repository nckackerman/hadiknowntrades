// The Lineup's daily-selection algorithm (issue #208), resolving
// docs/design/order-lineup-2026-08/spec-the-lineup.md's own "Daily-
// selection algorithm" section -- widened, per that folder's own README,
// to cover both 3- AND 4-letter S&P 500 tickers rather than the spec's
// original 3-letter-only text (the mock's own final design hides ticker
// length entirely, which is what makes a 4-letter ticker fair game).
//
// Pure and framework-free on purpose, same posture as optimizer.ts and
// intraday-sessions.ts: this is a pipeline-side computation over already-
// fetched DailyClose data, with no I/O of its own, so it's directly
// unit-testable against synthetic fixtures.
//
// Algorithm (spec-the-lineup.md, widened):
//   1. Identify the trading day: the most recent day with real close data
//      (apps/pipeline passes its own `windowFetch.dataAsOf`).
//   2. For every 3- or 4-letter ticker in the S&P 500 universe, compute
//      abs(close[day] / close[previousTradingDay] - 1).
//   3. Sort descending by that absolute return (deterministic tie-break:
//      alphabetically-first ticker wins, matching optimizer.ts's own
//      cross-ticker tie-break convention -- plain `<`/`>`, not
//      `localeCompare`, for the same reason that file's own doc comment
//      gives).
//   4. Greedily select 5, skipping any ticker that appeared in a lineup
//      published within the last `LINEUP_REPEAT_AVOIDANCE_DAYS` days.
//   5. If that can't find 5, relax to 7 days, then to 0 (no
//      repeat-avoidance at all) -- the mechanic must never fail to
//      produce a puzzle just because a short published-history window
//      happens to be volatile everywhere it looks.

import { daysBeforeUtc, toDateString } from "./date-utils";
import { isValidPrice } from "./is-valid-price";
import { SP500_CONSTITUENTS } from "./sp500-constituents";
import type { DailyClose } from "./yahoo-client";

/** How many tickers a day's lineup always contains. */
export const LINEUP_SIZE = 5;

/**
 * The repeat-avoidance cascade (spec-the-lineup.md's own proposal,
 * unchanged by the mock's later revisions): try to avoid any ticker that
 * appeared in a lineup published in the last 14 days; if that can't find
 * 5 candidates, relax to 7, then to 0 (no avoidance at all). Order
 * matters -- tried in this exact sequence, widest window first.
 */
export const LINEUP_REPEAT_AVOIDANCE_DAYS = 14;
const REPEAT_AVOIDANCE_FALLBACK_DAYS: readonly number[] = [LINEUP_REPEAT_AVOIDANCE_DAYS, 7, 0];

/**
 * A real, plain-letter 3- or 4-character ticker symbol -- the pool every
 * day's answer AND every legal guess is drawn from.
 *
 * **Deliberately excludes a symbol that merely happens to be 3-4
 * *characters* long but isn't a plain ticker** -- `BF.B` (share-class
 * dot notation) is 4 characters but would be a nonsensical, untypeable
 * "ticker" for this game (its own 4th slot would need to render a
 * literal `.`, and Yahoo itself renders it `BF-B`, not `BF.B` -- see
 * yahoo-client.ts's own `toYahooSymbol`). Filtering on `/^[A-Z]{3,4}$/`
 * (anchored, letters only) excludes it and `BRK.B` (5 characters
 * regardless) alike, rather than a bare `.length` check, which would
 * have silently let `BF.B` into the 4-letter pool.
 *
 * Exported so results-schema.ts's own validateLineupResult can check a
 * published LineupResult's tickers against this exact pattern too,
 * rather than re-deriving an equivalent regex a second time.
 */
export const TICKER_PATTERN = /^[A-Z]{3,4}$/;

/**
 * Every real S&P 500 ticker eligible to be a Lineup answer or a legal
 * guess -- sorted for a stable, deterministic iteration order (this
 * package's own `SP500_CONSTITUENTS` array order is alphabetical by
 * company *name*, not by symbol, so this isn't already sorted by symbol
 * without an explicit sort). 281 three-letter + 162 real four-letter
 * tickers as of this file's own snapshot date (see sp500-constituents.ts)
 * -- `BF.B` is the one symbol excluded from the raw 163-count of
 * length-4 strings, per TICKER_PATTERN's own doc comment.
 */
export const LINEUP_TICKER_POOL: readonly string[] = SP500_CONSTITUENTS.map((c) => c.symbol).filter(
  (symbol) => TICKER_PATTERN.test(symbol),
);

/** One previously-published lineup, for repeat-avoidance. */
export interface LineupHistoryEntry {
  /** The trading day this lineup was selected for, YYYY-MM-DD. */
  date: string;
  /** Exactly LINEUP_SIZE tickers. */
  tickers: string[];
}

export interface LineupSelectionResult {
  /** Exactly LINEUP_SIZE tickers, descending by |return| among whichever candidates the repeat-avoidance window that succeeded allowed through. */
  tickers: string[];
  /** Which of REPEAT_AVOIDANCE_FALLBACK_DAYS actually produced 5 candidates -- purely for operational visibility/testing, not part of the published LineupResult. */
  repeatAvoidanceDaysUsed: number;
}

interface Candidate {
  ticker: string;
  absReturn: number;
}

/**
 * Every LINEUP_TICKER_POOL ticker's abs(close[day]/close[previousDay]-1),
 * for whichever tickers have both a real entry on `day` and a real entry
 * immediately before it in their own series.
 *
 * **`closesByTicker` must already be sorted ascending by date per
 * ticker** -- this function does not sort defensively (apps/pipeline's
 * own `sortedHistory` already guarantees this once, cached, before this
 * is ever called; re-sorting per candidate here would repeat that cost
 * for no benefit). A ticker missing from the map, or whose own series has
 * no entry on `day` (a real, unremarkable case -- not every ticker trades
 * every session, and a small local-dev ticker sample won't have every
 * pool member at all), is silently skipped rather than treated as an
 * error -- exactly the same "skip what's missing, don't fail the whole
 * computation" posture `optimizer.ts`'s own per-ticker handling already
 * takes.
 */
function computeCandidates(
  closesByTicker: ReadonlyMap<string, readonly DailyClose[]>,
  day: string,
): Candidate[] {
  const candidates: Candidate[] = [];
  for (const ticker of LINEUP_TICKER_POOL) {
    const series = closesByTicker.get(ticker);
    if (!series || series.length < 2) continue;
    const dayIndex = series.findIndex((point) => point.date === day);
    if (dayIndex <= 0) continue; // no entry for `day`, or `day` is the series' own first point (no previous day to compare against)
    const todayClose = series[dayIndex]!.close;
    const previousClose = series[dayIndex - 1]!.close;
    if (!isValidPrice(todayClose) || !isValidPrice(previousClose)) continue;
    candidates.push({ ticker, absReturn: Math.abs(todayClose / previousClose - 1) });
  }
  // Descending by |return|; deterministic alphabetical tie-break (plain
  // `<`/`>`, not localeCompare -- see this file's own header comment).
  candidates.sort((a, b) => {
    if (b.absReturn !== a.absReturn) return b.absReturn - a.absReturn;
    return a.ticker < b.ticker ? -1 : a.ticker > b.ticker ? 1 : 0;
  });
  return candidates;
}

/**
 * Every ticker that appeared in a lineup published within `windowDays`
 * days before (but not including) `day`. `windowDays === 0` always
 * returns an empty set -- the "no repeat-avoidance at all" fallback.
 */
function recentlyPublishedTickers(
  history: readonly LineupHistoryEntry[],
  day: string,
  windowDays: number,
): Set<string> {
  if (windowDays <= 0) return new Set();
  const cutoff = toDateString(daysBeforeUtc(new Date(`${day}T00:00:00Z`), windowDays));
  const excluded = new Set<string>();
  for (const entry of history) {
    if (entry.date >= cutoff && entry.date < day) {
      for (const ticker of entry.tickers) excluded.add(ticker);
    }
  }
  return excluded;
}

/**
 * Selects the day's 5 Lineup tickers: the biggest movers (by absolute
 * daily return) among LINEUP_TICKER_POOL, walking the repeat-avoidance
 * cascade (14 -> 7 -> 0 days) until 5 candidates survive.
 *
 * Returns `null` only if fewer than 5 candidates exist at all (i.e. even
 * with zero repeat-avoidance) -- unreachable in production against the
 * real ~444-ticker pool, but a real possibility against a small local-dev
 * ticker sample, and this function must degrade rather than throw: the
 * caller (apps/pipeline) treats a `null` result the same non-fatal way
 * it already treats Beat the Bench's own session-fetch failure.
 */
export function selectLineupTickers(
  closesByTicker: ReadonlyMap<string, readonly DailyClose[]>,
  day: string,
  history: readonly LineupHistoryEntry[],
): LineupSelectionResult | null {
  const candidates = computeCandidates(closesByTicker, day);
  if (candidates.length < LINEUP_SIZE) return null;

  for (const windowDays of REPEAT_AVOIDANCE_FALLBACK_DAYS) {
    const excluded = recentlyPublishedTickers(history, day, windowDays);
    const picked = candidates
      .filter((candidate) => !excluded.has(candidate.ticker))
      .slice(0, LINEUP_SIZE)
      .map((candidate) => candidate.ticker);
    if (picked.length === LINEUP_SIZE) {
      return { tickers: picked, repeatAvoidanceDaysUsed: windowDays };
    }
  }
  // Every fallback (including 0 -- no avoidance) failed to find 5, which
  // only happens if `candidates.length < LINEUP_SIZE` -- already handled
  // above -- so this is unreachable in practice. Kept as an explicit,
  // typed fallback rather than a non-null assertion on the loop above.
  return null;
}

/**
 * How long a lineup stays in the published history object at all
 * (results/lineup/history.json) -- must be at least
 * LINEUP_REPEAT_AVOIDANCE_DAYS (the widest window the cascade above ever
 * checks), plus a little slack so the object's own age doesn't become the
 * binding constraint on repeat-avoidance right at the boundary. Mirrors
 * CallBoard's own ~30-day/MAX_STORED_RESOLVED_CALLS magnitude for a
 * bounded rolling history, not a fresh number invented here.
 */
export const LINEUP_HISTORY_RETENTION_DAYS = 30;

/**
 * Folds today's newly-selected lineup into the existing published
 * history, replacing (not duplicating) any existing entry for the same
 * date -- an idempotent re-run of the same day's pipeline must not grow
 * the history twice -- and trims anything older than
 * LINEUP_HISTORY_RETENTION_DAYS so the object stays small and bounded
 * rather than growing forever.
 */
export function mergeLineupHistory(
  existing: readonly LineupHistoryEntry[],
  today: LineupHistoryEntry,
): LineupHistoryEntry[] {
  const withoutToday = existing.filter((entry) => entry.date !== today.date);
  const cutoff = toDateString(
    daysBeforeUtc(new Date(`${today.date}T00:00:00Z`), LINEUP_HISTORY_RETENTION_DAYS),
  );
  return [...withoutToday, today]
    .filter((entry) => entry.date >= cutoff)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}
