// The Order's pure game mechanics (issue #207): scoring, the locked-slot
// move/shuffle algorithm, and the WCAG glyph vocabulary -- no React, no
// storage, ported directly from
// docs/design/order-lineup-2026-08/mockup-order-lineup.html's own
// `<script>` (the "THE ORDER" section), treated as executable spec per
// this issue's own Background section, not just the mock's screenshots.
//
// Kept pure and storage-free (mirroring lib/call-board-scoring.ts's own
// split from call-board-storage.ts) so this can be unit-tested against
// synthetic guesses with no `window`/localStorage involved at all.

import { ORDER_POOL_SIZE } from "@hadiknowntrades/core";

/** How many attempts the player gets before the puzzle reveals as "out of guesses" -- see spec-the-order.md's own "Attempt limit & pacing" section for the reasoning behind 4. */
export const ORDER_MAX_ATTEMPTS = 4;

/**
 * How many tickers a puzzle always shows -- a re-export of
 * `@hadiknowntrades/core`'s own `ORDER_POOL_SIZE`, not a third
 * independently hardcoded `5` (code review, issue #210:
 * `packages/core/src/order-selection.ts`'s own `ORDER_POOL_SIZE` and
 * `results-schema.ts`'s own `THE_ORDER_TICKER_COUNT` -- itself now also
 * derived from `ORDER_POOL_SIZE`, see that file's own doc comment --
 * used to have this exact same number defined a third, separate time
 * here, with nothing but a comment claiming the three matched).
 */
export const ORDER_SLOT_COUNT = ORDER_POOL_SIZE;

/**
 * One slot's per-attempt feedback -- WCAG 1.4.1-compliant glyph system,
 * directly modeled on CallBoard.tsx's own OUTCOME_STYLES/callOutcomeFor
 * (see spec-the-order.md's own "Feedback mechanics" section): a real
 * glyph *and* an sr-only sentence on top of color, never color alone.
 */
export type OrderFeedback = "exact" | "close" | "far";

/**
 * Scores one submitted guess against the real answer, per slot.
 *
 * **Rank-distance, not return-magnitude distance** -- the input is a
 * discrete permutation of 5 known items, not a set of continuous numbers,
 * so "off by one position" means the same thing every day regardless of
 * that day's real dispersion (spec-the-order.md's own "Scoring,
 * precisely" section works through why this is the right answer, not a
 * simplification). A win is exactly every slot scoring "exact"
 * (equivalent to `guess` being identical to `answer`).
 *
 * `guess`/`answer` are both ticker-code arrays, worst-to-best; ported
 * verbatim from the mockup's own `scoreOrder`.
 */
export function scoreOrderGuess(
  guess: readonly string[],
  answer: readonly string[],
): OrderFeedback[] {
  return guess.map((ticker, i) => {
    const actualIndex = answer.indexOf(ticker);
    const distance = Math.abs(i - actualIndex);
    if (distance === 0) return "exact";
    if (distance === 1) return "close";
    return "far";
  });
}

/** A win is exactly "every slot scored exact." */
export function isWinningFeedback(feedback: readonly OrderFeedback[]): boolean {
  return feedback.every((entry) => entry === "exact");
}

/**
 * The next slot in direction `dir` that isn't locked, hopping *over* any
 * locked slot in its path rather than stopping against it -- ported
 * verbatim from the mockup's own `nextOpenSlot`. Returns -1 if there is
 * no open slot in that direction (the edge, or every remaining slot in
 * that direction is locked).
 */
export function nextOpenSlot(locked: readonly boolean[], index: number, dir: 1 | -1): number {
  let target = index + dir;
  while (target >= 0 && target < locked.length && locked[target]) target += dir;
  return target >= 0 && target < locked.length ? target : -1;
}

/**
 * Moves the slot at `index` one step in direction `dir`, swapping with
 * whichever open slot `nextOpenSlot` finds -- a locked slot never moves
 * (mirrors the mockup's own `moveOrder`'s `if (orderLocked[index])
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
 * Shuffles only the unlocked slots among themselves, leaving every locked
 * slot's ticker and position untouched -- ported from the mockup's own
 * "order-shuffle" click handler ("shuffle only the still-unresolved slots
 * -- a locked, correct slot never gets shuffled back out of place").
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
 * A fresh full shuffle of `answer` for the very first attempt row --
 * retried up to `maxAttemptsToAvoidSolve` times if it happens to land on
 * the real answer outright, mirroring the mockup's own `resetOrder`
 * ("avoid an accidental already-solved shuffle for demo purposes"). With
 * ORDER_SLOT_COUNT=5 (120 permutations), an unguarded shuffle has a real,
 * if small (1/120), chance of an instant, anticlimactic win on the very
 * first render -- worth guarding against for a real player too, not just
 * a demo.
 */
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
 * special-case this endpoint's URL -- would otherwise crash
 * `useOrderGame`'s own `puzzle.tickers.map(...)` with an uncaught
 * `TypeError` instead of falling back to the same "still loading"
 * placeholder state a genuinely pending fetch already shows.
 *
 * **Also enforces the same strict-ascending-by-`pctReturn` check the
 * server-side `validateTheOrderPuzzle` (`packages/core`'s
 * `results-schema.ts`) already enforces at write time** (code review,
 * issue #210) -- this used to check shape/types only, which meant a
 * malformed-but-right-shaped puzzle (e.g. `tickers` in the wrong order,
 * from a hand-crafted test double or a corrupted cache entry) would pass
 * here even though the equivalent object would fail server-side
 * validation before ever being written. Grading a guess against an
 * out-of-order `tickers` array would silently score every guess against
 * the wrong answer -- the exact failure this check exists to catch
 * before a puzzle is ever trusted client-side, matching the server's own
 * rejection instead of accepting a shape the server never would have.
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
      typeof pctReturn !== "number" ||
      !Number.isFinite(pctReturn)
    ) {
      return false;
    }
    if (previousReturn !== null && pctReturn <= previousReturn) return false;
    previousReturn = pctReturn;
    return true;
  });
}

/** "-3.10%" / "+3.20%" -- the mockup's own `pctText` formatting (`(stock.pct >= 0 ? "+" : "") + stock.pct.toFixed(2) + "%"`), for a `pctReturn` that's already a percent number (e.g. -3.1 for -3.1%), not a fraction -- deliberately not `format-currency.ts`'s own `formatPercent` (which expects and multiplies a fraction by 100). */
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
