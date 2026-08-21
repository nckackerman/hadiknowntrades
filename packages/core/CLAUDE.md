# packages/core — working notes

Shared domain logic: ticker universe, Yahoo client, optimizer, preset-range
math, date utils. Read this before re-investigating something below — if a
fact here turns out to be stale, fix the fact here too, not just the code.

## Data source: Yahoo Finance, not Stooq — don't reintroduce Stooq

The original plan (see issue #3) was Stooq. **Stooq now actively blocks
programmatic access**: `robots.txt` disallows all bots except
Google/Bing, plus a site-wide JS proof-of-work anti-bot challenge on
every page, verified live. Don't build a client that solves that
challenge — that's circumventing an explicit anti-bot protection, not
just an inconvenience.

Using **Yahoo Finance's unofficial chart endpoint** instead
(`src/yahoo-client.ts`). Facts verified empirically, not from docs
(Yahoo has none):

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

## Internal imports: no `.js` extension on relative specifiers

`src/*.ts` files import each other with plain extensionless relative
specifiers (`from "./date-utils"`, not `from "./date-utils.js"`) —
consistent with `tsconfig.base.json`'s `moduleResolution: "Bundler"`,
which doesn't need or want the NodeNext-style `.js`-pointing-at-`.ts`
convention. Don't add `.js` back onto these: `apps/web` (issue #7)
imports this package directly by its `@hadiknowntrades/core` package
specifier (a pnpm workspace symlink into `src`, not a compiled `dist`),
and empirically, Turbopack's `next build` fails to resolve a `.js`
specifier against a sibling `.ts` file once resolution crosses into a
package reached through `node_modules` (even a workspace symlink) —
`Module not found: Can't resolve './date-utils.js'`, even though tsc and
vitest both resolve it fine. Not documented anywhere in Next.js's own
docs; found by bisecting a real `next build` failure. Reintroducing `.js`
here will silently break `apps/web`'s build the same way.

## Optimizer algorithm

`src/optimizer.ts` — a backward DP generalizing "best time to buy/sell
stock IV" across many tickers instead of one. Full derivation is in the
file's own header comment; don't re-derive it, read that first.

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
  invalid `maxTrades`/`startingCapital`) — it does not trust this
  package's own Yahoo client to have already sanitized everything, by
  design (defense in depth, see `is-valid-price.ts`).
- **Fun/expected product quirk, not a bug**: the "Max" range genuinely
  produces astronomically large numbers (a 5-ticker demo run hit ~$716M
  from $20). That's real perfect-hindsight compounding over decades, not
  a calculation error — worth remembering when designing display/number
  formatting in `apps/web` (issue #8), since a naive `$` format will
  look absurd or broken to a first-time viewer without some framing.
