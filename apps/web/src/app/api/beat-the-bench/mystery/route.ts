// GET /api/beat-the-bench/mystery (issue #132) -- serves one randomly
// chosen session from the nightly pipeline's Mystery Day pool (issue
// #127's `results/beat-the-bench/pool/{id}.json` objects, picked via
// `results/beat-the-bench/pool/index.json`).
//
// **This route can never leak the answer**: a MysterySession carries no
// date field at all and its bars are labelled by time of day only, a
// contract the pipeline enforces mechanically at write time by scanning
// the serialized payload for any date-shaped substring
// (`validateMysterySession`). The real date lives in exactly one object,
// and only ../mystery/reveal/route.ts reads it.
//
// See getMysterySessionResponse (../../../../lib/results-api.ts) for the
// response logic, factored out there so it's unit-testable with a mocked
// reader and a pinned random pick instead of a real S3Client.

import { createResultReader } from "@/lib/create-result-reader";
import { getMysterySessionResponse } from "@/lib/results-api";

// Always runs at request time -- doubly so here: the response is a random
// pick, so a cached or statically-generated one would hand every player
// the same "mystery" day. The handler's own response also sets
// `Cache-Control: no-store` for the same reason.
export const dynamic = "force-dynamic";

// Built once per warm process and reused across requests, via the same
// shared ../../../../lib/create-result-reader.ts every other
// results-reading route calls, so this route's reader precedence
// (including the LOCAL_RESULTS_DIR dev-only escape hatch) can't drift
// from theirs.
const reader = createResultReader();

export async function GET(): Promise<Response> {
  return getMysterySessionResponse(reader);
}
