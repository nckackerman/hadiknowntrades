// The pure engine behind Beat the Bench (issue #131) -- the playable,
// bar-by-bar buy/sell game against this app's own SPY benchmark. No
// React, no storage, no formatting decisions beyond the two small
// helpers at the bottom, so every rule below is unit-testable against a
// real price series without mounting anything.
//
// The mechanic, stated once here so the component doesn't have to
// re-derive it:
//
//   - The player starts with STARTING_CAPITAL, already **in the market**
//     -- exactly where the benchmark starts. That is what makes the
//     zero-trade case a genuine tie rather than a near-miss.
//   - Each tick reveals one more real SessionBar. The player may toggle
//     between holding and cash at the bar currently on screen, as many
//     times as they like.
//   - At the last bar, both sides settle. The benchmark is buy-and-hold
//     over the same session -- i.e. *this same function with no moves at
//     all* (see `balanceAtBar`), which is why the tie is exact rather
//     than merely close.

import { isValidPrice, type SessionBar } from "@hadiknowntrades/core";

/**
 * The stake, in dollars. Deliberately the same $20 the rest of this app
 * starts every hindsight run from (see packages/core's optimizer and
 * `starting-capital.ts`'s DEFAULT_STARTING_CAPITAL) -- **not** wired to
 * the viewer's own configurable starting capital (issue #15), because
 * per issue #122 this section takes no props from the results view and
 * owns its own state. One fixed, stated stake also keeps the settlement
 * copy honest ("starting from $20.00, already in the market").
 */
export const STARTING_CAPITAL = 20;

/**
 * Playback speeds, as multipliers of the 1x baseline below. Five fixed
 * settings rather than a slider: each one has to be a >=44px touch
 * target at 375px (issue #131's own acceptance criteria), and a
 * continuous control would make "what speed am I at" unreadable at a
 * glance mid-session.
 */
export const PLAYBACK_SPEEDS = [0.1, 0.5, 1, 2, 4] as const;
export type PlaybackSpeed = (typeof PLAYBACK_SPEEDS)[number];

export const DEFAULT_SPEED: PlaybackSpeed = 1;

/**
 * Milliseconds per bar at 1x -- **the single most experience-defining
 * number in this mechanic**, so it is a stated target hit on purpose,
 * not an emergent property.
 *
 * The target: a full regular session plays in **under 30 seconds at
 * 1x**. A real regular SPY session is 79 five-minute bars (09:30
 * through 16:00 inclusive -- verified against real pipeline output, not
 * assumed), and the first bar is already on screen when play starts, so
 * a full run is 78 ticks: 78 x 300ms = **23.4s**. That leaves real
 * headroom over the 30s target for the longest session shape this data
 * can produce, while staying slow enough that a human can actually
 * decide to sell.
 *
 * The other four speeds fall out of this: 0.1x is a deliberately
 * patient 3.9 minutes (for someone reading every bar), 4x is 5.9
 * seconds (for a replay, or for a reduced-motion viewer who would
 * rather not step 78 times).
 */
export const BASE_TICK_MS = 300;

/** The stated real-time ceiling for a full session at 1x -- asserted against real bar counts in this module's own tests, so a future change to BASE_TICK_MS can't quietly blow past it. */
export const TARGET_SESSION_MS_AT_1X = 30_000;

/** How long one bar is held on screen at `speed`. Every speed produces a genuinely different interval -- see this module's own tests, which assert the real timings rather than merely that the multipliers differ. */
export function tickIntervalMs(speed: PlaybackSpeed): number {
  return BASE_TICK_MS / speed;
}

/**
 * Real-time length of a full playthrough of `barCount` bars at `speed`.
 * `barCount - 1` ticks, not `barCount`: the opening bar is already on
 * screen when play starts (the player is already in the market at that
 * price), so only the remaining bars are revealed on a timer.
 */
export function sessionDurationMs(barCount: number, speed: PlaybackSpeed): number {
  return Math.max(0, barCount - 1) * tickIntervalMs(speed);
}

/**
 * What the player is holding right now. A shares/cash pair rather than a
 * running balance multiplied by each bar's return, on purpose: valuing
 * `shares` at the current price is one multiplication from the opening
 * price no matter how many bars have passed, so a 79-bar session
 * accumulates no per-bar floating-point drift at all. That is also what
 * lets the zero-move case tie the benchmark *exactly* rather than within
 * an epsilon.
 */
