// GET /api/results?range=1M|3M|1Y|5Y|MAX (case-insensitive) -- serves the
// nightly pipeline's precomputed trade sequence + summary for the
// requested preset range, straight from S3, with no recomputation at
// request time. See ../../../lib/results-api.ts for the response logic
// (factored out there so it's unit-testable without a real S3Client or
// NextRequest) and ../../../lib/s3-result-reader.ts for the S3 read.

import type { NextRequest } from "next/server";

import { getResultsResponse } from "@/lib/results-api";
import { S3ResultReader } from "@/lib/s3-result-reader";

// Always runs at request time: it reads live from S3 (not through
// Next's own `fetch` cache), and the Cache-Control header set in
// results-api.ts is what downstream caches should rely on -- not any of
// Next's own build-time static optimization.
export const dynamic = "force-dynamic";

// Built once per warm process and reused across requests, not
// reconstructed on every GET -- an S3Client resolves its credential
// provider chain and opens its own connection pool at construction time,
// so a fresh one per request would throw away keep-alive reuse for no
// benefit on a bucket name that never changes at runtime.
const bucket = process.env.RESULTS_BUCKET;
const reader = bucket ? new S3ResultReader(bucket) : null;

export async function GET(request: NextRequest): Promise<Response> {
  return getResultsResponse(request.nextUrl.searchParams.get("range"), reader);
}
