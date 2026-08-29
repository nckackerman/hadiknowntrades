// Covers validateTheOrderPuzzle (issue #207). Kept in its own file rather
// than appended to results-schema.test.ts or results-schema.sessions.test.ts
// -- this validates yet another separate family of stored object, with its
// own invariant (a strictly-ascending-by-pctReturn `tickers` array) that
// shares no fixtures with either existing suite.

import { describe, expect, it } from "vitest";

import {
  RESULTS_SCHEMA_VERSION,
  ResultValidationError,
  THE_ORDER_KEY,
  THE_ORDER_TICKER_COUNT,
  validateTheOrderPuzzle,
  type TheOrderPuzzle,
} from "./results-schema";

const TICKERS: TheOrderPuzzle["tickers"] = [
  { ticker: "TSLA", companyName: "Tesla, Inc.", pctReturn: -3.1 },
  { ticker: "AAPL", companyName: "Apple Inc.", pctReturn: -0.42 },
  { ticker: "MSFT", companyName: "Microsoft", pctReturn: 0.55 },
  { ticker: "META", companyName: "Meta Platforms", pctReturn: 1.85 },
  { ticker: "NVDA", companyName: "Nvidia", pctReturn: 3.2 },
];

function puzzle(overrides: Partial<TheOrderPuzzle> = {}): TheOrderPuzzle {
  return {
    schemaVersion: RESULTS_SCHEMA_VERSION,
    generatedAt: "2026-08-27T06:00:00.000Z",
    date: "2026-08-26",
    tickers: TICKERS.map((t) => ({ ...t })),
    ...overrides,
  };
}

describe("The Order S3 key", () => {
  it("is a fixed, top-level key overwritten each run", () => {
    expect(THE_ORDER_KEY).toBe("results/the-order.json");
  });

  it("THE_ORDER_TICKER_COUNT matches the puzzle's own real shape", () => {
    expect(THE_ORDER_TICKER_COUNT).toBe(5);
  });
});

describe("validateTheOrderPuzzle", () => {
  it("accepts a real, well-formed puzzle", () => {
    expect(() => validateTheOrderPuzzle(puzzle())).not.toThrow();
  });

  it("rejects a stale schemaVersion", () => {
    expect(() =>
      validateTheOrderPuzzle(puzzle({ schemaVersion: RESULTS_SCHEMA_VERSION - 1 })),
    ).toThrow(/schemaVersion must be exactly/);
  });

  it("requires a well-formed date", () => {
    expect(() => validateTheOrderPuzzle(puzzle({ date: "2026-08" }))).toThrow(
      /date must be a "YYYY-MM-DD" string/,
    );
  });

  it("requires exactly THE_ORDER_TICKER_COUNT tickers", () => {
    expect(() => validateTheOrderPuzzle(puzzle({ tickers: TICKERS.slice(0, 4) }))).toThrow(
      /exactly 5 entries/,
    );
    expect(() =>
      validateTheOrderPuzzle(puzzle({ tickers: [...TICKERS, { ...TICKERS[0]! }] })),
    ).toThrow(/exactly 5 entries/);
  });

  it("rejects a ticker/companyName that isn't a non-empty string", () => {
    const tickers = TICKERS.map((t, i) => (i === 2 ? { ...t, ticker: "" } : t));
    expect(() => validateTheOrderPuzzle(puzzle({ tickers }))).toThrow(/tickers\[2\]\.ticker/);
  });

  it("rejects a non-finite pctReturn", () => {
    const tickers = TICKERS.map((t, i) => (i === 1 ? { ...t, pctReturn: NaN } : t));
    expect(() => validateTheOrderPuzzle(puzzle({ tickers }))).toThrow(
      /tickers\[1\]\.pctReturn must be a finite number/,
    );
  });

  it("rejects a tickers array that isn't strictly ascending by pctReturn", () => {
    const tickers = [...TICKERS];
    // Swap two entries so the array is no longer worst-to-best.
    [tickers[0], tickers[1]] = [tickers[1]!, tickers[0]!];
    expect(() => validateTheOrderPuzzle(puzzle({ tickers }))).toThrow(
      /strictly ascending by pctReturn/,
    );
  });

  it("rejects a tie (two adjacent tickers with the identical pctReturn)", () => {
    const tickers = TICKERS.map((t, i) =>
      i === 3 ? { ...t, pctReturn: TICKERS[2]!.pctReturn } : t,
    );
    expect(() => validateTheOrderPuzzle(puzzle({ tickers }))).toThrow(
      /strictly ascending by pctReturn/,
    );
  });

  it("reports every problem at once, not just the first", () => {
    let message = "";
    try {
      validateTheOrderPuzzle(
        puzzle({
          date: "nope",
          tickers: TICKERS.slice(0, 4),
        }),
      );
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("date");
    expect(message).toContain("tickers");
  });

  it("throws a ResultValidationError, not a generic Error", () => {
    expect(() => validateTheOrderPuzzle(puzzle({ date: "bad" }))).toThrow(ResultValidationError);
  });
});