export interface Holding {
  /** Units of the session's ticker held. Zero exactly when the player is in cash. */
  shares: number;
  /** Dollars held outside the market. Zero exactly when the player is holding. */
  cash: number;
}

/** Whether a holding is in the market or sitting in cash -- the toggle button's whole state. */
export type Position = "holding" | "cash";

export function positionOf(holding: Holding): Position {
  return holding.shares > 0 ? "holding" : "cash";
}

/** The opening holding: the whole stake, in the market, at the session's first price. */
export function openHolding(openingPrice: number, capital: number): Holding {
  return { shares: capital / openingPrice, cash: 0 };
}

/** Flips a holding at `price` -- sell everything to cash, or put all the cash back in. All-in/all-out only, matching the rest of this app's trade model. */
export function toggleHolding(holding: Holding, price: number): Holding {
  if (holding.shares > 0) {
    return { shares: 0, cash: holding.shares * price };
  }
  return { shares: holding.cash / price, cash: 0 };
}

/** What a holding is worth at `price`. */
export function holdingValue(holding: Holding, price: number): number {
  return holding.shares * price + holding.cash;
}

/**
 * The player's balance as of `barIndex`, having toggled at exactly the
 * bars listed in `moveBarIndexes` (ascending, each <= barIndex to have
 * any effect).
 *
 * **This one function computes both sides of the game.** The benchmark
 * is `balanceAtBar(bars, [], capital, i)` -- literally this call with no
 * moves -- so "buy and hold" and "never touch it" aren't two
 * implementations that agree to within rounding, they're the same
 * evaluation of the same expression. That is the mechanic's core
 * invariant (issue #131's first acceptance criterion) and it holds by
 * construction, not by tolerance.
 */
export function balanceAtBar(
  bars: readonly SessionBar[],
  moveBarIndexes: readonly number[],
  capital: number,
  barIndex: number,
): number {
  const clamped = Math.min(Math.max(barIndex, 0), bars.length - 1);
  let holding = openHolding(bars[0]!.close, capital);
  for (const moveIndex of moveBarIndexes) {
    if (moveIndex > clamped) break;
    holding = toggleHolding(holding, bars[moveIndex]!.close);
  }
  return holdingValue(holding, bars[clamped]!.close);
}

/** The holding a player would be sitting on at `barIndex`, given their moves so far -- what the toggle button renders its label and color from. */
export function holdingAtBar(
  bars: readonly SessionBar[],
  moveBarIndexes: readonly number[],
  capital: number,
  barIndex: number,
): Holding {
  let holding = openHolding(bars[0]!.close, capital);
  for (const moveIndex of moveBarIndexes) {
    if (moveIndex > barIndex) break;
    holding = toggleHolding(holding, bars[moveIndex]!.close);
  }
  return holding;
}

/**
 * The player's position *after* `barIndex` -- i.e. with every toggle up
 * to and including that bar applied. Each toggle flips the position, so
 * this is simply the parity of the moves so far; two toggles at the same
 * bar (a mis-tap, or a genuine change of mind at one price) cancel out,
 * which is exactly what really happens to the money too.
 */
export function positionAfterBar(moveBarIndexes: readonly number[], barIndex: number): Position {
  const applied = moveBarIndexes.filter((moveIndex) => moveIndex <= barIndex).length;
  return applied % 2 === 0 ? "holding" : "cash";
}

/** The position after each bar from 0 through `barIndex`, for the chart's per-segment styling. */
export function positionsThroughBar(
  moveBarIndexes: readonly number[],
  barIndex: number,
): Position[] {
  return Array.from({ length: Math.max(barIndex + 1, 0) }, (_, i) =>
    positionAfterBar(moveBarIndexes, i),
  );
}

/**
 * How a finished session came out. `"tie"` is reserved for **exact**
 * equality -- see `settleSession` for why that is a reachable outcome
 * rather than a theoretical one.
 */
export type SessionOutcome = "win" | "loss" | "tie";

export interface Settlement {
  startingCapital: number;
  playerBalance: number;
  benchmarkBalance: number;
  playerReturnFraction: number;
  benchmarkReturnFraction: number;
  /** How many times the player toggled. Zero is a real, deliberate way to play -- see `outcomeHeadline`. */
  moves: number;
  outcome: SessionOutcome;
}

