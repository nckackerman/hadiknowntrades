import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fetchDailyClosesCached } from "./yahoo-client-cache.js";
import type { DailyClose } from "./yahoo-client.js";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function validChartBody(): unknown {
  return {
    chart: {
      result: [
        {
          meta: { gmtoffset: -14400 },
          timestamp: [1704205800, 1704292200],
          indicators: {
            quote: [{ close: [100, 100] }],
            adjclose: [{ adjclose: [183.4, 182.03] }],
          },
        },
      ],
      error: null,
    },
  };
}

const EXPECTED: DailyClose[] = [
  { date: "2024-01-02", close: 183.4 },
  { date: "2024-01-03", close: 182.03 },
];

describe("fetchDailyClosesCached", () => {
  const from = new Date("2024-01-01T00:00:00Z");
  const to = new Date("2024-01-05T00:00:00Z");
  let cacheDir: string;

  beforeEach(async () => {
    cacheDir = await mkdtemp(join(tmpdir(), "yahoo-cache-test-"));
  });

  afterEach(async () => {
    await rm(cacheDir, { recursive: true, force: true });
  });

  it("fetches on a miss, then serves subsequent calls from the cache without refetching", async () => {
    const fetchImpl = vi
      .fn()
      .mockImplementation(() => Promise.resolve(jsonResponse(validChartBody())));

    const first = await fetchDailyClosesCached("AAPL", from, to, { fetchImpl, cacheDir });
    const second = await fetchDailyClosesCached("AAPL", from, to, { fetchImpl, cacheDir });

    expect(first).toEqual(EXPECTED);
    expect(second).toEqual(EXPECTED);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("hits the cache even when the caller constructs a fresh `to` Date each call (same calendar day)", async () => {
    // The natural "fetch through today" pattern for iterative local dev
    // — the whole reason this cache exists — constructs `to: new Date()`
    // fresh each call. Millisecond-precision keys would miss every time.
    const fetchImpl = vi
      .fn()
      .mockImplementation(() => Promise.resolve(jsonResponse(validChartBody())));

    const first = await fetchDailyClosesCached("AAPL", from, new Date(to.getTime()), {
      fetchImpl,
      cacheDir,
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await fetchDailyClosesCached("AAPL", from, new Date(to.getTime() + 5), {
      fetchImpl,
      cacheDir,
    });

    expect(first).toEqual(EXPECTED);
    expect(second).toEqual(EXPECTED);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("treats a corrupt cache file as a miss and refetches", async () => {
    const fetchImpl = vi
      .fn()
      .mockImplementation(() => Promise.resolve(jsonResponse(validChartBody())));
    await mkdir(cacheDir, { recursive: true });
    // Prime a garbage file at the exact path this call will hash to, by
    // fetching once for real first to learn the path, then corrupting it.
    await fetchDailyClosesCached("AAPL", from, to, { fetchImpl, cacheDir });
    const [cacheFile] = (await import("node:fs/promises").then((fs) => fs.readdir(cacheDir))).map(
      (name) => join(cacheDir, name),
    );
    if (!cacheFile) throw new Error("expected a cache file to have been written");
    await writeFile(cacheFile, "{not valid json", "utf-8");

    const result = await fetchDailyClosesCached("AAPL", from, to, { fetchImpl, cacheDir });

    expect(result).toEqual(EXPECTED);
    expect(fetchImpl).toHaveBeenCalledTimes(2); // once to prime, once after corruption
  });

  it("treats a validly-JSON but wrong-shaped cache file as a miss and refetches", async () => {
    const fetchImpl = vi
      .fn()
      .mockImplementation(() => Promise.resolve(jsonResponse(validChartBody())));
    await mkdir(cacheDir, { recursive: true });
    await fetchDailyClosesCached("AAPL", from, to, { fetchImpl, cacheDir });
    const files = await import("node:fs/promises").then((fs) => fs.readdir(cacheDir));
    const cacheFile = files[0] ? join(cacheDir, files[0]) : undefined;
    if (!cacheFile) throw new Error("expected a cache file to have been written");
    await writeFile(cacheFile, JSON.stringify({ not: "the right shape" }), "utf-8");

    const result = await fetchDailyClosesCached("AAPL", from, to, { fetchImpl, cacheDir });

    expect(result).toEqual(EXPECTED);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("still returns the fetched result even if the cache write fails", async () => {
    const fetchImpl = vi
      .fn()
      .mockImplementation(() => Promise.resolve(jsonResponse(validChartBody())));
    // A file (not a directory) at the cacheDir path makes mkdir(recursive) fail.
    const blockedCacheDir = join(cacheDir, "blocked");
    await writeFile(blockedCacheDir, "i am a file, not a directory", "utf-8");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await fetchDailyClosesCached("AAPL", from, to, {
      fetchImpl,
      cacheDir: blockedCacheDir,
    });

    expect(result).toEqual(EXPECTED);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("dedupes concurrent calls for the same symbol/range into a single fetch", async () => {
    let resolveFetch!: (value: Response) => void;
    const fetchImpl = vi.fn().mockReturnValue(
      new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      }),
    );

    const call1 = fetchDailyClosesCached("AAPL", from, to, { fetchImpl, cacheDir });
    const call2 = fetchDailyClosesCached("AAPL", from, to, { fetchImpl, cacheDir });

    resolveFetch(jsonResponse(validChartBody()));
    const [result1, result2] = await Promise.all([call1, call2]);

    expect(result1).toEqual(EXPECTED);
    expect(result2).toEqual(EXPECTED);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
