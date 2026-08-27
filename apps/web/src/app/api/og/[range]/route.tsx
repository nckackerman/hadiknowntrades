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
// Scope: **every** preset range gets a card as of issue #134. This
// route used to serve only the "window" model (5Y/MAX) and 404 the
// "intraday-daily" ranges (1W/1M/3M/1Y) -- see
// ../../../../lib/og-card.ts's own doc comment for why that restriction
// was real when it shipped and why it's stale now (issues #84/#91's
// whole-range capital chaining gave the intraday model a single
// meaningful headline figure, the same one the page itself headlines).
// The `buildOgCardContent(...) === null` 404 below stays for the one
// case that genuinely has nothing to show: a result with no trading
// days at all.
//
// Route-param validation (issue #33 follow-up, found in code review):
// the raw `[range]` segment is checked against `isCanonicalRange`
// (../../../../lib/results-api.ts) -- an exact-case membership check
// against PRESET_RANGES -- before any other work happens, including
// before `getResultsResponse` is even called. Two things this guards
// against that `getResultsResponse`'s own (case-insensitive) `parseRange`
// doesn't, because they're specific to this route being `force-static`
// with a *path segment*, not `/api/results`' query parameter:
//   - Case variants (`/api/og/max`, `/api/og/Max`, `/api/og/MAX`, ...)
//     would otherwise all separately reach the Satori render (since
//     `parseRange` case-folds), each becoming its own separate
//     24h-cached ISR entry for what's ultimately identical content --
//     wasted duplicate render work.
//   - An arbitrary/garbage path segment would otherwise still reach
//     `getResultsResponse` (cheap to reject there, but only *after*
//     Next has already committed to routing this request through the
//     static-generation path for that exact string).
//
// Deliberately exact-case rejection, not a case-fold-then-redirect to
// the canonical casing: a redirect would still need a first request (and
// still burns one cache slot) per case variant, and silently accepting
// any casing as equivalent is exactly the behavior that caused the
// duplicate-cache-entry problem in the first place.
//
// Deliberately *not* solved via `generateStaticParams` +
// `dynamicParams = false` instead (Next's other documented mechanism for
// restricting a dynamic segment to a fixed set, which would let Next
// itself 404 an unlisted path before ever invoking this handler) --
// considered, but rejected for this route specifically: `next build`
// eagerly invokes a Route Handler's `GET` once per
// `generateStaticParams`-declared param to produce its build-time static
// output (confirmed against node_modules/next/dist/docs's own
// generate-static-params.md example). This route's actual deployment
// split is build-time-without-S3-access, runtime-with-S3-access (no
// `RESULTS_BUCKET` at `next build` time -- see this file's own
// `dynamic = "force-static"` comment below -- but the deployed Lambda
// runtime does have it, same as apps/pipeline's, see
// infra/CLAUDE.md's env var contract note). Eagerly building each
// canonical range at compile time would bake in today's
// `server_misconfigured` 500 (no reader) as that path's *initial*
// 24h-cached entry, actively regressing the current behavior where the
// very first real runtime request already renders correctly against the
// real bucket. An in-handler exact-case check has no such regression --
// it costs nothing at build time and only rejects paths this route was
// never going to serve real content for anyway.

import type { PrecomputedResult } from "@hadiknowntrades/core";
import { PRESET_RANGES } from "@hadiknowntrades/core";

import { renderOgCard } from "@/components/OgCard";
import { createResultReader } from "@/lib/create-result-reader";
import { buildOgCardContent } from "@/lib/og-card";
import { getResultsResponse, isCanonicalRange } from "@/lib/results-api";

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
// as ../../results/route.ts's own module-scope `reader`. Goes through
// the shared `createResultReader` (issue #134) rather than constructing
// an S3ResultReader from `RESULTS_BUCKET` directly the way this route
// did when it shipped: that helper was extracted after this route
// existed, so this file had silently drifted into being the one
// results-reading route that didn't honor the committed
// `LOCAL_RESULTS_DIR` local-dev workflow (see
// ../../../../lib/create-result-reader.ts and apps/web/CLAUDE.md's
// "Local development without AWS credentials") -- meaning a card could
// never be rendered locally at all without real AWS credentials.
// Production behavior is unchanged: with no LOCAL_RESULTS_DIR set,
// `createResultReader` resolves to exactly the same
// `RESULTS_BUCKET`-backed S3ResultReader (or `null`) as before.
const reader = createResultReader();

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

  if (!isCanonicalRange(rawRange)) {
    return errorResponse(
      404,
      `Unknown range "${rawRange}". Expected an exact (case-sensitive) match for one of: ${PRESET_RANGES.join(", ")}.`,
    );
  }

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
    // Since issue #134 both result models produce a card, so this is no
    // longer a "this model isn't supported" rejection -- it's the
    // genuinely empty result (no trading days at all) case. `model` is
    // still named in the message since it's the cheapest way to tell
    // which shape came back when this ever does fire.
    return errorResponse(
      404,
      `No shareable card could be built for range "${rawRange}" (model "${result.model}") -- it has no result to headline.`,
    );
  }

  return renderOgCard(content);
}
