// Turns one ticker's raw intraday bars into discrete, playable trading
// *sessions* -- the data unit Beat the Bench (issues #127/#131/#132)
// plays through bar by bar. Introduced by issue #127 for SPY
// specifically, but nothing here is SPY-specific.
//
// Two jobs, both small and both load-bearing:
//
// 1. **Split the date from the time-of-day.** `IntradayBar.date` holds a
//    full local datetime ("2026-08-21T14:30:00", see yahoo-client.ts) --
//    a per-bar fingerprint of exactly which calendar day the bar came
//    from. A `SessionBar` keeps only the time-of-day half, and the real
//    date is carried once, on the session envelope, where a caller can
//    choose to publish it (Today's Close) or withhold it (Mystery Day).
//    That split is the whole mechanism behind issue #127's secrecy
//    guarantee: there is no per-bar date left for a mystery payload to
//    leak. See results-schema.ts's MysterySession for the payload side.
//
// 2. **Decide which sessions are actually *closed*.** A pooled session
//    is meant to be a complete trading day, not a partial one. Two real
//    (empirically observed, not hypothetical) ways a partial session
//    shows up in a chart-endpoint response:
//    - The pipeline runs mid-session, so the newest day only has bars up
//      to "now."
//    - Yahoo appends a single stub bar for the *current* moment even to
//      a request whose `period2` is months in the past -- verified live
//      while implementing issue #127: a `interval=60m` request for
//      2025-11-25..2025-11-28 came back with a trailing
//      `2026-08-26T15:00` bar tacked onto the end. Left alone, that
//      single bar would become its own one-bar "session."
//
// The completeness test is deliberately a **span** (last bar minus first
// bar), not an absolute time-of-day threshold like "the last bar must be
// at/after 15:55." An absolute threshold looks more precise but is
// actually wrong here, because `meta.gmtoffset` is the exchange's offset
// *at request time* applied uniformly to every bar in the range (see
// packages/core/CLAUDE.md's "60-minute intraday bars" section) -- so any
// session on the far side of a DST transition from "now" carries
// time-of-day labels shifted by an hour, and a fixed 15:55 threshold
// would reject a whole batch of genuinely complete sessions every
// November and March. A span is a *difference* between two labels, so
// that uniform offset cancels out exactly.

import type { IntradayBar } from "./yahoo-client";
import { splitLocalDateTime } from "./intraday-optimizer";
import type { SessionBar } from "./results-schema";

/**
 * Minimum first-bar-to-last-bar span, in minutes, for a session to count
 * as a real, closed trading day.
 *
 * 180 (3 hours) is chosen to sit below the shortest *real* US equity
 * session and comfortably above any partial one worth rejecting:
 * - A regular session (09:30-16:00 ET) spans 385 minutes to its last
 *   5-minute bar (09:30 -> 15:55).
 * - A holiday-shortened half day (09:30-13:00 ET) spans 210 minutes --
 *   live-verified against real data, not assumed: 2025-11-28, the Friday
 *   after Thanksgiving 2025, really does run 09:30 -> 13:00 (see
 *   intraday-sessions.test.ts, which uses that exact real session as its
 *   fixture).
 * - Yahoo's trailing current-moment stub bar spans 0 minutes.
 *
 * **Known, accepted gap**: a run that happens *during* a regular session
 * but after ~12:30 ET produces a partial day that clears this bar and
 * would be treated as closed. That's unreachable for the real nightly
 * run (06:00 UTC = 01:00/02:00 ET, hours after the close and before the
 * next open -- see infra/cdk/lib/hadiknowntrades-stack.ts) and is only
 * reachable from a manual mid-afternoon local run. Closing it properly
 * would need a real NYSE holiday/early-close calendar, which is far more
 * machinery than a stakes-free game's session pool justifies.
 */
export const MIN_CLOSED_SESSION_SPAN_MINUTES = 180;

/**
 * One complete trading session's worth of bars, with the real date and
 * the time-of-day-only bars kept as separate fields so a caller can
 * publish the bars without publishing the date (issue #127's Mystery Day).
 */
export interface IntradaySession {
  /** The real exchange-local trading date, YYYY-MM-DD. Never embedded in `bars`. */
  date: string;
  /** This session's bars, ascending by time-of-day, each labelled with time-of-day only. */
  bars: SessionBar[];
}

/**
 * Groups one ticker's intraday bars into complete trading sessions,
 * ascending by date.
 *
 * Any session whose span falls under `MIN_CLOSED_SESSION_SPAN_MINUTES` is
 * dropped -- see that constant's own doc comment for the two real
 * partial-session cases this exists to reject, and for why the test is a
 * span rather than an absolute time-of-day. A session that survives is
 * returned in full: **no bar-count assumption is made anywhere here**, so
 * a real 39-bar half day and a real 78-bar regular day both come through
 * intact, differing only in `bars.length`.
 *
 * Bars are sorted by their full local datetime before grouping (plain
 * string comparison is correct for the fixed-width "YYYY-MM-DDTHH:MM:SS"
 * shape) rather than trusting the fetch's return order -- the same
 * defensive posture `apps/pipeline`'s own `sortedHistory` takes toward
 * `fetchDailyCloses`'s documented-as-"ascending in practice",
 * not-actually-guaranteed ordering.
 */
export function buildIntradaySessions(bars: readonly IntradayBar[]): IntradaySession[] {
  const byDate = new Map<string, SessionBar[]>();
  for (const bar of [...bars].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))) {
    const { date, time } = splitLocalDateTime(bar.date);
    let sessionBars = byDate.get(date);
    if (!sessionBars) {
      sessionBars = [];
      byDate.set(date, sessionBars);
    }
    sessionBars.push({ time, close: bar.close });
  }

  const sessions: IntradaySession[] = [];
  for (const date of [...byDate.keys()].sort()) {
    const sessionBars = byDate.get(date)!;
    if (sessionSpanMinutes(sessionBars) < MIN_CLOSED_SESSION_SPAN_MINUTES) continue;
    sessions.push({ date, bars: sessionBars });
  }
  return sessions;
}

/** First-bar-to-last-bar span in minutes; 0 for a session of fewer than two bars. */
function sessionSpanMinutes(bars: readonly SessionBar[]): number {
  const first = bars[0];
  const last = bars[bars.length - 1];
  if (!first || !last || first === last) return 0;
  return minutesOfDay(last.time) - minutesOfDay(first.time);
}

/** "13:00:00" -> 780. Seconds are ignored: no real bar boundary lands off a whole minute. */
function minutesOfDay(time: string): number {
  const [hours, minutes] = time.split(":");
  return Number(hours) * 60 + Number(minutes);
}
