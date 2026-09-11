// GET /api/sp500-prefix?range=... (issue #233) -- serves The Cut's
// per-range precomputed result (packages/core's Sp500PrefixResult,
// written to results/sp500-prefix/{RANGE}.json by apps/pipeline's own
// buildSp500PrefixResults, issue #232), so TheCut.tsx can play it.
//
// Same thin-route convention as ../results/route.ts/../the-order/route.ts:
// the real logic (parse the range, read+validate the S3 object, return it
// with caching headers or a clear error) lives in getSp500PrefixResponse
// (../../../lib/results-api.ts) so it can be unit tested with a mocked
// ResultReader instead of a real S3Client or a full Next.js request/
// response cycle.

import type { NextRequest } from "next/server";

import { createResultReader } from "@/lib/create-result-reader";
import { getSp500PrefixResponse } from "@/lib/results-api";

// Always runs at request time -- same convention as every other
// results-reading route in this app.
export const dynamic = "force-dynamic";

// Built once per warm process, via the same shared
// ../../../lib/create-result-reader.ts every other results-reading route
// calls, so this route's reader precedence (including the
// LOCAL_RESULTS_DIR dev-only escape hatch) can't drift from theirs.
const reader = createResultReader();

export async function GET(request: NextRequest): Promise<Response> {
  return getSp500PrefixResponse(request.nextUrl.searchParams.get("range"), reader);
}
