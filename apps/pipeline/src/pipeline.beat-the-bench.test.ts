// Issue #127's data-contract coverage for Beat the Bench's persisted SPY
// session data.
//
// The headline check here is deliberately a *payload-level* one, not a UI
// one: every object a client is allowed to fetch before Final Settlement
// (the pool manifest, and every pooled session) is asserted to contain no
// calendar date anywhere in its serialized JSON, and specifically none of
// the real dates the settlement-time index maps those same sessions to.
// The corresponding UI-level check ("the date is absent from the DOM
// mid-session") belongs to issue #132, per issue #127's own scope note.
//
// Kept in its own file, mirroring pipeline.write-validation.test.ts's and
// pipeline.merge-fallback.test.ts's precedent, since it drives runPipeline
// with a completely different fixture shape from pipeline.test.ts's.

import {
  MYSTERY_INDEX_KEY,
  MYSTERY_POOL_MANIFEST_KEY,
  TODAYS_CLOSE_SESSION_KEY,
  mysterySessionKey,
  type DailyClose,
  type IntradayBar,
  type MysteryIndex,
  type MysteryPoolManifest,
  type MysterySession,
  type TodaysCloseSession,
} from "@hadiknowntrades/core";
import {
  SPY_2025_11_28_HALF_DAY,
  SPY_THANKSGIVING_WEEK_2025,
} from "@hadiknowntrades/core/src/test-fixtures/spy-thanksgiving-2025";
import { describe, expect, it } from "vitest";

import { runPipeline, type ResultStore } from "./pipeline.js";

// The Monday after the fixture's last session, so every real session in
// it (including 2025-11-28, the half day) is inside the run's own window.
const ASOF = new Date("2025-11-30T00:00:00Z");

const TICKERS = ["AAA", "BBB"];

/** Any YYYY-MM-DD, anywhere in a string -- the whole vocabulary a pre-settlement payload is forbidden from using. */
const EMBEDDED_DATE = /\d{4}-\d{2}-\d{2}/;

// Enough real-shaped daily closes for the window path (5Y/MAX) to produce
// results, so the run doesn't trip runPipeline's "neither path produced
// usable data" abort before any write happens. Irrelevant to what's under
// test; it just has to be non-empty and well-formed.
const DAILY: DailyClose[] = [
  { date: "2025-11-24", close: 100 },
  { date: "2025-11-25", close: 110 },
  { date: "2025-11-26", close: 105 },
];

function memoryStore(): ResultStore & { objects: Map<string, string> } {
  const objects = new Map<string, string>();
  return {
    objects,
    async putObject(key, body) {
      objects.set(key, body);
    },
  };
}

/**
 * Runs the pipeline with the real Thanksgiving-2025 SPY fixture standing
 * in for the SPY 5-minute fetch.
 *
 * `random` is pinned per call rather than left to Math.random -- see
 * RunPipelineOptions.random. `() => 0` makes Fisher-Yates take its
 * j-is-always-0 path, a fully determined (and, usefully, thoroughly
 * non-chronological) permutation.
 */
async function run(random: () => number) {
  const store = memoryStore();
  await runPipeline({
    tickers: TICKERS,
    fetchDailyCloses: async () => DAILY,
    // The universe's own intraday path -- unrelated to Beat the Bench,
    // present only so the intraday ranges also compute and write.
    fetchIntradayBars: async (): Promise<IntradayBar[]> => [...SPY_THANKSGIVING_WEEK_2025],
    // Serves both the 3M granularity override (called per universe
    // ticker) and Beat the Bench's own SPY session fetch (called once,
    // for "SPY", regardless of the universe).
    fetchFiveMinuteBars: async (): Promise<IntradayBar[]> => [...SPY_THANKSGIVING_WEEK_2025],
    fetchIntraday1mBars: async (): Promise<IntradayBar[]> => [],
    store,
    asOf: ASOF,
    random,
  });
  return store;
}

function parse<T>(store: { objects: Map<string, string> }, key: string): T {
  const body = store.objects.get(key);
  expect(body, `expected an object written at ${key}`).toBeDefined();
  return JSON.parse(body!) as T;
}

