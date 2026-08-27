// Core logic for GET /api/results?range=... , factored out of the route
// handler (see ../app/api/results/route.ts) so it can be unit tested with
// a mocked ResultReader instead of a real S3Client or a full Next.js
// request/response cycle.

import {
  anchorDateToDate,
  CUSTOM_ANCHORS_MANIFEST_KEY,
  PRESET_RANGES,
  resultKey,
  customResultKey,
  RESULTS_SCHEMA_VERSION,
  TODAYS_CLOSE_SESSION_KEY,
  type AnchorDate,
  type CustomAnchorsManifest,
  type CustomWindowResult,
  type PrecomputedResult,
  type PresetRange,
  type TodaysCloseSession,
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
  | "invalid_anchor"
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
 * Everything getPrecomputedResultResponse (below) needs to know to
 * differ between "a preset range's own PrecomputedResult" and "a custom
 * anchor's CustomWindowResult" -- see that function's own doc comment.
 */
interface ResultRouteConfig<TParsed> {
  /** Parses the raw query-string value into the well-formed identifier this route needs, or null if it isn't one. */
  parse: (raw: string | null) => TParsed | null;
  /** The 400 response for a missing/malformed identifier. */
  invalidError: { code: ApiErrorCode; message: (raw: string | null) => string };
  /** The S3 key to read for a well-formed, parsed identifier. */
  buildKey: (parsed: TParsed) => string;
  /** The 404 body's message for "well-formed, but nothing stored under that key yet." */
  notFoundMessage: (parsed: TParsed) => string;
  /** A short noun phrase identifying what was being read, embedded in every console.error call below (e.g. "result for range 1Y", "custom-range result for anchor 2019-03"). */
  logLabel: (parsed: TParsed) => string;
  /** Whether a successfully-parsed stored object's `model` field is one this result family actually produces. */
  isValidModel: (model: unknown) => boolean;
}

/** The outcome of `readCurrentSchemaObject` below -- either the successfully-read, schema-current object, or an already-built error `Response` the caller should return as-is. */
type StoredObjectOutcome =
  { ok: true; value: Record<string, unknown> } | { ok: false; response: Response };

/**
 * Shared "read raw body from `key`, JSON.parse it, and confirm it's a
 * non-null object at the current RESULTS_SCHEMA_VERSION" skeleton --
 * every stored-object route this file backs needs exactly these steps
 * (the reader-configured check, the `getObject` try/catch, the
 * `not_found` check, the `JSON.parse` try/catch, the object-shape
 * guard, the `schemaVersion` check), differing only in the log label
 * embedded in error messages and the 404 body's own `notFoundMessage`.
 *
 * **Factored out of `getPrecomputedResultResponse` (issue #75 code
 * review finding, fixed)**: `getCustomAnchorsResponse` (below) has no
 * identifier to parse and therefore can't reuse
 * `getPrecomputedResultResponse`'s own `ResultRouteConfig` abstraction
 * (which is built around "parse an identifier, then build a key from
 * it") -- before this extraction, it hand-typed a second copy of this
 * exact read/parse/validate sequence instead, the same class of
 * duplication `getPrecomputedResultResponse` itself already exists to
 * prevent between `getResultsResponse`/`getCustomResultsResponse` (see
 * that function's own doc comment). `getPrecomputedResultResponse` now
 * calls this too, rather than keeping its own now-redundant inline copy.
 *
 * Returns the parsed object as an untyped `Record<string, unknown>`,
 * not yet cast to any specific result shape -- callers still need their
 * own further checks (a `model` discriminant, or `Array.isArray(anchors)`)
 * before trusting it further; this function's job stops at "well-formed
 * object, current schema version."
 */
async function readCurrentSchemaObject(
  key: string,
  reader: ResultReader | null,
  label: string,
  notFoundMessage: string,
): Promise<StoredObjectOutcome> {
  if (!reader) {
    console.error("[api/results] RESULTS_BUCKET environment variable is not set");
    return {
      ok: false,
      response: errorResponse(500, "server_misconfigured", "Results storage is not configured."),
    };
  }

  let raw: string | null;
  try {
    raw = await reader.getObject(key);
  } catch (error) {
    console.error(`[api/results] failed to read ${label}:`, error);
    return {
      ok: false,
      response: errorResponse(502, "upstream_error", "Failed to read precomputed results."),
    };
  }

  if (raw === null) {
    return { ok: false, response: errorResponse(404, "not_found", notFoundMessage) };
  }

  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(raw);
  } catch (error) {
    console.error(`[api/results] stored ${label} is not valid JSON:`, error);
    return {
      ok: false,
      response: errorResponse(502, "corrupt_data", "Stored results could not be parsed."),
    };
  }

  // JSON.parse succeeds on plenty of shapes that aren't a usable result
  // object -- `null`, a bare number/string/boolean, or an array -- any of
  // which is a plausible shape for a partially-written S3 object (this
  // codebase's own docs note apps/pipeline's writes are non-atomic, see
  // packages/core/CLAUDE.md's write-time validation notes). Without this
  // check, a caller's own `result.schemaVersion` read below would throw
  // an uncaught TypeError for a `null` parse result (reading a property
  // off `null`) and escape this route as a raw, undocumented 500 instead
  // of the same 502 `corrupt_data` response every other malformed-data
  // path here returns.
  if (typeof parsedBody !== "object" || parsedBody === null) {
    console.error(`[api/results] stored ${label} did not parse to a JSON object`);
    return {
      ok: false,
      response: errorResponse(502, "corrupt_data", "Stored results could not be parsed."),
    };
  }
  const result = parsedBody as Record<string, unknown>;

  // apps/pipeline (writer) and this API (reader) are independently
  // deployable -- a schema bump on one side without the other must not
  // silently serve a shape this reader doesn't understand.
  if (result.schemaVersion !== RESULTS_SCHEMA_VERSION) {
    console.error(
      `[api/results] stored ${label} has schemaVersion ${String(result.schemaVersion)}, expected ${RESULTS_SCHEMA_VERSION}`,
    );
    return {
      ok: false,
      response: errorResponse(
        502,
        "schema_mismatch",
        "Stored results are in an unrecognized format.",
      ),
    };
  }

  return { ok: true, value: result };
}

