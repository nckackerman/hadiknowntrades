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
  sourced from Yahoo Finance's unofficial chart endpoint, end-of-day only.
  "Adjusted" means split- and dividend-adjusted -- a trade's return
  reflects the real total return a holder would have seen, not a raw price
  change distorted by a stock split. (Originally planned to use Stooq,
  which now actively blocks programmatic access -- see issue #3 for
  details.)
- **Optimizer**: a backward DP (generalizing the classic "best time to
  buy/sell stock IV" problem across many tickers) finds the sequence of up
  to 3 non-overlapping round-trip trades — buy on a close, sell on a later
  close, full balance reinvested each time, can switch tickers between
  trades — that maximizes the ending balance for a given date range.
- **Compute**: a nightly scheduled job runs the optimizer for each preset
  range (1W / 1M / 3M / 1Y / 5Y / Max) and writes the results to S3. The site
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
  core/      Shared domain logic: ticker universe, Yahoo client, optimizer
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

`pnpm dev` runs and renders fine with no further setup -- but the app's
`/api/results` route reads precomputed results from S3, so without pointing
it at a real bucket you'll see the app's normal "results are temporarily
unavailable" error state instead of real data. To see real data locally,
set `RESULTS_BUCKET` (read explicitly in
`apps/web/src/app/api/results/route.ts`) and `AWS_REGION` (read implicitly
by the AWS SDK's own default region/credential provider chain, not by any
line in this app's own code) before running `pnpm dev`:

```bash
RESULTS_BUCKET=<your-deployed-bucket-name> AWS_REGION=us-west-2 pnpm dev
```

This requires AWS credentials with read access to that bucket (e.g. via
`aws configure`, picked up automatically by the AWS SDK) and a bucket that
already has results in it -- either your own deployment (see
`infra/cdk/`) or ask a maintainer for read access to theirs. There's no
public demo bucket.

Other useful root-level scripts (run across all workspace packages):

```bash
pnpm lint
pnpm typecheck
pnpm format        # writes formatting fixes
pnpm format:check  # CI-friendly, no writes
pnpm build
pnpm test
```

## Contributing

- One branch/PR per issue; open PRs against `main`.
- CI (`.github/workflows/ci.yml`) runs lint, typecheck, format check,
  build, and test on every PR -- all five must pass.
- Match the existing code's comment density and style; nested `CLAUDE.md`
  files throughout the repo (`packages/core/CLAUDE.md`,
  `apps/pipeline/CLAUDE.md`, `infra/CLAUDE.md`, `.github/workflows/CLAUDE.md`)
  document non-obvious facts and decisions specific to that area -- read
  the relevant one before touching that part of the codebase.
- This is a learning-project-scale codebase, not high-stakes production
  software -- keep that in mind when judging how much process a given
  change deserves.

## Status

The [v1: MVP launch milestone](https://github.com/nckackerman/hadiknowntrades/milestone/1)
is code-complete: the optimizer, nightly precompute pipeline, and the core
visualization UI are all built and merged, and infra is deployed and
running the real pipeline against real data.

**Live now (temporary URL):**

```
https://7wyjrkhxt5srua26agwb5egtfm0dkvqa.lambda-url.us-west-2.on.aws/
```

This is an AWS Lambda Function URL, not the final CloudFront-fronted
domain -- CloudFront itself is still blocked by an AWS account
verification step outside this repo's control (see `infra/CLAUDE.md`).
It's a deliberate, reversible workaround (`bypassCloudFront` CDK context
flag) that serves the real app directly from the web Lambda in the
meantime. Once AWS clears the account, a plain `cdk deploy` (no flag)
will pick up the already-declared CloudFront distribution and this URL
will be replaced by the real domain. See that milestone and the
`backlog`-labeled issues for what's next.
