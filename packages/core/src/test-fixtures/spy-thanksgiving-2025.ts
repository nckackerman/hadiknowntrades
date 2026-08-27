// Real, recorded SPY intraday bars covering Thanksgiving week 2025 --
// captured live from the same Yahoo chart endpoint yahoo-client.ts uses,
// during issue #127's implementation, and committed verbatim.
//
// **Test-only.** Nothing in production imports this; it lives under
// `src/` purely so both `packages/core`'s and `apps/pipeline`'s test
// suites can share one copy of the same real data instead of keeping two
// hand-transcribed ones that could drift.
//
// **Why this specific week**: it contains **2025-11-28, the Friday after
// Thanksgiving -- a real NYSE holiday-shortened session** (09:30-13:00 ET
// instead of 09:30-16:00), which is exactly the "fewer bars than usual"
// case issue #127 requires be handled with a real day rather than a
// hypothetical one.
//
// **Why 60-minute bars, when Beat the Bench itself uses 5-minute ones**:
// there is no way to get real 5-minute bars for any real half day.
// Yahoo's `interval=5m` retention is a hard 60-day wall (see
// packages/core/CLAUDE.md's "5-minute intraday bars" section), and -- as
// verified live while implementing issue #127, by fetching the whole
// current 59-day window and counting bars per day -- that rolling window
// contained **no** shortened session at all: all 42 trading days from
// 2026-06-29 to 2026-08-26 had exactly 78 five-minute bars. The next US
// early closes are 2026-11-27 and 2026-12-24, both far outside it, and
// the most recent ones (2025-11-28, 2025-12-24) are far outside it in the
// other direction. `interval=60m`'s 730-day retention does reach them, so
// this fixture is a real half day's real prices at the coarsest
// granularity that could still see it. That's exactly enough for what it
// proves: session-building makes no bar-count assumption whatsoever, so a
// 4-bar day and a 7-bar day both come through intact for the same reason
// a 39-bar day and a 78-bar day would.
//
// Two further real artifacts of this data, both deliberately preserved
// rather than cleaned up, because both are things the code under test has
// to cope with:
//
//  - **2025-11-28 has a `null` close at 12:30**, which
//    `parseIntradayChartResult` drops -- so the real half day yields
//    **4** usable bars, not 5, against a regular day's 7.
//  - **The trailing 2026-08-26T15:00 bar is real**, not a typo: Yahoo
//    appends a bar for the *current* moment even to a request whose
//    `period2` is months in the past (observed live, 2026-08-26). Left in
//    on purpose -- it's precisely the one-bar stub
//    MIN_CLOSED_SESSION_SPAN_MINUTES exists to reject.
//
// Local times are computed with EST (-18000), the historically correct
// offset for late November, rather than the EDT offset `meta.gmtoffset`
// reported at capture time in August -- see packages/core/CLAUDE.md's
// note on that known DST skew. Prices and timestamps are otherwise
// untouched.

import type { IntradayBar } from "../yahoo-client";

/** A regular 2025-11-20 session: 7 bars, 09:30 -> 15:30. */
export const SPY_2025_11_20: readonly IntradayBar[] = [
  { date: "2025-11-20T09:30:00", close: 674.8300170898438 },
  { date: "2025-11-20T10:30:00", close: 667.9000244140625 },
  { date: "2025-11-20T11:30:00", close: 658.5700073242188 },
  { date: "2025-11-20T12:30:00", close: 659.5800170898438 },
  { date: "2025-11-20T13:30:00", close: 657.010009765625 },
  { date: "2025-11-20T14:30:00", close: 656.2000122070312 },
  { date: "2025-11-20T15:30:00", close: 652.530029296875 },
];

/** A regular 2025-11-21 session: 7 bars, 09:30 -> 15:30. */
export const SPY_2025_11_21: readonly IntradayBar[] = [
  { date: "2025-11-21T09:30:00", close: 653.0800170898438 },
  { date: "2025-11-21T10:30:00", close: 655.9299926757812 },
  { date: "2025-11-21T11:30:00", close: 660.3800048828125 },
  { date: "2025-11-21T12:30:00", close: 658.3599853515625 },
  { date: "2025-11-21T13:30:00", close: 664.22998046875 },
  { date: "2025-11-21T14:30:00", close: 659.6300048828125 },
  { date: "2025-11-21T15:30:00", close: 659.0599975585938 },
];