/**
 * The shared request-handling skeleton behind both GET /api/results?range=
 * and GET /api/results?anchor=YYYY-MM-DD (issue #11's custom-range
 * feature): parse the identifier -> read+validate the object through
 * `readCurrentSchemaObject` above -> check the discriminant `model` ->
 * return it with the standard caching headers, or a clear JSON error
 * response (with an appropriate status code) at whichever step fails
 * first.
 *
 * **Extracted from what used to be two independent, near-identical
 * copies of this entire skeleton (code review finding, issue #11)**:
 * getResultsResponse and getCustomResultsResponse only ever differed in
 * which identifier they parse, which S3 key they build, and which
 * `model` value(s) they accept -- everything else (the reader-configured
 * check, the getObject try/catch, the JSON.parse try/catch, the
 * schemaVersion check, the Cache-Control response) was byte-for-byte the
 * same logic typed out twice. `getResultsResponse`/
 * `getCustomResultsResponse` below are now thin `ResultRouteConfig`
 * instantiations of this one function instead.
 */
async function getPrecomputedResultResponse<
  TParsed,
  TResult extends { schemaVersion: number; model: unknown },
>(
  rawParam: string | null,
  reader: ResultReader | null,
  config: ResultRouteConfig<TParsed>,
): Promise<Response> {
  const parsed = config.parse(rawParam);
  if (parsed === null) {
    return errorResponse(400, config.invalidError.code, config.invalidError.message(rawParam));
  }

  const outcome = await readCurrentSchemaObject(
    config.buildKey(parsed),
    reader,
    config.logLabel(parsed),
    config.notFoundMessage(parsed),
  );
  if (!outcome.ok) return outcome.response;
  const result = outcome.value as unknown as TResult;

  // A stored object with a corrupted/wrong `model` (e.g. a partial write
  // -- apps/pipeline's own writes are explicitly documented as
  // non-atomic) would otherwise pass the schemaVersion check silently
  // and go on to crash the UI with a raw TypeError (e.g. `data.trades`
  // undefined) instead of failing cleanly the same way a schemaVersion
  // mismatch already does.
  if (!config.isValidModel(result.model)) {
    console.error(
      `[api/results] stored ${config.logLabel(parsed)} has an unrecognized model ${JSON.stringify(result.model)}`,
    );
    return errorResponse(502, "schema_mismatch", "Stored results are in an unrecognized format.");
  }

  return Response.json(result, {
    headers: { "Cache-Control": CACHE_CONTROL },
  });
}

/**
 * Handles GET /api/results?range=... : validates the range, reads the
 * corresponding precomputed result via `reader`, and returns it as JSON
 * with caching headers -- or a clear JSON error response (with an
 * appropriate status code) for an invalid range, missing bucket
 * configuration, a not-yet-published range, or an unreadable/corrupt
 * stored object. See getPrecomputedResultResponse for the shared
 * mechanics this instantiates.
 */
