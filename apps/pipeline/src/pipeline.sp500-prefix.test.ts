// Pipeline integration coverage for The Cut's nightly result (issue #232;
// extended to a 7th range, "1D", by issue #238) -- mirrors
// pipeline.beat-the-bench.test.ts's own precedent: a small, real-ticker
// fixture driven through the real runPipeline, with expected output
// hand-computed independently (via the exact formula
// docs/design/the-cut-2026-09/README.md's "The mechanic" section
// documents), not by re-running the pipeline's own computeSp500PrefixSelection
// under test. computeSp500PrefixSelection's own exhaustive unit coverage
// already lives in packages/core/src/sp500-prefix-selection.test.ts; this
// file only checks the *wiring*: real S&P 500 ranking (SP500_CONSTITUENTS,
// not options.tickers), real boundary-date resolution against the
// already-fetched window history, the new S3 key convention, and the
// non-fatal-compute/fatal-write posture. The dedicated "1D" describe block
// near the bottom of this file covers issue #238's own backward-lookup
// boundary resolution specifically -- see its own header comment.
//
// **Uses real S&P 500 ticker symbols, not fictional ones** -- unlike
// every other per-game builder in this file (which mostly tolerate an
// arbitrary options.tickers sample), The Cut always ranks the *fixed,
// real* SP500_CONSTITUENTS list regardless of options.tickers, so a
// fictional "AAA"/"BBB" fixture (pipeline.beat-the-bench.test.ts's own
// convention) would make every single constituent lack window data and
// come back bestN: null for every range -- a real, but uninteresting,
// degenerate case. NVDA/AAPL/MSFT (real S&P 500 rank #1/#2/#3 by weight,
// verified live against sp500-constituents.ts as of this writing) are
// used instead specifically so the top-of-list prefix selection has
// something real to select among.
//
// **Every date below is a real trading date present in the fixture for
// every one of NVDA/AAPL/MSFT (and SPY)** -- chosen to land exactly on
// each PresetRange's own nominal boundary (presetRangeStartDate) for
// ASOF, so buildSp500PrefixResults' own forward-snapping never needs to
// snap at all (no ambiguity from "nearest date" resolution): every
// resolved startDate below is asserted to equal its nominal boundary
// exactly. Two "eras" of prices are used -- an OLD era for the three
// long-lookback ranges (5Y/1Y/MAX, which all share the identical
// 2019-06-01/2019-06-15/2023-06-15 OLD price, so their own curves are
// byte-identical apart from `truncated`/`startDate` metadata) and a
// RECENT era for the three short-lookback ranges (3M/1M/1W, sharing the
// identical 2024-03-15/2024-05-15/2024-06-08 RECENT price) -- keeping
// this fixture to exactly 7 dates per ticker instead of one for every
// PresetRange x era combination.

import {
  RESULTS_SCHEMA_VERSION,
  SP500_CONSTITUENTS,
  sp500PrefixResultKey,
  toDateString,
  type DailyClose,
  type IntradayBar,
  type Sp500PrefixResult,
} from "@hadiknowntrades/core";
import { describe, expect, it } from "vitest";

import { runPipeline, type ResultStore } from "./pipeline.js";

const ASOF = new Date("2024-06-15T00:00:00Z");

// The 7 dates every one of NVDA/AAPL/MSFT/SPY below carries a close on --
// see this file's own header comment for why these particular 7 (not a
// dense daily series) are enough to make every range's own boundary-date
// resolution exact, with no forward-snapping ambiguity.
const D_MAX = "2019-06-01"; // earliest fetched date at all -- MAX's own resolved start
const D_5Y = "2019-06-15"; // 5Y's nominal start (subtractCalendar(ASOF, {years: 5}))
const D_1Y = "2023-06-15"; // 1Y's nominal start (subtractCalendar(ASOF, {years: 1}))
const D_3M = "2024-03-15"; // 3M's nominal start (subtractCalendar(ASOF, {months: 3}))
const D_1M = "2024-05-15"; // 1M's nominal start (subtractCalendar(ASOF, {months: 1}))
const D_1W = "2024-06-08"; // 1W's nominal start (daysBeforeUtc(ASOF, 7))
const D_END = "2024-06-15"; // ASOF itself -- dataAsOf/endDate for every range

