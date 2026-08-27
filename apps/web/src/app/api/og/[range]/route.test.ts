// @vitest-environment node
//
// Node, not this project's default jsdom (see vitest.config.mts's own
// comment): the end-to-end block below renders a real card through
// `next/og`, whose PNG rasterization (resvg, WASM-based) fails outright
// with "Unsupported input" under jsdom -- something about jsdom's
// globals confuses it. Plain node has no such issue. Nothing in this
// file needs a DOM, so the whole file takes the node environment rather
// than splitting the render test into a second file.
//
// Two kinds of coverage here:
//   - The route's own early-rejection guard (issue #33 follow-up, found
//     in code review -- see route.tsx's own header comment). Those tests
//     run with no reader configured at all, so a *canonical* range falls
//     through to `getResultsResponse`'s own "no reader configured" 500 --
//     enough to confirm canonical ranges reach that point (i.e. pass the
//     guard) while non-canonical ones are rejected before it.
//   - A real fetch-validate-render pass (issue #134), driving the whole
//     route against real precomputed-shape JSON on disk via the same
//     `LOCAL_RESULTS_DIR`/`LocalFileResultReader` path `next dev` uses
//     locally (see apps/web/CLAUDE.md's "Local development without AWS
//     credentials"). The route builds its reader once at module load, so
//     these tests set the env var and then `vi.resetModules()` +
//     re-import the route rather than sharing the top-level import.

import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { IntradayDayResult, IntradayResult, WindowResult } from "@hadiknowntrades/core";
import { PRESET_RANGES, RESULTS_SCHEMA_VERSION, resultKey } from "@hadiknowntrades/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GET } from "./route";

function request(range: string): Promise<Response> {
  return GET(new Request("http://localhost/api/og/" + range), {
    params: Promise.resolve({ range }),
  });
}

describe("GET /api/og/[range]", () => {
  it("rejects a lowercase case variant of a valid range with 404, before doing any rendering work", async () => {
    const response = await request("max");

    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = await response.text();
    expect(body).toContain("max");
  });

  it("rejects mixed-case variants of every valid range", async () => {
    for (const range of PRESET_RANGES) {
      const response = await request(range.toLowerCase());
      expect(response.status).toBe(404);
    }
  });

  it("rejects an arbitrary/garbage range with 404 and no-store", async () => {
    const response = await request("not-a-range");

    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = await response.text();
    expect(body).toContain("not-a-range");
  });

  it("lets every exact-case canonical range past the guard (reaches getResultsResponse, not the guard's own 404)", async () => {
    for (const range of PRESET_RANGES) {
      const response = await request(range);
      // No reader configured in this test process (no RESULTS_BUCKET, no
      // LOCAL_RESULTS_DIR) -- getResultsResponse's own "server not
      // configured" 500 (surfaced here as this route's own plain-text
      // error body, see route.tsx's own re-wrapping) is proof this
      // request passed the guard rather than being rejected by it, which
      // would be a 404 instead.
      expect(response.status).toBe(500);
      const body = await response.text();
      expect(body).toContain("not configured");
    }
  });
});

function intradayDay(
  date: string,
  startingCapital: number,
  endingBalance: number,
): IntradayDayResult {
  return {
    date,
    startingCapital,
    endingBalance,
    barIntervalMinutes: 60,
    trades: [
      {
        ticker: "AAPL",
        direction: "long",
        date,
        openTime: "09:30:00",
        openPrice: 100,
        closeTime: "15:30:00",
        closePrice: (100 * endingBalance) / startingCapital,
      },
    ],
    worstCase: { startingCapital, endingBalance: startingCapital / 2, trades: [] },
    longShort: {
      startingCapital,
      endingBalance: endingBalance * 1.1,
      trades: [],
      worstCase: { startingCapital, endingBalance: startingCapital / 4, trades: [] },
    },
  };
}

/** A real, current-schema 1W intraday-daily result: $20 chained across three real trading days to $41.00. */
function intradayResultFixture(days: IntradayDayResult[]): IntradayResult {
  return {
    schemaVersion: RESULTS_SCHEMA_VERSION,
    model: "intraday-daily",
    range: "1W",
    generatedAt: "2026-08-21T00:00:00.000Z",
    dataAsOf: "2026-08-20",
    endDate: "2026-08-21",
    maxTradesPerDay: 3,
    startingCapital: 20,
    universeSize: 503,
    skippedTickers: [],
    benchmark: null,
    days,
  };
}

function windowResultFixture(): WindowResult {
  return {
    schemaVersion: RESULTS_SCHEMA_VERSION,
    model: "window",
    range: "MAX",
    generatedAt: "2026-08-21T00:00:00.000Z",
    dataAsOf: "2026-08-20",
    startDate: null,
    endDate: "2026-08-21",
    maxTrades: 3,
    startingCapital: 20,
    endingBalance: 48_203,
    trades: [],
    worstCase: { endingBalance: 20, trades: [] },
    longShort: { endingBalance: 48_203, trades: [], worstCase: { endingBalance: 20, trades: [] } },
    universeSize: 503,
    skippedTickers: [],
    benchmark: null,
  };
}

describe("GET /api/og/[range] against real stored results (issue #134)", () => {
  afterEach(() => {
    delete process.env.LOCAL_RESULTS_DIR;
    vi.resetModules();
  });

  /**
   * Writes each result to a fresh temp dir under the same
   * `results/{RANGE}.json` key layout a real bucket uses, points
   * LOCAL_RESULTS_DIR at it, and re-imports the route so its
   * module-scope reader picks that directory up.
   */
  async function routeReading(
    results: readonly (IntradayResult | WindowResult)[],
  ): Promise<(range: string) => Promise<Response>> {
    const dir = await mkdtemp(path.join(tmpdir(), "og-card-route-"));
    for (const result of results) {
      const key = resultKey(result.range);
      await mkdir(path.join(dir, path.dirname(key)), { recursive: true });
      await writeFile(path.join(dir, key), JSON.stringify(result), "utf-8");
    }
    process.env.LOCAL_RESULTS_DIR = dir;
    vi.resetModules();
    const { GET: freshGet } = await import("./route");
    return (range: string) =>
      freshGet(new Request("http://localhost/api/og/" + range), {
        params: Promise.resolve({ range }),
      });
  }

  it("renders a real PNG card for an intraday-daily range, end to end", async () => {
    const get = await routeReading([
      intradayResultFixture([
        intradayDay("2026-08-17", 20, 25),
        intradayDay("2026-08-18", 25, 30),
        intradayDay("2026-08-19", 30, 41),
      ]),
    ]);

    const response = await get("1W");

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/png");
    // A real rasterized PNG, not just a non-empty body: the first eight
    // bytes are the PNG signature.
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(Array.from(bytes.slice(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(bytes.byteLength).toBeGreaterThan(1000);
  });

  it("still renders a window-model range's card, unchanged", async () => {
    const get = await routeReading([windowResultFixture()]);

    const response = await get("MAX");

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/png");
  });

  it("404s an intraday-daily range whose stored result has no trading days", async () => {
    const get = await routeReading([intradayResultFixture([])]);

    const response = await get("1W");

    expect(response.status).toBe(404);
    expect(await response.text()).toContain("no result to headline");
  });

  it("404s a range the pipeline hasn't published yet", async () => {
    const get = await routeReading([intradayResultFixture([intradayDay("2026-08-19", 20, 41)])]);

    const response = await get("3M");

    expect(response.status).toBe(404);
  });
});
