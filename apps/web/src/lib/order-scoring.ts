// The Order's pure game mechanics: the matching/move/shuffle algorithm
// and the WCAG glyph vocabulary -- no React, no storage, so this can be
// unit-tested against synthetic guesses with no `window`/localStorage
// involved at all (mirroring lib/call-board-scoring.ts's own split from
// call-board-storage.ts).
//
// **First redesigned from the original issue #207 mechanic (direct user
// feedback, not a filed issue -- see TheOrder.tsx's own top-of-file note
// for the full "why").** The original version hid every stock's real
// percent move and only ever graded a submitted order via distance-based
// Mastermind feedback (exact/close/far) across up to 4 attempts, worst
// mover at the top (position 1) and best mover at the bottom (position
// 5) -- which read as backwards ("the best mover is at the bottom?") and
// hid the one number a player most wants while playing. That redesign
// showed every slot's real percent move up front, ranked best (top,
// position 1) to worst (bottom, position N) -- the *ordering* is no
// longer something to guess, it's given -- and reduced grading to a
// binary correct/incorrect per slot (no partial credit for "close" any
// more, since a slot's target ticker is a known, already-visible fact).
//
// **Second redesign, this one (direct user request, not a filed issue --
// see TheOrder.tsx's own top-of-file note): submitting no longer ends
// the day outright.** The first redesign turned this into one free
// rearrange-then-submit round with no second chance -- quite punishing
// for a pure matching puzzle, since a single wrong swap between two
// otherwise-correct slots meant losing the whole day. Now a submission
// grades the current arrangement per slot exactly as before, but any
// slot graded "correct" **locks in place** (its ticker can never move
// again, and can never be swapped into by another ticker either) while
// every "incorrect" slot stays open for further rearranging among the
// other still-open slots, then another submission. The day is won once
// every slot is eventually locked correct -- with **no cap on how many
// submissions that takes**, a deliberate product decision (this game
// isn't scored on attempt efficiency, only on eventually solving it).
//
// `nextOpenSlot`/`moveOrderGuess`/`shuffleUnlockedGuess` below restore
// (adapted for binary correct/incorrect rather than the original
// Mastermind mechanic's rank-distance exact/close/far) the exact
// hop-over-locked-slots move/shuffle algorithm the *first* redesign had
// removed as unnecessary for a one-shot puzzle -- see this repo's own
// git history (the pre-first-redesign version of this file, commit
// e4413c1) for the original, from which this is ported near-verbatim.
//
// A slot's own "locked" status is never stored separately -- it's always
// derived from the most recent submission's own per-slot grading
// (`lockedSlots` below), since a locked slot's guess never moves again
// and can therefore only ever keep scoring "correct" on every later
// resubmission. This mirrors how this app already prefers deriving
// state fresh over storing a second, redundant copy of it (e.g.
// CallBoard's/The Order's own streak stats, computed from a history
// rather than stored as their own numbers) -- one less thing to keep in
// sync, and one less way for persisted state to drift from what it
// actually describes.

import { ORDER_POOL_SIZE } from "@hadiknowntrades/core";

import { isFiniteNumber } from "./is-finite-number";

/**
 * How many tickers a puzzle always shows -- a re-export of
 * `@hadiknowntrades/core`'s own `ORDER_POOL_SIZE`, not a second
 * independently hardcoded `5` (see that package's own doc comment for
 * the single-source-of-truth history this already went through once).
 */
export const ORDER_SLOT_COUNT = ORDER_POOL_SIZE;

/**
 * One slot's grading from its most recent submission -- binary, not the
 * original three-state exact/close/far. A slot's target ticker is a
 * known, already-visible fact the moment its percent move is on screen
 * (this redesign's whole point), so there's no meaningful "close" any
 * more: an assignment is either the real ticker for that slot or it
 * isn't. A "correct" grading is permanent (see `lockedSlots` below) --
 * once a slot locks, its own guess never changes again, so it can only
 * ever keep re-grading "correct" on every later submission.
 */
export type OrderFeedback = "correct" | "incorrect";

/**
 * Scores a submitted guess against the real answer, per slot:
 * `guess[i]` is correct exactly when it's the ticker that really belongs
 * in slot `i`. `answer` is expected in the same best-to-worst order the
 * slots are rendered in -- see `bestToWorstTickers` below, the one place
 * that ordering gets derived from the puzzle's own (server-side,
 * worst-to-best) `tickers` array. Safe to call over the *entire* current
 * guess on every resubmission (not just the still-open slots) -- a
 * locked slot's own guess never moves, so it always re-scores "correct"
 * regardless of how many times this runs.
 */
