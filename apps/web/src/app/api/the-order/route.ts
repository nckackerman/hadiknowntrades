// GET /api/the-order (issue #207) -- serves the nightly pipeline's daily
// Order puzzle (packages/core's TheOrderPuzzle, written to
// results/the-order.json by apps/pipeline's own buildTheOrderPuzzle),
// so TheOrder.tsx can play it.
//
// A dedicated route rather than another branch on /api/results, same
// reasoning as ../beat-the-bench/route.ts: no identifier to parse (one
// fixed key), and a shape that isn't a `model`-discriminated result at
// all. See getTheOrderResponse (../../../lib/results-api.ts) for the
// response logic.

import { createResultReader } from "@/lib/create-result-reader";
import { getTheOrderResponse } from "@/lib/results-api";

// Always runs at request time -- same convention as ../results/route.ts,
// ../custom-anchors/route.ts, and ../beat-the-bench/route.ts.
export const dynamic = "force-dynamic";

// Built once per warm process, via the same shared
// ../../../lib/create-result-reader.ts every other results-reading route
// calls, so this route's reader precedence (including the
// LOCAL_RESULTS_DIR dev-only escape hatch) can't drift from theirs.
const reader = createResultReader();

export async function GET(): Promise<Response> {
  return getTheOrderResponse(reader);
}