function closes(oldPrice: number, recentPrice: number, endPrice: number): DailyClose[] {
  return [
    { date: D_MAX, close: oldPrice },
    { date: D_5Y, close: oldPrice },
    { date: D_1Y, close: oldPrice },
    { date: D_3M, close: recentPrice },
    { date: D_1M, close: recentPrice },
    { date: D_1W, close: recentPrice },
    { date: D_END, close: endPrice },
  ];
}

// Real S&P 500 rank #1/#2/#3 by weight (verified live -- see this file's
// own header comment). Looked up from the real SP500_CONSTITUENTS list
// rather than hardcoded a second time, so this test can't silently drift
// from the real data it depends on.
const NVDA_WEIGHT = SP500_CONSTITUENTS.find((c) => c.symbol === "NVDA")!.weight;
const AAPL_WEIGHT = SP500_CONSTITUENTS.find((c) => c.symbol === "AAPL")!.weight;
const MSFT_WEIGHT = SP500_CONSTITUENTS.find((c) => c.symbol === "MSFT")!.weight;

// OLD era (governs 5Y/1Y/MAX): NVDA triples, AAPL +50%, MSFT -10%.
const NVDA_OLD_RATIO = 3.0;
const AAPL_OLD_RATIO = 1.5;
const MSFT_OLD_RATIO = 0.9;
// RECENT era (governs 3M/1M/1W): NVDA +50%, AAPL doubles, MSFT -20%.
const NVDA_RECENT_RATIO = 1.5;
const AAPL_RECENT_RATIO = 2.0;
const MSFT_RECENT_RATIO = 0.8;

// Each ticker's own `endPrice` is a single, real close on D_END (one
// calendar date can't carry two different closes) -- so unlike a naive
// "same number for both eras" design, getting each era's own *_RATIO
// constant above exactly right means solving each ticker's OLD/RECENT
// *start* price backward from one shared endPrice: NVDA(300),
// AAPL(150), MSFT(90).
const DAILY_FIXTURE = new Map<string, DailyClose[]>([
  ["NVDA", closes(300 / NVDA_OLD_RATIO, 300 / NVDA_RECENT_RATIO, 300)],
  ["AAPL", closes(150 / AAPL_OLD_RATIO, 150 / AAPL_RECENT_RATIO, 150)],
  ["MSFT", closes(90 / MSFT_OLD_RATIO, 90 / MSFT_RECENT_RATIO, 90)],
  // SPY: flat 100 across both eras, +20% to 120 by ASOF -- a simple,
  // uniform benchmark.endingBalance ($24 from $20) across every range,
  // used to hand-verify n500VsSpyPctDiff below.
  ["SPY", closes(100, 100, 120)],
]);

// Enough real-shaped intraday bars for the intraday path (1W/1M/3M/1Y) to
// also produce results, so the run doesn't trip runPipeline's "at least
// one path or write failed" throw -- irrelevant to what's under test
// here, same reasoning pipeline.beat-the-bench.test.ts's own DAILY
// fixture comment gives.
const INTRADAY_FIXTURE = new Map<string, IntradayBar[]>([
  [
    "NVDA",
    [
      { date: `${D_END}T09:30:00`, close: 300 },
      { date: `${D_END}T10:30:00`, close: 305 },
    ],
  ],
  [
    "AAPL",
    [
      { date: `${D_END}T09:30:00`, close: 150 },
      { date: `${D_END}T10:30:00`, close: 152 },
    ],
  ],
  [
    "MSFT",
    [
      { date: `${D_END}T09:30:00`, close: 90 },
      { date: `${D_END}T10:30:00`, close: 91 },
    ],
  ],
]);

const TICKERS = ["NVDA", "AAPL", "MSFT"];
const noIntradayData = async (): Promise<IntradayBar[]> => [];

function memoryStore(): ResultStore & { objects: Map<string, string> } {
  const objects = new Map<string, string>();
  return {
    objects,
    async putObject(key, body) {
      objects.set(key, body);
    },
  };
}

