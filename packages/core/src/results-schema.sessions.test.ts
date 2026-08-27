// Covers the four Beat the Bench validators issue #127 added to
// results-schema.ts. Kept in its own file rather than appended to the
// already-large results-schema.test.ts: these validate a separate family
// of stored objects with their own invariants (chiefly "no date in this
// payload"), and none of them share fixtures with the
// PrecomputedResult/CustomWindowResult suites.

import { describe, expect, it } from "vitest";

import {
  MYSTERY_INDEX_KEY,
  MYSTERY_POOL_MANIFEST_KEY,
  MYSTERY_SESSION_IDS,
  RESULTS_SCHEMA_VERSION,
  ResultValidationError,
  TODAYS_CLOSE_SESSION_KEY,
  mysterySessionKey,
  validateMysteryIndex,
  validateMysteryPoolManifest,
  validateMysterySession,
  validateTodaysCloseSession,
  type MysteryIndex,
  type MysteryPoolManifest,
  type MysterySession,
  type TodaysCloseSession,
} from "./results-schema";

const BARS = [
  { time: "09:30:00", close: 681.69 },
  { time: "10:30:00", close: 682.15 },
  { time: "11:30:00", close: 682.31 },
  { time: "13:00:00", close: 683.11 },
];

function todaysClose(overrides: Partial<TodaysCloseSession> = {}): TodaysCloseSession {
  return {
    schemaVersion: RESULTS_SCHEMA_VERSION,
    generatedAt: "2025-11-29T06:00:00.000Z",
    ticker: "SPY",
    date: "2025-11-28",
    barIntervalMinutes: 5,
    bars: [...BARS],
    ...overrides,
  };
}

function mystery(overrides: Partial<MysterySession> = {}): MysterySession {
  return {
    schemaVersion: RESULTS_SCHEMA_VERSION,
    ticker: "SPY",
    sessionId: "s01",
    barIntervalMinutes: 5,
    bars: [...BARS],
    ...overrides,
  };
}

function poolManifest(overrides: Partial<MysteryPoolManifest> = {}): MysteryPoolManifest {
  return {
    schemaVersion: RESULTS_SCHEMA_VERSION,
    generatedAt: "2025-11-29T06:00:00.000Z",
    sessionIds: ["s01", "s02", "s03"],
    ...overrides,
  };
}

function mysteryIndex(overrides: Partial<MysteryIndex> = {}): MysteryIndex {
  return {
    schemaVersion: RESULTS_SCHEMA_VERSION,
    generatedAt: "2025-11-29T06:00:00.000Z",
    entries: [
      { sessionId: "s01", date: "2025-11-24" },
      { sessionId: "s02", date: "2025-11-20" },
      { sessionId: "s03", date: "2025-11-26" },
    ],
    ...overrides,
  };
}

describe("Beat the Bench S3 keys", () => {
  it("namespaces the sessions under their own prefix, and the date lookup deliberately outside it", () => {
    expect(TODAYS_CLOSE_SESSION_KEY).toBe("results/beat-the-bench/today.json");
    expect(MYSTERY_POOL_MANIFEST_KEY).toBe("results/beat-the-bench/pool/index.json");
    expect(mysterySessionKey("s07")).toBe("results/beat-the-bench/pool/s07.json");
    // Intentionally NOT under results/beat-the-bench/pool/ -- see
    // MYSTERY_INDEX_KEY's own doc comment.
    expect(MYSTERY_INDEX_KEY).toBe("results/mystery-index.json");
  });

  it("draws every session id from a fixed, bounded, date-free slot list", () => {
    expect(MYSTERY_SESSION_IDS.length).toBeGreaterThanOrEqual(43);
    expect(new Set(MYSTERY_SESSION_IDS).size).toBe(MYSTERY_SESSION_IDS.length);
    for (const id of MYSTERY_SESSION_IDS) {
      expect(id).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    }
    // Ascending by id, so a manifest built by walking this list in order
    // already satisfies the strictly-ascending contract.
    expect([...MYSTERY_SESSION_IDS].sort()).toEqual([...MYSTERY_SESSION_IDS]);
  });
});

