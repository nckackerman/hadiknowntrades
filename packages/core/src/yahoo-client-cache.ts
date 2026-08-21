// Dev-only file cache for the Yahoo client, so iterating locally (or
// running the optimizer against real data repeatedly) doesn't repeatedly
// hit Yahoo for the same symbol/range. Not used in the actual nightly
// pipeline run — each Lambda invocation is ephemeral anyway, and the
// pipeline should always fetch fresh data.

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { fetchDailyCloses, type DailyClose } from "./yahoo-client.js";

const DEFAULT_CACHE_DIR = ".cache/yahoo";

function cacheKey(symbol: string, from: Date, to: Date): string {
  const raw = `${symbol}:${from.toISOString()}:${to.toISOString()}`;
  return createHash("sha256").update(raw).digest("hex");
}

/**
 * Same contract as fetchDailyCloses, but reads/writes a local JSON cache
 * file first. Intended for local development only.
 */
export async function fetchDailyClosesCached(
  symbol: string,
  from: Date,
  to: Date,
  options: { fetchImpl?: typeof fetch; cacheDir?: string } = {},
): Promise<DailyClose[]> {
  const cacheDir = options.cacheDir ?? DEFAULT_CACHE_DIR;
  const cacheFile = join(cacheDir, `${cacheKey(symbol, from, to)}.json`);

  try {
    const cached = await readFile(cacheFile, "utf-8");
    return JSON.parse(cached) as DailyClose[];
  } catch {
    // Cache miss (file doesn't exist, or is corrupt) — fetch fresh below.
  }

  const result = await fetchDailyCloses(symbol, from, to, options);

  await mkdir(cacheDir, { recursive: true });
  await writeFile(cacheFile, JSON.stringify(result), "utf-8");

  return result;
}