async function run() {
  const store = memoryStore();
  await runPipeline({
    tickers: TICKERS,
    fetchDailyCloses: async (symbol) => DAILY_FIXTURE.get(symbol) ?? [],
    fetchIntradayBars: async (symbol) => INTRADAY_FIXTURE.get(symbol) ?? [],
    fetchFiveMinuteBars: noIntradayData,
    fetchIntraday1mBars: noIntradayData,
    store,
    asOf: ASOF,
  });
  return store;
}

function parseSp500Prefix(
  store: { objects: Map<string, string> },
  range: Parameters<typeof sp500PrefixResultKey>[0],
): Sp500PrefixResult {
  const key = sp500PrefixResultKey(range);
  const body = store.objects.get(key);
  expect(body, `expected an object written at ${key}`).toBeDefined();
  return JSON.parse(body!) as Sp500PrefixResult;
}

/** portfolioReturn(N) per docs/design/the-cut-2026-09/README.md's own formula -- a plain weighted average, computed independently of computeSp500PrefixSelection (the function under test, one layer down). */
function weightedReturn(pairs: Array<[weight: number, ratio: number]>): number {
  const cumWeight = pairs.reduce((sum, [w]) => sum + w, 0);
  const cumWeightedReturn = pairs.reduce((sum, [w, r]) => sum + w * r, 0);
  return cumWeightedReturn / cumWeight;
}

