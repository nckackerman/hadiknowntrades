// The "coarsened arbitrary date-range" feature (issue #11, extended to
// day granularity by issue #75): instead of a truly arbitrary
// user-chosen (start, end) pair -- which the issue #11 plan
// (docs/plans/issue-11-plan.md) showed isn't nightly-recomputable at any
// real scale (a day-granularity, both-endpoints-free grid is ~14 million
// pairs) -- the user picks a *start* from a fixed, bounded set of
// anchor points, with the *end* always pinned to "today" (the same
// end-of-window convention every existing preset range already uses).
//
// Issue #75 replaced issue #11's original month-granularity anchors
// (the 1st of every month, a pure function of calendar time alone) with
// real *trading-day* anchors, sourced from the actual fetched
// daily-close history rather than a synthetic calendar/holiday model --
// see customRangeAnchors's own doc comment below for why, and
// docs/plans/issue-75-plan.md section 3 for the full design writeup.
// This file is still the single source of truth for what those anchor
// points are: apps/pipeline computes+writes one CustomWindowResult per
// anchor every nightly run (see apps/pipeline/CLAUDE.md's "Custom
// date-range anchors" section) plus a manifest of the anchor list itself
// (results-schema.ts's CustomAnchorsManifest), and apps/web's date-picker
// UI only ever lets a user select from that same published list -- so
// the two can't drift on what "a valid custom start date" means.

import { toDateString } from "./date-utils";

/**
 * How many years back from "now" this feature generates trading-day
 * start-date anchors for. **Deliberately conservative, not the deepest
 * value a real live benchmark showed was safe** -- issue #75's own
 * benchmark (docs/plans/issue-75-plan.md section 2) found the naive
 * extension of issue #11's original 21-year lookback to day granularity
 * (~5,282 anchors) does NOT fit the pipeline Lambda's real 900s timeout,
 * by ~4.5x on compute time alone, and that 7-8 years (~1,761-2,012
 * anchors) is the numbers-backed *safe range* (463-607s compute, real
 * headroom under 900s). **5 was chosen instead of that range**, as an
 * even more conservative starting point with extra timeout headroom on
 * top of what the benchmark already showed safe -- a deliberate product
 * choice (confirmed with the user), not a technical ceiling. This is
 * the one, single, clearly-documented lever for that choice: bump this
 * constant alone to extend the lookback later (up through the
 * benchmark's own confirmed-safe 7-8 year range, or re-benchmark before
 * going deeper than that) -- nothing else hardcodes 5 or needs to
 * change, every consumer (apps/pipeline, apps/web's picker) derives its
 * own bounds from this same constant via customRangeAnchors below.
 */
export const CUSTOM_RANGE_ANCHOR_YEARS_BACK = 5;

/**
 * A custom-range start-date anchor, identified by a real trading date
 * (e.g. "2019-03-15") -- the exact `YYYY-MM-DD` shape `date-utils.ts`'s
 * `toDateString` already produces, and the same shape `DailyClose.date`/
 * every `WindowResult.startDate` already uses. Deliberately a plain
 * string, not a Date -- the same "plain, sortable, comparable string"
 * convention every other date-like identifier in this package's schema
 * already uses, so it round-trips through JSON (the S3 storage format)
 * and a URL query param with no extra encoding/decoding step.
 *
 * **Issue #75 renamed this from `AnchorMonth`/`YYYY-MM`** (the 1st of a
 * calendar month) to a full trading day -- see this file's own module
 * header comment and customRangeAnchors' doc comment for why a day
 * granularity needs a genuinely different sourcing mechanism, not just a
 * type-level rename.
 */
export type AnchorDate = string;

const ANCHOR_DATE_PATTERN = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

/**
 * Sanity floor for a parsed anchor's year (carried forward unchanged from
 * issue #11's original `anchorMonthToDate`, see the code-review history
 * on that function): matches apps/pipeline's own DEFAULT_EARLIEST_DATE
 * floor (no real ticker's history goes back further than 1970), and --
 * more importantly -- sits comfortably above JS's legacy `Date.UTC`/`new
 * Date(year, ...)` two-digit-year reinterpretation range (years 0-99
 * silently become 1900-1999). Without this floor, a 4-digit-but-small
 * anchor like "0099-06-01" passes ANCHOR_DATE_PATTERN (it's exactly 4
 * digits) but `Date.UTC(99, 5, 1)` silently returns 1999-06-01, not a
 * date in the year 99 -- a real, silent misinterpretation, not a
 * hypothetical one. This has nothing to do with month-vs-day granularity,
 * so it's reused unchanged from the original month-scheme constant.
 */
const MIN_ANCHOR_YEAR = 1970;

