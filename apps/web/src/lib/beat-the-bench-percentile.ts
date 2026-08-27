// "Where did I finish against a field of people trading at random?" --
// the Monte Carlo half of Beat the Bench's Final Settlement (issue #132).
//
// This is a real simulation against the **same real session price path**
// the player just played, not a fitted curve or a stored distribution:
// `SIMULATION_TRIALS` synthetic traders walk the identical bars, each
// toggling in and out at random moments, and the player's own finishing
// balance is ranked against theirs. Every trader in the field is settled
// by `beat-the-bench.ts`'s own `balanceAtBar` -- the exact function that
// settles the player and the bench -- so the field, the player and
// buy-and-hold are all the same evaluation of the same expression, and a
// zero-move player's rank is genuinely buy-and-hold's rank rather than an
// approximation of it.
//
// **The randomness is injectable, and no call path here ever reaches
// `Math.random()`.** A bare `Math.random()` would make any assertion on a
// resulting percentile flaky by construction, and this repo treats test
// flakiness as a bug rather than something to tolerate (see the root
// CLAUDE.md's working agreements, and apps/pipeline's own injectable
// `random` for the mystery-slot permutation). Callers pass an `Rng`;
// `BeatTheBench.tsx` passes one seeded from the session's own price path
// (`seedFromBars`), so a given session always produces the same field --
// the number a player sees is reproducible, not a fresh coin flip each
// time the component happens to re-render.

import { balanceAtBar } from "./beat-the-bench";
import { mulberry32, type Rng } from "./seeded-random";
import type { SessionBar } from "@hadiknowntrades/core";

/**
 * Re-exported so this file's own existing callers (`BeatTheBench.tsx`,
 * `beat-the-bench-percentile.test.ts`) need no import changes --
 * `mulberry32`/`Rng` themselves now live in `lib/seeded-random.ts`, see
 * that module's own doc comment for why they moved (issue #174).
 */
export { mulberry32, type Rng };

/**
 * How many synthetic traders the field holds.
 *
 * 500 is a deliberate middle: enough that the percentile is stable to
 * about a percentage point run to run under different seeds (checked
 * against both real fixtures), and cheap enough to run synchronously in a
 * render at settlement -- a trial is one pass over the session's bars, so
 * a regular 78-bar session costs on the order of 40k simple operations
 * total, well under a frame.
 */
export const SIMULATION_TRIALS = 500;

/**
 * Per-bar probability that a simulated trader flips between holding and
 * cash.
 *
 * Chosen so an average trader makes roughly four moves across a regular
 * ~78-bar session (`0.05 * 77 ~= 3.9`) -- restless enough that the field
 * genuinely spends time out of the market (which is what makes
 * buy-and-hold's rank move with the session's direction, the whole point
 * of the comparison), without being so twitchy that every trader
 * converges on the same "in about half the time" average and the
 * distribution collapses.
 *
 * A first-pass value, tuned by inspection against the two real fixtures
 * rather than derived from anything about real trader behaviour -- said
 * plainly here so no UI copy presents this field as a model of how people
 * actually trade. It is a random-timing control group, nothing more.
 */
export const TOGGLE_PROBABILITY = 0.05;

/**
 * A seed derived from the session's own price path.
 *
 * Deliberately *not* the clock, a counter, or anything about the viewer:
 * the same session must always produce the same field, so re-rendering
 * the settlement (a resize, a mode toggle, React strict mode's double
 * render) can never quietly move the percentile a player is reading. It
 * is also safe for Mystery Day -- a price path is already fully published
 * in the payload the client is holding, so hashing it reveals nothing the
 * client didn't already have. **Never seed this from a session date**;
 * for Mystery Day the client does not have one, and must not.
 */
export function seedFromBars(bars: readonly SessionBar[]): number {
  let hash = 0x811c9dc5;
  for (const bar of bars) {
    // Scale to hundredths of a cent before truncating, so two bars whose
    // closes differ only past the second decimal still hash apart.
    const scaled = Math.trunc(bar.close * 10000);
    hash = Math.imul(hash ^ (scaled & 0xffff), 0x01000193);
    hash = Math.imul(hash ^ ((scaled >>> 16) & 0xffff), 0x01000193);
  }
  return hash >>> 0;
}

export interface SimulationOptions {
  trials?: number;
  toggleProbability?: number;
  /** Required -- there is no default, so no caller can accidentally fall through to unseeded randomness. */
  random: Rng;
}

