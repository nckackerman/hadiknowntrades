// GET /api/custom-anchors (issue #75) -- serves the nightly pipeline's
// published list of valid custom-range start-date anchors (packages/core's
// CustomAnchorsManifest, written to results/custom/index.json), so
// apps/web's calendar-grid picker (CustomRangeSelector.tsx, via
// useCustomAnchors()) knows which specific real trading days it may
// offer. A dedicated route rather than a third branch on /api/results --
// see getCustomAnchorsResponse's own doc comment (../../../lib/results-api.ts)
// for why this has no identifier to parse and returns a genuinely
// different response shape than the range/anchor result routes.
//
// Day-granularity anchors are no longer computable client-side the way
// the old month scheme's were (customRangeAnchors(asOf) needed no real
// data) -- see packages/core/src/custom-range-anchors.ts's own doc
// comment. This route is what makes the published anchor list reachable
// from the browser at all.

import { createResultReader } from "@/lib/create-result-reader";
import { getCustomAnchorsResponse } from "@/lib/results-api";

// Always runs at request time: it reads live from S3 (not through Next's
// own `fetch` cache), and the Cache-Control header set in results-api.ts
// is what downstream caches should rely on -- not any of Next's own
// build-time static optimization. Same convention as ../results/route.ts.
export const dynamic = "force-dynamic";

// Built once per warm process and reused across requests, via the same
// shared ../../../lib/create-result-reader.ts both routes call -- keeps
// this route's reader precedence (including the LOCAL_RESULTS_DIR
// dev-only escape hatch) from silently drifting from ../results/route.ts's.
// Without this, the calendar picker always shows its "Start-date picker
// unavailable" fallback under local `next dev`, even when
// ../results/route.ts is serving real preset-range/custom-anchor data
// just fine off the same local directory.
const reader = createResultReader();

export async function GET(): Promise<Response> {
  return getCustomAnchorsResponse(reader);
}