/**
 * Parses a YYYY-MM-DD anchor identifier back to a UTC Date at that exact
 * day, or null if it isn't well-formed (wrong shape, a month outside
 * 01-12 or a day outside 01-31 -- the regex's own alternations already
 * reject those at the syntax level -- or a year outside a sane range).
 * Does NOT validate that the day is real for its month (e.g.
 * "2021-02-30" passes the regex and this parse, same as issue #11's
 * original month-scheme version never validated a month's own real
 * length) -- every real anchor this package produces always comes from
 * customRangeAnchors below, itself always sourced from a real fetched
 * trading date, so an invalid-calendar-day anchor is never actually
 * produced in practice; this function's job is catching a malformed
 * *string*, not re-deriving a full calendar model.
 *
 * **The regex alone is NOT sufficient validation** -- same two-digit-year
 * `Date.UTC` reinterpretation gap issue #11's original `anchorMonthToDate`
 * had to guard against (see MIN_ANCHOR_YEAR's own doc comment): a
 * syntactically well-formed 4-digit year like "0099" still hits that
 * legacy rule and would silently resolve to a completely different year.
 * The explicit `year < MIN_ANCHOR_YEAR` check below (plus a generous
 * upper bound so a clearly-future year doesn't slip through either)
 * closes that gap; a caller should never rely on the regex match alone
 * implying a well-formed result.
 */
export function anchorDateToDate(anchor: string): Date | null {
  const match = ANCHOR_DATE_PATTERN.exec(anchor);
  if (!match) return null;
  const year = Number(anchor.slice(0, 4));
  const month = Number(anchor.slice(5, 7));
  const day = Number(anchor.slice(8, 10));
  // Upper bound is "next calendar year" rather than an exact match
  // against customRangeAnchors(...)'s own current bound -- deliberately
  // generous, same reasoning parseAnchorDate (apps/web/src/lib/
  // results-api.ts) already documents for why it doesn't range-check
  // against the live anchor list: this server's "now" and a caller's own
  // "now" can disagree by up to a day around a year boundary, and this
  // is a sanity floor/ceiling against genuinely bogus input (like the
  // two-digit-year bug above), not a re-derivation of the real bounded
  // anchor list.
  const maxYear = new Date().getUTCFullYear() + 1;
  if (year < MIN_ANCHOR_YEAR || year > maxYear) return null;
  return new Date(Date.UTC(year, month - 1, day));
}

/**
 * Every valid custom-start-date anchor as of `asOf`, given the real
 * trading-day calendar `tradingDates` (ascending, e.g.
 * `buildCalendar(history).dates` from optimizer.ts) -- every real
 * trading day within `CUSTOM_RANGE_ANCHOR_YEARS_BACK` years of `asOf`,
 * newest first (matching the pre-issue-#75 month scheme's own
 * newest-first convention).
 *
 * **No longer a pure function of calendar time alone (issue #75), unlike
 * the month scheme's original version** -- there is no calendar-math
 * equivalent of "the 1st of the month" for "a real NYSE/Nasdaq trading
 * day": a naive calendar-day anchor list would include weekends/holidays
 * that all forward-snap to the same real trading day under
 * computeWindowOptimization's ordinary `p.date >= startDateString`
 * slicing filter, producing byte-identical results under multiple
 * different, both-selectable anchor identities -- wasted compute/storage
 * and a confusing product surface (see docs/plans/issue-75-plan.md
 * section 3.1 for the full "no forward-snapping at day granularity"
 * argument). Trading days are sourced from the actual fetched
 * daily-close history instead of a hand-rolled US market holiday
 * calendar (fixed holidays + Good Friday + weekend exclusion +
 * observed-holiday shifting) -- a synthetic model can drift from reality
 * (an unscheduled closure, or a plain bug in the holiday-shifting rules)
 * in a way real fetched data structurally can't; every date
 * `tradingDates` contains is *definitionally* correct, since it's
 * derived from the exact data every anchor's own result is computed
 * from.
 *
 * Callers: `apps/pipeline`'s `runPipeline` is the only real caller,
 * passing `buildCalendar(windowFetch.history).dates` (the same full
 * daily-close history 5Y/MAX already fetch, reused -- zero new Yahoo
 * requests for this feature) -- see apps/pipeline/CLAUDE.md's "Custom
 * date-range anchors" section. `apps/web`'s date-picker no longer calls
 * this function directly (it needs real fetched data this package alone
 * can't supply client-side) -- it instead reads the pipeline's own
 * published anchor list from the new `results/custom/index.json`
 * manifest (results-schema.ts's `CustomAnchorsManifest`) via a small
 * server-side API route, so the two still can't drift on what "a valid
 * custom start date" means, just via a published list instead of a
 * shared pure function.
 *
 * Stays a pure, easily-unit-tested function despite taking real data as
 * an argument -- feed it a synthetic `tradingDates` array and a fixed
 * `asOf`, assert the filtered/reversed output, no real fetch needed for
 * a test.
 */
export function customRangeAnchors(tradingDates: readonly string[], asOf: Date): AnchorDate[] {
  const cutoff = toDateString(
    new Date(
      Date.UTC(
        asOf.getUTCFullYear() - CUSTOM_RANGE_ANCHOR_YEARS_BACK,
        asOf.getUTCMonth(),
        asOf.getUTCDate(),
      ),
    ),
  );
  const endString = toDateString(asOf);
  return tradingDates.filter((d) => d >= cutoff && d <= endString).reverse();
}