describe("Beat the Bench session data (issue #127)", () => {
  it("publishes the most recently closed session transparently, with its real date and real bars", async () => {
    const store = await run(() => 0);

    const today = parse<TodaysCloseSession>(store, TODAYS_CLOSE_SESSION_KEY);

    expect(today.ticker).toBe("SPY");
    expect(today.barIntervalMinutes).toBe(5);
    // The newest complete session in the fixture is 2025-11-28 -- which
    // happens to be the real half day, so this doubles as an end-to-end
    // check that a shortened session survives every downstream
    // assumption, validators included.
    expect(today.date).toBe("2025-11-28");
    expect(today.bars).toHaveLength(SPY_2025_11_28_HALF_DAY.length);
    expect(today.bars[0]).toEqual({ time: "09:30:00", close: 681.6900024414062 });
    expect(today.bars.at(-1)).toEqual({ time: "13:00:00", close: 683.1099853515625 });
  });

  it("withholds every pooled session's real date from everything a client can fetch before settlement", async () => {
    const store = await run(() => 0);

    const index = parse<MysteryIndex>(store, MYSTERY_INDEX_KEY);
    const manifest = parse<MysteryPoolManifest>(store, MYSTERY_POOL_MANIFEST_KEY);
    const realDates = index.entries.map((entry) => entry.date);
    expect(realDates.length).toBeGreaterThan(0);

    // Every pooled session a client might pick: not just "doesn't
    // contain its own date" -- doesn't contain any date-shaped substring
    // at all, so there's nothing to correlate even across the whole pool
    // at once.
    for (const id of manifest.sessionIds) {
      const key = mysterySessionKey(id);
      const body = store.objects.get(key);
      expect(body, `expected an object written at ${key}`).toBeDefined();
      expect(body).not.toMatch(EMBEDDED_DATE);
      for (const date of realDates) {
        expect(body).not.toContain(date);
      }
    }

    // The pool manifest gets the same treatment, minus its own
    // `generatedAt` run stamp -- the one date-shaped substring that
    // legitimately appears pre-settlement, and the only field exempted
    // here. It's the *run* timestamp, identical across the whole pool and
    // already known to any client with a clock, so it maps no id to any
    // day; see MysteryPoolManifest.generatedAt's own doc comment for why
    // it's carried at all.
    const manifestBody = store.objects.get(MYSTERY_POOL_MANIFEST_KEY)!;
    expect(JSON.stringify({ ...manifest, generatedAt: "<run stamp>" })).not.toMatch(EMBEDDED_DATE);
    for (const date of realDates) {
      expect(manifestBody).not.toContain(date);
    }

    // ...and the one object that does carry them is the settlement-time
    // lookup, at its own separate key.
    const indexBody = store.objects.get(MYSTERY_INDEX_KEY)!;
    for (const date of realDates) {
      expect(indexBody).toContain(date);
    }
  });

  it("assigns real days to opaque slots by a permutation, not by recency", async () => {
    const store = await run(() => 0);

    const index = parse<MysteryIndex>(store, MYSTERY_INDEX_KEY);

    // The fixture's five older complete sessions, ascending:
    // 11-20, 11-21, 11-24, 11-25, 11-26. Fisher-Yates with j always 0
    // maps them onto s01..s05 in this exact, deliberately scrambled
    // order -- note the *oldest* day lands in the *last* slot.
    expect(index.entries).toEqual([
      { sessionId: "s01", date: "2025-11-21" },
      { sessionId: "s02", date: "2025-11-24" },
      { sessionId: "s03", date: "2025-11-25" },
      { sessionId: "s04", date: "2025-11-26" },
      { sessionId: "s05", date: "2025-11-20" },
    ]);
    // Slot order is not date order -- which is the entire reason the
    // manifest can publish these ids without leaking anything.
    expect(index.entries.map((e) => e.date)).not.toEqual(
      [...index.entries.map((e) => e.date)].sort(),
    );
  });

  it("really does derive the assignment from the injected RNG", async () => {
    // The contrast case: `j === i` on every step leaves Fisher-Yates'
    // input untouched. Identity is a legitimate (if unlucky) draw -- the
    // point is that a different RNG yields a different mapping, so the
    // permutation is genuinely re-rolled per run rather than baked in.
    const store = await run(() => 0.999999);

    const index = parse<MysteryIndex>(store, MYSTERY_INDEX_KEY);

    expect(index.entries).toEqual([
      { sessionId: "s01", date: "2025-11-20" },
      { sessionId: "s02", date: "2025-11-21" },
      { sessionId: "s03", date: "2025-11-24" },
      { sessionId: "s04", date: "2025-11-25" },
      { sessionId: "s05", date: "2025-11-26" },
    ]);
  });

  it("keeps Today's Close out of the mystery pool", async () => {
    const store = await run(() => 0);

    const today = parse<TodaysCloseSession>(store, TODAYS_CLOSE_SESSION_KEY);
    const index = parse<MysteryIndex>(store, MYSTERY_INDEX_KEY);

    // A player who has already played Today's Close would recognize the
    // same price path instantly -- both a poor experience and a free
    // de-anonymization of one pool member.
    expect(index.entries.map((e) => e.date)).not.toContain(today.date);
  });

  it("publishes exactly the sessions the manifest advertises, and nothing else", async () => {
    const store = await run(() => 0);

    const manifest = parse<MysteryPoolManifest>(store, MYSTERY_POOL_MANIFEST_KEY);
    const index = parse<MysteryIndex>(store, MYSTERY_INDEX_KEY);

    expect(manifest.sessionIds).toEqual(index.entries.map((e) => e.sessionId));
    // Ascending by id, per MysteryPoolManifest's own contract.
    expect(manifest.sessionIds).toEqual([...manifest.sessionIds].sort());

    const poolKeys = [...store.objects.keys()].filter((key) =>
      key.startsWith("results/beat-the-bench/pool/"),
    );
    expect(poolKeys.sort()).toEqual(
      [MYSTERY_POOL_MANIFEST_KEY, ...manifest.sessionIds.map((id) => mysterySessionKey(id))].sort(),
    );

    for (const id of manifest.sessionIds) {
      const session = parse<MysterySession>(store, mysterySessionKey(id));
      expect(session.sessionId).toBe(id);
      expect(session.ticker).toBe("SPY");
      expect(session.bars.length).toBeGreaterThanOrEqual(2);
      expect(Object.keys(session)).not.toContain("date");
      expect(Object.keys(session)).not.toContain("generatedAt");
    }
  });

  it("writes nothing at all -- and doesn't fail the run -- when the SPY session fetch fails", async () => {
    const store = memoryStore();

    // Non-fatal by design (see fetchSessionBars' own doc comment): the
    // six real ranges still compute and write, and the run still
    // succeeds.
    await runPipeline({
      tickers: TICKERS,
      fetchDailyCloses: async () => DAILY,
      fetchIntradayBars: async (): Promise<IntradayBar[]> => [...SPY_THANKSGIVING_WEEK_2025],
      fetchFiveMinuteBars: async (symbol: string): Promise<IntradayBar[]> => {
        if (symbol === "SPY") throw new Error("simulated SPY 5-minute fetch failure");
        return [...SPY_THANKSGIVING_WEEK_2025];
      },
      fetchIntraday1mBars: async (): Promise<IntradayBar[]> => [],
      store,
      asOf: ASOF,
      random: () => 0,
    });

    expect(store.objects.has(TODAYS_CLOSE_SESSION_KEY)).toBe(false);
    expect(store.objects.has(MYSTERY_POOL_MANIFEST_KEY)).toBe(false);
    expect(store.objects.has(MYSTERY_INDEX_KEY)).toBe(false);
    // The real ranges are untouched by this path's failure.
    expect(store.objects.has("results/1W.json")).toBe(true);
    expect(store.objects.has("results/MAX.json")).toBe(true);
  });

  it("still publishes Today's Close when there's only one complete session to pool from", async () => {
    const store = memoryStore();

    await runPipeline({
      tickers: TICKERS,
      fetchDailyCloses: async () => DAILY,
      fetchIntradayBars: async (): Promise<IntradayBar[]> => [...SPY_THANKSGIVING_WEEK_2025],
      fetchFiveMinuteBars: async (symbol: string): Promise<IntradayBar[]> =>
        symbol === "SPY" ? [...SPY_2025_11_28_HALF_DAY] : [...SPY_THANKSGIVING_WEEK_2025],
      fetchIntraday1mBars: async (): Promise<IntradayBar[]> => [],
      store,
      asOf: ASOF,
      random: () => 0,
    });

    expect(parse<TodaysCloseSession>(store, TODAYS_CLOSE_SESSION_KEY).date).toBe("2025-11-28");
    // An empty pool publishes no manifest and no index at all, rather
    // than an empty one -- an empty manifest would fail its own
    // non-empty check, the same posture the custom-anchors manifest
    // already takes.
    expect(store.objects.has(MYSTERY_POOL_MANIFEST_KEY)).toBe(false);
    expect(store.objects.has(MYSTERY_INDEX_KEY)).toBe(false);
  });
});