describe("The Cut: nightly pipeline integration (issue #232)", () => {
  it("ranks by real S&P 500 weight (not options.tickers order) and writes one object per preset range at the new S3 key", async () => {
    const store = await run();

    // All 6 preset ranges, at results/sp500-prefix/{RANGE}.json -- not
    // interleaved with, or overwriting, the 6 flat results/{RANGE}.json
    // keys.
    for (const range of ["1W", "1M", "3M", "1Y", "5Y", "MAX"] as const) {
      expect(store.objects.has(sp500PrefixResultKey(range))).toBe(true);
      expect(store.objects.has(`results/${range}.json`)).toBe(true);
    }
    // "1D" (issue #238) at its own key too -- but with no flat
    // results/1D.json counterpart, since "1D" is a Cut-only range, not
    // one of the 6 PRESET_RANGES the main results page writes/reads.
    expect(store.objects.has(sp500PrefixResultKey("1D"))).toBe(true);
    expect(store.objects.has("results/1D.json")).toBe(false);

    const oneYear = parseSp500Prefix(store, "1Y");
    expect(oneYear.schemaVersion).toBe(RESULTS_SCHEMA_VERSION);
    expect(oneYear.range).toBe("1Y");
    expect(oneYear.startingCapital).toBe(20);
    expect(oneYear.universeSize).toBe(SP500_CONSTITUENTS.length);
  });

  it("finds the true best N for the OLD era (5Y/1Y/MAX): bestN=1, NVDA alone beats every larger prefix", async () => {
    const store = await run();

    // portfolioReturn(1) = 3.0 (NVDA alone) is the global max here --
    // strictly greater than portfolioReturn(2) (~2.308) and
    // portfolioReturn(3) (~1.933, frozen for every N from 3 to 503, since
    // every S&P 500 constituent past rank 3 lacks window data in this
    // fixture) -- so bestN is 1, not 2 or 3, even though this range's
    // curve has real, distinct values at N=2/N=3 too (checked below).
    for (const range of ["1Y", "5Y", "MAX"] as const) {
      const result = parseSp500Prefix(store, range);
      expect(result.bestN).toBe(1);
      expect(result.bestPortfolioReturn).toBeCloseTo(NVDA_OLD_RATIO, 10);
      expect(result.bestEndingBalance).toBeCloseTo(20 * NVDA_OLD_RATIO, 8);

      // The curve's own N=1/N=2/N=3 entries, hand-computed independently
      // via the design doc's own weighted-average formula.
      const n2Return = weightedReturn([
        [NVDA_WEIGHT, NVDA_OLD_RATIO],
        [AAPL_WEIGHT, AAPL_OLD_RATIO],
      ]);
      const n3Return = weightedReturn([
        [NVDA_WEIGHT, NVDA_OLD_RATIO],
        [AAPL_WEIGHT, AAPL_OLD_RATIO],
        [MSFT_WEIGHT, MSFT_OLD_RATIO],
      ]);
      expect(result.curve[0]).toMatchObject({ n: 1, portfolioReturn: NVDA_OLD_RATIO });
      expect(result.curve[0]!.cumWeight).toBeCloseTo(NVDA_WEIGHT, 10);
      expect(result.curve[1]!.n).toBe(2);
      expect(result.curve[1]!.portfolioReturn).toBeCloseTo(n2Return, 10);
      expect(result.curve[2]!.n).toBe(3);
      expect(result.curve[2]!.portfolioReturn).toBeCloseTo(n3Return, 10);

      // Every N from 3 to the full universe is frozen at N=3's own value
      // -- no S&P 500 constituent past rank 3 has window data in this
      // fixture, so cumWeight/cumWeightedReturn never move again. The
      // curve therefore has exactly `universeSize` entries (every N from
      // 1 has cumWeight > 0, since NVDA is rank #1).
      expect(result.curve).toHaveLength(SP500_CONSTITUENTS.length);
      const last = result.curve.at(-1)!;
      expect(last.n).toBe(SP500_CONSTITUENTS.length);
      expect(last.portfolioReturn).toBeCloseTo(n3Return, 10);
      expect(last.cumWeight).toBeCloseTo(NVDA_WEIGHT + AAPL_WEIGHT + MSFT_WEIGHT, 10);

      // The N=universeSize ("N=500") case vs. the SPY benchmark
      // (endingBalance = 20 * 1.2 = $24 uniformly, see DAILY_FIXTURE's
      // own SPY entry) -- a real, non-zero gap, exactly the design doc's
      // "Baseline comparison" section's own expectation.
      expect(result.benchmark).not.toBeNull();
      expect(result.benchmark!.endingBalance).toBeCloseTo(24, 8);
      const expectedPctDiff = ((20 * n3Return) / 24 - 1) * 100;
      expect(result.n500VsSpyPctDiff).toBeCloseTo(expectedPctDiff, 8);
    }
  });

  it("finds a different true best N for the RECENT era (3M/1M/1W): bestN=2, NVDA+AAPL beats both NVDA alone and all three", async () => {
    const store = await run();

    // portfolioReturn(2) (~1.7306) > portfolioReturn(1) (1.5) >
    // portfolioReturn(3) (~1.4825, frozen thereafter) -- a genuinely
    // different bestN from the OLD era above, over the exact same three
    // tickers, confirming this is real per-range window slicing, not a
    // fixed answer.
    const n1Return = NVDA_RECENT_RATIO;
    const n2Return = weightedReturn([
      [NVDA_WEIGHT, NVDA_RECENT_RATIO],
      [AAPL_WEIGHT, AAPL_RECENT_RATIO],
    ]);
    const n3Return = weightedReturn([
      [NVDA_WEIGHT, NVDA_RECENT_RATIO],
      [AAPL_WEIGHT, AAPL_RECENT_RATIO],
      [MSFT_WEIGHT, MSFT_RECENT_RATIO],
    ]);
    expect(n2Return).toBeGreaterThan(n1Return);
    expect(n2Return).toBeGreaterThan(n3Return);

    for (const range of ["3M", "1M", "1W"] as const) {
      const result = parseSp500Prefix(store, range);
      expect(result.bestN).toBe(2);
      expect(result.bestPortfolioReturn).toBeCloseTo(n2Return, 10);
      expect(result.bestEndingBalance).toBeCloseTo(20 * n2Return, 8);

      const last = result.curve.at(-1)!;
      expect(last.n).toBe(SP500_CONSTITUENTS.length);
      expect(last.portfolioReturn).toBeCloseTo(n3Return, 10);

      expect(result.benchmark).not.toBeNull();
      expect(result.benchmark!.endingBalance).toBeCloseTo(24, 8);
      const expectedPctDiff = ((20 * n3Return) / 24 - 1) * 100;
      expect(result.n500VsSpyPctDiff).toBeCloseTo(expectedPctDiff, 8);
    }
  });

  it("resolves every range's own real trading-date boundary exactly, with the OLD/RECENT eras' truncated flags matching SPY's own", async () => {
    const store = await run();

    const expectedStartDates: Record<string, string> = {
      // "1D" (issue #238) resolves *backward* from D_END to the nearest
      // earlier common date, which happens to be D_1W in this fixture's
      // own sparse 7-date calendar (there's nothing between D_1W and
      // D_END) -- not because 1D and 1W share any real economic meaning,
      // just a coincidence of this fixture's coarse date choices. The
      // dedicated "1D" describe block below covers the backward-lookup
      // mechanism itself with a fixture built to exercise it directly.
      "1D": D_1W,
      "1W": D_1W,
      "1M": D_1M,
      "3M": D_3M,
      "1Y": D_1Y,
      "5Y": D_5Y,
      MAX: D_MAX,
    };
    for (const [range, startDate] of Object.entries(expectedStartDates)) {
      const result = parseSp500Prefix(store, range as Parameters<typeof sp500PrefixResultKey>[0]);
      expect(result.startDate).toBe(startDate);
      expect(result.dataAsOf).toBe(D_END);
      expect(result.endDate).toBe(D_END);
      // Only MAX's own nominal start is unbounded -- every bounded range's
      // nominal boundary is comfortably inside the fetched universe's own
      // earliest date (D_MAX, 2019-06-01), matching the real SPY
      // benchmark's own truncated:false for the same bounded ranges (see
      // computeBenchmark's identical derivation, generalized here across
      // the whole fetched universe instead of SPY alone).
      expect(result.truncated).toBe(range === "MAX");
    }
  });

  it("resolves the shared end boundary to the majority-agreed date, not a single outlier ticker's fresher one (regression, live-verified real bug)", async () => {
    // Live verification against the real, full ~503-ticker S&P 500
    // universe (2026-09-10) found a real single outlier ticker (HUBB)
    // whose fetched data reached one calendar day further than all 502
    // others (unanimous). This fixture reproduces the same shape at a
    // 3-ticker scale: NVDA (this fixture's own rank-#1, highest-weighted
    // ticker) gets one extra close the other two lack, one day past
    // D_END -- 1 of 3 (33%), comfortably below
    // SP500_PREFIX_COMMON_DATE_THRESHOLD (0.9), so it must NOT become the
    // resolved end boundary.
    const outlierFixture = new Map(DAILY_FIXTURE);
    outlierFixture.set("NVDA", [
      ...DAILY_FIXTURE.get("NVDA")!,
      { date: "2024-06-16", close: 9999 },
    ]);
    const store = memoryStore();
    await runPipeline({
      tickers: TICKERS,
      fetchDailyCloses: async (symbol) => outlierFixture.get(symbol) ?? [],
      fetchIntradayBars: async (symbol) => INTRADAY_FIXTURE.get(symbol) ?? [],
      fetchFiveMinuteBars: noIntradayData,
      fetchIntraday1mBars: noIntradayData,
      store,
      asOf: ASOF,
    });

    for (const range of ["1D", "1W", "1M", "3M", "1Y", "5Y", "MAX"] as const) {
      const result = parseSp500Prefix(store, range);
      // The resolved end boundary is still D_END (shared by all 3
      // tickers), not NVDA's own one-ticker-only 2024-06-16 -- and
      // coverage/bestN are unaffected by the outlier, exactly matching
      // this same range's own value in the non-outlier fixture above.
      expect(result.dataAsOf).toBe(D_END);
      expect(result.curve.at(-1)!.cumWeight).toBeCloseTo(
        NVDA_WEIGHT + AAPL_WEIGHT + MSFT_WEIGHT,
        10,
      );
    }
    const oneYear = parseSp500Prefix(store, "1Y");
    expect(oneYear.bestN).toBe(1);
    expect(oneYear.bestPortfolioReturn).toBeCloseTo(NVDA_OLD_RATIO, 10);
  });

  it("counts a duplicate-dated entry once per ticker, not once per entry, when deciding whether a date is majority-shared (regression)", async () => {
    // Threshold math only leaves any slack once history.size >= 10
    // (SP500_PREFIX_COMMON_DATE_THRESHOLD is 0.9, and ceil(0.9 * n) < n
    // only once n >= 10) -- so this needs 10 real tickers, not 3, to make
    // the dedup fix's effect observable at all.
    const tenTickers = [
      "NVDA",
      "AAPL",
      "MSFT",
      "AMZN",
      "GOOGL",
      "AVGO",
      "GOOG",
      "META",
      "MU",
      "TSLA",
    ];
    const EARLY = "2024-06-14"; // every one of the 10 shares this date -- the correct common end date
    const LATE = "2024-06-15"; // only 8 of the 10 genuinely share this date

    const tenTickerFixture = new Map<string, DailyClose[]>(
      tenTickers.map((symbol, i) => {
        const closesForTicker: DailyClose[] = [{ date: EARLY, close: 100 }];
        if (i < 8) closesForTicker.push({ date: LATE, close: 110 });
        // NVDA (index 0, one of the 8 genuine LATE holders) also carries a
        // literal duplicate LATE entry -- without per-ticker dedup, this
        // inflates LATE's raw tally from 8 to 9, exactly meeting
        // ceil(10 * 0.9) = 9 and wrongly qualifying LATE as majority-shared
        // even though only 8 *distinct* tickers (80%) actually have it.
        if (i === 0) closesForTicker.push({ date: LATE, close: 999 });
        return [symbol, closesForTicker];
      }),
    );
    const tenTickerIntraday = new Map<string, IntradayBar[]>(
      tenTickers.map((symbol) => [
        symbol,
        [
          { date: `${EARLY}T09:30:00`, close: 100 },
          { date: `${EARLY}T10:30:00`, close: 101 },
        ],
      ]),
    );

    const store = memoryStore();
    await runPipeline({
      tickers: tenTickers,
      fetchDailyCloses: async (symbol) => tenTickerFixture.get(symbol) ?? [],
      fetchIntradayBars: async (symbol) => tenTickerIntraday.get(symbol) ?? [],
      fetchFiveMinuteBars: noIntradayData,
      fetchIntraday1mBars: noIntradayData,
      store,
      asOf: new Date("2024-06-16T00:00:00Z"),
    });

    // The resolved end boundary must be EARLY (genuinely 10/10, 100%),
    // never LATE (correctly only 8/10, 80%, below the 90% threshold once
    // NVDA's duplicate is no longer double-counted).
    const result = parseSp500Prefix(store, "MAX");
    expect(result.dataAsOf).toBe(EARLY);
  });

  it("flags truncated when the majority-shared calendar's own freshest date is older than a bounded range's own nominal start (regression)", async () => {
    // Every ticker's history stops at ONLY_DATE, deliberately older than
    // 1W's own 7-day lookback from asOf -- so no common date at or after
    // 1W's nominal start exists at all, and startDate must fall back to
    // ONLY_DATE (the earliest -- here, the *only* -- common date), a much
    // earlier date than "1 week ago" implies. Before this fix, `truncated`
    // stayed false in exactly this case (see buildSp500PrefixResults' own
    // doc comment for why `earliestCommonDate > nominalStartString` alone
    // can't catch it).
    const asOf = new Date("2024-06-15T00:00:00Z");
    const ONLY_DATE = "2024-06-01"; // older than 1W's own nominal start (2024-06-08)
    const staleFixture = new Map<string, DailyClose[]>(
      TICKERS.map((symbol) => [symbol, [{ date: ONLY_DATE, close: 100 }]]),
    );
    const staleIntraday = new Map<string, IntradayBar[]>(
      TICKERS.map((symbol) => [
        symbol,
        [
          { date: `${ONLY_DATE}T09:30:00`, close: 100 },
          { date: `${ONLY_DATE}T10:30:00`, close: 101 },
        ],
      ]),
    );

    const store = memoryStore();
    await runPipeline({
      tickers: TICKERS,
      fetchDailyCloses: async (symbol) => staleFixture.get(symbol) ?? [],
      fetchIntradayBars: async (symbol) => staleIntraday.get(symbol) ?? [],
      fetchFiveMinuteBars: noIntradayData,
      fetchIntraday1mBars: noIntradayData,
      store,
      asOf,
    });

    const oneWeek = parseSp500Prefix(store, "1W");
    expect(oneWeek.startDate).toBe(ONLY_DATE);
    expect(oneWeek.dataAsOf).toBe(ONLY_DATE);
    expect(oneWeek.truncated).toBe(true);
  });

  it("writes nothing at all -- and doesn't fail the run -- when the window path itself has no usable data", async () => {
    const store = memoryStore();
    const noDailyData = async (): Promise<DailyClose[]> => [];

    await expect(
      runPipeline({
        tickers: TICKERS,
        fetchDailyCloses: noDailyData,
        fetchIntradayBars: async (symbol) => INTRADAY_FIXTURE.get(symbol) ?? [],
        fetchFiveMinuteBars: noIntradayData,
        fetchIntraday1mBars: noIntradayData,
        store,
        asOf: ASOF,
      }),
    ).rejects.toThrow();

    for (const range of ["1D", "1W", "1M", "3M", "1Y", "5Y", "MAX"] as const) {
      expect(store.objects.has(sp500PrefixResultKey(range))).toBe(false);
    }
  });
});

