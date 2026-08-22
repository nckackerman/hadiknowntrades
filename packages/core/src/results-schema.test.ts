import { describe, expect, it } from "vitest";

import {
  RESULTS_SCHEMA_VERSION,
  resultKey,
  ResultValidationError,
  validatePrecomputedResult,
  type BenchmarkResult,
  type IntradayResult,
  type WindowResult,
} from "./results-schema";

/** A well-formed BenchmarkResult (issue #12), cloned and mutated by individual tests below rather than shared by reference. */
function validBenchmark(): BenchmarkResult {
  return {
    ticker: "SPY",
    startDate: "2019-06-17",
    startPrice: 280,
    endDate: "2024-06-14",
    endPrice: 540,
    endingBalance: 38.57,
    truncated: false,
  };
}

describe("resultKey", () => {
  it("builds the results/{RANGE}.json key for a preset range", () => {
    expect(resultKey("1M")).toBe("results/1M.json");
    expect(resultKey("MAX")).toBe("results/MAX.json");
  });
});

/** A well-formed WindowResult, cloned and mutated by individual tests below rather than shared by reference. */
function validWindowResult(): WindowResult {
  return {
    schemaVersion: 4,
    range: "5Y",
    generatedAt: "2024-06-15T00:00:00.000Z",
    dataAsOf: "2024-06-14",
    startingCapital: 20,
    universeSize: 1,
    skippedTickers: [],
    benchmark: null,
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
    worstCase: {
      endingBalance: 10,
      trades: [
        {
          ticker: "MSFT",
          buyDate: "2019-06-15",
          buyPrice: 30,
          sellDate: "2024-06-14",
          sellPrice: 15,
        },
      ],
    },
  };
}