export function scoreOrderMatch(
  guess: readonly string[],
  answer: readonly string[],
): OrderFeedback[] {
  return guess.map((ticker, i) => (ticker === answer[i] ? "correct" : "incorrect"));
}

/** A win is exactly "every slot scored correct." */
export function isWinningFeedback(feedback: readonly OrderFeedback[]): boolean {
  return feedback.every((entry) => entry === "correct");
}

/**
 * Which slots are locked in place -- derived from the most recent
 * submission's own per-slot grading, never stored as a separate array.
 * `feedback === null` (never submitted yet, or the day ended via a
 * bail-out reveal with nothing actually graded) means nothing is
 * locked. Slot `i` is locked exactly when `feedback[i] === "correct"`.
 */
export function lockedSlots(
  feedback: readonly OrderFeedback[] | null,
  slotCount: number,
): boolean[] {
  if (feedback === null) return new Array<boolean>(slotCount).fill(false);
  return feedback.map((entry) => entry === "correct");
}

/**
 * The puzzle's tickers in the order the game actually shows and grades
 * against: best mover first (top, slot 1), worst mover last (bottom,
 * slot N). The server always emits `tickers` ascending by `pctReturn`
 * (worst-to-best -- `packages/core`'s own validated invariant, unchanged
 * by this redesign); this is the one place that gets reversed into
 * leaderboard order, so nothing else has to re-derive it independently.
 */
export function bestToWorstTickers<T>(tickers: readonly T[]): T[] {
  return [...tickers].reverse();
}

/**
 * The next slot in direction `dir` that isn't locked, hopping *over* any
 * locked slot in its path rather than stopping against it -- ported
 * (adapted for this redesign's own binary locking, not the original
 * Mastermind mechanic's rank-distance one) from the pre-first-redesign
 * version of this file (see this repo's own git history, commit
 * e4413c1). Returns -1 if there is no open slot in that direction (the
 * edge, or every remaining slot in that direction is locked).
 */
export function nextOpenSlot(locked: readonly boolean[], index: number, dir: 1 | -1): number {
  let target = index + dir;
  while (target >= 0 && target < locked.length && locked[target]) target += dir;
  return target >= 0 && target < locked.length ? target : -1;
}

/**
 * Moves the slot at `index` one step in direction `dir`, swapping with
 * whichever open slot `nextOpenSlot` finds -- a locked slot never moves
 * (mirrors the pre-first-redesign version's own `if (locked[index])
 * return`), and a move with no legal target is a no-op, both returning
 * the same array reference unchanged so a caller can skip a re-render.
 */
export function moveOrderGuess(
  guess: readonly string[],
  locked: readonly boolean[],
  index: number,
  dir: 1 | -1,
): readonly string[] {
  if (locked[index]) return guess;
  const target = nextOpenSlot(locked, index, dir);
  if (target === -1) return guess;
  const next = [...guess];
  [next[index], next[target]] = [next[target]!, next[index]!];
  return next;
}

/** Fisher-Yates over an injected uniform [0, 1) source, mirroring apps/pipeline's own shuffleInPlace (pipeline.ts) -- kept as a second, independent copy rather than a shared package: that one lives server-side, this one client-side, and there's no existing shared module either would import from without adding one purely for this. */
function shuffleInPlace<T>(items: T[], random: () => number): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [items[i], items[j]] = [items[j]!, items[i]!];
  }
  return items;
}

/**
 * Shuffles only the unlocked slots among themselves, leaving every
 * locked slot's ticker and position untouched -- ported (adapted for
 * this redesign's own binary locking) from the pre-first-redesign
 * version of this file's own "shuffle only the still-unresolved slots"
 * click handler (commit e4413c1).
 */
export function shuffleUnlockedGuess(
  guess: readonly string[],
  locked: readonly boolean[],
  random: () => number,
): readonly string[] {
  const openIndices: number[] = [];
  const openValues: string[] = [];
  guess.forEach((value, i) => {
    if (!locked[i]) {
      openIndices.push(i);
      openValues.push(value);
    }
  });
  const shuffled = shuffleInPlace([...openValues], random);
  const next = [...guess];
  openIndices.forEach((slotIndex, k) => {
    next[slotIndex] = shuffled[k]!;
  });
  return next;
}

