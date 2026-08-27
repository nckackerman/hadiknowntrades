// GET /api/beat-the-bench/mystery/reveal?id=sNN (issue #132) -- resolves
// one opaque Mystery Day session id to the real trading date it came
// from.
//
// **This is the one route in the app that can reveal a mystery day's
// answer**, and it is deliberately the only one: issue #127 put the
// id -> date mapping in a single object (`results/mystery-index.json`)
// precisely so "don't read this yet" is one rule rather than several.
// Nothing else here reads that key.
//
// It answers for **one id at a time** rather than serving the whole
// index. A player who has finished a session has earned exactly one date;
// handing back the full map would let a single settlement de-anonymise
// every other session still in the pool.
//
// The client-side half of the discipline lives in
// ../../../../../lib/use-mystery-session.ts: the reveal hook's URL is
// `null` until a session has genuinely settled, so this route is not
// merely "not displayed" early -- it is not requested at all. That is
// asserted against a real rendered DOM and a recorded network log, not
// taken on trust.

import { createResultReader } from "@/lib/create-result-reader";
import { getMysteryRevealResponse } from "@/lib/results-api";

export const dynamic = "force-dynamic";

const reader = createResultReader();

export async function GET(request: Request): Promise<Response> {
  const id = new URL(request.url).searchParams.get("id");
  return getMysteryRevealResponse(reader, id);
}
