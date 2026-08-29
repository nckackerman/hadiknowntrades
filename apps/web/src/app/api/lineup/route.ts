// GET /api/lineup (issue #208) -- serves the nightly pipeline's most
// recently published Lineup selection (packages/core's LineupResult,
// written to results/lineup/latest.json by apps/pipeline's
// buildLineupResult), so TheLineup.tsx can play a real, checkable daily
// puzzle.
//
// A dedicated route rather than another branch on /api/results: like
// ../beat-the-bench/route.ts and ../custom-anchors/route.ts, this has no
// identifier to parse (one fixed key, not one object per request) and
// returns a shape that isn't a `model`-discriminated PrecomputedResult at
// all. See getLineupResponse (../../../lib/results-api.ts) for the
// response logic, factored out there so it's unit-testable without a
// real S3Client.

import { createResultReader } from "@/lib/create-result-reader";
import { getLineupResponse } from "@/lib/results-api";

// Always runs at request time: it reads live from S3 (not through Next's
// own `fetch` cache), and the Cache-Control header set in results-api.ts
// is what downstream caches should rely on. Same convention as
// ../results/route.ts, ../custom-anchors/route.ts, and
// ../beat-the-bench/route.ts.
export const dynamic = "force-dynamic";

// Built once per warm process and reused across requests, via the same
// shared ../../../lib/create-result-reader.ts every other results-reading
// route calls -- so this route's reader precedence (including the
// LOCAL_RESULTS_DIR dev-only escape hatch) can't drift from theirs. See
// apps/web/CLAUDE.md's issue #134 notes for why this matters (a route
// that built its own reader instead of reusing this once broke local dev
// entirely).
const reader = createResultReader();

export async function GET(): Promise<Response> {
  return getLineupResponse(reader);
}