export async function getResultsResponse(
  rawRange: string | null,
  reader: ResultReader | null,
): Promise<Response> {
  return getPrecomputedResultResponse<PresetRange, PrecomputedResult>(rawRange, reader, {
    parse: parseRange,
    invalidError: {
      code: "invalid_range",
      message: (raw) =>
        `Unsupported or missing "range" query parameter. Expected one of: ${PRESET_RANGES.join(", ")} (case-insensitive). Received: ${raw ?? "(none)"}.`,
    },
    buildKey: resultKey,
    notFoundMessage: (range) => `No precomputed results are available yet for range "${range}".`,
    logLabel: (range) => `result for range ${range}`,
    // Since issue #28, PrecomputedResult is a discriminated union on
    // `model` ("window" | "intraday-daily").
    isValidModel: (model) => model === "window" || model === "intraday-daily",
  });
}

/**
 * Parses a raw `anchor` query-string value into a well-formed AnchorDate
 * (YYYY-MM-DD, a real calendar day), or null if it isn't one -- reuses
 * packages/core's anchorDateToDate for the actual parse/range check
 * rather than re-deriving a second regex here, the same "one source of
 * truth" discipline parseRange/isCanonicalRange already follow for
 * PresetRange above.
 *
 * Deliberately does NOT also check the parsed anchor against the live
 * published anchors manifest -- see getCustomResultsResponse's own doc
 * comment for why: this route's server-side "now" and the pipeline's
 * own last-run "now" can disagree by up to one anchor right around a day
 * boundary, and re-validating against a live-read manifest here would
 * mean an extra S3 read on every single `?anchor=` request just to
 * duplicate a check `getPrecomputedResultResponse`'s own not_found path
 * already gives for free. A syntactically well-formed but never-computed
 * anchor (out of range, or just not published yet) is handled by that
 * ordinary not_found path instead, exactly like any preset range not yet
 * computed on a first-ever pipeline run.
 *
 * **Issue #75 renamed this from `parseAnchorMonth`** (YYYY-MM) to match
 * the day-granularity anchor scheme.
 */
export function parseAnchorDate(raw: string | null): AnchorDate | null {
  if (!raw) return null;
  return anchorDateToDate(raw) ? raw : null;
}

/**
 * Handles GET /api/results?anchor=YYYY-MM-DD (issue #11's coarsened
 * custom date-range feature, day-granularity anchors since issue #75) --
 * validates the anchor's *shape*, reads the corresponding precomputed
 * CustomWindowResult via `reader`, and returns it with the same caching
 * headers/error-response shape getResultsResponse already establishes
 * for `?range=`.
 *
 * Deliberately a sibling function, not a branch merged into
 * getResultsResponse itself: the two read genuinely different S3 key
 * families and result types (PrecomputedResult vs. CustomWindowResult).
 * Both are still called from the same route (../app/api/og/../route.ts
 * analog -- see ../app/api/results/route.ts), which is the layer that
 * decides which one applies to a given request, and both are thin
 * ResultRouteConfig instantiations of the same
 * getPrecomputedResultResponse mechanics -- see that function's own doc
 * comment for why (a real, code-review-caught duplication this replaced).
 */
export async function getCustomResultsResponse(
  rawAnchor: string | null,
  reader: ResultReader | null,
): Promise<Response> {
  return getPrecomputedResultResponse<AnchorDate, CustomWindowResult>(rawAnchor, reader, {
    parse: parseAnchorDate,
    invalidError: {
      code: "invalid_anchor",
      message: (raw) =>
        `Unsupported or missing "anchor" query parameter. Expected a YYYY-MM-DD date (e.g. "2019-03-15"). Received: ${raw ?? "(none)"}.`,
    },
    buildKey: customResultKey,
    notFoundMessage: (anchor) =>
      `No precomputed results are available for the custom start date "${anchor}" -- it may be outside the supported range, or not published yet.`,
    logLabel: (anchor) => `custom-range result for anchor ${anchor}`,
    isValidModel: (model) => model === "custom-window",
  });
}

