import { describe, expect, it } from "vitest";

import {
  LINEUP_REPEAT_AVOIDANCE_DAYS,
  LINEUP_SIZE,
  LINEUP_TICKER_POOL,
  mergeLineupHistory,
  selectLineupTickers,
  type LineupHistoryEntry,
} from "./lineup-selection";
import type { DailyClose } from "./yahoo-client";

// selectLineupTickers only ever considers tickers actually in
// LINEUP_TICKER_POOL (the real S&P 500 3-/4-letter pool) -- synthetic
// tickers like "AAA"/"BBB" would silently never be picked up, so every
// fixture below uses real pool members instead.

/** Builds a small, real-shaped closesByTicker map: every ticker gets the same two dates, `previousClose`/`todayClose`. */
function fixture(
  entries: Record<string, [previousClose: number, todayClose: number]>,
  day = "2026-08-27",
  previousDay = "2026-08-26",
): Map<string, DailyClose[]> {
  for (const ticker of Object.keys(entries)) {
    if (!LINEUP_TICKER_POOL.includes(ticker)) {
      throw new Error(`test fixture bug: "${ticker}" is not a real LINEUP_TICKER_POOL member`);
    }
  }
  const map = new Map<string, DailyClose[]>();
  for (const [ticker, [previousClose, todayClose]] of Object.entries(entries)) {
    map.set(ticker, [
      { date: previousDay, close: previousClose },
      { date: day, close: todayClose },
    ]);
  }
  return map;
}

describe("LINEUP_TICKER_POOL", () => {
  it("contains only real, plain 3- or 4-letter tickers -- no dotted share-class symbol slips in", () => {
    for (const ticker of LINEUP_TICKER_POOL) {
      expect(ticker).toMatch(/^[A-Z]{3,4}$/);
    }
    // BF.B is 4 *characters* but not a plain 4-letter ticker -- must be
    // excluded, not silently swept into the 4-letter pool by a bare
    // `.length` check.
    expect(LINEUP_TICKER_POOL).not.toContain("BF.B");
    expect(LINEUP_TICKER_POOL).not.toContain("BRK.B");
  });

  it("matches the real, live-checked S&P 500 counts (281 three-letter + 162 real four-letter)", () => {
    const threeLetter = LINEUP_TICKER_POOL.filter((t) => t.length === 3);
    const fourLetter = LINEUP_TICKER_POOL.filter((t) => t.length === 4);
    expect(threeLetter).toHaveLength(281);
    expect(fourLetter).toHaveLength(162);
    expect(LINEUP_TICKER_POOL).toHaveLength(443);
  });

  it("includes real recognizable 4-letter tickers, unlike the superseded 3-letter-only spec", () => {
    expect(LINEUP_TICKER_POOL).toContain("AAPL");
    expect(LINEUP_TICKER_POOL).toContain("TSLA");
  });
});

