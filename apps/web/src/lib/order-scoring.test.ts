import { describe, expect, it } from "vitest";

import { ORDER_POOL_SIZE, THE_ORDER_TICKER_COUNT } from "@hadiknowntrades/core";

import {
  bestToWorstTickers,
  initialOrderGuess,
  isValidOrderPuzzle,
  isWinningFeedback,
  lockedSlots,
  moveOrderGuess,
  nextOpenSlot,
  ORDER_SLOT_COUNT,
  scoreOrderMatch,
  shuffleUnlockedGuess,
  type OrderFeedback,
} from "./order-scoring";

const ANSWER = ["TSLA", "AAPL", "MSFT", "META", "NVDA"];
const ALL_OPEN = [false, false, false, false, false];

function validPuzzlePayload(): unknown {
  return {
    date: "2026-08-26",
    tickers: [
      { ticker: "TSLA", companyName: "Tesla, Inc.", pctReturn: -3.1 },
      { ticker: "AAPL", companyName: "Apple Inc.", pctReturn: -0.42 },
      { ticker: "MSFT", companyName: "Microsoft", pctReturn: 0.55 },
      { ticker: "META", companyName: "Meta Platforms", pctReturn: 1.85 },
      { ticker: "NVDA", companyName: "Nvidia", pctReturn: 3.2 },
    ],
  };
}

describe("constants", () => {
  it("has the expected value", () => {
    expect(ORDER_SLOT_COUNT).toBe(5);
  });

  // The puzzle's slot count used to be hardcoded independently in three
  // places (ORDER_POOL_SIZE in packages/core's order-selection.ts,
  // THE_ORDER_TICKER_COUNT in results-schema.ts, ORDER_SLOT_COUNT here) --
  // now all three derive from the same single source of truth
  // (order-selection.ts's ORDER_POOL_SIZE), so this asserts the real
  // import link rather than three literals that just happen to agree.
  it("derives from @hadiknowntrades/core's ORDER_POOL_SIZE, the single source of truth", () => {
    expect(ORDER_SLOT_COUNT).toBe(ORDER_POOL_SIZE);
    expect(THE_ORDER_TICKER_COUNT).toBe(ORDER_POOL_SIZE);
  });
});

describe("bestToWorstTickers", () => {
  it("reverses a worst-to-best array into best-to-worst", () => {
    const worstToBest = [
      { ticker: "TSLA", pctReturn: -3.1 },
      { ticker: "AAPL", pctReturn: -0.42 },
      { ticker: "NVDA", pctReturn: 3.2 },
    ];
    expect(bestToWorstTickers(worstToBest).map((t) => t.ticker)).toEqual(["NVDA", "AAPL", "TSLA"]);
  });

  it("doesn't mutate its input", () => {
    const worstToBest = [{ ticker: "TSLA" }, { ticker: "AAPL" }];
    const copy = [...worstToBest];
    bestToWorstTickers(worstToBest);
    expect(worstToBest).toEqual(copy);
  });
});

describe("scoreOrderMatch", () => {
  it("scores a fully correct guess as every slot correct", () => {
    const feedback = scoreOrderMatch(ANSWER, ANSWER);
    expect(feedback).toEqual(["correct", "correct", "correct", "correct", "correct"]);
    expect(isWinningFeedback(feedback)).toBe(true);
  });

  it("scores a fully reversed guess as incorrect everywhere except the middle slot", () => {
    const reversed = [...ANSWER].reverse();
    const feedback = scoreOrderMatch(reversed, ANSWER);
    expect(feedback).toEqual(["incorrect", "incorrect", "correct", "incorrect", "incorrect"]);
    expect(isWinningFeedback(feedback)).toBe(false);
  });

  it("scores an adjacent swap as incorrect for exactly the two swapped slots", () => {
    const guess = ["AAPL", "TSLA", "MSFT", "META", "NVDA"]; // swap slots 0/1
    const feedback: OrderFeedback[] = scoreOrderMatch(guess, ANSWER);
    expect(feedback).toEqual(["incorrect", "incorrect", "correct", "correct", "correct"]);
  });

  it("realistic mix: some correct, some not", () => {
    const guess = ["NVDA", "AAPL", "META", "MSFT", "TSLA"];
    const feedback = scoreOrderMatch(guess, ANSWER);
    expect(feedback).toEqual(["incorrect", "correct", "incorrect", "incorrect", "incorrect"]);
  });
});