describe("validateTodaysCloseSession", () => {
  it("accepts a real, transparent session", () => {
    expect(() => validateTodaysCloseSession(todaysClose())).not.toThrow();
  });

  it("accepts a real half day's shorter bar array -- no bar-count assumption", () => {
    expect(() => validateTodaysCloseSession(todaysClose({ bars: BARS.slice(0, 2) }))).not.toThrow();
  });

  it("requires the real date, since this mode is the transparent one", () => {
    expect(() => validateTodaysCloseSession(todaysClose({ date: undefined as never }))).toThrow(
      ResultValidationError,
    );
    expect(() => validateTodaysCloseSession(todaysClose({ date: "2025-11" }))).toThrow(
      /date must be a "YYYY-MM-DD" string/,
    );
  });

  it("rejects a stale schemaVersion", () => {
    expect(() =>
      validateTodaysCloseSession(todaysClose({ schemaVersion: RESULTS_SCHEMA_VERSION - 1 })),
    ).toThrow(/schemaVersion must be exactly/);
  });

  it("rejects a session with nothing to play through", () => {
    expect(() => validateTodaysCloseSession(todaysClose({ bars: [BARS[0]!] }))).toThrow(
      /at least 2 bars/,
    );
  });

  it("reports every problem at once, not just the first", () => {
    let message = "";
    try {
      validateTodaysCloseSession(
        todaysClose({ ticker: "", date: "nope", bars: [{ time: "09:30", close: -1 }, BARS[1]!] }),
      );
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("ticker");
    expect(message).toContain("date");
    expect(message).toContain("bars[0].time");
    expect(message).toContain("bars[0].close");
  });
});

describe("validateMysterySession", () => {
  it("accepts a date-free session", () => {
    expect(() => validateMysterySession(mystery())).not.toThrow();
  });

  it("rejects a date smuggled in as a new field", () => {
    // The exact regression this gate exists for: a future refactor
    // "helpfully" carrying the real date onto the mystery payload.
    const leaky = { ...mystery(), date: "2025-11-24" } as MysterySession;

    expect(() => validateMysterySession(leaky)).toThrow(
      /must contain no calendar date anywhere in its payload, but found "2025-11-24"/,
    );
  });

  it("rejects a full datetime left in a bar's time field", () => {
    // IntradayBar.date is a full local datetime, so this is the specific
    // way the split in intraday-sessions.ts could regress: bars keeping
    // their source label instead of the time-of-day half.
    const leaky = mystery({
      bars: [{ time: "2025-11-24T09:30:00", close: 100 }, BARS[1]!],
    });

    expect(() => validateMysterySession(leaky)).toThrow(ResultValidationError);
    expect(() => validateMysterySession(leaky)).toThrow(/bars\[0\].time must be an "HH:MM:SS"/);
    expect(() => validateMysterySession(leaky)).toThrow(/must contain no calendar date/);
  });

  it("rejects a date encoded into the session id itself", () => {
    expect(() => validateMysterySession(mystery({ sessionId: "2025-11-24" }))).toThrow(
      /must contain no calendar date/,
    );
  });

  it("names MYSTERY_INDEX_KEY in the failure, so the fix is obvious from the message alone", () => {
    let message = "";
    try {
      validateMysterySession({ ...mystery(), date: "2025-11-24" } as MysterySession);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain(MYSTERY_INDEX_KEY);
  });

  it("still enforces the ordinary shape checks", () => {
    expect(() => validateMysterySession(mystery({ sessionId: "" }))).toThrow(/sessionId/);
    expect(() => validateMysterySession(mystery({ barIntervalMinutes: 0 }))).toThrow(
      /barIntervalMinutes/,
    );
  });
});

describe("validateMysteryPoolManifest", () => {
  it("accepts an ascending, duplicate-free id list", () => {
    expect(() => validateMysteryPoolManifest(poolManifest())).not.toThrow();
  });

  it("rejects an order that isn't strictly ascending by id", () => {
    // Order is load-bearing here, not cosmetic: a date-derived order
    // would leak the whole pool without anyone fetching the index.
    expect(() => validateMysteryPoolManifest(poolManifest({ sessionIds: ["s02", "s01"] }))).toThrow(
      /out of order -- must be strictly ascending/,
    );
    expect(() => validateMysteryPoolManifest(poolManifest({ sessionIds: ["s01", "s01"] }))).toThrow(
      /duplicates/,
    );
  });

  it("rejects an id that isn't a known slot", () => {
    expect(() => validateMysteryPoolManifest(poolManifest({ sessionIds: ["zz"] }))).toThrow(
      /is not one of the known MYSTERY_SESSION_IDS/,
    );
  });

  it("rejects an empty manifest -- there'd be nothing to publish", () => {
    expect(() => validateMysteryPoolManifest(poolManifest({ sessionIds: [] }))).toThrow(
      /non-empty array/,
    );
  });
});

describe("validateMysteryIndex", () => {
  it("accepts entries carrying real dates -- this is the one object that should", () => {
    expect(() => validateMysteryIndex(mysteryIndex())).not.toThrow();
  });

  it("requires a well-formed date on every entry", () => {
    expect(() =>
      validateMysteryIndex(mysteryIndex({ entries: [{ sessionId: "s01", date: "not-a-date" }] })),
    ).toThrow(/entries\[0\].date must be a "YYYY-MM-DD" string/);
  });

  it("requires the same strictly-ascending id order the manifest publishes", () => {
    expect(() =>
      validateMysteryIndex(
        mysteryIndex({
          entries: [
            { sessionId: "s02", date: "2025-11-20" },
            { sessionId: "s01", date: "2025-11-24" },
          ],
        }),
      ),
    ).toThrow(/out of order/);
  });

  it("rejects a duplicate id, which would make a settlement lookup ambiguous", () => {
    expect(() =>
      validateMysteryIndex(
        mysteryIndex({
          entries: [
            { sessionId: "s01", date: "2025-11-20" },
            { sessionId: "s01", date: "2025-11-24" },
          ],
        }),
      ),
    ).toThrow(/duplicates/);
  });
});