describe("The Cut: 1D range (issue #238)", () => {
  it("resolves \"1D\"'s own start to commonDates' entry immediately preceding the resolved end date, matching 1W's own curve/bestN in this fixture's sparse calendar", async () => {
    const store = await run();

    const oneDay = parseSp500Prefix(store, "1D");
    const oneWeek = parseSp500Prefix(store, "1W");

    // D_1W is the common date immediately preceding D_END in this
    // fixture's own sparse 7-date calendar (see this file's own header
    // comment) -- so "1D"'s backward lookup and "1W"'s forward-snapped
    // nominal start land on the exact same real startDate here, and
    // therefore compute an identical curve/bestN/benchmark. This is a
    // coincidence of this fixture's coarse dates, not a claim that 1D
    // and 1W mean the same thing -- the dedicated fixture in the next
    // test exercises the backward lookup on its own, realistic terms.
    expect(oneDay.startDate).toBe(D_1W);
    expect(oneDay.dataAsOf).toBe(D_END);
    expect(oneDay.endDate).toBe(D_END);
    expect(oneDay.truncated).toBe(false);
    expect(oneDay.bestN).toBe(oneWeek.bestN);
    expect(oneDay.curve).toEqual(oneWeek.curve);
    expect(oneDay.benchmark).toEqual(oneWeek.benchmark);
  });

  it("resolves the true previous trading day when the nominal 1-day-back date is a weekend, instead of collapsing to a zero-width window (regression, issue #238)", async () => {
    // FRI is the real previous trading day; SAT/SUN (the nominal "1
    // calendar day before asOf") have no data at all, reproducing the
    // exact "yesterday is a weekend" case issue #238's own acceptance
    // criteria calls out. Before the backward-lookup fix, forward-
    // snapping this nominal start would have walked forward past the
    // gap and landed on MON itself, collapsing "1D" to a zero-width
    // (startDate === endDate) window instead of a real 1-trading-day one.
    const FRI = "2024-06-14";
    const MON = "2024-06-17";
    const asOf = new Date("2024-06-17T00:00:00Z");

    const dailyFixture = new Map<string, DailyClose[]>([
      [
        "NVDA",
        [
          { date: FRI, close: 100 },
          { date: MON, close: 110 }, // +10%
        ],
      ],
      [
        "AAPL",
        [
          { date: FRI, close: 200 },
          { date: MON, close: 180 }, // -10%
        ],
      ],
      [
        "MSFT",
        [
          { date: FRI, close: 50 },
          { date: MON, close: 55 }, // +10%
        ],
      ],
      [
        "SPY",
        [
          { date: FRI, close: 100 },
          { date: MON, close: 105 }, // +5%
        ],
      ],
    ]);
    const intradayFixture = new Map<string, IntradayBar[]>(
      TICKERS.map((symbol) => [
        symbol,
        [
          { date: `${MON}T09:30:00`, close: 100 },
          { date: `${MON}T10:30:00`, close: 101 },
        ],
      ]),
    );

    const store = memoryStore();
    await runPipeline({
      tickers: TICKERS,
      fetchDailyCloses: async (symbol) => dailyFixture.get(symbol) ?? [],
      fetchIntradayBars: async (symbol) => intradayFixture.get(symbol) ?? [],
      fetchFiveMinuteBars: noIntradayData,
      fetchIntraday1mBars: noIntradayData,
      store,
      asOf,
    });

    const oneDay = parseSp500Prefix(store, "1D");

    // Not collapsed to zero width -- the real previous trading day (FRI),
    // not MON itself.
    expect(oneDay.startDate).toBe(FRI);
    expect(oneDay.startDate).not.toBe(oneDay.dataAsOf);
    expect(oneDay.dataAsOf).toBe(MON);
    expect(oneDay.endDate).toBe(MON);
    expect(oneDay.truncated).toBe(false);

    // N=1 (NVDA alone, real S&P 500 rank #1 by weight): a real,
    // hand-computed +10% return, not a degenerate 1.0 (which a
    // collapsed FRI/FRI or MON/MON window would have produced instead).
    expect(oneDay.curve[0]).toMatchObject({ n: 1, portfolioReturn: 1.1 });

    // The SPY benchmark resolves the exact same real FRI -> MON window,
    // for the identical reason (see buildSp500PrefixResults' own "1D"
    // branch, which computes it directly rather than reusing
    // benchmarksByRange's nominal-start-based entries) -- also not
    // collapsed to zero width.
    expect(oneDay.benchmark).not.toBeNull();
    expect(oneDay.benchmark!.startDate).toBe(FRI);
    expect(oneDay.benchmark!.endDate).toBe(MON);
    expect(oneDay.benchmark!.endingBalance).toBeCloseTo(20 * 1.05, 8);
  });

  it("keeps the SPY benchmark's own truncated flag in agreement with the top-level one in the defensive zero-width fallback (regression, code review finding)", async () => {
    // Only ONE majority-shared trading date exists at all -- every
    // ticker (NVDA/AAPL/MSFT/SPY) has exactly one close, all on the
    // same date, so resolveOneDayBoundary's own defensive fallback
    // (fewer than two common dates) fires: startDate collapses to
    // commonEndDate, a genuine zero-width window, and the top-level
    // `truncated` is correctly `true`. Before this fix, the SPY
    // benchmark computed against that same zero-width pair derived its
    // own `truncated` independently via computeBenchmark's ordinary
    // "nearest point in [start, end]" logic, which has no way to detect
    // a *zero-width* range as truncated on its own (SPY still has a
    // real close on that single date) -- so `benchmark.truncated` came
    // back `false`, silently disagreeing with the top-level flag. A
    // reader that only checks `benchmark.truncated` would miss the
    // warning entirely.
    const ONLY_DATE = "2024-06-17";
    const asOf = new Date("2024-06-17T00:00:00Z");

    const dailyFixture = new Map<string, DailyClose[]>([
      ["NVDA", [{ date: ONLY_DATE, close: 100 }]],
      ["AAPL", [{ date: ONLY_DATE, close: 200 }]],
      ["MSFT", [{ date: ONLY_DATE, close: 50 }]],
      ["SPY", [{ date: ONLY_DATE, close: 100 }]],
    ]);
    const intradayFixture = new Map<string, IntradayBar[]>(
      TICKERS.map((symbol) => [
        symbol,
        [
          { date: `${ONLY_DATE}T09:30:00`, close: 100 },
          { date: `${ONLY_DATE}T10:30:00`, close: 101 },
        ],
      ]),
    );

    const store = memoryStore();
    await runPipeline({
      tickers: TICKERS,
      fetchDailyCloses: async (symbol) => dailyFixture.get(symbol) ?? [],
      fetchIntradayBars: async (symbol) => intradayFixture.get(symbol) ?? [],
      fetchFiveMinuteBars: noIntradayData,
      fetchIntraday1mBars: noIntradayData,
      store,
      asOf,
    });

    const oneDay = parseSp500Prefix(store, "1D");

    // The genuine zero-width collapse: only one common date exists, so
    // startDate === dataAsOf === endDate, and the top-level flag says so.
    expect(oneDay.startDate).toBe(ONLY_DATE);
    expect(oneDay.startDate).toBe(oneDay.dataAsOf);
    expect(oneDay.truncated).toBe(true);
    // A same-day ratio is exactly 1.0 -- confirms this really is the
    // degenerate zero-width case, not a real 1-day comparison.
    expect(oneDay.curve[0]).toMatchObject({ n: 1, portfolioReturn: 1 });

    // The fix under test: benchmark.truncated agrees with the top-level
    // flag for this same degenerate window, not independently false.
    expect(oneDay.benchmark).not.toBeNull();
    expect(oneDay.benchmark!.startDate).toBe(ONLY_DATE);
    expect(oneDay.benchmark!.endDate).toBe(ONLY_DATE);
    expect(oneDay.benchmark!.truncated).toBe(true);
  });
});
