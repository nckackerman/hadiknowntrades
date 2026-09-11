// The Cut (issue #233): pure guess-scoring logic, no React, no storage --
// mirrors order-scoring.ts's own "pure functions the hook calls" shape.
// See docs/design/the-cut-2026-09/README.md's "Interaction"/"Scoring"
// sections for the design this implements.
//
// The mechanic: the player guesses a prefix length N (1..universeSize),
// picking how many of the real-weight-ranked S&P 500 companies (held
// cap-weighted, #1..N) they think would have maximized hindsight profit
// over the chosen window. Up to CUT_MAX_ATTEMPTS guesses, each graded two
// ways: a direction (too high / too low, relative to the real bestN) and
// a named closeness band on rank-distance. The game ends the instant a
// guess is exactly bestN (a win), or once CUT_MAX_ATTEMPTS guesses are
// used up without one (a loss) -- the same "up to N attempts, stop early
// on an exact match" shape a Wordle-style game uses, chosen over The
// Order's/The Lineup's one-shot mechanics because directional feedback
// across several guesses is what makes a 1..500 search tractable at all.
//
// Scoring is NOT based on rank-distance alone -- the design doc is
// explicit that a guess far off in a flat stretch of the curve can be
// nearly free, while a guess close by across a steep stretch can cost the
// whole edge. `edgeCapturedPct` measures this directly: the % of the real
// available edge (bestEndingBalance over the N=universeSize baseline)
// that the guessed N's own ending balance actually captures.

import type { Sp500PrefixCurvePoint, Sp500PrefixResult } from "@hadiknowntrades/core";

import { FULL_CELEBRATION_INTENSITY, type CelebrationIntensity } from "./celebration-magnitude";

/** Up to 6 guesses per game (docs/design/the-cut-2026-09/README.md's own "5-6 guesses"). */
export const CUT_MAX_ATTEMPTS = 6;

export type CutDirection = "too-high" | "too-low";
export type CutCloseness = "hot" | "warm" | "cold" | "ice-cold";

/**
 * The full grading for one guess. `direction`/`closeness` are both `null`
 * exactly when `correct` is true -- there's nothing to grade a direction
 * or a distance band against once the guess is the real answer.
 */
export interface CutGuessFeedback {
  guess: number;
  correct: boolean;
  direction: CutDirection | null;
  closeness: CutCloseness | null;
  /** |guess - bestN| -- the secondary, human-readable stat the design doc asks for alongside the %. */
  rankDistance: number;
  /** 0-100, clamped -- the % of the real available edge over the N=universeSize baseline this guess actually captures. */
  edgeCapturedPct: number;
  /** This guess's own ending balance (from the curve, or startingCapital as a fallback -- see curvePointAtOrBelow's own doc comment). */
  guessEndingBalance: number;
}

/**
 * The last curve entry with `n <= guess` -- `curve` only ever has an
 * entry for an N where `cumWeight[N] > 0` (computeSp500PrefixSelection's
 * own documented guard, packages/core), so a guess smaller than the
 * curve's own smallest `n` (only reachable when a leading run of the
 * highest-ranked companies all lack window data -- vanishingly rare
 * against a real, mostly-populated universe, but not impossible against
 * a small test/dev fixture) has no exact entry to read. Returns `null`
 * in that case; callers fall back to treating the guess as if it held
 * nothing (its own `startingCapital`, i.e. a 1x/flat return) rather than
 * crashing on a missing curve point.
 */
export function curvePointAtOrBelow(
  curve: readonly Sp500PrefixCurvePoint[],
  n: number,
): Sp500PrefixCurvePoint | null {
  let result: Sp500PrefixCurvePoint | null = null;
  for (const point of curve) {
    if (point.n <= n) {
      result = point;
    } else {
      break; // curve is ascending by n (computeSp500PrefixSelection's own contract) -- safe to stop early
    }
  }
  return result;
}

/**
 * Named closeness band on rank-distance, scaled to the universe's own
 * size so the same four bands stay meaningful whether `universeSize` is
 * the real ~503 or a much smaller test fixture. Distance 0 (an exact
 * match) always falls in "hot" too -- callers that need to distinguish a
 * genuine win check `correct`/`direction` separately, not this band.
 */
