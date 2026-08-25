// GET /api/results?range=1M|3M|1Y|5Y|MAX (case-insensitive) -- serves the
// nightly pipeline's precomputed trade sequence + summary for the
// requested preset range, straight from S3, with no recomputation at
// request time. See ../../../lib/results-api.ts for the response logic
// (factored out there so it's unit-testable without a real S3Client or
// NextRequest) and ../../../lib/s3-result-reader.ts for the S3 read.
//
// GET /api/results?anchor=YYYY-MM-DD (issue #11's coarsened custom
// date-range feature, day-granularity anchors since issue #75) is the
// same route, branching on which query param is present -- both `range`
// and `anchor` share this one route/reader/caching setup rather than
// needing a second route file, since (unlike the live-compute design
// this issue's plan originally sketched) a custom anchor's result is
// precomputed nightly exactly like a preset range's, with the exact same
// S3-read-only backing logic and cache semantics -- see results-api.ts's
// getCustomResultsResponse. See ../custom-anchors/route.ts for the
// separate route that serves the anchors *manifest* (issue #75) --
// genuinely different from this route's job, since it has no identifier
// to resolve.

import type { NextRequest } from "next/server";

import { createResultReader } from "@/lib/create-result-reader";
import { getCustomResultsResponse, getResultsResponse } from "@/lib/results-api";

// Always runs at request time: it reads live from S3 (not through
// Next's own `fetch` cache), and the Cache-Control header set in
// results-api.ts is what downstream caches should rely on -- not any of
// Next's own build-time static optimization.
export const dynamic = "force-dynamic";

// Built once per warm process and reused across requests, not
// reconstructed on every GET -- an S3Client resolves its credential
// provider chain and opens its own connection pool at construction time,
// so a fresh one per request would throw away keep-alive reuse for no
// benefit on a bucket name that never changes at runtime. See
// ../../../lib/create-result-reader.ts for which reader this resolves
// to (including the LOCAL_RESULTS_DIR dev-only escape hatch) -- shared
// with ../custom-anchors/route.ts so the two routes can't drift on this
// precedence.
const reader = createResultReader();

export async function GET(request: NextRequest): Promise<Response> {
  const params = request.nextUrl.searchParams;
  const anchor = params.get("anchor");
  // `anchor`'s mere presence (not just a well-formed value) selects the
  // custom-range branch -- an invalid/malformed anchor still routes to
  // getCustomResultsResponse, which returns its own invalid_anchor 400,
  // rather than silently falling through to the range-based response.
  if (anchor !== null) {
    return getCustomResultsResponse(anchor, reader);
  }
  return getResultsResponse(params.get("range"), reader);
}
