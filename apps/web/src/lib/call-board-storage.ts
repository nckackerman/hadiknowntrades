// Date-keyed browser storage for The Call Board (issue #128), plus the one
// orchestration function (`syncCallBoard`) that turns stored picks + a real
// SPY daily-close series into everything the UI (issue #129) needs.
//
// Follows this app's established two-layer localStorage pattern (see
// apps/web/CLAUDE.md's "localStorage pattern"): every read/write goes
// through local-storage.ts's defensive helpers, this module owns one
// namespaced key prefix and its own JSON shapes, and anything that doesn't
// parse as a well-formed value reads as "nothing stored" rather than
// throwing. The `"use client"` hook layer over this is issue #129's, not
// this file's.
//
// **Date-keying is the point here, and is not a reversal of issue #91's
// decision for range-guess-storage.ts.** That module deliberately has no
// date dimension because there is exactly one whole-range guess per
// (range, mode). This mechanic is the opposite shape: one independent call
// per trading day, several open at once, each locking and resolving on its
// own schedule -- so the day *is* the identity, and one entry per date is
// the correct key, not a regression to something #91 moved away from.

import type { DailyClose } from "@hadiknowntrades/core";

import {
  computeCallBoardStats,
  mergeResolvedCalls,
  resolveCalls,
  upcomingCallDays,
  type CallBoardStats,
  type CallBucket,
  type CallScore,
  type ResolvedCall,
} from "./call-board-scoring";
import { isPickEditable } from "./market-calendar";
import { readLocalStorage, writeLocalStorage } from "./local-storage";
import { parseJson } from "./parse-json";

// Namespaced distinctly from every other feature's prefix ("hikt:range-guess:",
// "hikt:startingCapital", ...) so no coordination between features is needed.
const KEY_PREFIX = "hikt:call-board:";
const PICK_KEY_PREFIX = `${KEY_PREFIX}pick:`;
const HISTORY_KEY = `${KEY_PREFIX}history`;

/**
 * How many resolved calls are kept. Roughly 18 months of trading days --
 * far more than any stat on the board reads back (`bestStreak` is the only
 * one that looks at the whole history at all), but cheap enough at ~100
 * bytes an entry that trimming harder would only risk truncating a real
 * streak for no practical gain. Oldest entries are dropped first.
 */
export const MAX_STORED_RESOLVED_CALLS = 400;

// Per-day pick entries are deliberately never pruned once their day has
// resolved. They're tiny (~45 bytes each, ~250 a year of active play) against
// a multi-megabyte origin budget, and deleting one would mean first proving
// its resolved entry actually made it into the persisted history -- an
// extra read-back to guard against a quota failure, for storage this
// mechanic will never plausibly fill. Revisit only if a real quota problem
// ever shows up.

function pickKeyFor(date: string): string {
  return `${PICK_KEY_PREFIX}${date}`;
}

function isCallBucket(value: unknown): value is CallBucket {
  return value === "up-strong" || value === "up" || value === "down" || value === "down-strong";
}

/** The stored shape of one day's pick. An object rather than a bare bucket string so a later field (a timestamp, a note) is an additive value change, not a stored-format migration. */
interface StoredPick {
  bucket: CallBucket;
}

/** The viewer's pick for `date`, or `null` if they haven't called that day (or storage is unavailable, or holds something malformed). */
export function getCallBoardPick(date: string): CallBucket | null {
  const parsed = parseJson(readLocalStorage(pickKeyFor(date)));
  if (typeof parsed !== "object" || parsed === null) return null;
  const { bucket } = parsed as Record<string, unknown>;
  return isCallBucket(bucket) ? bucket : null;
}

/** Every stored pick among `dates`, as a date -> bucket map (dates with no pick are simply absent). */
export function readCallBoardPicks(dates: readonly string[]): Record<string, CallBucket> {
  const picks: Record<string, CallBucket> = {};
  for (const date of dates) {
    const pick = getCallBoardPick(date);
    if (pick !== null) picks[date] = pick;
  }
  return picks;
}

/**
 * Records (or changes) the viewer's call for `date`, but **only while that
 * day is still editable** -- a not-yet-started trading day, per
 * `isPickEditable`'s clock approximation. A pick may be changed any number
 * of times before that boundary; once the day's market has opened, this is
 * a no-op that returns `false` rather than silently overwriting a locked
 * call.
 *
 * The lock lives here, at the persistence boundary, rather than only in the
 * UI: whatever #129 renders, a pick that reached storage after its own day
 * opened would be indistinguishable from one made honestly, and this is the
 * one place every write has to pass through.
 *
 * Returns `false` for a rejected write *and* for a genuine storage failure
 * (see local-storage.ts) -- callers that care about the difference should
 * ask `isPickEditable` first; nothing in the shipped UI needs to.
 */