export function closenessBand(rankDistance: number, universeSize: number): CutCloseness {
  const fraction = universeSize > 0 ? rankDistance / universeSize : 1;
  if (fraction <= 0.02) return "hot";
  if (fraction <= 0.08) return "warm";
  if (fraction <= 0.2) return "cold";
  return "ice-cold";
}

/**
 * % of the real available edge (bestEndingBalance over the
 * N=universeSize baseline) a guess's own ending balance captures, clamped
 * to [0, 100]. When there's no real edge to capture at all (bestN already
 * equals universeSize -- the N=500 baseline was already optimal),
 * returns 100 unconditionally: there was nothing to miss.
 */
export function edgeCapturedPct(
  guessEndingBalance: number,
  n500EndingBalance: number,
  bestEndingBalance: number,
): number {
  const availableEdge = bestEndingBalance - n500EndingBalance;
  if (availableEdge <= 0) return 100;
  const capturedEdge = guessEndingBalance - n500EndingBalance;
  return Math.max(0, Math.min(100, (capturedEdge / availableEdge) * 100));
}

export interface ScoreCutGuessInput {
  guess: number;
  bestN: number;
  curve: readonly Sp500PrefixCurvePoint[];
  n500EndingBalance: number;
  bestEndingBalance: number;
  universeSize: number;
  startingCapital: number;
}

/** Grades one guess against the real bestN -- see this module's own header comment for the full mechanic. */
export function scoreCutGuess({
  guess,
  bestN,
  curve,
  n500EndingBalance,
  bestEndingBalance,
  universeSize,
  startingCapital,
}: ScoreCutGuessInput): CutGuessFeedback {
  const rankDistance = Math.abs(guess - bestN);
  const correct = rankDistance === 0;
  const point = curvePointAtOrBelow(curve, guess);
  const guessEndingBalance = point ? point.endingBalance : startingCapital;

  return {
    guess,
    correct,
    direction: correct ? null : guess > bestN ? "too-high" : "too-low",
    closeness: correct ? null : closenessBand(rankDistance, universeSize),
    rankDistance,
    edgeCapturedPct: edgeCapturedPct(guessEndingBalance, n500EndingBalance, bestEndingBalance),
    guessEndingBalance,
  };
}

/**
 * `curve`'s own entry for `n === universeSize` -- the N=500 baseline this
 * game scores every guess against (see docs/design/the-cut-2026-09/
 * README.md's "Baseline comparison" section). Falls back to the curve's
 * last entry when there's no exact match (only reachable if the very
 * highest-ranked companies' own window data is missing all the way to the
 * top of the universe -- see curvePointAtOrBelow's own doc comment for
 * the identical rare case), and `null` when the curve is empty entirely.
 */
export function n500CurvePoint(
  curve: readonly Sp500PrefixCurvePoint[],
  universeSize: number,
): Sp500PrefixCurvePoint | null {
  return curve.find((point) => point.n === universeSize) ?? curve.at(-1) ?? null;
}

