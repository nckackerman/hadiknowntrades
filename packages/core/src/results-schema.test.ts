import { describe, expect, it } from "vitest";

import {
  resultKey,
  ResultValidationError,
  validatePrecomputedResult,
  type IntradayResult,
  type WindowResult,
} from "./results-schema";

describe("resultKey", () => {
  it("builds the results/{RANGE}.json key for a preset range", () => {
    expect(resultKey("1M")).toBe("results/1M.json");
    expect(resultKey("MAX")).toBe("results/MAX.json");
  });
});

/** A well-formed WindowResult, cloned and mutated by individual tests below rather than shared by reference. */
function validWindowResult(): WindowResult {
  return {
    schemaVersion: 2,
    range: "5Y",
    generatedAt: "2024-06-15T00:00:00.000Z",
    dataAsOf: "2024-06-14",
    startingCapital: 20,
    universeSize: 1,
    skippedTickers: [],
    model: "window",
    startDate: "2019-06-15",
    endDate: "2024-06-15",
    maxTrades: 3,
    endingBalance: 60,
    trades: [
      {
        ticker: "AAPL",
        buyDate: "2019-06-15",
        buyPrice: 10,
        sellDate: "2024-06-14",
        sellPrice: 30,
      },
    ],
  };
}

/** A well-formed IntradayResult, cloned and mutated by individual tests below rather than shared by reference. */
function validIntradayResult(): IntradayResult {
  return {
    schemaVersion: 2,
    range: "1M",
    generatedAt: "2024-06-15T00:00:00.000Z",
    dataAsOf: "2024-06-14",
    startingCapital: 20,
    universeSize: 1,
    skippedTickers: ["MSFT"],
    model: "intraday-daily",
    endDate: "2024-06-15",
    maxTradesPerDay: 3,
    days: [
      {
        date: "2024-06-14",
        startingCapital: 20,
        endingBalance: 40,
        barIntervalMinutes: 60,
        trades: [
          {
            ticker: "AAPL",
            date: "2024-06-14",
            buyTime: "09:30:00",
            buyPrice: 10,
            sellTime: "10:30:00",
            sellPrice: 20,
          },
        ],
      },
    ],
  };
}

describe("validatePrecomputedResult", () => {
  it("passes a well-formed WindowResult", () => {
    expect(() => validatePrecomputedResult(validWindowResult())).not.toThrow();
  });

  it("passes a well-formed WindowResult with a null startDate and no trades (MAX / zero-trade edge cases)", () => {
    const result = validWindowResult();
    result.startDate = null;
    result.maxTrades = 0;
    result.trades = [];
    expect(() => validatePrecomputedResult(result)).not.toThrow();
  });

  it("passes a well-formed IntradayResult", () => {
    expect(() => validatePrecomputedResult(validIntradayResult())).not.toThrow();
  });

  it("passes a well-formed IntradayResult with no trading days found", () => {
    const result = validIntradayResult();
    result.days = [];
    expect(() => validatePrecomputedResult(result)).not.toThrow();
  });

  it("rejects a result missing a required base field", () => {
    const result = validWindowResult() as unknown as Record<string, unknown>;
    delete result.dataAsOf;
    expect(() => validatePrecomputedResult(result as unknown as WindowResult)).toThrow(
      ResultValidationError,
    );
    expect(() => validatePrecomputedResult(result as unknown as WindowResult)).toThrow(/dataAsOf/);
  });

  it("rejects a result missing a model-specific required field", () => {
    const result = validIntradayResult() as unknown as Record<string, unknown>;
    delete result.maxTradesPerDay;
    expect(() => validatePrecomputedResult(result as unknown as IntradayResult)).toThrow(
      /maxTradesPerDay/,
    );
  });

  it("rejects a WindowResult with a non-finite endingBalance", () => {
    const result = validWindowResult();
    result.endingBalance = NaN;
    expect(() => validatePrecomputedResult(result)).toThrow(/endingBalance/);
  });

  it("rejects a WindowResult with an Infinity endingBalance", () => {
    const result = validWindowResult();
    result.endingBalance = Infinity;
    expect(() => validatePrecomputedResult(result)).toThrow(/endingBalance/);
  });

  it("rejects an IntradayResult with a non-finite day endingBalance", () => {
    const result = validIntradayResult();
    result.days[0]!.endingBalance = NaN;
    expect(() => validatePrecomputedResult(result)).toThrow(/days\[0\]\.endingBalance/);
  });

  it("rejects a WindowResult with a malformed trade (missing ticker)", () => {
    const result = validWindowResult();
    result.trades = [{ ...result.trades[0]!, ticker: "" }];
    expect(() => validatePrecomputedResult(result)).toThrow(/trades\[0\]\.ticker/);
  });

  it("rejects a WindowResult with a malformed trade (non-finite buyPrice)", () => {
    const result = validWindowResult();
    result.trades = [{ ...result.trades[0]!, buyPrice: NaN }];
    expect(() => validatePrecomputedResult(result)).toThrow(/trades\[0\]\.buyPrice/);
  });

  it("rejects a WindowResult whose trades field isn't an array", () => {
    const result = validWindowResult() as unknown as Record<string, unknown>;
    result.trades = "not an array";
    expect(() => validatePrecomputedResult(result as unknown as WindowResult)).toThrow(
      /trades must be an array/,
    );
  });

  it("rejects an IntradayResult with a malformed day (non-object entry)", () => {
    const result = validIntradayResult() as unknown as Record<string, unknown>;
    (result.days as unknown[])[0] = null;
    expect(() => validatePrecomputedResult(result as unknown as IntradayResult)).toThrow(
      /days\[0\]/,
    );
  });

  it("rejects an IntradayResult with a malformed intraday trade (missing buyTime)", () => {
    const result = validIntradayResult();
    result.days[0]!.trades = [{ ...result.days[0]!.trades[0]!, buyTime: "" }];
    expect(() => validatePrecomputedResult(result)).toThrow(/days\[0\]\.trades\[0\]\.buyTime/);
  });

  it("rejects a result with an unrecognized model discriminant", () => {
    const result = validWindowResult() as unknown as Record<string, unknown>;
    result.model = "something-else";
    expect(() => validatePrecomputedResult(result as unknown as WindowResult)).toThrow(/model/);
  });

  it("rejects a result whose range isn't one of the preset ranges", () => {
    const result = validWindowResult() as unknown as Record<string, unknown>;
    result.range = "2Y";
    expect(() => validatePrecomputedResult(result as unknown as WindowResult)).toThrow(/range/);
  });

  it("reports every problem found, not just the first", () => {
    const result = validWindowResult();
    result.endingBalance = NaN;
    result.trades = [{ ...result.trades[0]!, sellPrice: -5 }];
    try {
      validatePrecomputedResult(result);
      throw new Error("expected validatePrecomputedResult to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ResultValidationError);
      const message = (error as Error).message;
      expect(message).toMatch(/endingBalance/);
      expect(message).toMatch(/trades\[0\]\.sellPrice/);
    }
  });
});
