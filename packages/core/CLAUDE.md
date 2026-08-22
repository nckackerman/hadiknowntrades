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
specifiers (`from "./date-utils"`, not `from "./date-utils.js"`) -
consistent with `tsconfig.base.json`'s `moduleResolution: "Bundler"`,
which doesn't need or want the NodeNext-style `.js`-pointing-at-`.ts`
convention. Don't add `.js` back onto these: `apps/web` (issue #7)
imports this package directly by its `@hadiknowntrades/core` package
specifier (a pnpm workspace symlink into `src`, not a compiled `dist`),
and empirically, Turbopack's `next build` fails to resolve a `.js`
specifier against a sibling `.ts` file once resolution crosses into a
package reached through `node_modules` (even a workspace symlink) -
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
  so this never flips a calendar date) — documented in the code. See
  "60-minute intraday bars" below for what this same limitation actually
  does once intraday data is involved (verified live, issue #28) -- it's
  no longer purely theoretical, though the specific failure mode it
  causes there still doesn't break day-bucketing.
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

## 60-minute intraday bars (issue #28)

`fetchIntradayBars` in `src/yahoo-client.ts` fetches `interval=60m` bars
from the same chart endpoint `fetchDailyCloses` uses, sharing its
retry/error-classification machinery via an extracted `fetchChartSeries`
helper. Facts below verified empirically against the real endpoint
during issue #28's implementation, not assumed from the daily-close
behavior:

- **730-day retention confirmed exactly as the issue's own research
  said**: a request 729 days back succeeds (thousands of bars returned);
  a request further back than 730 days gets a `422 Unprocessable Entity`
  with `chart.error.description` reading `"1h data not available for
startTime=... The requested range must be within the last 730 days."`
  -- a hard wall, not a soft limit.
- **`adjclose` is absent from real intraday responses** (`indicators`
  has no `adjclose` key at all for `interval=60m`, unlike daily) -- every
  intraday bar falls through `extractCloses`'s `?? quote?.close`
  fallback to the raw close. This is fine for this feature's purposes:
  split/dividend adjustment only matters across a holding period long
  enough for a corporate action to occur, and every intraday trade opens
  and closes within one day.
- **The DST-offset limitation on `unixToLocalDateString` (see above) is
  real and observable for intraday, not just theoretical**: verified by
  fetching a week straddling a real US DST "fall back" transition
  (2025-11-02). `meta.gmtoffset` is fixed at whatever the exchange's
  offset was _at request time_, applied uniformly to the whole requested
  range -- so bars on the far side of a DST transition from "now" get
  mapped to a _displayed_ local time-of-day that's off by up to 1 hour
  (observed concretely: the first bar of the trading day after the
  transition showed as `10:30:00` local instead of the real `09:30:00`
  market open). **This never crossed a calendar-date boundary in the
  verification run** (0 bars landed within 4 hours of local midnight,
  out of 50 checked spanning the transition) -- US market hours (9:30
  AM-4:00 PM local) sit with several hours of margin on both sides of
  midnight, so a 1-hour offset error is never enough to push a bar into
  the wrong trading day. Net effect: `optimizeIntradayDays`' day-grouping
  (which only depends on the calendar-date part) stays correct across a
  DST transition; the buy/sell _time-of-day_ shown to a user for a trade
  on the far side of a DST boundary from the pipeline's most recent run
  can be off by up to 1 hour. Accepted as-is (same reasoning as the
  daily-bar case: a real per-timestamp historical-offset table is more
  complexity than this is worth) -- but unlike the daily case, this one
  is a real, verified, user-visible (if minor) inaccuracy, not purely
  inert. Re-verify if this ever needs tightening.
- `IntradayBar`'s `date` field intentionally holds a full local datetime
  string (`unixToLocalDateTimeString`, "YYYY-MM-DDTHH:MM:SS"), not a
  plain calendar date -- same field name as `DailyClose.date` on purpose,
  so `IntradayBar[]` flows through `optimizeTrades`/`buildCalendar`
  unmodified (see "Per-day intraday optimizer" below). Don't rename this
  field to `datetime` or similar -- that was a real bug caught in this
  issue's Phase-1 plan review before any code was written (it would have
  broken the "no adapter shim needed" reuse the whole design depends on).

## 5-minute intraday bars (issue #30)

`fetchFiveMinuteBars` in `src/yahoo-client.ts` fetches `interval=5m` bars
from the same chart endpoint, upgrading the 3M range's most recent days
to finer granularity (see "Mixed-granularity 3M assembly" below).
Shares `fetchChartSeries`/`parseIntradayChartResult` with
`fetchIntradayBars` -- same envelope, same single-request-no-chunking
shape, only the interval string differs. Facts below verified
empirically against the real endpoint, not assumed from the 60-minute
case:

- **Retention is a hard 60-day wall**, the same "N-1 succeeds, N fails"
  pattern as 60m's 730-day limit: a request 59 days back succeeds
  (thousands of bars), 60 days back gets `422 Unprocessable Entity`
  with `chart.error.description` reading `"5m data not available for
startTime=... The requested range must be within the last 60 days."`
- **The out-of-retention case never reaches the `chart.error` branch at
  all** -- verified live, and this is a real, previously-undocumented
  gap in `fetchChartSeries`'s own comment (which suggests `chart.error`
  is how an out-of-range request surfaces): the response's HTTP status
  is 422, which is `!response.ok` and not in `isRetryableStatus`, so
  `fetchChartSeries` throws `UnexpectedResponseError` from the
  status-code branch _before_ ever calling `response.json()` far enough
  to inspect `chart.error`. Concretely: an out-of-retention 5m request
  throws `UnexpectedResponseError`, not `TickerNotFoundError`. This
  matters operationally, not just academically -- `UnexpectedResponseError`
  is a systemic-abort signal to `apps/pipeline`'s `fetchUniverseHistory`
  (stops the whole fetch path, not just that one ticker), so a
  miscalculated `from` date that puts every ticker's request past the
  60-day wall would abort the entire 5-minute fetch, not just skip a
  few tickers. `apps/pipeline` avoids ever hitting this in practice by
  requesting a conservative 59-day-back window (one full day inside the
  verified boundary) -- see `apps/pipeline/CLAUDE.md`'s "5-minute path"
  section for why that's fine either way (the whole path degrades
  gracefully regardless of which error class trips it).
