import { describe, expect, it } from "vitest";

import { computeSp500PrefixSelection, type Sp500PrefixTicker } from "./sp500-prefix-selection";
import type { DailyClose } from "./yahoo-client";

const START = "2024-01-01";
const END = "2024-01-31";
const STARTING_CAPITAL = 20;

/** One ticker's window close pair -- a real close on both boundary dates, giving `close[END] / close[START] === ratio`. */
function closesFor(ratio: number, startClose = 100): DailyClose[] {
  return [
    { date: START, close: startClose },
    { date: END, close: startClose * ratio },
  ];
}

describe("computeSp500PrefixSelection", () => {
  it("hand-computed: finds the best N on a small synthetic universe", () => {
    // A(weight 40, ratio 1.10), B(weight 30, ratio 1.50), C(weight 20, ratio 1.05), D(weight 10, ratio 0.90)
    // N=1: cumWeight=40, sum=44           -> pr=1.10
    // N=2: cumWeight=70, sum=44+45=89     -> pr=89/70=1.271428571...  <- best
    // N=3: cumWeight=90, sum=89+21=110    -> pr=110/90=1.222222...
    // N=4: cumWeight=100, sum=110+9=119   -> pr=119/100=1.19
    const orderedTickers: Sp500PrefixTicker[] = [
      { symbol: "A", weight: 40 },
      { symbol: "B", weight: 30 },
      { symbol: "C", weight: 20 },
      { symbol: "D", weight: 10 },
    ];
    const closesByTicker = new Map<string, DailyClose[]>([
      ["A", closesFor(1.1)],
      ["B", closesFor(1.5)],
      ["C", closesFor(1.05)],
      ["D", closesFor(0.9)],
    ]);
    const result = computeSp500PrefixSelection({
      orderedTickers,
      closesByTicker,
      rangeStartString: START,
      endDateString: END,
      startingCapital: STARTING_CAPITAL,
    });

    expect(result.bestN).toBe(2);
    expect(result.bestPortfolioReturn).toBeCloseTo(89 / 70, 10);
    expect(result.bestEndingBalance).toBeCloseTo(STARTING_CAPITAL * (89 / 70), 10);
    expect(result.curve).toHaveLength(4);
    expect(result.curve.map((p) => p.n)).toEqual([1, 2, 3, 4]);
    expect(result.curve[0]!.portfolioReturn).toBeCloseTo(1.1, 10);
    expect(result.curve[1]!.portfolioReturn).toBeCloseTo(89 / 70, 10);
    expect(result.curve[2]!.portfolioReturn).toBeCloseTo(110 / 90, 10);
    expect(result.curve[3]!.portfolioReturn).toBeCloseTo(1.19, 10);
  });

  it("breaks a tie between N=1 and N=3 deterministically toward the smaller N", () => {
    // A(weight 60, ratio 1.30) -> N=1 pr=1.30
    // B(weight 20, ratio 1.10) -> N=2 cumWeight=80, sum=78+22=100 -> pr=1.25 (not part of the tie)
    // C(weight 20, ratio 1.50) -> N=3 cumWeight=100, sum=100+30=130 -> pr=1.30 (ties N=1's max)
    const orderedTickers: Sp500PrefixTicker[] = [
      { symbol: "A", weight: 60 },
      { symbol: "B", weight: 20 },
      { symbol: "C", weight: 20 },
    ];
    const closesByTicker = new Map<string, DailyClose[]>([
      ["A", closesFor(1.3)],
      ["B", closesFor(1.1)],
      ["C", closesFor(1.5)],
    ]);
    const result = computeSp500PrefixSelection({
      orderedTickers,
      closesByTicker,
      rangeStartString: START,
      endDateString: END,
      startingCapital: STARTING_CAPITAL,
    });

    expect(result.curve[0]!.portfolioReturn).toBeCloseTo(1.3, 10);
    expect(result.curve[1]!.portfolioReturn).toBeCloseTo(1.25, 10);
    expect(result.curve[2]!.portfolioReturn).toBeCloseTo(1.3, 10);
    // N=1 and N=3 are an exact tie for the maximum -- smallest N must win.
    expect(result.bestN).toBe(1);
    expect(result.bestPortfolioReturn).toBeCloseTo(1.3, 10);
  });

  it("excludes a missing/delisted-mid-window ticker (effectiveWeight 0), not a NaN or a crash", () => {
    // A(weight 50, ratio 1.20) is rank 1.
    // B(weight 30) is rank 2 but has NO close on END (delisted mid-window) -- excluded.
    // C(weight 20, ratio 2.00) is rank 3.
    // N=2 must be numerically identical to N=1 (B contributes nothing), and
    // N=3 must be the best (C's big ratio, once included, dominates).
    const orderedTickers: Sp500PrefixTicker[] = [
      { symbol: "A", weight: 50 },
      { symbol: "B", weight: 30 },
      { symbol: "C", weight: 20 },
    ];
    const closesByTicker = new Map<string, DailyClose[]>([
      ["A", closesFor(1.2)],
      ["B", [{ date: START, close: 100 }]], // no close on END at all -- delisted mid-window
      ["C", closesFor(2.0)],
    ]);
    const result = computeSp500PrefixSelection({
      orderedTickers,
      closesByTicker,
      rangeStartString: START,
      endDateString: END,
      startingCapital: STARTING_CAPITAL,
    });

    expect(result.curve).toHaveLength(3); // B still gets a curve point -- cumWeight stays > 0 via A
    expect(result.curve[0]!.cumWeight).toBe(50);
    expect(result.curve[1]!.cumWeight).toBe(50); // unchanged by B -- effectiveWeight_B === 0
    expect(result.curve[1]!.portfolioReturn).toBeCloseTo(result.curve[0]!.portfolioReturn, 10);
    expect(result.curve[2]!.cumWeight).toBe(70); // 50 (A) + 20 (C), never 100
    expect(result.bestN).toBe(3);
  });

  it("also excludes a ticker entirely absent from closesByTicker, same as one present but missing a boundary close", () => {
    const orderedTickers: Sp500PrefixTicker[] = [
      { symbol: "A", weight: 50 },
      { symbol: "MISSING", weight: 50 },
    ];
    const closesByTicker = new Map<string, DailyClose[]>([["A", closesFor(1.5)]]);
    const result = computeSp500PrefixSelection({
      orderedTickers,
      closesByTicker,
      rangeStartString: START,
      endDateString: END,
      startingCapital: STARTING_CAPITAL,
    });

    expect(result.curve).toHaveLength(2);
    expect(result.curve[1]!.cumWeight).toBe(50);
    expect(result.curve[1]!.portfolioReturn).toBeCloseTo(1.5, 10);
    expect(result.bestN).toBe(1); // both N tie at pr=1.5 -- smallest wins
  });

  it("excludes a whole leading prefix from the argmax and curve when every company in it lacks window data", () => {
    // A(rank 1) has no data at all. B(rank 2)/C(rank 3) do.
    // N=1 (A only) must be excluded entirely -- cumWeight[1]=0 -- not
    // scored as a 0/NaN point in the curve, and never eligible for bestN.
    const orderedTickers: Sp500PrefixTicker[] = [
      { symbol: "A", weight: 50 },
      { symbol: "B", weight: 50 },
      { symbol: "C", weight: 50 },
    ];
    const closesByTicker = new Map<string, DailyClose[]>([
      // A: not in the map at all -- e.g. a fetch failure for this ticker's window.
      ["B", closesFor(1.2)],
      ["C", closesFor(1.1)],
    ]);
    const result = computeSp500PrefixSelection({
      orderedTickers,
      closesByTicker,
      rangeStartString: START,
      endDateString: END,
      startingCapital: STARTING_CAPITAL,
    });

    expect(result.curve.map((p) => p.n)).toEqual([2, 3]); // no n=1 entry at all
    expect(result.bestN).toBe(2); // B alone (pr=1.2) beats B+C averaged (pr=1.15)
    expect(result.bestPortfolioReturn).toBeCloseTo(1.2, 10);
  });

  it("returns bestN: null when every company in the whole universe lacks window data", () => {
    const orderedTickers: Sp500PrefixTicker[] = [
      { symbol: "A", weight: 50 },
      { symbol: "B", weight: 50 },
    ];
    const closesByTicker = new Map<string, DailyClose[]>(); // nothing has any data at all
    const result = computeSp500PrefixSelection({
      orderedTickers,
      closesByTicker,
      rangeStartString: START,
      endDateString: END,
      startingCapital: STARTING_CAPITAL,
    });

    expect(result.bestN).toBeNull();
    expect(result.bestPortfolioReturn).toBeNull();
    expect(result.bestEndingBalance).toBeNull();
    expect(result.curve).toEqual([]);
  });

  it("N=full-length self-consistency invariant: with no exclusions, the last curve point equals the plain full-universe weighted average", () => {
    const orderedTickers: Sp500PrefixTicker[] = [
      { symbol: "T01", weight: 12.3 },
      { symbol: "T02", weight: 9.8 },
      { symbol: "T03", weight: 8.1 },
      { symbol: "T04", weight: 7.4 },
      { symbol: "T05", weight: 6.6 },
      { symbol: "T06", weight: 5.9 },
      { symbol: "T07", weight: 5.2 },
      { symbol: "T08", weight: 4.7 },
      { symbol: "T09", weight: 4.1 },
      { symbol: "T10", weight: 3.3 },
    ];
    const ratios = [1.42, 0.88, 1.05, 1.31, 0.97, 1.19, 1.02, 0.76, 1.24, 1.09];
    const closesByTicker = new Map<string, DailyClose[]>(
      orderedTickers.map((t, i) => [t.symbol, closesFor(ratios[i]!)]),
    );

    const result = computeSp500PrefixSelection({
      orderedTickers,
      closesByTicker,
      rangeStartString: START,
      endDateString: END,
      startingCapital: STARTING_CAPITAL,
    });

    // Plain full-universe weighted average, computed independently of
    // computeSp500PrefixSelection's own prefix-sum machinery.
    let weightSum = 0;
    let weightedReturnSum = 0;
    for (let i = 0; i < orderedTickers.length; i++) {
      weightSum += orderedTickers[i]!.weight;
      weightedReturnSum += orderedTickers[i]!.weight * ratios[i]!;
    }
    const expectedFullReturn = weightedReturnSum / weightSum;

    expect(result.curve).toHaveLength(orderedTickers.length);
    const lastPoint = result.curve[result.curve.length - 1]!;
    expect(lastPoint.n).toBe(orderedTickers.length);
    expect(lastPoint.portfolioReturn).toBeCloseTo(expectedFullReturn, 12);
    expect(lastPoint.cumWeight).toBeCloseTo(weightSum, 12);
    expect(lastPoint.endingBalance).toBeCloseTo(STARTING_CAPITAL * expectedFullReturn, 10);
  });

  it("treats a non-positive or non-finite close on a boundary date as invalid, same as a missing one", () => {
    const orderedTickers: Sp500PrefixTicker[] = [
      { symbol: "A", weight: 50 },
      { symbol: "ZERO", weight: 50 },
    ];
    const closesByTicker = new Map<string, DailyClose[]>([
      ["A", closesFor(1.4)],
      [
        "ZERO",
        [
          { date: START, close: 0 },
          { date: END, close: 10 },
        ],
      ],
    ]);
    const result = computeSp500PrefixSelection({
      orderedTickers,
      closesByTicker,
      rangeStartString: START,
      endDateString: END,
      startingCapital: STARTING_CAPITAL,
    });

    expect(result.curve[1]!.cumWeight).toBe(50); // ZERO excluded -- its startClose (0) isn't a valid price
    expect(result.bestN).toBe(1);
  });

  it("uses the first close matching each boundary date when a ticker's history has a duplicate-dated entry, not the last", () => {
    // DUPE's own close array (order/uniqueness isn't a guaranteed
    // contract -- see packages/core/CLAUDE.md's fetchDailyCloses note)
    // has two entries dated START (100, then a bogus later 999) and two
    // dated END (200, then a bogus later 111). First match must win for
    // both boundaries -- ratio 200/100 = 2, never 111/999.
    const orderedTickers: Sp500PrefixTicker[] = [{ symbol: "DUPE", weight: 100 }];
    const closesByTicker = new Map<string, DailyClose[]>([
      [
        "DUPE",
        [
          { date: START, close: 100 },
          { date: END, close: 200 },
          { date: START, close: 999 }, // duplicate START -- must be ignored
          { date: END, close: 111 }, // duplicate END -- must be ignored
        ],
      ],
    ]);
    const result = computeSp500PrefixSelection({
      orderedTickers,
      closesByTicker,
      rangeStartString: START,
      endDateString: END,
      startingCapital: STARTING_CAPITAL,
    });

    expect(result.bestN).toBe(1);
    expect(result.bestPortfolioReturn).toBeCloseTo(2, 10); // 200/100, not 111/999 or any other combination
    expect(result.bestEndingBalance).toBeCloseTo(STARTING_CAPITAL * 2, 10);
  });

  it("is deterministic: identical input always produces identical output", () => {
    const orderedTickers: Sp500PrefixTicker[] = [
      { symbol: "A", weight: 40 },
      { symbol: "B", weight: 30 },
      { symbol: "C", weight: 20 },
      { symbol: "D", weight: 10 },
    ];
    const closesByTicker = new Map<string, DailyClose[]>([
      ["A", closesFor(1.1)],
      ["B", closesFor(1.5)],
      ["C", closesFor(1.05)],
      ["D", closesFor(0.9)],
    ]);
    const input = {
      orderedTickers,
      closesByTicker,
      rangeStartString: START,
      endDateString: END,
      startingCapital: STARTING_CAPITAL,
    };
    const a = computeSp500PrefixSelection(input);
    const b = computeSp500PrefixSelection(input);
    expect(a).toEqual(b);
  });
});
