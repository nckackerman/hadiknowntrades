// The "coarsened arbitrary date-range" feature (issue #11): instead of a
// truly arbitrary user-chosen (start, end) pair -- which the issue's own
// plan (docs/plans/issue-11-plan.md) showed isn't nightly-recomputable at
// any real scale (a day-granularity, both-endpoints-free grid is ~14
// million pairs) -- the user picks a *start* from a fixed, bounded set of
// month-granularity anchor points, with the *end* always pinned to "today"
// (the same end-of-window convention every existing preset range already
// uses). This file is the single source of truth for what those anchor
// points are: apps/pipeline computes+writes one CustomWindowResult per
// anchor every nightly run (see apps/pipeline/CLAUDE.md's "Custom
// date-range anchors" section), and apps/web's date-picker UI only ever
// lets a user select from this same list -- so the two can't drift on
// what "a valid custom start date" means.

/**
 * How many years back from "now" this feature generates monthly
 * start-date anchors for. Chosen to match the depth already used to
 * benchmark the optimizer's own "Max" range (see this package's
 * CLAUDE.md's "Optimizer algorithm" section, ~330ms for a 21-year
 * window) -- not MAX's own true, unbounded, ticker-inception-dependent
 * reach, just a concretely cost-modeled depth this feature's nightly
 * compute/storage budget is sized against (see apps/pipeline/CLAUDE.md
 * for the real numbers this constant drives: ~252 anchors, an estimated
 * ~80s of added nightly compute, ~1MB of added S3 storage). Bump this
 * later if a deeper reach is wanted -- nothing else needs to change,
 * every consumer (pipeline, API validation, the UI picker) derives its
 * own bounds from this same constant via customRangeAnchors below.
 */
export const CUSTOM_RANGE_ANCHOR_YEARS_BACK = 21;

/**
 * A custom-range start-date anchor, identified by calendar year and
 * month (e.g. "2019-03" for March 2019 -- the anchor's actual start date
 * is always the 1st of that month, see anchorMonthToDate). Deliberately
 * a plain YYYY-MM string, not a Date -- the same "plain, sortable,
 * comparable string" convention every other date-like identifier in this
 * package's schema already uses (DailyClose.date, PresetRange's own
 * start/end date strings), so it round-trips through JSON (the S3
 * storage format) and a URL query param with no extra encoding/decoding
 * step.
 */
export type AnchorMonth = string;

