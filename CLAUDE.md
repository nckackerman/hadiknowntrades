# Had I Known Trades — working notes

This file exists to save a fresh session from re-deriving things that were
expensive to discover the first time (live experiments against Yahoo,
benchmarking, a multi-round bug hunt in the optimizer). Read this before
re-investigating something below — if a fact here turns out to be stale,
fix the fact here too, not just the code.

## What this is

A hindsight data visualizer: starting from $20, using only closed (EOD)
market data, what's the best possible outcome from **at most 3 sequential,
all-in, long-only trades** across the entire S&P 500 over a preset window
(1M / 3M / 1Y / 5Y / Max)? Not investment advice, not a predictor — a
retrospective "what was optimal" toy. Explicitly a learning exercise in
agent-first development (see "Working agreements" below), not a
production/high-stakes app — keep that in mind when deciding how much
process/rigor a given change deserves.

Track build-out via the GitHub milestone **"v1: MVP launch"** (issues
#1-#10) and the `backlog`-labeled issues (#11-#15) for deferred v2 ideas.

## Architecture

pnpm workspace monorepo:

```
apps/
  web/       Next.js 16.3.1 + TypeScript frontend (issue #7/#8, not built yet)
  pipeline/  Nightly precompute job: fetch -> optimize -> write to S3
packages/
  core/      Shared domain logic: ticker universe, Yahoo client, optimizer,
             preset-range math, date utils
infra/
  bootstrap/ One-time sandbox AWS/IAM setup docs+policies (not the CDK app)
  cdk/       AWS infrastructure as code (issue #6, not built yet)
```

Data flow: `packages/core`'s Yahoo client fetches daily closes ->
`packages/core`'s optimizer (a DP) finds the best 3-trade sequence ->
`apps/pipeline` runs this nightly for all 5 preset ranges and writes JSON
to S3 -> (future) a thin API serves it to the frontend. No live
recomputation per request — everything is precomputed nightly.

## Data source: Yahoo Finance, not Stooq — don't reintroduce Stooq

The original plan (see issue #3) was Stooq. **Stooq now actively blocks
programmatic access**: `robots.txt` disallows all bots except
Google/Bing, plus a site-wide JS proof-of-work anti-bot challenge on
every page, verified live. Don't build a client that solves that
challenge — that's circumventing an explicit anti-bot protection, not
just an inconvenience.

Using **Yahoo Finance's unofficial chart endpoint** instead
(`packages/core/src/yahoo-client.ts`). Facts verified empirically, not
from docs (Yahoo has none):

- Requires a browser-like `User-Agent` header. Without one, requests get
  a misleading "Too Many Requests" response regardless of actual volume
  — it's UA-fingerprint filtering, not real rate limiting.
- Dot-class share symbols use a hyphen on Yahoo, not a dot: `BRK.B` ->
  `BRK-B`, `BF.B` -> `BF-B`. Handled by `toYahooSymbol()`.
- An invalid/delisted symbol returns HTTP 200 with
  `{ chart: { result: null, error: {...} } }`, not an HTTP error status.
  A genuinely nonexistent symbol returns HTTP 404.
- **A legitimately empty date range (e.g. a weekend-only window) omits
  `timestamp` entirely and returns `quote: [{}]` / `adjclose: [{}]`** —
  no `close`/`adjclose` key at all, not even an empty array. This shape
  is easy to get wrong by guessing instead of checking live (it crashed
  the client once during development — see git history on
  `yahoo-client.ts` if the exact shape ever needs re-verifying).
- Daily bars are timestamped near market open (mid-morning local time),
  not midnight, so a naive inclusive-end-date range needs the internal
  day-padding on `period2` that's already in the client — don't remove it.
- No official ToS backs this endpoint (it's what `yfinance` and most
  OSS finance tooling has quietly relied on for years) — it could change
  or start blocking without notice. If it ever does, re-run the same
  empirical research process from issue #3 rather than assuming Stooq
  is fine again.

## Optimizer algorithm

`packages/core/src/optimizer.ts` — a backward DP generalizing "best time
to buy/sell stock IV" across many tickers instead of one. Full derivation
is in the file's own header comment; don't re-derive it, read that first.

- O(days × tickers × maxTrades). Benchmarked (not estimated): ~330ms for
  the full S&P 500 over a 21-year ("Max") window on realistic synthetic
  data. Real S&P 500 data will vary but this isn't a performance risk at
  the target scale.
- Deterministic tie-break when two tickers achieve an identical best
  ratio: alphabetically-first ticker symbol wins (plain `<`/`>`
  comparison, not `localeCompare` — locale-dependent sorting isn't
  simple ASCII order and was a real bug once).
- Known, accepted limitation: `unixToLocalDateString`'s date derivation
  uses the exchange's _current_ UTC offset for every timestamp in a
  range, not the historically-correct per-date offset, so a range
  spanning a DST transition is technically imprecise. Inert in practice
  for daily bars (market-open timestamps never sit near a day boundary,
  so this never flips a calendar date) — documented in the code, not
  worth the complexity of a real per-date timezone table unless intraday
  data is ever added.
- The optimizer has its own input validation (`OptimizerInputError`) and
  is defensive against malformed caller input (non-finite prices,
  invalid `maxTrades`/`startingCapital`) — it does not trust
  `packages/core`'s own Yahoo client to have already sanitized
  everything, by design (defense in depth, see `is-valid-price.ts`).
- **Fun/expected product quirk, not a bug**: the "Max" range genuinely
  produces astronomically large numbers (a 5-ticker demo run hit ~$716M
  from $20). That's real perfect-hindsight compounding over decades, not
  a calculation error — worth remembering when designing display/number
  formatting in issue #8, since a naive `$` format will look absurd or
  broken to a first-time viewer without some framing.

## Pipeline (apps/pipeline)

- Fetches each ticker's **full** history once (from 1970, effectively
  "everything Yahoo has"), then slices that one fetch into the 5 preset
  windows locally — not 5x separate network fetches per ticker.
- Bounded concurrency (default 10 concurrent fetches).
- Error handling is deliberately asymmetric:
  - `TickerNotFoundError` / `TransientFetchError` on one ticker -> skip
    that ticker, log it, keep going.
  - `BlockedError` / `UnexpectedResponseError` -> **abort the entire
    run**. Both signal a systemic problem (we're blocked, or the API
    contract changed), not "this one ticker is weird" — continuing to
    fire off hundreds more requests would be pointless and risks
    masking a total outage as routine per-ticker noise.
  - If literally zero tickers succeed, the run throws rather than
    writing empty-but-schema-valid JSON — refuses to overwrite
    yesterday's good results with an empty run that "succeeded."
- Idempotent by design: fixed S3 key per range (`results/{RANGE}.json`),
  overwritten each run, not accumulated as dated copies.
- `dataAsOf` (the actual last trading date found in fetched data) and
  `endDate` (the requested boundary) are deliberately different fields —
  they can genuinely diverge (e.g. asOf lands on a weekend) and both are
  useful; don't collapse them back into one field.
- `S3ResultStore` (`s3-store.ts`) and the real entry point (`index.ts`)
  exist and typecheck but **have never been run against a real AWS
  bucket** — that requires issue #6's infrastructure first. Don't assume
  they've been exercised for real just because they're merged.

## AWS / infra state

- Sandbox IAM already set up per `infra/bootstrap/SETUP.md`: three
  policies (deny-list on expensive/always-on services, scoped IAM for
  CDK-created roles, a lockdown policy) attached to IAM user
  `hadiknowntrades-agent`, region **us-west-2**.
- **A budget circuit breaker was deliberately deferred** by the user's
  own choice — there is currently no automatic spend cap beyond the
  IAM deny-list. Worth raising again before any real `cdk deploy` in
  issue #6.
- If a custom domain + HTTPS ever gets added to CloudFront: the ACM
  certificate for that specifically must be requested in **us-east-1**
  regardless of the region everything else lives in — a CloudFront/ACM
  quirk, not a reason to move the whole app.
- `.claude/settings.json` in this repo grants a standing permission for
  `gh pr merge` (see its own comments) — that was a real harness
  permission wall hit once already, already solved, don't re-litigate it.
- **Never deploy or touch real AWS resources without the user's
  explicit go-ahead**, independent of anything else in this file — that
  agreement predates and overrides any process shortcut described here.

## Toolchain

- Node + pnpm are managed via `mise` (see `mise.toml`) — pinned versions,
  not whatever's on `PATH`. On this machine specifically, the `node`/
  `npm` that show up on `PATH` by default are **Windows binaries leaking
  into WSL**, not a real Linux install — always verify `which node`
  resolves to the mise shim before assuming the toolchain is sane in a
  new environment.
- Next.js is **16.3.1** — newer than typical model training data. Its
  own generated `apps/web/AGENTS.md` (imported by `apps/web/CLAUDE.md`)
  already warns about this: check `node_modules/next/dist/docs/` before
  writing Next-specific code rather than assuming older App Router
  conventions.
- CI (`.github/workflows/ci.yml`): `actions/setup-node`'s
  `node-version-file` claims `mise.toml` support but actually mis-parses
  the `[tools]` table header as the version string — the workflow
  extracts the version from `mise.toml` itself via `grep`/`sed` instead.
  Don't "simplify" this back to `node-version-file: mise.toml`, it's
  broken.

## Working agreements (how we build this together)

- One branch/PR per issue, roughly in dependency order.
- Always **watch the actual CI run** (`gh run watch`) rather than trusting
  a workflow file looks right — this caught two real bugs (a broken
  `setup-node` parse, and a typecheck ordering issue) that would have
  shipped otherwise.
- Run `/code-review` before merging, **default effort `high`, not
  `xhigh`** — this is a simple learning project, not high-stakes
  production work. `xhigh`'s ~10-agent fan-out costs roughly 7x a `high`
  pass for reviews of comparable value on most of this codebase; reserve
  it for a single pass on the one genuinely highest-stakes file per
  epic (the optimizer got it once, deservedly). Don't auto-retry a
  failed multi-agent review from scratch — fall back to `high` or a
  manual read instead.
- Verify live (real network calls, real benchmarks) at least once per
  feature, not after every incremental fix once the test suite is
  solid — repeating full live verification after every small change
  mostly just inflates context for little new signal.
- Merge my own PRs once tests + review are clean, for code-only changes.
  Anything touching real AWS/infra needs the user's explicit go-ahead
  first, every time, regardless of how clean the diff is.