- `adjclose` is absent from real 5-minute responses too, same as 60m --
  not re-verified bar-by-bar here since the parsing path
  (`parseIntradayChartResult`/`extractCloses`) is shared code already
  covered by the 60m verification above.

## Mixed-granularity 3M assembly (issue #30)

3M's per-day results (`IntradayResult.days`) are assembled from **two
separate `optimizeIntradayDays` calls, merged**, not from a single
mixed-granularity fetch or DP: one over the existing 60-minute-bar
history (same fetch already used for 1M/1Y), one over a second
5-minute-bar fetch scoped to the last 59 days. `apps/pipeline`'s
`buildIntradayResults` merges the two day-result arrays keyed by date,
letting the 5-minute version win wherever it exists (it can only exist
for a day within the last 59 days, by construction of what was
fetched) and falling back to the 60-minute version for every older day
in the 3M window. 1M and 1Y are untouched -- they only ever read the
60-minute day-result array, never the 5-minute one.

- `IntradayDayResult.barIntervalMinutes` (stamped by
  `optimizeIntradayDays` from `OptimizeIntradayOptions.barIntervalMinutes`,
  required, not inferred) makes this visible **in the output itself**,
  per-day -- deliberately not left as something a reader has to infer
  from a day's date relative to "now," since the issue text called that
  out explicitly as non-obvious. 1M/1Y days always carry `60`; 3M's
  recent ~59 days carry `5`, its older days carry `60` -- genuinely
  mixed within one range's `days` array.
- **The 5-minute path is deliberately best-effort, not held to the same
  alerting standard as the window/intraday path split** (see
  `apps/pipeline/CLAUDE.md`'s "Two independent paths since issue #28"
  section for that standard): a 5-minute fetch that aborts or comes back
  empty makes 3M's recent days silently fall back to 60-minute bars --
  i.e. exactly 3M's pre-#30 behavior -- rather than failing the whole
  pipeline run. This was a deliberate judgment call, not an oversight:
  the window-vs-intraday split's strict "must still fail the run" rule
  exists because a silent failure there means a whole range serves
  frozen/stale JSON forever with nothing to notice it; a 5-minute-path
  failure instead means 3M reverts to already-shipped, fully-correct
  (just coarser) 60-minute data -- qualitatively different from serving
  stale or broken output. Re-litigate this if 5-minute-granularity 3M
  data ever becomes something the product depends on rather than a
  bonus precision upgrade.
- Per-ticker skips accumulated by the 5-minute fetch are still merged
  into 3M's own `skippedTickers` (and the pipeline-wide summary) even
  though a 5-minute-only failure doesn't fail the run -- a ticker that
  fails only the 5-minute fetch but succeeds the 60-minute one doesn't
  appear at all in 3M's recent (5-minute-sourced) days, since the merge
  swaps in the 5-minute day's _entire_ tickers-considered-that-day set,
  not a per-ticker splice within a day -- worth surfacing as a skip even
  though that ticker's older 3M days and its 1M/1Y results are unaffected.
- `RESULTS_SCHEMA_VERSION` was **not** bumped for this issue --
  `barIntervalMinutes` is a purely additive field on an already-versioned
  shape (`IntradayDayResult`, introduced at schema version 2 by #28), and
  nothing in `apps/web` reads it yet. The version-bump criterion
  documented on `RESULTS_SCHEMA_VERSION` itself is "a shape change a
  reader needs to know about" -- an additive field no current reader
  depends on doesn't meet that bar. Revisit if `apps/web` ever starts
  branching on this field's presence.

## Per-day intraday optimizer (issue #28)

`src/intraday-optimizer.ts`'s `optimizeIntradayDays` needs **no new DP**.
Every trading day is an independent sub-problem (a position must open
and close same-day), and `optimizeTrades` already treats its `date` keys
as opaque, sortable, unique strings with no calendar-day assumptions
baked in -- so this is a thin wrapper: group a window's `IntradayBar[]`
by calendar day (the date-part of each bar's `date`), then call
`optimizeTrades` once per day with just that day's bars, unmodified.

- **Starting capital resets every day -- does not compound across days.**
  This was the single biggest interpretive judgment call in this issue's
  planning phase (the issue text didn't say so explicitly); confirmed by
  the human user before implementation. `IntradayDayResult.startingCapital`
  is the same constant on every day.
- The wrapper never reuses `Trade`'s `buyDate`/`sellDate` fields as-is
  for its public output (`IntradayTrade`) -- `optimizeTrades` echoes back
  whatever date-string key it was given, which here is the full
  datetime, not a plain date. `IntradayTrade` splits that into explicit
  `date` + `buyTime`/`sellTime` fields instead, since `apps/web`'s
  existing `Trade` consumers (`TradeList`, `PortfolioChart`,
  `format-date.ts`) all assumed `buyDate`/`sellDate` were plain calendar
  dates -- silently reusing `Trade` unmodified here would have corrupted
  those call sites' date parsing rather than erroring.
