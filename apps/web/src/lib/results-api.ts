// Core logic for GET /api/results?range=... , factored out of the route
// handler (see ../app/api/results/route.ts) so it can be unit tested with
// a mocked ResultReader instead of a real S3Client or a full Next.js
// request/response cycle.

import {
  PRESET_RANGES,
  resultKey,
  RESULTS_SCHEMA_VERSION,
  type PrecomputedResult,
  type PresetRange,
} from "@hadiknowntrades/core";

/**
 * Minimal interface for reading a precomputed result's raw JSON body by
 * its S3 key. Implemented by S3ResultReader (see s3-result-reader.ts) for
 * production, and by a hand-rolled mock in tests.
 */
export interface ResultReader {
  /** Returns the object's raw body as a string, or null if the key doesn't exist. */
  getObject(key: string): Promise<string | null>;
}

/**
 * Every error code this route can emit, as a single source of truth --
 * see the `errorResponse(...)` calls below. Client code (use-results.ts,
 * ResultsPanel.tsx) imports this instead of typing the error field as a
 * bare `string`, so renaming or removing a code here is a compile error
 * at every call site that still switches on the old name, instead of a
 * silently-unreachable UI branch.
 */
export type ApiErrorCode =
  | "invalid_range"
  | "server_misconfigured"
  | "upstream_error"
  | "not_found"
  | "corrupt_data"
  | "schema_mismatch";

// Data only changes on the nightly pipeline run, so it's safe for
// browsers and any CDN in front of this route to reuse a response for a
// while without re-checking -- but short enough that a same-day rerun of
// the pipeline (e.g. a manual fix) shows up reasonably quickly, and with
// stale-while-revalidate so a cache doesn't serve indefinitely-stale data
// if the origin is briefly unreachable past max-age.
const CACHE_CONTROL = "public, max-age=300, s-maxage=300, stale-while-revalidate=3600";

function errorResponse(status: number, error: ApiErrorCode, message: string): Response {
  // Explicit no-store so an intermediate cache never applies heuristic
  // freshness to an error -- 404 in particular is heuristically
  // cacheable by default per RFC 7231 section 6.1, which would otherwise risk
  // a stale "not published yet" response outliving the real data.
  return Response.json({ error, message }, { status, headers: { "Cache-Control": "no-store" } });
}

/** Case-insensitively matches a raw query-string value against PRESET_RANGES, or returns null if it doesn't match any of them. */
export function parseRange(raw: string | null): PresetRange | null {
  if (!raw) return null;
  const upper = raw.toUpperCase();
  return (PRESET_RANGES as readonly string[]).includes(upper) ? (upper as PresetRange) : null;
}

/**
 * Exact-case membership check against PRESET_RANGES -- deliberately
 * *not* case-folding the way `parseRange` does for a query-string value.
 *
 * This exists for validating a raw dynamic *route segment* (see
 * ../app/api/og/[range]/route.tsx), not a query parameter: Next's Full
 * Route Cache caches a `force-static` route handler's response per
 * distinct path string, so a case-insensitive match there would still
 * let every case variant of a valid range (`/api/og/max`, `/api/og/Max`,
 * `/api/og/MAX`, ...) resolve to equivalent content while each getting
 * its own separate 24h-cached entry and its own separate render -- the
 * exact duplicate-work bug this function exists to close. A query
 * string, by contrast, is never part of a cached path segment, so
 * `parseRange`'s case-insensitivity there is harmless and stays as-is.
 */
export function isCanonicalRange(raw: string): raw is PresetRange {
  return (PRESET_RANGES as readonly string[]).includes(raw);
}

/**
 * Handles GET /api/results?range=... : validates the range, reads the
 * corresponding precomputed result via `reader`, and returns it as JSON
 * with caching headers -- or a clear JSON error response (with an
 * appropriate status code) for an invalid range, missing bucket
 * configuration, a not-yet-published range, or an unreadable/corrupt
 * stored object.
 */
export async function getResultsResponse(
  rawRange: string | null,
  reader: ResultReader | null,
): Promise<Response> {
  const range = parseRange(rawRange);
  if (!range) {
    return errorResponse(
      400,
      "invalid_range",
      `Unsupported or missing "range" query parameter. Expected one of: ${PRESET_RANGES.join(", ")} (case-insensitive). Received: ${rawRange ?? "(none)"}.`,
    );
  }

  if (!reader) {
    console.error("[api/results] RESULTS_BUCKET environment variable is not set");
    return errorResponse(500, "server_misconfigured", "Results storage is not configured.");
  }

  let raw: string | null;
  try {
    raw = await reader.getObject(resultKey(range));
  } catch (error) {
    console.error(`[api/results] failed to read results for range ${range}:`, error);
    return errorResponse(502, "upstream_error", "Failed to read precomputed results.");
  }

  if (raw === null) {
    return errorResponse(
      404,
      "not_found",
      `No precomputed results are available yet for range "${range}".`,
    );
  }

  let result: PrecomputedResult;
  try {
    result = JSON.parse(raw) as PrecomputedResult;
  } catch (error) {
    console.error(`[api/results] stored result for range ${range} is not valid JSON:`, error);
    return errorResponse(502, "corrupt_data", "Stored results could not be parsed.");
  }

  // apps/pipeline (writer) and this API (reader) are independently
  // deployable -- a schema bump on one side without the other must not
  // silently serve a shape this reader doesn't understand.
  if (result.schemaVersion !== RESULTS_SCHEMA_VERSION) {
    console.error(
      `[api/results] stored result for range ${range} has schemaVersion ${String(result.schemaVersion)}, expected ${RESULTS_SCHEMA_VERSION}`,
    );
    return errorResponse(502, "schema_mismatch", "Stored results are in an unrecognized format.");
  }

  // Since issue #28, PrecomputedResult is a discriminated union on
  // `model` ("window" | "intraday-daily") -- schemaVersion alone
  // doesn't guarantee this field is one of those two values. A stored
  // object with a corrupted/wrong `model` (e.g. a partial write --
  // apps/pipeline's own writes are explicitly documented as non-atomic)
  // would otherwise pass this check silently and go on to crash the UI
  // with a raw TypeError (e.g. `data.trades` undefined) instead of
  // failing cleanly the same way a schemaVersion mismatch already does.
  if (result.model !== "window" && result.model !== "intraday-daily") {
    console.error(
      `[api/results] stored result for range ${range} has an unrecognized model ${JSON.stringify((result as { model?: unknown }).model)}`,
    );
    return errorResponse(502, "schema_mismatch", "Stored results are in an unrecognized format.");
  }

  return Response.json(result, {
    headers: { "Cache-Control": CACHE_CONTROL },
  });
}
