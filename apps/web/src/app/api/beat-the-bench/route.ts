// GET /api/beat-the-bench (issue #131) -- serves the nightly pipeline's
// Today's Close session (packages/core's TodaysCloseSession, written to
// results/beat-the-bench/today.json by issue #127), so BeatTheBench.tsx
// can play a real SPY trading day bar by bar.
//
// A dedicated route rather than another branch on /api/results: like
// ../custom-anchors/route.ts, this has no identifier to parse (one fixed
// key, not one object per request) and returns a shape that isn't a
// `model`-discriminated result at all. See getTodaysCloseSessionResponse
// (../../../lib/results-api.ts) for the response logic, factored out
// there so it's unit-testable without a real S3Client.
//
// Issue #127 published this object and deliberately stopped short of a
// read path; this route is that read path. Mystery Day's own pool/index
// objects (issue #132) are NOT served here -- that mode's settlement
// discipline (fetch the id -> date index only at Final Settlement) is
// its own issue's to design.

import { createResultReader } from "@/lib/create-result-reader";
import { getTodaysCloseSessionResponse } from "@/lib/results-api";

// Always runs at request time: it reads live from S3 (not through Next's
// own `fetch` cache), and the Cache-Control header set in results-api.ts
// is what downstream caches should rely on. Same convention as
// ../results/route.ts and ../custom-anchors/route.ts.
export const dynamic = "force-dynamic";

// Built once per warm process and reused across requests, via the same
// shared ../../../lib/create-result-reader.ts every other results-reading
// route calls -- so this route's reader precedence (including the
// LOCAL_RESULTS_DIR dev-only escape hatch) can't drift from theirs. The
// /api/og route learned that one the hard way; see apps/web/CLAUDE.md's
// issue #134 notes.
const reader = createResultReader();

export async function GET(): Promise<Response> {
  return getTodaysCloseSessionResponse(reader);
}