/** Settles a finished session: the player's own balance against buy-and-hold over the same bars. */
export function settleSession(
  bars: readonly SessionBar[],
  moveBarIndexes: readonly number[],
  capital: number = STARTING_CAPITAL,
): Settlement {
  const lastIndex = bars.length - 1;
  const playerBalance = balanceAtBar(bars, moveBarIndexes, capital, lastIndex);
  const benchmarkBalance = balanceAtBar(bars, [], capital, lastIndex);
  return {
    startingCapital: capital,
    playerBalance,
    benchmarkBalance,
    playerReturnFraction: playerBalance / capital - 1,
    benchmarkReturnFraction: benchmarkBalance / capital - 1,
    moves: moveBarIndexes.length,
    outcome:
      playerBalance > benchmarkBalance ? "win" : playerBalance < benchmarkBalance ? "loss" : "tie",
  };
}

/**
 * The settlement stamp's headline.
 *
 * **Register note (issue #131, explicitly):** the mechanic is borrowed
 * from Beat the Couch, the voice is not. That product's copy taunts a
 * player who sat still ("twitchy", "even odds"); this app's voice is the
 * wistful, earnest one `narrate-trades.ts` established ("Had you known,
 * you'd have bought..."). A player who never traded made a real choice
 * and got a real, mathematically inevitable result -- "along for the
 * ride" describes it; "even odds" doesn't even describe it accurately
 * (zero trades is buy-and-hold, not a coin flip).
 */
export function outcomeHeadline(settlement: Settlement): string {
  if (settlement.outcome === "win") return "You beat the bench";
  if (settlement.outcome === "loss") return "The bench stayed ahead";
  return settlement.moves === 0 ? "Along for the ride" : "Dead even with the bench";
}

/** The sentence under the stamp -- earnest, never mocking, and honest about what a zero-move tie actually is. */
export function outcomeDetail(settlement: Settlement): string {
  if (settlement.moves === 0) {
    return "You never moved, so you finished exactly where the bench did -- to the cent. Holding and never touching it are the same thing.";
  }
  if (settlement.outcome === "win") {
    return `You stepped aside at the right moment. ${movesPhrase(settlement.moves)}, and it was worth it.`;
  }
  if (settlement.outcome === "loss") {
    return `The market moved while you were out of it. ${movesPhrase(settlement.moves)} -- and holding would have done better today.`;
  }
  return `${movesPhrase(settlement.moves)}, and it came out level with holding -- every dollar you stepped out of, you stepped back into at the same price.`;
}

function movesPhrase(moves: number): string {
  return moves === 1 ? "You moved once" : `You moved ${moves} times`;
}

/**
 * How far ahead or behind the bench the player finished, in words.
 *
 * A single session moves a fraction of a percent, so both balances
 * routinely round to the same dollars-and-cents figure even when one
 * genuinely won -- the gap, not the two balances, is the honest thing to
 * put on screen. Below a hundredth of a percent it says so plainly
 * rather than printing a misleading "0.00%" next to a win stamp.
 */
export function gapPhrase(settlement: Settlement): string {
  const { playerBalance, benchmarkBalance } = settlement;
  if (playerBalance === benchmarkBalance) return "Level with the bench, exactly.";
  const gap = playerBalance / benchmarkBalance - 1;
  const direction = gap > 0 ? "ahead of" : "behind";
  const magnitude = Math.abs(gap);
  if (magnitude < 0.00005) return `Less than 0.01% ${direction} the bench.`;
  return `${(magnitude * 100).toFixed(2)}% ${direction} the bench.`;
}

/**
 * The part of a fetched session payload this check actually looks at.
 *
 * Structural rather than `TodaysCloseSession`, because issue #132 plays
 * `MysterySession` payloads through this same engine unchanged -- the two
 * differ only in whether they carry a real date, which is exactly the
 * field a playability check has no business reading.
 */
export interface PlayableSessionPayload {
  bars: readonly SessionBar[];
}

/**
 * Whether a fetched session is actually playable: at least two bars (one
 * to start at and one to move to) and a real price on every one of them.
 *
 * Delegates the per-price check to packages/core's `isValidPrice` rather
 * than re-deriving `Number.isFinite(v) && v > 0` -- the same single
 * source of truth `call-board-scoring.ts` reuses (see
 * packages/core/CLAUDE.md, which records catching exactly that drift
 * once already). The API route already rejects a wrong-shaped or
 * empty-barred payload; this is the client's own last guard before
 * dividing by a price.
 */
export function isPlayableSession(session: PlayableSessionPayload): boolean {
  return (
    Array.isArray(session.bars) &&
    session.bars.length >= 2 &&
    session.bars.every((bar) => typeof bar.time === "string" && isValidPrice(bar.close))
  );
}
