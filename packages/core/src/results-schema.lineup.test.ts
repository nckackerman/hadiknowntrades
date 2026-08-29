// Covers the two Lineup validators issue #208 added to results-schema.ts.
// Kept in its own file, matching results-schema.sessions.test.ts's own
// precedent for a self-contained stored-object family with its own
// invariants and no shared fixtures with the PrecomputedResult/
// CustomWindowResult/session-family suites.

import { describe, expect, it } from "vitest";

import {
  LINEUP_HISTORY_KEY,
  LINEUP_LATEST_KEY,
  RESULTS_SCHEMA_VERSION,
  ResultValidationError,
  lineupResultKey,
  validateLineupHistory,
  validateLineupResult,
  type LineupHistory,
  type LineupResult,
} from "./results-schema";

function lineupResult(overrides: Partial<LineupResult> = {}): LineupResult {
  return {
    schemaVersion: RESULTS_SCHEMA_VERSION,
    generatedAt: "2026-08-27T06:00:00.000Z",
    date: "2026-08-26",
    tickers: ["IBM", "TSLA", "DIS", "MSFT", "CAT"],
    ...overrides,
  };
}

function lineupHistory(overrides: Partial<LineupHistory> = {}): LineupHistory {
  return {
    schemaVersion: RESULTS_SCHEMA_VERSION,
    generatedAt: "2026-08-27T06:00:00.000Z",
    entries: [
      { date: "2026-08-25", tickers: ["ACN", "AEE", "AES", "AFL", "ALL"] },
      { date: "2026-08-26", tickers: ["IBM", "TSLA", "DIS", "MSFT", "CAT"] },
    ],
    ...overrides,
  };
}

describe("lineupResultKey / LINEUP_HISTORY_KEY / LINEUP_LATEST_KEY", () => {
  it("namespaces under results/lineup/, distinguishable by key shape alone", () => {
    expect(lineupResultKey("2026-08-26")).toBe("results/lineup/2026-08-26.json");
    expect(LINEUP_HISTORY_KEY).toBe("results/lineup/history.json");
    expect(LINEUP_LATEST_KEY).toBe("results/lineup/latest.json");
  });
});

describe("validateLineupResult", () => {
  it("accepts a well-formed result", () => {
    expect(() => validateLineupResult(lineupResult())).not.toThrow();
  });

  it("rejects a stale schemaVersion", () => {
    const error = catchValidation(() => validateLineupResult(lineupResult({ schemaVersion: 1 })));
    expect(error.message).toContain("schemaVersion");
  });

  it("rejects a malformed date", () => {
    const error = catchValidation(() =>
      validateLineupResult(lineupResult({ date: "Aug 26, 2026" })),
    );
    expect(error.message).toContain("date");
  });

  it("rejects fewer than 5 tickers", () => {
    const error = catchValidation(() =>
      validateLineupResult(lineupResult({ tickers: ["IBM", "TSLA"] })),
    );
    expect(error.message).toContain("tickers");
  });

  it("rejects more than 5 tickers", () => {
    const error = catchValidation(() =>
      validateLineupResult(lineupResult({ tickers: ["IBM", "TSLA", "DIS", "MSFT", "CAT", "ACN"] })),
    );
    expect(error.message).toContain("tickers");
  });

  it("rejects a ticker that isn't a real 3-4 letter shape", () => {
    const error = catchValidation(() =>
      validateLineupResult(lineupResult({ tickers: ["IBM", "TSLA", "DIS", "MSFT", "TOOLONG"] })),
    );
    expect(error.message).toContain("tickers[4]");
  });

  it("rejects a dotted share-class symbol -- not a plain ticker shape", () => {
    const error = catchValidation(() =>
      validateLineupResult(lineupResult({ tickers: ["IBM", "TSLA", "DIS", "MSFT", "BF.B"] })),
    );
    expect(error.message).toContain("tickers[4]");
  });

  it("rejects a duplicate ticker", () => {
    const error = catchValidation(() =>
      validateLineupResult(lineupResult({ tickers: ["IBM", "IBM", "DIS", "MSFT", "CAT"] })),
    );
    expect(error.message).toContain("duplicates");
  });

  it("collects every problem, not just the first", () => {
    const error = catchValidation(() =>
      validateLineupResult(
        lineupResult({ schemaVersion: 1, date: "bad", tickers: ["IBM", "TSLA"] }),
      ),
    );
    expect(error.message).toContain("schemaVersion");
    expect(error.message).toContain("date");
    expect(error.message).toContain("tickers");
  });
});

describe("validateLineupHistory", () => {
  it("accepts a well-formed history", () => {
    expect(() => validateLineupHistory(lineupHistory())).not.toThrow();
  });

  it("accepts an empty entries array (a fresh pipeline with no prior history)", () => {
    expect(() => validateLineupHistory(lineupHistory({ entries: [] }))).not.toThrow();
  });

  it("rejects a stale schemaVersion", () => {
    const error = catchValidation(() => validateLineupHistory(lineupHistory({ schemaVersion: 1 })));
    expect(error.message).toContain("schemaVersion");
  });

  it("rejects entries out of strictly-ascending date order", () => {
    const error = catchValidation(() =>
      validateLineupHistory(
        lineupHistory({
          entries: [
            { date: "2026-08-26", tickers: ["A"] },
            { date: "2026-08-25", tickers: ["B"] },
          ],
        }),
      ),
    );
    expect(error.message).toContain("ascending");
  });

  it("rejects a duplicate date", () => {
    const error = catchValidation(() =>
      validateLineupHistory(
        lineupHistory({
          entries: [
            { date: "2026-08-26", tickers: ["A"] },
            { date: "2026-08-26", tickers: ["B"] },
          ],
        }),
      ),
    );
    expect(error.message).toContain("ascending");
  });

  it("rejects an entry with a malformed date", () => {
    const error = catchValidation(() =>
      validateLineupHistory(lineupHistory({ entries: [{ date: "bad", tickers: ["A"] }] })),
    );
    expect(error.message).toContain("date");
  });

  it("rejects an entry whose tickers isn't an array of non-empty strings", () => {
    const error = catchValidation(() =>
      validateLineupHistory(
        lineupHistory({ entries: [{ date: "2026-08-26", tickers: ["A", ""] }] }),
      ),
    );
    expect(error.message).toContain("tickers");
  });
});

/** Awaits a synchronous throw and returns it, typed as Error -- fails the test if the callback doesn't throw. */
function catchValidation(fn: () => void): ResultValidationError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ResultValidationError);
    return error as ResultValidationError;
  }
  throw new Error("expected validation to throw, but it did not");
}