export function saveCallBoardPick(date: string, bucket: CallBucket, now: Date): boolean {
  if (!isPickEditable(date, now)) return false;
  const stored: StoredPick = { bucket };
  return writeLocalStorage(pickKeyFor(date), JSON.stringify(stored));
}

function isCallScore(value: unknown): value is CallScore {
  return value === 0 || value === 1 || value === 2;
}

function isResolvedCall(value: unknown): value is ResolvedCall {
  if (typeof value !== "object" || value === null) return false;
  const { date, pick, actual, moveFraction, score } = value as Record<string, unknown>;
  return (
    typeof date === "string" &&
    date.length > 0 &&
    isCallBucket(pick) &&
    isCallBucket(actual) &&
    typeof moveFraction === "number" &&
    Number.isFinite(moveFraction) &&
    isCallScore(score)
  );
}

/**
 * The persisted resolved history, ascending by date.
 *
 * Persisted rather than re-derived on every load because it outlives its own
 * source data: `benchmarkSeries` is a trailing ~90-calendar-day window, so a
 * call resolved four months ago has no closes left to re-resolve it from,
 * and a streak that ran across that boundary would silently reset if this
 * were derived state.
 *
 * Any entry that doesn't parse is dropped rather than failing the whole
 * read -- a partially-corrupt history should cost the entries it corrupted,
 * not the entire record.
 */
export function getResolvedCalls(): ResolvedCall[] {
  const parsed = parseJson(readLocalStorage(HISTORY_KEY));
  if (typeof parsed !== "object" || parsed === null) return [];
  const { resolved } = parsed as Record<string, unknown>;
  if (!Array.isArray(resolved)) return [];
  return resolved.filter(isResolvedCall);
}

/** Replaces the persisted history with `calls`, trimmed to the most recent `MAX_STORED_RESOLVED_CALLS`. */
export function saveResolvedCalls(calls: readonly ResolvedCall[]): boolean {
  const trimmed = calls.slice(-MAX_STORED_RESOLVED_CALLS);
  return writeLocalStorage(HISTORY_KEY, JSON.stringify({ resolved: trimmed }));
}

/** One of the (at most `MAX_OPEN_CALLS`) not-yet-started trading days on the board, with whatever the viewer has called for it so far. */
export interface OpenCall {
  date: string;
  /** `null` until the viewer calls this day; still freely changeable either way, since an open call is by definition not yet locked. */
  pick: CallBucket | null;
}

/** Everything the board needs to render, and the only shape #129 has to consume. */
export interface CallBoardState {
  /** The rolling lookahead, ascending -- see `upcomingCallDays`. */
  openCalls: OpenCall[];
  /** Settled calls, ascending by date, newly-resolved days already folded in. */
  resolved: ResolvedCall[];
  /** Derived from `resolved` on every read rather than stored (see below). */
  stats: CallBoardStats;
}

/**
 * Reads the board, settling anything that has closed since the last read.
 *
 * Given the real SPY daily closes a `PrecomputedResult` carries
 * (`benchmarkSeries.closes`, issue #126) and the client's own clock, this:
 * resolves every stored pick the series now covers, folds those into the
 * persisted history (an already-settled date keeps its original entry, see
 * `mergeResolvedCalls`), writes the history back, and returns the merged
 * history alongside the current lookahead.
 *
 * **Stats are derived here, never persisted.** The issue's storage brief
 * lists them alongside picks and history, but computing them from the
 * history on every read is strictly safer than storing a second copy: a
 * stale or hand-edited stored `bestStreak` could disagree with the very
 * calls it claims to summarise, and `computeCallBoardStats` is a cheap walk
 * over a few hundred entries.
 *
 * Safe to call during a server render (it just reports an empty board --
 * every storage read degrades to "nothing stored" without a `window`), but
 * #129's hook still owes it this app's usual hydration discipline: don't
 * let a client's first render disagree with the server's.
 */
export function syncCallBoard(closes: readonly DailyClose[], now: Date): CallBoardState {
  const picks = readCallBoardPicks(closes.map((entry) => entry.date));
  const newlyResolved = resolveCalls(closes, picks);
  const existing = getResolvedCalls();
  const merged = mergeResolvedCalls(existing, newlyResolved);
  // `mergeResolvedCalls` only ever adds dates (an already-settled one keeps
  // its original entry), so a length change is exactly "something new
  // settled" -- worth checking, since this runs on every board read and the
  // overwhelmingly common case is that nothing has closed since the last one.
  if (merged.length !== existing.length) saveResolvedCalls(merged);

  const openCalls = upcomingCallDays(now).map((date) => ({
    date,
    pick: getCallBoardPick(date),
  }));

  return { openCalls, resolved: merged, stats: computeCallBoardStats(merged) };
}
