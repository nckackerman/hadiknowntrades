import { describe, expect, it } from "vitest";

import {
  initialOrderGuess,
  isWinningFeedback,
  moveOrderGuess,
  nextOpenSlot,
  ORDER_MAX_ATTEMPTS,
  ORDER_SLOT_COUNT,
  scoreOrderGuess,
  shuffleUnlockedGuess,
  type OrderFeedback,
} from "./order-scoring";

const ANSWER = ["TSLA", "AAPL", "MSFT", "META", "NVDA"];

describe("constants", () => {
  it("has the expected values", () => {
    expect(ORDER_MAX_ATTEMPTS).toBe(4);
    expect(ORDER_SLOT_COUNT).toBe(5);
  });
});

describe("scoreOrderGuess", () => {
  it("scores an all-exact guess as every slot exact", () => {
    const feedback = scoreOrderGuess(ANSWER, ANSWER);
    expect(feedback).toEqual(["exact", "exact", "exact", "exact", "exact"]);
    expect(isWinningFeedback(feedback)).toBe(true);
  });

  it("scores a fully reversed guess as far everywhere except the middle slot", () => {
    const reversed = [...ANSWER].reverse();
    const feedback = scoreOrderGuess(reversed, ANSWER);
    // Positions: 0<->4 (dist 4, far), 1<->3 (dist 2, far), 2 stays put (dist 0, exact)
    expect(feedback).toEqual(["far", "far", "exact", "far", "far"]);
    expect(isWinningFeedback(feedback)).toBe(false);
  });

  it("scores an adjacent swap as close for both swapped slots", () => {
    const guess = ["AAPL", "TSLA", "MSFT", "META", "NVDA"]; // swap slots 0/1
    const feedback = scoreOrderGuess(guess, ANSWER);
    expect(feedback).toEqual(["close", "close", "exact", "exact", "exact"]);
  });

  it("realistic mix: some exact, some close, some far", () => {
    // ANSWER: TSLA(0) AAPL(1) MSFT(2) META(3) NVDA(4)
    const guess = ["NVDA", "AAPL", "META", "MSFT", "TSLA"];
    // NVDA at 0, real index 4 -> dist 4 -> far
    // AAPL at 1, real index 1 -> dist 0 -> exact
    // META at 2, real index 3 -> dist 1 -> close
    // MSFT at 3, real index 2 -> dist 1 -> close
    // TSLA at 4, real index 0 -> dist 4 -> far
    const feedback: OrderFeedback[] = scoreOrderGuess(guess, ANSWER);
    expect(feedback).toEqual(["far", "exact", "close", "close", "far"]);
  });
});

describe("nextOpenSlot", () => {
  it("returns the immediately adjacent slot when nothing is locked", () => {
    const locked = [false, false, false, false, false];
    expect(nextOpenSlot(locked, 2, 1)).toBe(3);
    expect(nextOpenSlot(locked, 2, -1)).toBe(1);
  });

  it("hops over a locked slot in its path", () => {
    const locked = [false, true, false, false, false];
    expect(nextOpenSlot(locked, 0, 1)).toBe(2); // hops over index 1
  });

  it("hops over multiple consecutive locked slots", () => {
    const locked = [false, true, true, true, false];
    expect(nextOpenSlot(locked, 0, 1)).toBe(4);
  });

  it("returns -1 at the edge with nothing further to move to", () => {
    const locked = [false, false, false, false, false];
    expect(nextOpenSlot(locked, 4, 1)).toBe(-1);
    expect(nextOpenSlot(locked, 0, -1)).toBe(-1);
  });

  it("returns -1 when every remaining slot in that direction is locked", () => {
    const locked = [false, false, false, true, true];
    expect(nextOpenSlot(locked, 2, 1)).toBe(-1);
  });
});

describe("moveOrderGuess", () => {
  it("swaps with the next open slot", () => {
    const guess = ["A", "B", "C", "D", "E"];
    const locked = [false, false, false, false, false];
    expect(moveOrderGuess(guess, locked, 1, 1)).toEqual(["A", "C", "B", "D", "E"]);
  });

  it("hops a moving slot over a locked slot in its path", () => {
    const guess = ["A", "B", "C", "D", "E"];
    const locked = [false, false, true, false, false];
    // Moving index 1 ("B") downward should land on index 3 ("D"), skipping locked index 2 ("C").
    expect(moveOrderGuess(guess, locked, 1, 1)).toEqual(["A", "D", "C", "B", "E"]);
  });

  it("never moves a locked slot itself", () => {
    const guess = ["A", "B", "C", "D", "E"];
    const locked = [false, true, false, false, false];
    expect(moveOrderGuess(guess, locked, 1, 1)).toBe(guess); // same reference, no-op
  });

  it("is a no-op (same reference) when there's no legal target", () => {
    const guess = ["A", "B", "C", "D", "E"];
    const locked = [false, false, false, false, false];
    expect(moveOrderGuess(guess, locked, 0, -1)).toBe(guess);
  });
});

describe("shuffleUnlockedGuess", () => {
  it("leaves every locked slot's ticker and position untouched", () => {
    const guess = ["A", "B", "C", "D", "E"];
    const locked = [true, false, false, true, false];
    // A fixed "random" source that always returns 0 -- deterministic Fisher-Yates result.
    const result = shuffleUnlockedGuess(guess, locked, () => 0);
    expect(result[0]).toBe("A");
    expect(result[3]).toBe("D");
    // The unlocked values (B, C, E) are still present, just possibly reordered.
    expect(new Set([result[1], result[2], result[4]])).toEqual(new Set(["B", "C", "E"]));
  });

  it("with every slot locked, returns the guess unchanged", () => {
    const guess = ["A", "B", "C", "D", "E"];
    const locked = [true, true, true, true, true];
    expect(shuffleUnlockedGuess(guess, locked, () => 0.5)).toEqual(guess);
  });
});

describe("initialOrderGuess", () => {
  it("is a permutation of the real answer", () => {
    const guess = initialOrderGuess(ANSWER, () => 0.5);
    expect([...guess].sort()).toEqual([...ANSWER].sort());
  });

  it("retries when the shuffle happens to land on the exact answer", () => {
    // Fisher-Yates over ORDER_SLOT_COUNT=5 makes exactly 4 random() calls
    // per shuffle attempt (i = 4, 3, 2, 1). A fixed 0.99 makes every one of
    // those calls resolve to j = i (floor(0.99 * (i+1)) === i for each),
    // i.e. every "swap" is really a no-op -- the identity permutation,
    // which equals ANSWER exactly and must trigger a retry. The next 4
    // calls (0) produce a real, verified-different permutation, so the
    // retry succeeds on its first attempt.
    let call = 0;
    const random = () => {
      call++;
      return call <= 4 ? 0.99 : 0;
    };
    const guess = initialOrderGuess(ANSWER, random, 10);
    expect(guess.join(",")).not.toBe(ANSWER.join(","));
    expect([...guess].sort()).toEqual([...ANSWER].sort());
  });

  it("never returns the exact answer when a genuinely random source is used repeatedly", () => {
    // Run many times with Math.random(); across enough trials, the guard
    // should mean we never observe the initial guess exactly matching the
    // answer once retries are available (this is a statistical sanity
    // check, not a proof, but ORDER_SLOT_COUNT=5 gives 1/120 odds per
    // shuffle and up to 10 retries, so failing this would indicate a real
    // bug, not noise).
    for (let trial = 0; trial < 200; trial++) {
      const guess = initialOrderGuess(ANSWER, Math.random, 10);
      expect(guess.join(",")).not.toBe(ANSWER.join(","));
    }
  });
});
