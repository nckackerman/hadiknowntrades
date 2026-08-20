# Had I Known Trades

A "had I known" hindsight data visualizer: starting from $20 and using only
closed (end-of-day) market data, what's the best possible outcome from **at
most 3 sequential, all-in, long-only trades** across the entire S&P 500 over
a given time window?

It's not investment advice and it isn't predicting anything — it's a
retrospective "what was optimal" visualization, useful for seeing how fast
money can compound with perfect hindsight over anything from a month to
decades.

## How it works

- **Data**: daily adjusted-close prices for all S&P 500 constituents,
  sourced from [Stooq](https://stooq.com), end-of-day only.
- **Optimizer**: a backward DP (generalizing the classic "best time to
  buy/sell stock IV" problem across many tickers) finds the sequence of up
  to 3 non-overlapping round-trip trades — buy on a close, sell on a later
  close, full balance reinvested each time, can switch tickers between
  trades — that maximizes the ending balance for a given date range.
- **Compute**: a nightly scheduled job runs the optimizer for each preset
  range (1M / 3M / 1Y / 5Y / Max) and writes the results to S3. The site
  reads precomputed results through a thin API layer — no live recomputation
  per request.

See [`infra/bootstrap/SETUP.md`](infra/bootstrap/SETUP.md) for the one-time
sandbox AWS setup (scoped IAM policies + budget circuit breaker) used when
deploying this project.

## Known v1 assumptions / limitations

- Current S&P 500 constituents are applied retroactively across all
  historical date ranges — there's no historical index-membership tracking,
  which introduces mild survivorship bias.
- Daily (EOD) granularity only — trades happen at closing prices, not
  intraday.
- No fees, slippage, taxes, or fractional-share constraints are modeled.

## Project structure

This is a pnpm workspace monorepo:

```
apps/
  web/       Next.js + TypeScript frontend, deployed to AWS
  pipeline/  Nightly precompute job (data fetch + optimizer + S3 write)
packages/
  core/      Shared domain logic: ticker universe, Stooq client, optimizer
infra/
  bootstrap/ One-time sandbox AWS/IAM setup (not part of the CDK app)
  cdk/       AWS infrastructure as code (added in issue #6)
```

## Getting started

Requires Node 22+ and pnpm. Versions are pinned in `mise.toml` and in
`package.json`'s `packageManager` field; if you use
[mise](https://mise.jdx.dev), run `mise trust && mise install` in the repo
root once and it'll install and use the exact pinned versions automatically
from then on.

```bash
pnpm install
pnpm dev          # runs the Next.js app in apps/web
```

Other useful root-level scripts (run across all workspace packages):

```bash
pnpm lint
pnpm typecheck
pnpm format        # writes formatting fixes
pnpm format:check  # CI-friendly, no writes
pnpm build
pnpm test
```

## Status

Early scaffolding — see the
[v1: MVP launch milestone](https://github.com/nckackerman/hadiknowntrades/milestone/1)
for the build-out plan.