/**
 * Defensively confirms a fetched payload actually has the shape
 * `TheOrder.tsx` needs before treating it as a real puzzle -- the server
 * route (`results-api.ts`'s own `getTheOrderResponse`) already validates
 * this, but a client should never trust a fetched JSON body's runtime
 * shape purely from its static TypeScript type (see
 * `InvalidTradePriceError`'s own precedent, `lib/trade-math.ts`, for why
 * this app already treats "the server validated it" as not the same
 * guarantee as "the client's own cast is safe"). Without this, a
 * malformed/wrong-shaped 200 response -- a stale cache entry, or (as
 * found live, in this repo's own tests) a test double that doesn't
 * special-case this endpoint's URL -- would otherwise crash this
 * component's own rendering with an uncaught `TypeError` instead of
 * falling back to the same "still loading" placeholder state a
 * genuinely pending fetch already shows.
 *
 * **Also enforces the same strict-ascending-by-`pctReturn` check the
 * server-side `validateTheOrderPuzzle` (`packages/core`'s
 * `results-schema.ts`) already enforces at write time** -- this used to
 * check shape/types only, which meant a malformed-but-right-shaped
 * puzzle (e.g. `tickers` in the wrong order, from a hand-crafted test
 * double or a corrupted cache entry) would pass here even though the
 * equivalent object would fail server-side validation before ever being
 * written. Grading a guess against an out-of-order `tickers` array would
 * silently score every guess against the wrong slot -- the exact failure
 * this check exists to catch before a puzzle is ever trusted
 * client-side, matching the server's own rejection instead of accepting
 * a shape the server never would have. Unaffected by this file's own
 * best-to-worst redesign above: the server-side invariant this checks is
 * still worst-to-best (`bestToWorstTickers` is what reverses it for
 * display/scoring, not this validator).
 */
export function isValidOrderPuzzle(value: unknown): value is {
  date: string;
  tickers: { ticker: string; companyName: string; pctReturn: number }[];
} {
  if (typeof value !== "object" || value === null) return false;
  const { date, tickers } = value as Record<string, unknown>;
  if (typeof date !== "string" || date.length === 0) return false;
  if (!Array.isArray(tickers) || tickers.length !== ORDER_SLOT_COUNT) return false;
  let previousReturn: number | null = null;
  return tickers.every((entry) => {
    if (typeof entry !== "object" || entry === null) return false;
    const { ticker, companyName, pctReturn } = entry as Record<string, unknown>;
    if (
      typeof ticker !== "string" ||
      ticker.length === 0 ||
      typeof companyName !== "string" ||
      companyName.length === 0 ||
      !isFiniteNumber(pctReturn)
    ) {
      return false;
    }
    if (previousReturn !== null && pctReturn <= previousReturn) return false;
    previousReturn = pctReturn;
    return true;
  });
}

/** "-3.10%" / "+3.20%" -- the original mockup's own `pctText` formatting (`(stock.pct >= 0 ? "+" : "") + stock.pct.toFixed(2) + "%"`), for a `pctReturn` that's already a percent number (e.g. -3.1 for -3.1%), not a fraction -- deliberately not `format-currency.ts`'s own `formatPercent` (which expects and multiplies a fraction by 100). */
export function formatOrderPctReturn(pctReturn: number): string {
  const sign = pctReturn >= 0 ? "+" : "";
  return `${sign}${pctReturn.toFixed(2)}%`;
}

/**
 * Whether `guess` is genuinely a permutation of `answer` -- same length,
 * same multiset of tickers, just possibly reordered. Used to defend
 * against stale persisted state (use-order-game.ts's own mount-time read)
 * that no longer matches the current puzzle's own tickers, e.g. if the
 * pipeline ever rewrites the same date's puzzle with a different 5-ticker
 * set (a manual backfill). Tickers are unique within one puzzle (see
 * order-selection.ts's own `computeOrderSelection`, which never repeats a
 * ticker across `picks`), so a straightforward sorted-array comparison is
 * enough -- no need to count duplicates.
 */
export function isPermutationOf(guess: readonly string[], answer: readonly string[]): boolean {
  if (guess.length !== answer.length) return false;
  const sortedGuess = [...guess].sort();
  const sortedAnswer = [...answer].sort();
  return sortedGuess.every((ticker, i) => ticker === sortedAnswer[i]);
}

/**
 * A fresh full shuffle of `answer` for the puzzle's very first render --
 * retried up to `maxAttemptsToAvoidSolve` times if it happens to land on
 * the real answer outright (mirroring the original mockup's own
 * `resetOrder`: "avoid an accidental already-solved shuffle for demo
 * purposes"). With ORDER_SLOT_COUNT=5 (120 permutations), an unguarded
 * shuffle has a real, if small (1/120), chance of an instant,
 * anticlimactic win on the very first render -- worth guarding against
 * for a real player too, not just a demo.
 */
export function initialOrderGuess(
  answer: readonly string[],
  random: () => number,
  maxAttemptsToAvoidSolve = 10,
): readonly string[] {
  let candidate = shuffleInPlace([...answer], random);
  let tries = 0;
  while (candidate.join(",") === answer.join(",") && tries < maxAttemptsToAvoidSolve) {
    candidate = shuffleInPlace([...answer], random);
    tries++;
  }
  return candidate;
}
