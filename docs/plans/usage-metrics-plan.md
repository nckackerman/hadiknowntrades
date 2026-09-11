# Usage metrics: unique players + plays-per-player over time

**Status: plan only, not yet built.** Deliberately deferred until this app has
a working CDN — CloudFront is currently blocked on AWS's own account
verification gate (see `infra/CLAUDE.md`'s "Current deployment state"
section), and any real usage on the site today is effectively zero/test
traffic anyway. Revisit this doc once that's cleared and `cdk deploy` picks
up the Distribution.

## The ask

"The absolute easiest way to detect usage metrics for the site. A simple
graph of unique players and how many times each unique player played over a
timeframe."

## Two real options

### Option A — free hosted third-party script (recommended: "absolute easiest")

Add a privacy-friendly analytics script tag to `app/layout.tsx` (e.g.
[Plausible](https://plausible.io) or [Umami Cloud](https://umami.is), both
have a free tier suitable for a low-traffic learning project) and fire a
custom event per "played a game" action (one `window.plausible('played', {
props: { game: 'beat-the-bench' } })`-style call per game's own settlement
path — Beat the Bench, The Call Board, The Order, The Lineup, The Cut each
already have one clear "this session/round finished" moment).

- **Unique players**: the tool's own visitor-counting already does this
  (cookie-less fingerprint or a lightweight first-party cookie, depending on
  the tool) — no code on our side beyond the script tag.
- **Plays per player over time**: needs the custom event above; most of
  these tools' dashboards can already break down "events per visitor" or
  export raw event data to build that specific graph if their built-in
  dashboard doesn't show it directly.
- **Cost**: minutes of work — one script tag, ~5 event-firing call sites.
  Zero new backend, zero new AWS resources.
- **Trade-off**: an external script and a third-party data processor,
  even a privacy-focused one. Worth a one-line disclosure if that matters to
  this project's own stated ethos (nothing here currently mentions any
  tracking at all).

### Option B — fully in-house, no third party

- A new `/api/track` route (mirroring this app's existing thin API-route
  shape, e.g. `/api/beat-the-bench`) that appends `{ playerId, event, ts }`
  rows somewhere persistent.
- `playerId`: a random UUID generated client-side and stored in
  `localStorage` via the existing `lib/local-storage.ts` two-layer pattern
  (same convention every other per-viewer feature in this app already uses)
  — anonymous, no login, resets if storage is cleared.
- Storage: either append-only JSON files in the existing results S3 bucket
  (cheapest, reuses infra already in place, but S3 has no query engine — an
  internal dashboard page would need to fetch and aggregate the whole log
  client- or server-side, fine at this app's real traffic scale) or a small
  DynamoDB table (a genuinely new AWS resource + CDK stack change, real but
  small infra work — `infra/cdk/lib/hadiknowntrades-stack.ts` would need a
  new table + IAM grant for the pipeline/web Lambda).
- A small internal-only page (e.g. `/admin/usage`, not linked from the real
  nav) rendering the requested graph — unique players over a timeframe, and
  a per-player play-count breakdown. A plain hand-rolled SVG bar chart
  (matching this app's own "no charting library" convention, see
  `apps/web/CLAUDE.md`'s "Chart: hand-rolled SVG, no library" section) is
  more than enough for this.
- **Cost**: a real, if small, build — one API route, one storage decision,
  one dashboard page. Everything stays inside this app's own AWS account,
  no external dependency.

## Recommendation

Option A first, given the explicit "absolute easiest" framing — it's
genuinely minutes of work once there's real traffic to measure. Option B is
the natural upgrade if this project ever wants the data to live entirely in
its own AWS account, or wants a metric neither hosted tool's dashboard
surfaces directly (the specific "plays per unique player, bucketed" shape is
exactly the kind of custom query an in-house event log answers more
precisely than most hosted dashboards).

## Preconditions before building either

1. CloudFront cleared (AWS Support case already the documented path, see
   `infra/CLAUDE.md`) — real traffic needs a real public URL, and Option
   A's script obviously needs a live page to run on.
2. User's explicit go-ahead on which option, per this repo's standing
   "never deploy or touch real AWS resources without asking first" rule —
   Option A alone needs zero new AWS resources (just a script tag + a
   third-party account); Option B needs a CDK stack change (a new
   DynamoDB table or a new S3 prefix + IAM grants), which is real infra
   and needs sign-off regardless of how small.