const ANCHOR_MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * Sanity floor for a parsed anchor's year (code review finding, issue
 * #11): matches apps/pipeline's own DEFAULT_EARLIEST_DATE floor (no real
 * ticker's history goes back further than 1970), and -- more importantly
 * -- sits comfortably above JS's legacy `Date.UTC`/`new Date(year, ...)`
 * two-digit-year reinterpretation range (years 0-99 silently become
 * 1900-1999). Without this floor, a 4-digit-but-small anchor like
 * "0099-06" passes ANCHOR_MONTH_PATTERN (it's exactly 4 digits) but
 * `Date.UTC(99, 5, 1)` silently returns 1999-06-01, not a date in the
 * year 99 -- a real, silent misinterpretation, not a hypothetical one.
 */
const MIN_ANCHOR_YEAR = 1970;

/**
 * Parses a YYYY-MM anchor identifier back to a UTC Date at the 1st of
 * that month, or null if it isn't well-formed (wrong shape, a month
 * outside 01-12 -- the regex's own `(0[1-9]|1[0-2])` alternation already
 * rejects "13" etc. at the syntax level -- or a year outside a sane
 * range).
 *
 * **The regex alone is NOT sufficient validation (a real bug, found in
 * code review, fixed here)**: a syntactically well-formed 4-digit year
 * like "0099" still hits `Date.UTC`'s legacy two-digit-year
 * reinterpretation rule (see MIN_ANCHOR_YEAR's own doc comment) and
 * silently resolves to a completely different year (1999, not 99) --
 * `GET /api/results?anchor=0099-06` would otherwise pass
 * ANCHOR_MONTH_PATTERN and apps/web's parseAnchorMonth (results-api.ts)
 * unrejected. The explicit `year < MIN_ANCHOR_YEAR` check below (plus a
 * generous upper bound so a clearly-future year doesn't slip through
 * either) closes that gap; a caller should never rely on the regex match
 * alone implying a well-formed result.
 */
export function anchorMonthToDate(anchor: string): Date | null {
  const match = ANCHOR_MONTH_PATTERN.exec(anchor);
  if (!match) return null;
  const year = Number(anchor.slice(0, 4));
  const month = Number(anchor.slice(5, 7));
  // Upper bound is "next calendar year" rather than an exact match
  // against customRangeAnchors(asOf)'s own current bound -- deliberately
  // generous, same reasoning parseAnchorMonth (apps/web/src/lib/
  // results-api.ts) already documents for why it doesn't range-check
  // against the live anchor list: this server's "now" and a caller's own
  // "now" can disagree by up to a day around a year/month boundary, and
  // this is a sanity floor/ceiling against genuinely bogus input (like
  // the two-digit-year bug above), not a re-derivation of the real
  // bounded anchor list.
  const maxYear = new Date().getUTCFullYear() + 1;
  if (year < MIN_ANCHOR_YEAR || year > maxYear) return null;
  return new Date(Date.UTC(year, month - 1, 1));
}

/** Formats a Date as its YYYY-MM anchor identifier (UTC month, matching anchorMonthToDate's own UTC interpretation). */
export function toAnchorMonth(date: Date): AnchorMonth {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

/**
 * Every valid custom-start-date anchor as of `asOf`: the 1st of every
 * calendar month from the current (possibly partial) month back
 * CUSTOM_RANGE_ANCHOR_YEARS_BACK years, newest first. Both apps/pipeline
 * (which computes/writes a CustomWindowResult for every one of these,
 * every nightly run -- see apps/pipeline/CLAUDE.md) and apps/web (whose
 * date-picker only ever offers this exact list, and whose API route
 * validates a requested anchor's *shape* via anchorMonthToDate rather
 * than re-deriving this bound -- see results-api.ts's own comment on why
 * it deliberately does NOT also range-check against this list) call this
 * -- the single source of truth for which anchors exist.
 *
 * No missing/holiday-date snapping logic is needed here, unlike the
 * live-compute design this feature's plan originally sketched (see
 * docs/plans/issue-11-plan.md's history): each anchor's start is always a
 * *calendar* month boundary, and the actual slicing filter that consumes
 * it (apps/pipeline's computeWindowOptimization, `p.date >=
 * startDateString`) already forward-snaps to the nearest real trading day
 * on or after it -- the exact same filter every existing preset range's
 * own startDate already goes through with no special-casing. The end
 * date is always "today," handled identically to how every preset range
 * already handles it (dataAsOf vs. endDate). There is nothing left to
 * "snap" beyond what already happens for free.
 */
export function customRangeAnchors(asOf: Date): AnchorMonth[] {
  const totalMonths = CUSTOM_RANGE_ANCHOR_YEARS_BACK * 12;
  const startYear = asOf.getUTCFullYear();
  const startMonth = asOf.getUTCMonth(); // 0-indexed
  const anchors: AnchorMonth[] = [];
  for (let i = 0; i < totalMonths; i++) {
    // startYear/startMonth are always a real, recent calendar date in
    // practice, so this index is always comfortably positive -- no need
    // to guard against JS's negative-modulo behavior for a negative
    // totalIndex.
    const totalIndex = startYear * 12 + startMonth - i;
    const year = Math.floor(totalIndex / 12);
    const month = totalIndex % 12; // 0-indexed, matching Date.UTC's own convention
    // Routed through toAnchorMonth (below) rather than hand-rolling the
    // identical zero-pad formatting a second time here -- a real,
    // code-review-caught duplication: this function is the one real
    // producer of AnchorMonth strings, but toAnchorMonth (exported
    // through this package's public API for exactly this purpose) had
    // zero actual callers anywhere in the codebase until this fix.
    anchors.push(toAnchorMonth(new Date(Date.UTC(year, month, 1))));
  }
  return anchors;
}
