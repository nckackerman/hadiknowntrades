// Local session persistence for Beat the Bench (issue #131): "did I play
// this day's session, and how did it come out."
//
// Follows this app's two-layer localStorage pattern (see apps/web/
// CLAUDE.md's "localStorage pattern"): every read/write goes through
// local-storage.ts's defensive helpers, this module owns one namespaced
// key prefix and its own small JSON shape, and anything that doesn't
// parse as a well-formed record reads as "nothing stored" rather than
// throwing. Storage being unavailable entirely (private browsing, a
// storage-blocking policy, SSR) degrades to "you haven't played yet" --
// the game stays fully playable, it just won't remember.
//
// **Keyed per (date, mode), which is why issue #133's status rail can
// build on it directly.** The date is the *session's own trading date*
// (TodaysCloseSession.date), not the viewer's calendar day: Today's
// Close replays the most recently closed session, so on a Saturday both
// the game and the rail mean Friday's session, and keying by the
// viewer's clock would silently start a second "today" over a weekend.

import { readLocalStorage, writeLocalStorage } from "./local-storage";
import type { SessionOutcome } from "./beat-the-bench";

/**
 * Which Beat the Bench mode a stored record belongs to. Only
 * "todays-close" ships in issue #131; "mystery" is issue #132's, and is
 * named here so that issue adds a value rather than a key format.
 */
export type BeatTheBenchMode = "todays-close" | "mystery";

const KEY_PREFIX = "hikt:beat-the-bench:";

/** The exact key one played session is stored under -- `hikt:beat-the-bench:{date}:{mode}`, the shape issue #133's status rail reads. */
export function beatTheBenchKey(date: string, mode: BeatTheBenchMode): string {
  return `${KEY_PREFIX}${date}:${mode}`;
}

/**
 * What one finished session leaves behind. An object (not a bare outcome
 * string) so a later field is an additive value change rather than a
 * stored-format migration -- the same reasoning `call-board-storage.ts`'s
 * own StoredPick records.
 *
 * `played` is stored explicitly even though its presence is implied by
 * the record existing: issue #133's rail asks "played today?" and should
 * be able to answer that from the field it names, not from a truthiness
 * check on the record itself.
 */
export interface PlayedSession {
  played: true;
  outcome: SessionOutcome;
  playerBalance: number;
  benchmarkBalance: number;
  /** How many times the player toggled. Zero is a real way to play (see `outcomeHeadline`), so this is a genuine value, not a "didn't really play" marker. */
  moves: number;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isOutcome(value: unknown): value is SessionOutcome {
  return value === "win" || value === "loss" || value === "tie";
}

/**
 * The viewer's stored result for one (date, mode), or `null` if they
 * haven't played it -- or if storage is unavailable, or holds something
 * malformed. A hand-edited or stale-format value is exactly as untrusted
 * as one that was never written.
 */
export function readPlayedSession(date: string, mode: BeatTheBenchMode): PlayedSession | null {
  const raw = readLocalStorage(beatTheBenchKey(date, mode));
  if (raw === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;

  const { played, outcome, playerBalance, benchmarkBalance, moves } = parsed as Record<
    string,
    unknown
  >;
  if (played !== true) return null;
  if (!isOutcome(outcome)) return null;
  if (!isFiniteNumber(playerBalance) || !isFiniteNumber(benchmarkBalance)) return null;
  if (!isFiniteNumber(moves) || moves < 0) return null;

  return { played: true, outcome, playerBalance, benchmarkBalance, moves };
}

/**
 * Records a finished session. Returns whether the write actually stuck --
 * callers that re-derive their own state from the value they just wrote
 * (which is what `BeatTheBench.tsx` does) can ignore it.
 *
 * A replay of the same day overwrites the previous record rather than
 * being refused. Nothing here enforces one play per day: the settlement
 * a viewer is looking at should be the one the page remembers, and a
 * stakes-free toy has no reason to lock someone out of playing their own
 * session twice.
 */
export function savePlayedSession(
  date: string,
  mode: BeatTheBenchMode,
  session: PlayedSession,
): boolean {
  return writeLocalStorage(beatTheBenchKey(date, mode), JSON.stringify(session));
}
