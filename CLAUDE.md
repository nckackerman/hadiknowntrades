# Had I Known Trades — working notes

This file is intentionally small. Deeper, area-specific detail — the kind
that's expensive to re-derive — lives in nested `CLAUDE.md` files that
load automatically once you're working in that area:
`packages/core/CLAUDE.md`, `apps/pipeline/CLAUDE.md`, `infra/CLAUDE.md`,
`.github/workflows/CLAUDE.md`. Check the relevant one before
re-investigating something rather than guessing from scratch.

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
             -- see apps/pipeline/CLAUDE.md
packages/
  core/      Shared domain logic: ticker universe, Yahoo client, optimizer,
             preset-range math, date utils -- see packages/core/CLAUDE.md
infra/
  bootstrap/ One-time sandbox AWS/IAM setup docs+policies (not the CDK app)
  cdk/       AWS infrastructure as code (issue #6, not built yet)
             -- see infra/CLAUDE.md
```

Data flow: `packages/core`'s Yahoo client fetches daily closes ->
`packages/core`'s optimizer (a DP) finds the best 3-trade sequence ->
`apps/pipeline` runs this nightly for all 5 preset ranges and writes JSON
to S3 -> (future) a thin API serves it to the frontend. No live
recomputation per request — everything is precomputed nightly.

## Toolchain gotchas (repo-wide)

- Node + pnpm are managed via `mise` (see `mise.toml`) — pinned versions,
  not whatever's on `PATH`. On this machine specifically, the `node`/`npm`
  that show up on `PATH` by default are **Windows binaries leaking into
  WSL**, not a real Linux install — always verify `which node` resolves
  to the mise shim before assuming the toolchain is sane in a new
  environment.
- `apps/web` runs **Next.js 16.3.1** — newer than typical model training
  data, with breaking API/convention changes. Its own generated
  `apps/web/AGENTS.md` (auto-imported via `apps/web/CLAUDE.md`) already
  warns about this and points at `node_modules/next/dist/docs/` — read
  it before writing any Next-specific code, don't assume older App
  Router conventions from training data.

## Working agreements (how we build this together)

- One branch/PR per issue, roughly in dependency order.
- Always **watch the actual CI run** (`gh run watch`) rather than trusting
  a workflow file looks right — this caught two real bugs (a broken
  `setup-node` parse, and a typecheck ordering issue) that would have
  shipped otherwise; see `.github/workflows/CLAUDE.md`.
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
  `.claude/settings.json` grants standing permission for `gh pr merge`
  (see its own comments) — that was a real harness permission wall hit
  once already, already solved, don't re-litigate it. Anything touching
  real AWS/infra needs the user's explicit go-ahead first, every time,
  regardless of how clean the diff is.