describe("lockedSlots", () => {
  it("is all-false when feedback is null (never yet submitted)", () => {
    expect(lockedSlots(null, 5)).toEqual([false, false, false, false, false]);
  });

  it("locks exactly the slots graded correct", () => {
    const feedback: OrderFeedback[] = ["correct", "incorrect", "correct", "incorrect", "correct"];
    expect(lockedSlots(feedback, 5)).toEqual([true, false, true, false, true]);
  });

  it("a bail-out reveal's 'revealed' grading never locks -- only a real 'correct' does", () => {
    const feedback: OrderFeedback[] = ["correct", "revealed", "revealed", "correct", "revealed"];
    expect(lockedSlots(feedback, 5)).toEqual([true, false, false, true, false]);
  });

  it("is all-true once every slot scores correct (a full win)", () => {
    const feedback: OrderFeedback[] = ["correct", "correct", "correct", "correct", "correct"];
    expect(lockedSlots(feedback, 5)).toEqual([true, true, true, true, true]);
  });
});

describe("nextOpenSlot", () => {
  it("returns the adjacent slot when nothing is locked", () => {
    expect(nextOpenSlot(ALL_OPEN, 1, 1)).toBe(2);
    expect(nextOpenSlot(ALL_OPEN, 1, -1)).toBe(0);
  });

  it("hops over one locked slot", () => {
    const locked = [false, true, false, false, false];
    expect(nextOpenSlot(locked, 0, 1)).toBe(2);
  });

  it("hops over multiple consecutive locked slots", () => {
    const locked = [false, true, true, true, false];
    expect(nextOpenSlot(locked, 0, 1)).toBe(4);
  });

  it("returns -1 at the edge", () => {
    expect(nextOpenSlot(ALL_OPEN, 0, -1)).toBe(-1);
    expect(nextOpenSlot(ALL_OPEN, 4, 1)).toBe(-1);
  });

  it("returns -1 when every remaining slot in that direction is locked", () => {
    const locked = [false, false, true, true, true];
    expect(nextOpenSlot(locked, 1, 1)).toBe(-1);
  });
});

describe("moveOrderGuess", () => {
  it("swaps with the adjacent open slot in the given direction", () => {
    const guess = ["A", "B", "C", "D", "E"];
    expect(moveOrderGuess(guess, ALL_OPEN, 1, 1)).toEqual(["A", "C", "B", "D", "E"]);
    expect(moveOrderGuess(guess, ALL_OPEN, 1, -1)).toEqual(["B", "A", "C", "D", "E"]);
  });

  it("is a no-op (same reference) at either edge", () => {
    const guess = ["A", "B", "C", "D", "E"];
    expect(moveOrderGuess(guess, ALL_OPEN, 0, -1)).toBe(guess);
    expect(moveOrderGuess(guess, ALL_OPEN, 4, 1)).toBe(guess);
  });

  it("a locked slot never moves, even when asked to", () => {
    const guess = ["A", "B", "C", "D", "E"];
    const locked = [false, true, false, false, false];
    expect(moveOrderGuess(guess, locked, 1, 1)).toBe(guess);
    expect(moveOrderGuess(guess, locked, 1, -1)).toBe(guess);
  });

  it("hops the moved ticker over one locked slot in its path", () => {
    const guess = ["A", "B", "C", "D", "E"];
    const locked = [false, true, false, false, false];
    // Moving slot 0 downward must land past the locked slot 1, at slot 2.
    expect(moveOrderGuess(guess, locked, 0, 1)).toEqual(["C", "B", "A", "D", "E"]);
  });

  it("hops over multiple consecutive locked slots", () => {
    const guess = ["A", "B", "C", "D", "E"];
    const locked = [false, true, true, true, false];
    expect(moveOrderGuess(guess, locked, 0, 1)).toEqual(["E", "B", "C", "D", "A"]);
  });

  it("is a no-op when there is no open slot left in that direction", () => {
    const guess = ["A", "B", "C", "D", "E"];
    const locked = [false, false, true, true, true];
    expect(moveOrderGuess(guess, locked, 1, 1)).toBe(guess);
  });
});