/**
 * The Cut's own reveal-burst gate + magnitude scale (issue #239).
 *
 * **The gate: `meetsCutCelebrationGate`, not `won`/`state.won` alone.**
 * HeroStat's own celebration burst gates on a strict dollar gain
 * (`isGain`, shouldCelebrate.ts) -- this game's closest analog is an
 * exact N=bestN win, but limiting the burst to *only* an exact match
 * would ignore a real, near-perfect guess that captured almost the whole
 * available edge without landing on bestN exactly (a guess one rank off
 * in a flat stretch of the curve, say). Both cases are genuinely "a good
 * result" worth celebrating, just at different intensities -- the "both,
 * at different intensities" option issue #239 itself named as a real
 * design choice, not a literal copy of HeroStat's dollar-gain gate. So
 * the gate is expressed directly against `edgeCapturedPct` (this
 * module's own scoring output, already the % of the real available edge
 * a guess captured) rather than against `correct`/`won` -- a guess that
 * happens to be exact always scores `edgeCapturedPct === 100` (see
 * `scoreCutGuess`), so an exact win still always clears this gate; it's
 * just not the *only* thing that can.
 *
 * **The magnitude scale is linear over 0-100, deliberately NOT a reuse
 * of celebration-magnitude.ts's own `celebrationIntensityFor`.** That
 * function's decade-spanning tiers exist specifically for HeroStat's
 * dollar-multiplier scale, which can span from 1x to tens of millions of
 * x (see that module's own header comment) -- a genuinely different
 * shape of number than `edgeCapturedPct`, which is already a bounded,
 * clamped 0-100 percentage. A plain linear ladder over that same 0-100
 * range is the natural scale here, not an order-of-magnitude one.
 *
 * Below 60%: no confetti at all -- capturing well under two-thirds of
 * the real available edge isn't a "throw confetti" result, even when the
 * direction/closeness bands shown alongside it read encouragingly.
 * 60-84%: modest. 85-99%: strong. 100% (an exact win, or a non-exact
 * guess that still reached the curve's own max attainable value -- see
 * `edgeCapturedPct`'s own doc comment for how that can happen without an
 * exact match): full, the same 24-piece/100%-spread burst HeroStat's own
 * top tier uses.
 *
 * The gate and the ladder's own suppressed tier deliberately share one
 * threshold (`SUPPRESS_BELOW_EDGE_PCT`), not two independently-tuned
 * numbers, so the two can never disagree about what counts as "worth
 * celebrating at all" -- `TheCut.tsx`'s own `CutReveal` component calls
 * both, passing `meetsCutCelebrationGate`'s result as `shouldCelebrate.ts`'s
 * `isGain` parameter (renamed `celebrationGateMet` there, since there's
 * no dollar gain/loss concept in this game to call it "a gain").
 */
const SUPPRESS_BELOW_EDGE_PCT = 60;
const MODEST_BELOW_EDGE_PCT = 85;
const STRONG_BELOW_EDGE_PCT = 100;

const MODEST_CUT_CELEBRATION_INTENSITY: CelebrationIntensity = {
  pieceCount: 8,
  spreadPercent: 45,
};
const STRONG_CUT_CELEBRATION_INTENSITY: CelebrationIntensity = {
  pieceCount: 16,
  spreadPercent: 72,
};

/** Whether a completed game's final guess is worth celebrating at all -- see this section's own header comment above. */
export function meetsCutCelebrationGate(edgeCapturedPctValue: number): boolean {
  return edgeCapturedPctValue >= SUPPRESS_BELOW_EDGE_PCT;
}

/** How much confetti a completed game's reveal throws, scaled to `edgeCapturedPct` -- see this section's own header comment above. */
export function cutCelebrationIntensity(edgeCapturedPctValue: number): CelebrationIntensity {
  if (!meetsCutCelebrationGate(edgeCapturedPctValue)) {
    return { pieceCount: 0, spreadPercent: 0 };
  }
  if (edgeCapturedPctValue < MODEST_BELOW_EDGE_PCT) {
    return MODEST_CUT_CELEBRATION_INTENSITY;
  }
  if (edgeCapturedPctValue < STRONG_BELOW_EDGE_PCT) {
    return STRONG_CUT_CELEBRATION_INTENSITY;
  }
  return FULL_CELEBRATION_INTENSITY;
}

/**
 * Defensive client-side re-check of a fetched /api/sp500-prefix body,
 * mirroring order-scoring.ts's own isValidOrderPuzzle -- a malformed or
 * wrong-shaped 200 response must fall back to the same "still loading"
 * placeholder a genuinely pending fetch shows, not crash the page. This
 * app's own API route already runs a much stricter check
 * (validateSp500PrefixResult, packages/core) before ever storing the
 * object, and readCurrentSchemaObject/getSp500PrefixResponse
 * (results-api.ts) re-check schemaVersion and a few load-bearing fields
 * again server-side -- this is one more, cheap client-side floor on top,
 * not a re-derivation of either.
 */
export function isValidSp500PrefixResult(value: unknown): value is Sp500PrefixResult {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.universeSize === "number" &&
    r.universeSize > 0 &&
    Array.isArray(r.curve) &&
    (r.bestN === null || typeof r.bestN === "number")
  );
}