/**
 * The bar indexes one simulated trader toggles at.
 *
 * Bar 0 is never a toggle candidate: every trader (like the player, and
 * like the bench) starts the session already in the market at the opening
 * price, so "toggle at bar 0" would just be a different starting
 * position, not a timing decision. The last bar is a candidate but has no
 * effect on the finishing balance -- selling at the closing price leaves
 * the same dollars -- which is true of the real game too, so it is left
 * in rather than special-cased away.
 */
export function randomTogglerMoves(barCount: number, toggleProbability: number, random: Rng) {
  const moves: number[] = [];
  for (let i = 1; i < barCount; i += 1) {
    if (random() < toggleProbability) moves.push(i);
  }
  return moves;
}

/**
 * Runs the whole field against `bars` and returns every trader's
 * finishing balance, **sorted ascending** (which is what `percentileRank`
 * below wants, and what makes the result easy to eyeball in a test).
 */
export function simulateRandomTogglers(
  bars: readonly SessionBar[],
  capital: number,
  options: SimulationOptions,
): number[] {
  const trials = options.trials ?? SIMULATION_TRIALS;
  const toggleProbability = options.toggleProbability ?? TOGGLE_PROBABILITY;
  const lastIndex = bars.length - 1;

  const balances: number[] = [];
  for (let trial = 0; trial < trials; trial += 1) {
    const moves = randomTogglerMoves(bars.length, toggleProbability, options.random);
    balances.push(balanceAtBar(bars, moves, capital, lastIndex));
  }
  return balances.sort((a, b) => a - b);
}

/**
 * Where `value` sits in `sortedBalances`, as a fraction in `[0, 1]`.
 *
 * Ties count as half, the standard mid-rank convention -- it matters here
 * rather than being a formality: a trader whose random moves happened to
 * cancel out finishes at *exactly* buy-and-hold (the same exactness
 * `settleSession`'s own zero-move tie relies on), so a zero-move player
 * genuinely ties a real slice of the field. Counting those ties as
 * "beaten" would overstate a do-nothing player's rank, and counting them
 * as "lost to" would understate it.
 */
export function percentileRank(sortedBalances: readonly number[], value: number): number {
  if (sortedBalances.length === 0) return 0;
  let below = 0;
  let equal = 0;
  for (const balance of sortedBalances) {
    if (balance < value) below += 1;
    else if (balance === value) equal += 1;
  }
  return (below + equal / 2) / sortedBalances.length;
}

export interface PercentileComparison {
  /** How many simulated traders the player was ranked against. */
  trials: number;
  /** The player's own rank in `[0, 1]` -- 0.87 means they finished ahead of 87% of the field. */
  percentile: number;
  /** The field's own median finishing balance, for the settlement copy to name a concrete "typical" outcome. */
  medianBalance: number;
}

/**
 * The settlement's percentile line, end to end: build the field, settle
 * the player the same way, and rank one against the other.
 *
 * For a zero-move player this is buy-and-hold's own percentile, with no
 * special case anywhere -- `balanceAtBar(bars, [], ...)` *is* the
 * benchmark (see `beat-the-bench.ts`), so "the player" and "buy and hold"
 * are the same call when there are no moves.
 */
export function comparePercentile(
  bars: readonly SessionBar[],
  moveBarIndexes: readonly number[],
  capital: number,
  options: SimulationOptions,
): PercentileComparison {
  const balances = simulateRandomTogglers(bars, capital, options);
  const playerBalance = balanceAtBar(bars, moveBarIndexes, capital, bars.length - 1);
  return {
    trials: balances.length,
    percentile: percentileRank(balances, playerBalance),
    medianBalance: medianOf(balances),
  };
}

/**
 * The settlement's percentile sentence.
 *
 * Names the field for what it is -- traders who moved *at random*, not a
 * benchmark of skill -- in the same earnest register as
 * `beat-the-bench.ts`'s own settlement copy (see `outcomeHeadline`'s
 * register note). The percentage is rounded to a whole number: the field
 * is 500 traders drawn from one seeded run, so a decimal place would
 * imply a precision the simulation doesn't have.
 */
export function percentilePhrase(comparison: PercentileComparison): string {
  const percent = Math.round(comparison.percentile * 100);
  const field = `${comparison.trials} traders who moved at random through the same session`;
  if (percent >= 100) return `You finished ahead of all ${field}.`;
  if (percent <= 0) return `You finished behind all ${field}.`;
  return `You finished ahead of ${percent}% of ${field}.`;
}

function medianOf(sorted: readonly number[]): number {
  if (sorted.length === 0) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}