/** A well-formed IntradayResult, cloned and mutated by individual tests below rather than shared by reference. */
function validIntradayResult(): IntradayResult {
  return {
    schemaVersion: 4,
    range: "1M",
    generatedAt: "2024-06-15T00:00:00.000Z",
    dataAsOf: "2024-06-14",
    startingCapital: 20,
    universeSize: 1,
    skippedTickers: ["MSFT"],
    benchmark: null,
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
        worstCase: {
          endingBalance: 15,
          trades: [
            {
              ticker: "AAPL",
              date: "2024-06-14",
              buyTime: "09:30:00",
              buyPrice: 20,
              sellTime: "10:30:00",
              sellPrice: 15,
            },
          ],
        },
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

  it("rejects a result whose schemaVersion doesn't exactly match RESULTS_SCHEMA_VERSION (stale or reverted, not just non-negative)", () => {
    const stale = validWindowResult();
    stale.schemaVersion = RESULTS_SCHEMA_VERSION - 1;
    expect(() => validatePrecomputedResult(stale)).toThrow(ResultValidationError);
    expect(() => validatePrecomputedResult(stale)).toThrow(/schemaVersion/);

    const future = validWindowResult();
    future.schemaVersion = RESULTS_SCHEMA_VERSION + 1;
    expect(() => validatePrecomputedResult(future)).toThrow(/schemaVersion/);
  });

  it("rejects a result whose range isn't one of the preset ranges", () => {
    const result = validWindowResult() as unknown as Record<string, unknown>;
    result.range = "2Y";
    expect(() => validatePrecomputedResult(result as unknown as WindowResult)).toThrow(/range/);
  });

  it("rejects a WindowResult missing worstCase entirely (issue #31)", () => {
    const result = validWindowResult() as unknown as Record<string, unknown>;
    delete result.worstCase;
    expect(() => validatePrecomputedResult(result as unknown as WindowResult)).toThrow(
      /worstCase must be an object/,
    );
  });

  it("rejects a WindowResult with a malformed worstCase trade (non-finite sellPrice)", () => {
    const result = validWindowResult();
    result.worstCase.trades = [{ ...result.worstCase.trades[0]!, sellPrice: NaN }];
    expect(() => validatePrecomputedResult(result)).toThrow(/worstCase\.trades\[0\]\.sellPrice/);
  });

  it("rejects a WindowResult whose worstCase.endingBalance exceeds the optimal-case endingBalance (issue #31 -- catches a max/min inversion bug)", () => {
    const result = validWindowResult();
    result.endingBalance = 60;
    result.worstCase.endingBalance = 61;
    expect(() => validatePrecomputedResult(result)).toThrow(
      /worstCase\.endingBalance \(61\) must not exceed its optimal-case counterpart \(60\)/,
    );
  });

  it("passes a WindowResult whose worstCase.endingBalance exactly equals the optimal-case endingBalance (the rare 'no losing trade available' edge case)", () => {
    const result = validWindowResult();
    result.endingBalance = 60;
    result.worstCase.endingBalance = 60;
    expect(() => validatePrecomputedResult(result)).not.toThrow();
  });

  it("rejects an IntradayResult missing a day's worstCase entirely (issue #31)", () => {
    const result = validIntradayResult() as unknown as Record<string, unknown>;
    const day = (result.days as unknown[])[0] as Record<string, unknown>;
    delete day.worstCase;
    expect(() => validatePrecomputedResult(result as unknown as IntradayResult)).toThrow(
      /days\[0\]\.worstCase must be an object/,
    );
  });

  it("rejects an IntradayResult with a malformed day worstCase trade (missing buyTime)", () => {
    const result = validIntradayResult();
    result.days[0]!.worstCase.trades = [{ ...result.days[0]!.worstCase.trades[0]!, buyTime: "" }];
    expect(() => validatePrecomputedResult(result)).toThrow(
      /days\[0\]\.worstCase\.trades\[0\]\.buyTime/,
    );
  });

  it("rejects an IntradayResult whose day worstCase.endingBalance exceeds that day's optimal-case endingBalance", () => {
    const result = validIntradayResult();
    result.days[0]!.endingBalance = 40;
    result.days[0]!.worstCase.endingBalance = 41;
    expect(() => validatePrecomputedResult(result)).toThrow(
      /days\[0\]\.worstCase\.endingBalance \(41\) must not exceed its optimal-case counterpart \(40\)/,
    );
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

  describe("benchmark (issue #12)", () => {
    it("passes a null benchmark (no benchmark data was available this run)", () => {
      const result = validWindowResult();
      result.benchmark = null;
      expect(() => validatePrecomputedResult(result)).not.toThrow();
    });

    it("passes a well-formed benchmark object", () => {
      const result = validWindowResult();
      result.benchmark = validBenchmark();
      expect(() => validatePrecomputedResult(result)).not.toThrow();
    });

    it("passes a well-formed truncated benchmark (the MAX/SPY-inception case)", () => {
      const result = validWindowResult();
      result.range = "MAX";
      result.startDate = null;
      result.benchmark = { ...validBenchmark(), truncated: true };
      expect(() => validatePrecomputedResult(result)).not.toThrow();
    });

    it("rejects an entirely-missing benchmark field (undefined), distinct from a valid null", () => {
      const result = validWindowResult() as unknown as Record<string, unknown>;
      delete result.benchmark;
      expect(() => validatePrecomputedResult(result as unknown as WindowResult)).toThrow(
        /benchmark must be null or an object, got undefined/,
      );
    });

    it("rejects a benchmark that isn't null or an object", () => {
      const result = validWindowResult() as unknown as Record<string, unknown>;
      result.benchmark = "SPY";
      expect(() => validatePrecomputedResult(result as unknown as WindowResult)).toThrow(
        /benchmark must be null or an object/,
      );
    });

    it("rejects a benchmark with a non-string ticker", () => {
      const result = validWindowResult();
      result.benchmark = { ...validBenchmark(), ticker: "" };
      expect(() => validatePrecomputedResult(result)).toThrow(/benchmark\.ticker/);
    });

    it("rejects a benchmark with a non-string startDate", () => {
      const result = validWindowResult();
      result.benchmark = { ...validBenchmark(), startDate: "" };
      expect(() => validatePrecomputedResult(result)).toThrow(/benchmark\.startDate/);
    });

    it("rejects a benchmark with a non-finite startPrice", () => {
      const result = validWindowResult();
      result.benchmark = { ...validBenchmark(), startPrice: NaN };
      expect(() => validatePrecomputedResult(result)).toThrow(/benchmark\.startPrice/);
    });

    it("rejects a benchmark with a non-string endDate", () => {
      const result = validWindowResult();
      result.benchmark = { ...validBenchmark(), endDate: "" };
      expect(() => validatePrecomputedResult(result)).toThrow(/benchmark\.endDate/);
    });

    it("rejects a benchmark with a non-positive endPrice", () => {
      const result = validWindowResult();
      result.benchmark = { ...validBenchmark(), endPrice: -1 };
      expect(() => validatePrecomputedResult(result)).toThrow(/benchmark\.endPrice/);
    });

    it("rejects a benchmark with a non-finite endingBalance", () => {
      const result = validWindowResult();
      result.benchmark = { ...validBenchmark(), endingBalance: Infinity };
      expect(() => validatePrecomputedResult(result)).toThrow(/benchmark\.endingBalance/);
    });

    it("rejects a benchmark whose truncated field isn't a boolean", () => {
      const result = validWindowResult();
      result.benchmark = { ...validBenchmark(), truncated: "yes" as unknown as boolean };
      expect(() => validatePrecomputedResult(result)).toThrow(/benchmark\.truncated/);
    });
  });
});
