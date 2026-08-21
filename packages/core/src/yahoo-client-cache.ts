// Dev-only file cache for the Yahoo client, so iterating locally (or
// running the optimizer against real data repeatedly) doesn't repeatedly
// hit Yahoo for the same symbol/range. Not used in the actual nightly
// pipeline run — each Lambda invocation is ephemeral anyway, and the
// pipeline should always fetch fresh data. Not exported from the
// package's main entry point for that reason — import it directly:
// `import { fetchDailyClosesCached } from "@hadiknowntrades/core/src/yahoo-client-cache.js"`.
//
// Caveat: the cache key is derived from (symbol, from, to) only, not
// which `fetchImpl` produced the data. If you pass a custom `fetchImpl`
// (e.g. a mock in a test or debug script), also pass a distinct
// `cacheDir` — otherwise mock data can get written to (or read from) the
// same cache files a real fetch would use.

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { fetchDailyCloses, type DailyClose } from "./yahoo-client.js";

// Resolved relative to this module's own location, not process.cwd() —
// otherwise the "shared" dev cache silently fragments into a different
// directory depending on where a script happens to be run from.
const DEFAULT_CACHE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", ".cache", "yahoo");

// Dedupes concurrent in-flight requests for the same key within this
// process, so e.g. two concurrent callers for the same symbol/range both
// see the cache miss but only one of them actually hits the network.
const inFlight = new Map<string, Promise<DailyClose[]>>();

function cacheKey(symbol: string, from: Date, to: Date): string {
  const raw = `${symbol}:${from.toISOString()}:${to.toISOString()}`;
  return createHash("sha256").update(raw).digest("hex");
}

function isValidCachedShape(value: unknown): value is DailyClose[] {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as Record<string, unknown>).date === "string" &&
        typeof (entry as Record<string, unknown>).close === "number",
    )
  );
}

async function readCache(cacheFile: string): Promise<DailyClose[] | null> {
  let raw: string;
  try {
    raw = await readFile(cacheFile, "utf-8");
  } catch {
    return null; // cache miss: file doesn't exist (or isn't readable)
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn(`[yahoo-client-cache] ignoring corrupt cache file: ${cacheFile}`);
    return null;
  }

  if (!isValidCachedShape(parsed)) {
    console.warn(`[yahoo-client-cache] ignoring cache file with unexpected shape: ${cacheFile}`);
    return null;
  }

  return parsed;
}

async function writeCache(
  cacheDir: string,
  cacheFile: string,
  result: DailyClose[],
): Promise<void> {
  try {
    await mkdir(cacheDir, { recursive: true });
    await writeFile(cacheFile, JSON.stringify(result), "utf-8");
  } catch (error) {
    // A cache write failure shouldn't lose an already-successfully-fetched
    // result — just skip caching this once and log why.
    console.warn(`[yahoo-client-cache] failed to write ${cacheFile}:`, error);
  }
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
  const dedupeKey = cacheFile;

  const existingInFlight = inFlight.get(dedupeKey);
  if (existingInFlight) return existingInFlight;

  const promise = (async () => {
    const cached = await readCache(cacheFile);
    if (cached) return cached;

    const result = await fetchDailyCloses(symbol, from, to, options);
    await writeCache(cacheDir, cacheFile, result);
    return result;
  })();

  inFlight.set(dedupeKey, promise);
  try {
    return await promise;
  } finally {
    inFlight.delete(dedupeKey);
  }
}