describe("selectLineupTickers", () => {
  it("picks the 5 biggest movers by absolute return, descending", () => {
    const closes = fixture({
      ACN: [100, 101], // +1%
      AEE: [100, 150], // +50%
      AES: [100, 90], // -10%
      AFL: [100, 100.5], // +0.5%
      ALL: [100, 80], // -20%
      AMD: [100, 105], // +5%
    });
    const result = selectLineupTickers(closes, "2026-08-27", []);
    expect(result?.tickers).toEqual(["AEE", "ALL", "AES", "AMD", "ACN"]);
  });

  it("breaks an exact tie alphabetically, not by insertion order", () => {
    // Each "tied" pair uses IDENTICAL previous/today prices, not just the
    // same nominal percentage -- a +10%-vs--10% pair computes to two
    // different doubles (1.1-1 !== 1-0.9 in IEEE 754), which would make
    // this test flaky-by-construction rather than exercising a real tie.
    const closes = fixture({
      AMD: [100, 110], // +10%
      ACN: [100, 110], // +10%, bit-identical to AMD's own computation
      ALL: [100, 95], // -5%
      AFL: [100, 95], // -5%, bit-identical to ALL's own computation
      AES: [100, 101], // +1%
    });
    const result = selectLineupTickers(closes, "2026-08-27", []);
    // ACN/AMD tie at 10%; AFL/ALL tie at 5% -- alphabetical break within each tie.
    expect(result?.tickers).toEqual(["ACN", "AMD", "AFL", "ALL", "AES"]);
  });

  it("skips a ticker missing `day`'s own entry, or with no prior-day entry to compare against", () => {
    const closes = fixture({
      AEE: [100, 150], // +50%
      AES: [100, 90], // -10%
      AFL: [100, 95], // -5%
      ALL: [100, 96], // -4%
      AMD: [100, 97], // -3%
    });
    closes.set("AMGN", [{ date: "2026-08-27", close: 1000 }]); // no previous-day entry at all
    closes.set("ACN", [{ date: "2026-08-20", close: 5 }]); // no entry for `day`
    const result = selectLineupTickers(closes, "2026-08-27", []);
    expect(result?.tickers).toEqual(["AEE", "AES", "AFL", "ALL", "AMD"]);
  });

  it("returns null when fewer than 5 candidates exist even with zero repeat-avoidance", () => {
    const closes = fixture({ ACN: [100, 101], AEE: [100, 99] });
    expect(selectLineupTickers(closes, "2026-08-27", [])).toBeNull();
  });

  it("skips a ticker published in a lineup within the last 14 days, falling back to the next-best mover", () => {
    const closes = fixture({
      AEE: [100, 150], // +50% -- but published 3 days ago
      AES: [100, 90], // -10%
      AFL: [100, 95], // -5%
      ALL: [100, 96], // -4%
      AMD: [100, 97], // -3%
      ACN: [100, 98], // -2%
    });
    const history: LineupHistoryEntry[] = [{ date: "2026-08-24", tickers: ["AEE", "AMGN"] }];
    const result = selectLineupTickers(closes, "2026-08-27", history);
    expect(result?.tickers).not.toContain("AEE");
    expect(result?.tickers).toEqual(["AES", "AFL", "ALL", "AMD", "ACN"]);
    expect(result?.repeatAvoidanceDaysUsed).toBe(LINEUP_REPEAT_AVOIDANCE_DAYS);
  });

  it("does not exclude a ticker published exactly LINEUP_REPEAT_AVOIDANCE_DAYS days before `day` (boundary is exclusive on the far edge)", () => {
    // day=2026-08-27, 14 days back is 2026-08-13 -- the cutoff itself is
    // included (>= cutoff), so a lineup published exactly on 2026-08-13
    // IS within the window and its tickers ARE excluded.
    const closes = fixture({
      AEE: [100, 150],
      AES: [100, 90],
      AFL: [100, 95],
      ALL: [100, 96],
      AMD: [100, 97],
      ACN: [100, 98],
    });
    const history: LineupHistoryEntry[] = [{ date: "2026-08-13", tickers: ["AEE"] }];
    const result = selectLineupTickers(closes, "2026-08-27", history);
    expect(result?.tickers).not.toContain("AEE");
  });

  it("does not exclude a ticker published just outside the 14-day window", () => {
    const closes = fixture({
      AEE: [100, 150],
      AES: [100, 90],
      AFL: [100, 95],
      ALL: [100, 96],
      AMD: [100, 97],
    });
    // One day earlier than the boundary test above -- outside the window.
    const history: LineupHistoryEntry[] = [{ date: "2026-08-12", tickers: ["AEE"] }];
    const result = selectLineupTickers(closes, "2026-08-27", history);
    expect(result?.tickers).toContain("AEE");
    expect(result?.repeatAvoidanceDaysUsed).toBe(LINEUP_REPEAT_AVOIDANCE_DAYS);
  });

  it("relaxes 14 -> 7 -> 0 days when a tighter window can't find 5 candidates", () => {
    // Only 5 real candidates total, and all 5 were published within the
    // last 14 days -- the 14-day and 7-day windows both fail to find 5,
    // forcing the fallback to 0 (no avoidance), which lets every
    // candidate back in regardless of history.
    const closes = fixture({
      AEE: [100, 150],
      AES: [100, 90],
      AFL: [100, 95],
      ALL: [100, 96],
      AMD: [100, 97],
    });
    const history: LineupHistoryEntry[] = [
      { date: "2026-08-25", tickers: ["AEE", "AES", "AFL", "ALL", "AMD"] },
    ];
    const result = selectLineupTickers(closes, "2026-08-27", history);
    expect(result?.tickers).toHaveLength(LINEUP_SIZE);
    expect(result?.repeatAvoidanceDaysUsed).toBe(0);
  });

  it("relaxes to exactly 7 days when 14 fails but 7 succeeds", () => {
    // 6 real candidates. Entry1 (2026-08-15) sits inside the 14-day
    // window (cutoff 2026-08-13) but outside the 7-day window (cutoff
    // 2026-08-20); entry2 (2026-08-22) sits inside both. So the 14-day
    // window excludes AEE+AES (4 candidates left, fails); the 7-day
    // window excludes only AES (5 candidates left, succeeds).
    const closes = fixture({
      AEE: [100, 150],
      AES: [100, 90],
      AFL: [100, 95],
      ALL: [100, 96],
      AMD: [100, 97],
      ACN: [100, 98],
    });
    const history: LineupHistoryEntry[] = [
      { date: "2026-08-15", tickers: ["AEE"] },
      { date: "2026-08-22", tickers: ["AES"] },
    ];
    const result = selectLineupTickers(closes, "2026-08-27", history);
    expect(result?.repeatAvoidanceDaysUsed).toBe(7);
    expect(result?.tickers).toContain("AEE");
    expect(result?.tickers).not.toContain("AES");
  });
});

describe("mergeLineupHistory", () => {
  it("appends a new day's entry", () => {
    const existing: LineupHistoryEntry[] = [{ date: "2026-08-26", tickers: ["ACN"] }];
    const merged = mergeLineupHistory(existing, { date: "2026-08-27", tickers: ["AEE"] });
    expect(merged).toEqual([
      { date: "2026-08-26", tickers: ["ACN"] },
      { date: "2026-08-27", tickers: ["AEE"] },
    ]);
  });

  it("replaces (not duplicates) an existing entry for the same date -- idempotent re-run", () => {
    const existing: LineupHistoryEntry[] = [{ date: "2026-08-27", tickers: ["ACN"] }];
    const merged = mergeLineupHistory(existing, { date: "2026-08-27", tickers: ["AEE"] });
    expect(merged).toEqual([{ date: "2026-08-27", tickers: ["AEE"] }]);
  });

  it("trims entries older than LINEUP_HISTORY_RETENTION_DAYS", () => {
    const existing: LineupHistoryEntry[] = [
      { date: "2026-01-01", tickers: ["ACN"] },
      { date: "2026-08-20", tickers: ["AEE"] },
    ];
    const merged = mergeLineupHistory(existing, { date: "2026-08-27", tickers: ["AES"] });
    expect(merged.map((e) => e.date)).toEqual(["2026-08-20", "2026-08-27"]);
  });

  it("returns entries sorted ascending by date", () => {
    const existing: LineupHistoryEntry[] = [{ date: "2026-08-25", tickers: ["ACN"] }];
    const merged = mergeLineupHistory(existing, { date: "2026-08-20", tickers: ["AEE"] });
    expect(merged.map((e) => e.date)).toEqual(["2026-08-20", "2026-08-25"]);
  });
});