describe("shuffleUnlockedGuess", () => {
  it("returns a permutation of the same tickers", () => {
    const guess = ["A", "B", "C", "D", "E"];
    const result = shuffleUnlockedGuess(guess, ALL_OPEN, () => 0.5);
    expect([...result].sort()).toEqual([...guess].sort());
  });

  it("doesn't mutate its input", () => {
    const guess = ["A", "B", "C", "D", "E"];
    const copy = [...guess];
    shuffleUnlockedGuess(guess, ALL_OPEN, () => 0.5);
    expect(guess).toEqual(copy);
  });

  it("leaves every locked slot's ticker and position untouched", () => {
    const guess = ["A", "B", "C", "D", "E"];
    const locked = [true, false, true, false, false];
    const result = shuffleUnlockedGuess(guess, locked, () => 0.99);
    expect(result[0]).toBe("A");
    expect(result[2]).toBe("C");
    // The unlocked slots (1, 3, 4) still hold exactly {B, D, E}, just
    // possibly reordered among themselves.
    expect([result[1], result[3], result[4]].sort()).toEqual(["B", "D", "E"]);
  });

  it("is a no-op when every slot is locked", () => {
    const guess = ["A", "B", "C", "D", "E"];
    const locked = [true, true, true, true, true];
    const result = shuffleUnlockedGuess(guess, locked, () => 0.5);
    expect(result).toEqual(guess);
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

describe("isValidOrderPuzzle", () => {
  it("accepts a real, correctly-shaped, ascending puzzle", () => {
    expect(isValidOrderPuzzle(validPuzzlePayload())).toBe(true);
  });

  it("rejects a malformed shape (missing/wrong-typed fields)", () => {
    expect(isValidOrderPuzzle(null)).toBe(false);
    expect(isValidOrderPuzzle({})).toBe(false);
    expect(isValidOrderPuzzle({ date: "2026-08-26", tickers: "not an array" })).toBe(false);
  });

  it("rejects a puzzle with the wrong number of tickers", () => {
    const payload = validPuzzlePayload() as { tickers: unknown[] };
    payload.tickers = payload.tickers.slice(0, 4);
    expect(isValidOrderPuzzle(payload)).toBe(false);
  });

  // The same strict-ascending-by-pctReturn check the server-side
  // validateTheOrderPuzzle (packages/core's results-schema.ts) already
  // enforces at write time -- a right-shaped-but-out-of-order puzzle
  // would otherwise silently grade every guess against the wrong slot.
  it("rejects a right-shaped puzzle whose tickers are not strictly ascending by pctReturn", () => {
    const payload = validPuzzlePayload() as {
      tickers: { ticker: string; companyName: string; pctReturn: number }[];
    };
    // Swap two entries so pctReturn is no longer ascending.
    [payload.tickers[0], payload.tickers[1]] = [payload.tickers[1]!, payload.tickers[0]!];
    expect(isValidOrderPuzzle(payload)).toBe(false);
  });

  it("rejects a puzzle with a real tie (not strictly ascending)", () => {
    const payload = validPuzzlePayload() as {
      tickers: { ticker: string; companyName: string; pctReturn: number }[];
    };
    payload.tickers[1]!.pctReturn = payload.tickers[0]!.pctReturn;
    expect(isValidOrderPuzzle(payload)).toBe(false);
  });
});
