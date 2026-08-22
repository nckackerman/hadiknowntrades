// GET /api/og/[range] -- a shareable "OG card" PNG for a preset range's
// precomputed result (issue #33), e.g. "$20 -> $48,203 - Max range". Built
// with Next's `ImageResponse` (next/og, Satori-based: renders from
// JSX/CSS, no headless browser involved) -- see apps/web/CLAUDE.md's OG
// card note for why that's the only approach this dev environment can
// actually develop and visually verify without extra OS-level setup. The
// actual pixel rendering lives in ../../../../components/OgCard.tsx (see
// that file's own header comment for why it's split out); this route is
// just fetch-validate-render glue.
//
// Content is derived from the exact same precomputed result
// /api/results already serves (see ../../results/route.ts) -- this route
// reuses `getResultsResponse` in-process rather than re-implementing its
// own S3-read-plus-validate path, so both routes stay byte-for-byte
// consistent on what counts as a valid/corrupt/not-yet-published result
// with no second copy of that logic to drift.
//
// Caching (the point of this issue, not just the image itself): this
// route is statically rendered by Next's own ISR (`export const
// dynamic = "force-static"` + `export const revalidate`), not
// recomputed on every request -- the actual Satori render only runs once
// per range per revalidate window (24h, matched to the pipeline's
// nightly cadence), and every request within that window is served
// straight from Next's cache with no image-generation work at all. This
// was chosen over the issue's own literal suggestion ("regenerate when
// apps/pipeline writes a new result") because that would require the
// pipeline to know about and call back into apps/web (or apps/web to
// poll S3 object metadata) purely to shave up to ~24h of staleness off
// an image that's already showing precomputed, nightly-refreshed data --
// out of proportion for this issue. The tradeoff: a card can lag the
// instant the pipeline actually wrote a new result by up to ~24h, same
// staleness the rest of the site already tolerates (see
// ../../results/route.ts's own CACHE_CONTROL comment).
//
// One accepted rough edge from relying on Next's built-in ISR rather
// than hand-rolling our own cache: an *error* response (bucket
// misconfigured, a range not published yet, corrupt stored data) is
// cached by Next the same as a successful render, for the same
// revalidate window -- there's no "don't cache non-2xx" carve-out in the
// Full Route Cache the way `fetch`'s own Data Cache has one. Accepted as
// a known tradeoff rather than engineered around (e.g. by throwing
// instead of returning a Response, which isn't a documented/reliable
// escape hatch for ISR'd route handlers either) -- these are rare,
// operational failure modes, and a stale error for up to a day is no
// worse than the staleness the rest of this precomputed-nightly app
// already accepts everywhere else.
//
// Scope (per the issue's own suggestion): only ranges using the
// "window" result model (5Y, MAX today) get a card -- see
// ../../../../lib/og-card.ts's own comment for why "intraday-daily"
// (1M/3M/1Y) is out of scope here, not just unimplemented by oversight.

import type { PrecomputedResult } from "@hadiknowntrades/core";

import { renderOgCard } from "@/components/OgCard";
import { buildOgCardContent } from "@/lib/og-card";
import { getResultsResponse } from "@/lib/results-api";
import { S3ResultReader } from "@/lib/s3-result-reader";

// Statically rendered per range, revalidated once a day -- see this
// file's header comment. Without `dynamic = "force-static"`, a route
// handler with a dynamic segment defaults to fully dynamic (rendered,
// uncached, on every request) as of Next 15+ regardless of `revalidate`
// alone (see node_modules/next/dist/docs's generateStaticParams/
// dynamic-routes guides: "You must ... utilize `export const dynamic =
// 'force-static'` in order to revalidate (ISR) paths at runtime").
// Deliberately has no `generateStaticParams` -- that would require this
// route to read from S3 (real network access) at `next build` time,
// which this sandboxed dev environment has no credentials for; omitting
// it means every range is instead rendered (and then cached) on its
// first real request instead, which works identically in production and
// keeps `next build` fully offline-safe here.
export const dynamic = "force-static";
export const revalidate = 86400; // 24h -- matches the nightly pipeline cadence.

// Built once per warm process and reused across requests, same reasoning
// as ../../results/route.ts's own module-scope `reader`.
const bucket = process.env.RESULTS_BUCKET;
const reader = bucket ? new S3ResultReader(bucket) : null;

function errorResponse(status: number, message: string): Response {
  // no-store on our own explicit header is honored for *this* response,
  // but see the header comment above: Next's route-level `revalidate`
  // still applies to the overall route, so this doesn't fully prevent
  // an error from being reused for the rest of the window.
  return new Response(message, { status, headers: { "Cache-Control": "no-store" } });
}

export async function GET(
  _request: Request,
  { params }: RouteContext<"/api/og/[range]">,
): Promise<Response> {
  const { range: rawRange } = await params;

  const resultResponse = await getResultsResponse(rawRange, reader);
  if (!resultResponse.ok) {
    // getResultsResponse's own body is `{ error, message }` (see
    // ../../results/route.ts) -- surface its `message` rather than the
    // HTTP status line alone, which can be an uninformative empty
    // string (e.g. plain `Response.json` doesn't set a `statusText`).
    const { message } = (await resultResponse.json()) as { message?: string };
    return errorResponse(
      resultResponse.status,
      `Could not render a share card for range "${rawRange}": ${message ?? "unknown error"}`,
    );
  }

  const result = (await resultResponse.json()) as PrecomputedResult;
  const content = buildOgCardContent(result);
  if (!content) {
    return errorResponse(
      404,
      `No shareable card is available yet for range "${rawRange}" (model "${result.model}").`,
    );
  }

  return renderOgCard(content);
}