/** A regular 2025-11-24 session: 7 bars, 09:30 -> 15:30. */
export const SPY_2025_11_24: readonly IntradayBar[] = [
  { date: "2025-11-24T09:30:00", close: 665.5449829101562 },
  { date: "2025-11-24T10:30:00", close: 667.969970703125 },
  { date: "2025-11-24T11:30:00", close: 668.1856079101562 },
  { date: "2025-11-24T12:30:00", close: 669.1900024414062 },
  { date: "2025-11-24T13:30:00", close: 668.89990234375 },
  { date: "2025-11-24T14:30:00", close: 668.9400024414062 },
  { date: "2025-11-24T15:30:00", close: 668.8099975585938 },
];

/** A regular 2025-11-25 session: 7 bars, 09:30 -> 15:30. */
export const SPY_2025_11_25: readonly IntradayBar[] = [
  { date: "2025-11-25T09:30:00", close: 668.5800170898438 },
  { date: "2025-11-25T10:30:00", close: 670.4199829101562 },
  { date: "2025-11-25T11:30:00", close: 673.3200073242188 },
  { date: "2025-11-25T12:30:00", close: 674.0250244140625 },
  { date: "2025-11-25T13:30:00", close: 673.3200073242188 },
  { date: "2025-11-25T14:30:00", close: 674.5 },
  { date: "2025-11-25T15:30:00", close: 675 },
];

/** A regular 2025-11-26 session: 7 bars, 09:30 -> 15:30. The last full session before Thanksgiving 2025. */
export const SPY_2025_11_26: readonly IntradayBar[] = [
  { date: "2025-11-26T09:30:00", close: 678.1300048828125 },
  { date: "2025-11-26T10:30:00", close: 680.530029296875 },
  { date: "2025-11-26T11:30:00", close: 680.9400024414062 },
  { date: "2025-11-26T12:30:00", close: 681.1099853515625 },
  { date: "2025-11-26T13:30:00", close: 681.239990234375 },
  { date: "2025-11-26T14:30:00", close: 681.2000122070312 },
  { date: "2025-11-26T15:30:00", close: 679.6300048828125 },
];

/**
 * **The real holiday-shortened session**: 2025-11-28, the Friday after
 * Thanksgiving 2025, a 1:00pm-ET NYSE early close. 4 usable bars (the
 * 12:30 bar's close was `null` upstream and is dropped by
 * `parseIntradayChartResult`), 09:30 -> 13:00, against a regular day's 7
 * bars and 09:30 -> 15:30.
 */
export const SPY_2025_11_28_HALF_DAY: readonly IntradayBar[] = [
  { date: "2025-11-28T09:30:00", close: 681.6900024414062 },
  { date: "2025-11-28T10:30:00", close: 682.1500244140625 },
  { date: "2025-11-28T11:30:00", close: 682.3150024414062 },
  { date: "2025-11-28T13:00:00", close: 683.1099853515625 },
];

/**
 * The real trailing stub bar Yahoo appended to this historical request --
 * a single bar for the moment of capture (2026-08-26), months past the
 * requested `period2`. Not a partial session anyone asked for; exactly
 * the thing `MIN_CLOSED_SESSION_SPAN_MINUTES` rejects.
 */
export const SPY_TRAILING_CURRENT_MOMENT_STUB: readonly IntradayBar[] = [
  { date: "2026-08-26T15:00:00", close: 766.0800170898438 },
];

/** The whole captured response, in the order the endpoint returned it -- five regular sessions, the real half day, and the trailing stub. */
export const SPY_THANKSGIVING_WEEK_2025: readonly IntradayBar[] = [
  ...SPY_2025_11_20,
  ...SPY_2025_11_21,
  ...SPY_2025_11_24,
  ...SPY_2025_11_25,
  ...SPY_2025_11_26,
  ...SPY_2025_11_28_HALF_DAY,
  ...SPY_TRAILING_CURRENT_MOMENT_STUB,
];