/**
 * Handles GET /api/custom-anchors (issue #75) -- reads the published
 * anchors manifest (packages/core's CustomAnchorsManifest, written to
 * `CUSTOM_ANCHORS_MANIFEST_KEY` by apps/pipeline every nightly run
 * alongside every individual CustomWindowResult) and returns the full
 * manifest object for apps/web's calendar-grid picker
 * (CustomRangeSelector.tsx's useCustomAnchors hook) to consume.
 *
 * **Deliberately NOT a `ResultRouteConfig` instantiation of
 * getPrecomputedResultResponse above**, unlike getResultsResponse/
 * getCustomResultsResponse: this route has no identifier to parse (the
 * manifest lives at one fixed key, not one per request) and returns a
 * different shape entirely (a flat `CustomAnchorsManifest`, not a
 * `model`-discriminated result) -- forcing it through that abstraction
 * would mean stretching it to cover a case it wasn't designed for.
 * Still built on `readCurrentSchemaObject` above (the reader-configured
 * check, the getObject try/catch, the not_found check, the JSON.parse
 * try/catch, the schemaVersion check -- all genuinely shared with
 * getPrecomputedResultResponse, not a second copy of any of it) plus its
 * own `Array.isArray(anchors)` check, the one thing specific to this
 * shape.
 *
 * **Returns the full parsed object (`{ schemaVersion, anchors }`), not
 * a narrowed `{ anchors }` projection (issue #75 code review finding,
 * fixed)** -- the old `{ anchors: manifest.anchors }` response body
 * didn't actually match `CustomAnchorsManifest` (missing
 * `schemaVersion`), while `useCustomAnchors()` (`use-custom-anchors.ts`)
 * always typed the fetched payload as the full `CustomAnchorsManifest`
 * regardless -- nothing enforced the two stayed in sync, and every
 * existing test's own hand-built mock response happened to include
 * `schemaVersion` anyway, masking the mismatch. Returning the real
 * validated object as-is (it already passed the schemaVersion check
 * above) closes that gap directly, the same "return the real read
 * object" pattern getPrecomputedResultResponse already uses.
 *
 * Checks `schemaVersion` exact-equality (via `readCurrentSchemaObject`)
 * and `Array.isArray(anchors)` only -- a lighter check than
 * packages/core's own `validateCustomAnchorsManifest` (which
 * apps/pipeline already runs immediately before this exact object's own
 * `putObject`, issue #47's write-time discipline): a stored manifest
 * that already passed that validator once is trusted not to have been
 * corrupted in transit, the same trust level `getPrecomputedResultResponse`
 * gives every other stored result after its own schemaVersion/model
 * check.
 */
export async function getCustomAnchorsResponse(reader: ResultReader | null): Promise<Response> {
  const outcome = await readCurrentSchemaObject(
    CUSTOM_ANCHORS_MANIFEST_KEY,
    reader,
    "the anchors manifest",
    "No custom-range start dates are available yet -- the anchors manifest hasn't been published by a pipeline run.",
  );
  if (!outcome.ok) return outcome.response;
  const manifest = outcome.value;

  if (!Array.isArray(manifest.anchors)) {
    console.error("[api/custom-anchors] stored anchors manifest's anchors field isn't an array");
    return errorResponse(502, "schema_mismatch", "Stored results are in an unrecognized format.");
  }

  return Response.json(manifest as unknown as CustomAnchorsManifest, {
    headers: { "Cache-Control": CACHE_CONTROL },
  });
}

/**
 * Handles GET /api/beat-the-bench (issue #131) -- reads the nightly
 * pipeline's Today's Close session (packages/core's TodaysCloseSession,
 * written to TODAYS_CLOSE_SESSION_KEY by issue #127's
 * `buildBeatTheBenchSessions`) so `BeatTheBench.tsx` can play a real
 * SPY session bar by bar.
 *
 * **Issue #127 published this object with no way to read it** -- its own
 * report says so explicitly; building the read path is issue #131's job.
 * It is deliberately the same shape as `getCustomAnchorsResponse` above
 * rather than a new storage-reading idiom: one fixed key, no identifier
 * to parse, so it can't be a `ResultRouteConfig` instantiation of
 * `getPrecomputedResultResponse` (which is built around parsing an
 * identifier and building a key from it), but everything genuinely
 * shared -- the reader-configured check, the getObject try/catch, the
 * not_found check, the JSON.parse try/catch, the schemaVersion check --
 * still comes from `readCurrentSchemaObject`.
 *
 * Checks only that `bars` is a non-empty array on top of that, the same
 * light check `getCustomAnchorsResponse` applies to `anchors`: this
 * object already passed packages/core's own `validateTodaysCloseSession`
 * immediately before apps/pipeline stored it (issue #47's write-time
 * discipline). A non-empty array is still worth asserting here, since
 * the pipeline's writes are documented as non-atomic and a zero-bar
 * session would otherwise reach the client as a game with nothing to
 * play. `beat-the-bench.ts`'s own `isPlayableSession` is the client's
 * last guard beyond this.
 */
export async function getTodaysCloseSessionResponse(
  reader: ResultReader | null,
): Promise<Response> {
  const outcome = await readCurrentSchemaObject(
    TODAYS_CLOSE_SESSION_KEY,
    reader,
    "the Today's Close session",
    "No Beat the Bench session is available yet -- today's close hasn't been published by a pipeline run.",
  );
  if (!outcome.ok) return outcome.response;
  const session = outcome.value;

  if (!Array.isArray(session.bars) || session.bars.length === 0) {
    console.error("[api/beat-the-bench] stored Today's Close session has no usable bars");
    return errorResponse(502, "schema_mismatch", "Stored results are in an unrecognized format.");
  }

  return Response.json(session as unknown as TodaysCloseSession, {
    headers: { "Cache-Control": CACHE_CONTROL },
  });
}
