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
- **Worst-case search (`optimizeWorstTrades`, issue #31)**: the same DP
  in the min direction, sharing 100% of `optimizeTrades`'s validation/
  calendar/reconstruction logic via a private `runOptimizer(...,
direction)` -- only `computeLevel`'s four comparison sites/sentinels are
  parameterized by `direction: "max" | "min"` (see that function's own
  doc comment for exactly which four, and why the "no price here"
  sentinel must flip to `+Infinity`, not stay `-Infinity`, for a min
  search). None of the three deterministic tie-break rules (cross-ticker
  alphabetical, cross-day earliest-wins, trade-vs-carry-forward strict
  inequality) needed inverting for "min" -- they're all about determinism
  given an otherwise-tied objective, not about maximizing, so the same
  rule falls out unchanged under inversion. Live-verified (real Yahoo
  data, full 503-ticker S&P 500 universe, all 5 ranges, no S3 write): 0
  invariant violations (`worst <= optimal` held everywhere), 0 non-finite
  results, and the "worst case still nets a gain" edge case (see that
  function's own doc comment) never triggered on real data -- 5Y's worst
  case came back $0.81 from $20, MAX's $0.02, both genuine losses. Full
  pipeline run (both directions, both paths, all 5 ranges, real network
  I/O) took ~34s for the full universe -- cheap either way, but see the
  next bullet for why "roughly doubles" was later tightened to "roughly
  1.6-1.7x" once the redundant per-direction calendar build below was
  fixed; confirms the intraday path's ~250-per-range separate
  `optimizeTrades` calls (now doubled to include `optimizeWorstTrades`)
  stay cheap too, not just the window path's single whole-window call.
- **Calendar/ticker-sort now shared across both directions, not rebuilt
  per call (code-review follow-up to issue #31, not part of its original
  scope)**: `buildCalendar` and the alphabetical ticker sort are a pure
  function of the input price data alone -- independent of `direction` --
  but every call site (`apps/pipeline`'s `buildWindowResults`,
  `optimizeIntradayDays`'s per-day loop) calls `optimizeTrades` then
  `optimizeWorstTrades` back-to-back on the _identical_ input, so the
  original `runOptimizer(..., direction)` design silently redid that work
  twice per range (and, for the intraday path, twice per _day_ -- up to
  ~252 extra redundant calendar builds for 1Y alone). Fixed by splitting
  `runOptimizer` into `buildOptimizerState` (builds the calendar + sorted
  ticker list once) and `runOptimizerForDirection` (runs the level-
  building loop/reconstruction for one direction off an already-built
  `OptimizerState`), plus a new exported `optimizeBothDirections` that
  calls the former once and the latter twice -- both call sites above now
  call `optimizeBothDirections` instead of the two separate functions.
  `optimizeTrades`/`optimizeWorstTrades` themselves are unchanged as a
  public API (still call `buildOptimizerState` + a single
  `runOptimizerForDirection`, for any caller that only wants one
  direction). Benchmarked (not estimated), same 503-ticker/21-year
  synthetic-data shape as the ~330ms figure above, maxTrades=3, averaged
  over 15 runs: the old "optimizeTrades then optimizeWorstTrades"
  back-to-back pattern took ~745ms total; `optimizeBothDirections` over
  the same input takes ~575ms -- about a 23% cut, consistent with
  eliminating one of the two calendar builds/ticker sorts (each direction
  alone still costs about the same ~330-370ms it always did; only the
  _second_ call's redundant setup work goes away). The doubled-cost
  intraday case (up to ~252 days x 2 for 1Y) benefits from this
  proportionally more, since its per-day calendars are far smaller and
  the fixed calendar-build/sort overhead was a proportionally larger
  slice of each call.
- **Fun/expected product quirk, not a bug**: the "Max" range genuinely
  produces astronomically large numbers (a 5-ticker demo run hit ~$716M
  from $20). That's real perfect-hindsight compounding over decades, not
  a calculation error — worth remembering when designing display/number
  formatting in `apps/web` (issue #8), since a naive `$` format will
  look absurd or broken to a first-time viewer without some framing.
  **Issue #13's short-selling mode makes this even more astronomical**:
  a short's reciprocal-price payoff (see below) is unbounded above as the
  covering price approaches zero, so `longShort.endingBalance` can exceed
  `endingBalance` by a wide margin on the MAX range -- live-verified
  (real S&P 500 data, 2026-08-21): MAX's long-only best came back
  ~$138.8B from $20, long+short's own best ~$215.1B over the _same_
  window. Same "real perfect-hindsight compounding, not a bug" framing,
  just a second axis it can come from now.

## Short-selling mode (issue #13)

`src/optimizer.ts` gains a second trade type alongside every existing
long trade: a short, opened at `P[open]` and covered at `P[close]`,
modeled as **reciprocal-price** (payoff `P[open]/P[close]`, i.e. exactly
what running the existing long formula on the reciprocal price series
`1/P(t)` would produce) rather than literal fixed-share-count short
mechanics -- see `docs/plans/issue-13-plan.md` section 1.1 for the full
derivation of why the literal model needs a fundamentally different (and
much more expensive) algorithm, and why reciprocal-price stays separable
the same way the existing long ratio is. This is a real, deliberate
economic-modeling trade-off, not an oversight: **a short's payoff under
this model is bounded below by 0 -- never negative -- unlike a real
short's unbounded downside risk.** (The plan's own section 1.4(a)
originally described this as "bounded to (0, +infinity)"; that phrasing
is imprecise, since that interval is unbounded _above_ -- the actual,
precise claim, and the one that matters for the safety argument below, is
"bounded below by 0.") That's exactly why it was safe to extend
`optimizeWorstTrades`'s min-direction search to include short candidates
too (see that function's own doc comment): a min search over a
candidate set that's bounded below by 0 can never produce an impossible
negative balance the way it would under the literal, unbounded-downside
model.

- **Gated behind an internal `includeShorts` flag, not a public
  `OptimizeOptions` field** -- `computeLevel` gains a second,
  `includeShorts`-conditional pass per ticker (structurally identical to
  the existing long pass: same suffix-best-then-`O(1)`-lookup shape, same
  `worstSentinel`/comparison primitives, just a second `g` array and the
  roles of "divide" and "multiply" swapped). `optimizeTrades`/
  `optimizeWorstTrades`/`optimizeBothDirections` all still call
  `runOptimizerForDirection` with a fixed `includeShorts: false` --
  pinned, not merely defaulted -- so their own behavior is provably
  unchanged by this issue (the long-only call path literally never
  reaches the new code). The only way to reach `includeShorts: true` is
  the new `optimizeAllVariants`, which runs all 4 direction x
  instrument-set combinations off one shared `OptimizerState`, mirroring
  `optimizeBothDirections`'s own calendar/ticker-sort sharing.
- **A new, genuinely arbitrary-but-deterministic tie-break axis**: when a
  long and a short candidate tie exactly for the same `value[d]` slot,
  the long wins -- not because of any principled preference, but because
  each ticker's long pass runs to completion (including its own
  `value[]`/`choice[]` update) before that same ticker's short pass even
  starts. Same character as the three pre-existing tie-break rules
  (cross-ticker alphabetical, cross-day earliest-wins, trade-vs-carry-
  forward strict inequality) -- about determinism given an otherwise-tied
  objective, not about maximizing.
- **The plan's own worked example for the same-ticker tie-break turned
  out not to actually exercise it, found and corrected during
  implementation (not just re-derived on paper -- checked empirically
  against the real DP).** The plan's numbers ($100/$105/$95.2381, chosen
  so `100/95.2381` ties the long's `105/100`) miss that a short opened on
  the _second_ day and covered on the third (`105/95.2381 ~= 1.1025`)
  strictly beats both intended candidates -- the DP correctly finds that
  better trade instead of the claimed tie, which is itself a small
  additional confirmation the implementation is doing the right thing,
  not a bug. `optimizer.test.ts`'s own same-ticker tie-break test uses a
  different, exhaustively-checked fixture (`[8, 10, 10, 8]`) instead of
  reusing the plan's numbers as-is.
- **`Trade`'s fields are renamed** to direction-neutral `openDate`/
  `openPrice`/`closeDate`/`closePrice` (from `buyDate`/`buyPrice`/
  `sellDate`/`sellPrice`), plus a new `direction: "long" | "short"`
  field -- `openDate`/`openPrice` always come from the earlier of the two
  indices and `closeDate`/`closePrice` from the later, regardless of
  direction, so trade reconstruction needs no direction-based branching.
  Same rename applies to `IntradayTrade` (`intraday-optimizer.ts`):
  `buyTime`/`sellTime` -> `openTime`/`closeTime`, plus `direction`.
- **`RESULTS_SCHEMA_VERSION` bumped 4 -> 5** (`results-schema.ts`) for
  the field rename plus a new `longShort` sibling field on
  `WindowResult`/`IntradayDayResult` (mirroring issue #31's `worstCase`
  sibling-field precedent, not a restructure of the existing flat
  fields). `validatePrecomputedResult` gained two new cross-checks, both
  true by construction and both live-verified as never violated on real
  data (see below): `longShort.endingBalance >= endingBalance` (a max
  search over a superset -- every long candidate plus shorts -- can never
  do worse) and `longShort.worstCase.endingBalance <= worstCase
.endingBalance` (same argument, inverted for a min search). Also a
  lower-priority optional guard: every trade in a long-only `trades`/
  `worstCase.trades` array must have `direction === "long"`, catching
  exactly the class of bug where `includeShorts` gets accidentally wired
  to `true` for a call site that should be `false`.
- **Live-verified** (real S&P 500 data, full 503-ticker universe,
  2026-08-21, no S3 write): both cross-checks held with **0 violations**
  across all 5 window ranges and all 251 real trading days of the 1Y
  intraday path. Real short trades appeared routinely, not just as a
  theoretical possibility -- every one of the 5 window ranges had at
  least one short trade in `longShort.best.trades` or
  `longShort.worst.trades`, and 218 of 251 real intraday days had a short
  trade in that day's `longShort.best.trades`.
- **Performance, live-measured (not just the plan's analytical estimate)**:
  for the single most expensive case (MAX range, full S&P 500,
  `maxTrades=3`), `optimizeAllVariants` took ~3.36s versus
  `optimizeBothDirections`'s own ~1.48s over the same input -- a ~2.3x
  ratio, in the ballpark of (a bit better than) the plan's own "roughly
  doubles per direction" framing for this single-range, single-call
  comparison. All 5 window ranges' `optimizeAllVariants` calls together
  took ~4.0s. The intraday path is comfortably cheap in absolute terms:
  ~1.08s total for all 251 real trading days' `optimizeIntradayDays`
  calls (which now always compute all 4 variants), ~4.3ms/day on
  average. Peak RSS during the window-path live-verification run (full
  fetch + all 5 ranges' `optimizeAllVariants` calls) was ~1.28GB, driven
  primarily by holding the full fetched 503-ticker/21-year daily-close
  history in memory, not by the optimizer's own additional short-search
  state.

### Code review follow-up: `computeLevel`'s long/short duplication, and `optimizeIntradayDays`' overflow containment

Two findings from a post-merge review of issue #13's PR:

- **`computeLevel`'s short-candidate pass used to be a near-verbatim
  structural duplicate of the long-candidate pass immediately above it**
  -- identical suffix-best/running-best/sentinel/tie-break machinery,
  differing only in the g/ratio formula and field names. Factored into
  one shared `runCandidatePass` helper, parameterized by two small
  formula functions (`gAt`/`ratioAt` -- `longG`/`longRatio` for the long
  pass, `shortG`/`shortRatio` for the short pass, both module-level
  constants since neither captures per-ticker state) and a
  `TradeDirection` tag for the emitted `TradeChoice`. `computeLevel`
  itself now just calls this helper twice per ticker (long
  unconditionally, short when `includeShorts`) -- same call order as
  before, so the existing "long wins an exact tie" behavior (see
  `includeShorts`'s own doc comment above) is unchanged: the long pass
  still fully updates `value[]`/`choice[]` for a ticker before that same
  ticker's short pass even starts. Pure refactor, verified against the
  full pre-existing `optimizer.test.ts` suite (974 tests, all still
  passing byte-for-byte) rather than assumed safe from reading the diff.
- **A known, documented, _not_-fixed inefficiency**: `optimizeAllVariants`'
  k=1 level does byte-for-byte identical long-pass work twice per
  direction (the long-only run's k=1 and the long+short run's k=1 both
  start from the same all-ones level-0 baseline, and the long pass has
  no dependency on `includeShorts`). Sharing it would need
  `computeLevel`/`runCandidatePass` to accept an already-computed
  baseline level instead of always initializing fresh from `prevValue` --
  judged not clean enough to be worth the added surface area for a
  saving bounded to one of up to `maxTrades` levels per run (levels
  k=2+ genuinely diverge between the two runs and have no equivalent
  redundancy). See `optimizeAllVariants`'s own doc comment for the full
  reasoning; revisit only if `computeLevel` is restructured for an
  unrelated reason that makes exposing that seam cheap.
- **`optimizeIntradayDays` now catches and contains a per-day compute
  failure** (most plausibly the same overflow issue: a short's
  reciprocal-price payoff is unbounded above as the covering price
  approaches zero) instead of letting it propagate and abort every other
  day's already-computable result. Its return type changed from a bare
  `IntradayDayResult[]` to `OptimizeIntradayResult` (`{days,
skippedDays}`, mirroring `apps/pipeline`'s own `fetchUniverseHistory`
  `{history, skipped, abortError}` shape for the identical "contain the
  failure, but still report it" problem) -- **every caller of
  `optimizeIntradayDays`, including every test, needed updating for this
  shape change**, not just apps/pipeline's own call sites. `catch (error)`
  here is deliberately broad -- any exception during a day's solve, not
  narrowed by type -- but always folds into `skippedDays` regardless of
  which exception fired; this function itself never distinguishes "the
  documented overflow" from "some other bug" (and a third code-review
  round on issue #13's PR confirmed that's correct: `catch`-and-report
  here is genuinely fine, the real gap it found was one level up, in a
  _caller_ silently discarding the `skippedDays` this function had
  already correctly populated -- see the next sentence). See
  `apps/pipeline/CLAUDE.md`'s "Code review follow-up: issue #13
  short-selling PR" section for how apps/pipeline turns `skippedDays`
  into a real, run-failing alert for _both_ the base 60-minute pass and
  every granularity override's own pass (a third code-review round fixed
  the override side, which had been wrongly treated as non-fatal by
  analogy to an unrelated case -- an override _fetch_ failure, which
  does stay non-fatal).

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
to finer granularity (see "Mixed-granularity 1M/3M assembly" below).
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
  verified boundary) -- see `apps/pipeline/CLAUDE.md`'s "Granularity
  overrides" section for why that's fine either way (the whole path
  degrades gracefully regardless of which error class trips it).
- `adjclose` is absent from real 5-minute responses too, same as 60m --
  not re-verified bar-by-bar here since the parsing path
  (`parseIntradayChartResult`/`extractCloses`) is shared code already
  covered by the 60m verification above.

## 1-minute intraday bars (issue #29)

`fetchIntraday1mBars` in `src/yahoo-client.ts` fetches `interval=1m`
bars, upgrading the 1M range's days to finer granularity -- same
`GranularityOverride`/best-effort pattern issue #30 established for 3M
(see "Mixed-granularity 1M/3M assembly" below), landed just after #30 in
this codebase's history. Shares `fetchChartSeries`/
`parseIntradayChartResult` with every other intraday fetch function, but
**unlike 60m/5m, needs internal chunking** -- `interval=1m` has two
independent limits, both verified live against the real endpoint
(2026-08-21), neither assumed from the 60m/5m cases:

- **Retention is a hard 30-day wall**, the same "N-1 succeeds, N fails"
  pattern as 5m's 60-day / 60m's 730-day limits: a request with
  `period1` 29 days back from the real request time succeeds (391 bars,
  a full trading day); one 30 days back fails with a 422
  (`chart.error.description`: `"1m data not available for startTime=...
The requested range must be within the last 30 days."`). Yahoo's own
  error text says "30 days" -- don't read that as "30 is safe"; the wall
  is _at_ 30, so 29 is the largest genuinely safe value.
  `apps/pipeline`'s `ONE_MINUTE_LOOKBACK_DAYS = 29` encodes this (one
  full day inside the verified boundary, same "N-1" convention as
  `FIVE_MINUTE_LOOKBACK_DAYS`). Same operational gotcha as 5m: this 422
  is `!response.ok`, so `fetchChartSeries` throws
  `UnexpectedResponseError` from the status-code branch, not
  `TickerNotFoundError` from `chart.error` -- see 5m's own bullet above
  for why that distinction matters and how the pipeline avoids ever
  depending on which one fires (the whole path degrades gracefully
  regardless).
- **A single request may span at most 8 calendar days**
  (`ONE_MINUTE_CHUNK_DAYS`, module-private -- unlike the retention
  window, chunking is an implementation detail no caller needs to know
  about), a _separate_ limit from retention: a request spanning exactly
  8 days succeeds (2,341 bars), one spanning 9 days fails with a
  _different_ 422 (`chart.error.description`: `"Only 8 days worth of 1m
granularity data are allowed to be fetched per request."`). Because of
  this, `fetchIntraday1mBars` is the only fetch function in this file
  that can issue **multiple HTTP requests for one logical call**: it
  splits the (already end-padded) total range into consecutive,
  non-overlapping <=8-day chunks and awaits them **sequentially**, not
  concurrently -- see `apps/pipeline/CLAUDE.md`'s "Granularity overrides"
  section (the "Per-override specifics" part) for why sequential
  chunking means this override doesn't need its own lower concurrency
  knob the way an earlier draft of this plan assumed it would. Only the
  conceptual _last_ chunk carries the padded
  end (the total range is padded once, then chunked, rather than padding
  every chunk independently, which would let chunk seams overlap and
  double-count a bar) -- a defensive dedup-by-`date` pass still runs
  when concatenating chunks regardless. A chunk that ultimately fails
  (after its own retries, or immediately for `BlockedError`/
  `TickerNotFoundError`/`UnexpectedResponseError`) discards that
  ticker's earlier chunks rather than returning a partial month --
  matches every other fetch function's all-or-nothing per-ticker
  contract, at the cost of each ticker's 1m fetch having ~4 independent
  chances to fail where 60m/5m have 1. Not yet observed to meaningfully
  raise 1M's `skippedTickers` in practice as of this issue's
  implementation -- worth watching after a real pipeline run.
- **Memory (corrected during this issue's plan review)**: the original
  draft plan's back-of-envelope estimate had an arithmetic error in its
  own component figures (its "~120-160 bytes/bar" assumption didn't
  match the ~24-32 + ~16-24 + ~35-40 byte components it listed, which
  sum to ~75-96 bytes/bar) -- corrected to **~350-450MB** of added
  memory for the 1-minute fetch specifically (not the draft's original
  ~618MB estimate). The qualitative conclusion held regardless: a real
  measured baseline of 903MB/1024MB (pre-#29, see
  `apps/pipeline/CLAUDE.md`) leaves only ~121MB of headroom, and even
  the corrected, smaller estimate is roughly 3-4x that headroom --
  hence the proactive `memorySize` bump to 2048MB in
  `infra/cdk/lib/hadiknowntrades-stack.ts` alongside this issue's code
  (not yet deployed -- see `infra/CLAUDE.md`). `optimizeIntradayDays`'s
  own per-ticker timestamp-array structures add further, unquantified
  memory beyond the raw fetched bars (~56x denser for 1-minute vs.
  60-minute data) -- flagged by the review as a real secondary
  contributor, not addressed by a code change here.

## Mixed-granularity 1M/3M assembly (issues #30, #29)

3M's and 1M's per-day results (`IntradayResult.days`) are each assembled
from **two separate `optimizeIntradayDays` calls, merged**, not from a
single mixed-granularity fetch or DP: one over the existing 60-minute-bar
history (shared across 1M/3M/1Y), one over a second, finer-granularity
fetch scoped to a shorter lookback (5-minute for 3M, last 59 days;
1-minute for 1M, last ~29 days -- see the "5-minute"/"1-minute intraday
bars" sections above for the exact retention walls behind each number).
`apps/pipeline`'s `buildIntradayResults` merges each range's two
day-result arrays keyed by date via the same, granularity-agnostic
`mergeDaysByGranularity`: for a date only one array covers, that one
wins by default; for a date **both** cover, it's NOT an unconditional
"finer granularity wins" -- it keeps whichever day's `endingBalance` is
actually higher (both solved with the same `startingCapital`, so
directly comparable). This matters because the two granularities'
fetches can see different ticker universes for the same day (a ticker's
finer-granularity fetch can fail for a day its 60-minute fetch succeeded
on), so the finer day can legitimately be the _worse_ one -- a real
correctness bug caught in #30's code review before this comparison
existed: unconditionally preferring the finer granularity regardless of
outcome could make a range's result strictly worse than what
60-minute-only data would have shown, which cuts against this app's
whole "best possible outcome" premise. 1Y is untouched by both issues --
it only ever reads the 60-minute day-result array.

- **1M's own window can genuinely outreach its finer-granularity
  fetch's lookback, unlike 3M's** -- a real, non-hypothetical
  consequence of the numbers involved, not just a theoretical edge case:
  1M's own start date (`presetRangeStartDate("1M", asOf)`) can land up
  to 31 calendar days back (a 31-day source month), one day past the
  1-minute fetch's ~29-day retention wall -- so it's normal, not a bug,
  for 1M's oldest day or two to have no 1-minute data at all and fall
  back to 60-minute via the same merge mechanism 3M's older (>59-day)
  days already use. 3M's own window (up to ~92 days) so comfortably
  exceeds its 5-minute fetch's 59-day lookback that this "does the
  override's own window fully cover the range's window" question never
  came up as sharply during #30 -- #29's plan review is what surfaced it
  explicitly, and the fix is: don't try to make the fetch's lookback
  match the range's window exactly, just clamp to the fetch's own safe
  retention limit and let the existing merge/fallback machinery handle
  the gap, exactly as it already does for 3M's older days.
- `IntradayDayResult.barIntervalMinutes` (stamped by
  `optimizeIntradayDays` from `OptimizeIntradayOptions.barIntervalMinutes`,
  required, not inferred) makes this visible **in the output itself**,
  per-day -- deliberately not left as something a reader has to infer
  from a day's date relative to "now," since issue #30's own text called
  that out explicitly as non-obvious. 1Y days always carry `60`; 3M's
  recent ~59 days carry `5` (older days carry `60`); 1M's days carry `1`
  wherever the 1-minute fetch reached, `60` for the day or two (if any)
  it didn't -- genuinely mixed within both 1M's and 3M's `days` arrays.
- **Both override paths are deliberately best-effort, not held to the
  same alerting standard as the window/intraday path split** (see
  `apps/pipeline/CLAUDE.md`'s "Two independent paths since issue #28"
  section for that standard): a 5-minute or 1-minute fetch that aborts
  or comes back empty makes that range's affected days silently fall
  back to 60-minute bars -- i.e. exactly that range's pre-#30/pre-#29
  behavior -- rather than failing the whole pipeline run. This was a
  deliberate judgment call for #30, not an oversight, and #29 follows
  the identical reasoning rather than re-litigating it: the
  window-vs-intraday split's strict "must still fail the run" rule
  exists because a silent failure there means a whole range serves
  frozen/stale JSON forever with nothing to notice it; a granularity-
  override failure instead means that range reverts to already-shipped,
  fully-correct (just coarser) 60-minute data -- qualitatively different
  from serving stale or broken output. Re-litigate this if
  finer-granularity data for either range ever becomes something the
  product depends on rather than a bonus precision upgrade.
- Per-ticker skips accumulated by a finer-granularity fetch are still
  merged into that range's own `skippedTickers` (and the pipeline-wide
  summary) even though that failure doesn't fail the run -- a ticker
  that fails only the finer-granularity fetch but succeeds the
  60-minute one can still be missing from a day it would otherwise have
  won on, since a day's winning granularity is picked wholesale (see the
  merge-correctness point above), not spliced per-ticker within a day --
  worth surfacing as a skip even though that ticker's other days/ranges
  are unaffected.
- Each range's `dataAsOf` folds in its own override fetch's freshness
  via `maxDateString`, not just the 60-minute fetch's -- a real bug
  caught in #30's code review, since a range's merged days can include
  one sourced only from its override fetch, and using only the
  60-minute fetch's `dataAsOf` could understate how fresh that range's
  data actually is, contradicting that field's own documented meaning
  ("the actual last trading date found in the fetched data" -- see
  `apps/pipeline/CLAUDE.md`). 1Y has no override and is unaffected.
- The per-range override (which extra history/skips/dataAsOf a range
  folds in beyond the base 60-minute data) is centralized in one
  `granularityOverrides: Map<PresetRange, GranularityOverride>` lookup
  in `buildIntradayResults`, not a hardcoded `range === "3M"`/
  `range === "1M"` branch -- #30's own code comment anticipated exactly
  this: "a future granularity override (e.g. issue #29's 1-minute bars
  for 1M) adds one map entry instead of a third bespoke branch," and
  #29 followed that instruction literally rather than reintroducing a
  parallel branch structure.
- `RESULTS_SCHEMA_VERSION` was **not** bumped for either issue --
  `barIntervalMinutes` is a purely additive field on an already-versioned
  shape (`IntradayDayResult`, introduced at schema version 2 by #28), and
  nothing in `apps/web` reads it yet. The version-bump criterion
  documented on `RESULTS_SCHEMA_VERSION` itself is "a shape change a
  reader needs to know about" -- an additive field no current reader
  depends on doesn't meet that bar. Revisit if `apps/web` ever starts
  branching on this field's presence.

## Buy-and-hold (SPY) benchmark field (issue #12)

`results-schema.ts`'s `BenchmarkResult` (a `benchmark: BenchmarkResult |
null` field on `PrecomputedResultBase`, so every `WindowResult`/
`IntradayResult` carries it) is a whole-window SPY buy-and-hold
comparison -- see `apps/pipeline/CLAUDE.md`'s own "Buy-and-hold (SPY)
comparison stat" section for how it's computed, and specifically for a
real, live-checked bug (~28% of days false-positive a `truncated` flag
under the plan's original, more obvious expression) that a naive port of
that field wouldn't have caught.

- **`RESULTS_SCHEMA_VERSION` bumped 3 -> 4** (issue #31's own 2 -> 3
  landed first, in parallel; #12 rebased its own version bump on top
  rather than colliding with it -- exactly the merge-order reconciliation
  this constant's own bump history keeps needing, see #28/#30/#29's own
  notes above).
- **`validateBenchmark` deliberately distinguishes `undefined` from
  `null`** -- same care as `schemaVersion`'s own exact-equality check
  (see "Write-time result self-validation" below): `value === null`
  passes (a valid "no benchmark data this run" state), but an
  entirely-missing field fails `typeof value !== "object"`, catching a
  stale pre-#12 stored object or a future refactor bug that forgets to
  set the field -- rather than a looser `value == null` blurring the two.
- Exported from `index.ts` alongside the other `results-schema.ts`
  types -- the plan this issue was built from originally missed this
  (its own UI code imported `BenchmarkResult` from
  `@hadiknowntrades/core` without ever adding the export), caught before
  implementation started, not after a build failure.

## Write-time result self-validation (issue #47)

`src/results-schema.ts`'s `validatePrecomputedResult` is a runtime,
hand-rolled check that a `PrecomputedResult` actually satisfies its own
declared shape (`WindowResult`/`IntradayResult`, discriminated by
`model`) -- required fields present, `startingCapital`/`endingBalance`/
prices/day-balances finite numbers, `trades`/`days` arrays well-formed
-- throwing `ResultValidationError` (every problem found, not just the
first) if not. `apps/pipeline/src/pipeline.ts` calls it immediately
before each range's `putObject` (see `apps/pipeline/CLAUDE.md`).

- **Deliberately hand-rolled, not a schema library** (e.g. zod) --
  checked first per the issue's own scope note, and this package has no
  runtime-validation dependency today; the shape is small, stable, and
  cheaper to keep in sync by hand-reading it against the interfaces
  above than by maintaining a second, library-specific representation
  of the same shape. Revisit if the shape ever grows enough that
  hand-sync stops being the cheaper option.
- **Must treat its input as untrusted despite the `PrecomputedResult`
  compile-time parameter type** -- the whole point is catching a bug
  that produces a runtime value violating that type despite TypeScript
  (e.g. a `NaN` slipping through arithmetic, exactly optimizer.ts's own
  `OptimizerInputError` "computed a non-finite endingBalance" case, just
  on the _output_ side instead of input). Every field access inside the
  validator goes through an `unknown`/`Record<string, unknown>` cast and
  an explicit runtime check (`Number.isFinite`, `Array.isArray`, etc.) --
  never a bare property read trusted to have the declared type, which
  would silently defeat the check for exactly the bug class it exists to
  catch.
- Same "defense in depth" spirit as `optimizer.ts`'s own input
  validation (see above), just facing the opposite direction: that
  validates the optimizer's _inputs_ before use; this validates the
  pipeline's _output_ right before it becomes what `apps/web` reads --
  there's nothing further downstream to catch a bad value once this
  passes.
- **`schemaVersion` is checked for exact equality against
  `RESULTS_SCHEMA_VERSION`, not just "is it a non-negative integer."**
  An earlier version of `validateBase` only did the looser check --
  caught in code review as a real gap, not a nitpick: a stale or
  reverted `schemaVersion` (e.g. a rollback that regressed the constant
  without regenerating results, or a hand-crafted test fixture that
  forgot to bump it) is exactly the kind of self-inconsistency this
  validator exists to catch, and "any non-negative integer" would
  silently accept it.
- **`isPositiveFiniteNumber` (used for `startingCapital`/`endingBalance`/
  day balances/`buyPrice`/`sellPrice`) builds on `is-valid-price.ts`'s
  `isValidPrice`** (`typeof v === "number" && isValidPrice(v)`) rather
  than re-deriving `Number.isFinite(value) && value > 0` independently
  -- also caught in code review: `optimizer.ts` and `yahoo-client.ts`
  already centralize that exact predicate through `isValidPrice`
  specifically so "legitimate price" can't drift between call sites,
  and this validator had quietly re-implemented it a third time. The
  predicate is unchanged either way (both are `Number.isFinite(value) &&
value > 0`); this is a reuse fix, not a behavior change.

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
- **Worst-case per day (issue #31)**: `optimizeIntradayDays`'s own
  `.map()` body is the one place this issue's design isn't a clean
  "leave the existing function untouched" mirror of `optimizer.ts`'s
  `optimizeTrades`/`optimizeWorstTrades` split -- there's no way to
  attach a `worstCase` field to a day's single returned
  `IntradayDayResult` object without touching this function's body, since
  `IntradayDayResult` is one combined per-day record, not two separate
  ones a caller merges. Fix: the per-day `.map()` callback also calls
  `optimizeWorstTrades(dayBars, ...)` and folds the result into
  `worstCase: { endingBalance, trades }` (`IntradayWorstCaseResult`) on
  the same object -- additive to this function's implementation, no
  change to any existing optimal-case value/behavior. `apps/pipeline`'s
  `pipeline.ts` needed **zero** changes for the intraday path as a
  result: it already treats `IntradayDayResult` as opaque everywhere
  (`sixtyMinuteDays`, `mergeDaysByGranularity`, the final `days` array),
  so `worstCase` flows through every one of those call sites for free
  once `IntradayDayResult` itself carries it.
- **No longer a bare `.map()` (code review follow-up to issue #13)**: the
  per-day body is now a `for...of` loop with a try/catch around each
  day's `optimizeAllVariants` call, so one day's compute failure (see
  "Code review follow-up" above) doesn't propagate and abort every other
  day's already-solved result. The return type changed to match --
  `OptimizeIntradayResult` (`{days, skippedDays}`), not a bare
  `IntradayDayResult[]` -- see that section for the full reasoning and
  what apps/pipeline does with `skippedDays`.

## Custom date-range anchors (issue #11)

`src/custom-range-anchors.ts` is the coarsened answer to "arbitrary
date-range picker" -- see `docs/plans/issue-11-plan.md`'s section 1 for
the full design writeup and section 3 (of the deferred original
research) for why the issue's _literal_ ask (day-granularity, both
endpoints free) isn't nightly-recomputable at any real scale (~14
million pairs). `customRangeAnchors(asOf)` returns the 1st of every
calendar month for `CUSTOM_RANGE_ANCHOR_YEARS_BACK` (21) years back from
`asOf`, newest first -- 252 `AnchorMonth` (`YYYY-MM`) strings, the single
source of truth both `apps/pipeline` (computes+writes a result for every
one, nightly) and `apps/web` (the date-picker only ever offers this exact
list) import.

- **21 years, not MAX's own true unbounded reach** -- deliberately chosen
  to match the depth this package's own optimizer benchmark already uses
  ("Optimizer algorithm" section above, ~330ms for a 21-year window), a
  concretely cost-modeled number rather than an attempt to match every
  individual ticker's real (sometimes much deeper) Yahoo history. Bump
  the constant later if a deeper reach is ever wanted -- nothing else
  hardcodes 252 or 21 a second time.
- **No missing/holiday-date snapping logic needed here at all** -- a real
  surprise relative to how much design effort the deferred live-compute
  research (section 2 of the plan) spent working this out. Each anchor's
  start is always a _calendar_ month boundary (the 1st), and the ordinary
  `p.date >= startDateString` slicing filter every preset range's own
  `startDate` already goes through (`apps/pipeline/src/pipeline.ts`'s
  `computeWindowOptimization`) already forward-snaps to the nearest real
  trading day on or after it, with zero new code. The end date is always
  "today," handled identically to how every preset range already handles
  it. Live-verified end to end (a real fixture with a gap right at an
  anchor's own boundary correctly snaps forward to the next real bar --
  see `apps/pipeline/src/pipeline.custom-range.test.ts`).
- `anchorMonthToDate`/`toAnchorMonth` round-trip an `AnchorMonth` string
  to/from a UTC `Date` at the 1st of that month. **`customRangeAnchors`
  itself now actually calls `toAnchorMonth` to format each generated
  anchor, instead of hand-rolling the identical zero-pad formatting a
  second time inline (second-round code review finding, fixed)** --
  `toAnchorMonth` was exported through this package's public API
  (`index.ts`) specifically for this, but had zero real callers anywhere
  in the codebase until this fix; `customRangeAnchors` is the one real
  producer of `AnchorMonth` strings, so it's the one place this should
  have been calling it all along. No behavior change -- same output for
  every anchor, just one implementation of the formatting instead of two
  that could silently drift.
  The regex
  (`^\d{4}-(0[1-9]|1[0-2])$`) is what rejects an out-of-range month like
  `"2019-13"`, but is **NOT** sufficient on its own for the year (a real
  bug, found in code review, fixed): a syntactically well-formed 4-digit
  year like `"0099"` still triggers JS's legacy `Date.UTC`/`new
Date(year, ...)` two-digit-year reinterpretation rule (years 0-99
  silently become 1900-1999), so `anchorMonthToDate("0099-06")` used to
  silently return a `Date` for 1999-06, not year 99 -- `GET
/api/results?anchor=0099-06` would have passed both the regex and
  `apps/web`'s `parseAnchorMonth` (`results-api.ts`) unrejected.
  `anchorMonthToDate` now also rejects a year outside a generous sane
  range (`MIN_ANCHOR_YEAR = 1970` through "next calendar year") -- see
  that constant's own doc comment. `CustomRangeSelector.tsx`
  (`apps/web`) had independently re-implemented this same
  slice+`Date.UTC` parse (its `formatAnchorLabel`) and was exposed to
  the identical bug; fixed to call `anchorMonthToDate` instead of
  re-deriving the parse a second time.
- **`results-schema.ts`'s `CustomWindowResult`** is a sibling of
  `PrecomputedResult`, not a third union member -- see that type's own
  doc comment for why (folding a 252-member anchor set into `PresetRange`
  would mean loosening that closed 5-member union everywhere it's
  exhaustively iterated). Still gated by the same `RESULTS_SCHEMA_VERSION`
  as every `PrecomputedResult`, unlike the live-compute design's own
  original judgment call to exempt an on-demand result from that check --
  a `CustomWindowResult` here _is_ written by a separate process
  (`apps/pipeline`, nightly) from the one that reads it (`apps/web`), the
  same writer/reader-drift risk that constant exists to catch everywhere
  else, so it reuses the same protection.
- `customResultKey(anchorMonth)` -> `results/custom/{anchorMonth}.json`,
  namespaced under its own prefix so the two result families (5 presets,
  252 custom anchors) are trivially distinguishable by key prefix alone.
- `validateCustomWindowResult` reuses every one of
  `validatePrecomputedResult`'s own private field-level validators
  (`isPositiveFiniteNumber`, `validateTrade`, `validateWorstCaseResultWith`,
  `validateBenchmark`) rather than re-deriving a second copy -- the two
  validators can't drift on what counts as e.g. a valid `Trade`.
  **This used to stop at just those low-level validators, leaving the
  higher-level field lists (schemaVersion, generatedAt, dataAsOf,
  startingCapital, universeSize, skippedTickers, benchmark, endDate,
  maxTrades, endingBalance, trades, worstCase) independently hand-typed
  in both functions -- a real, code-review-caught duplication (~50
  overlapping lines) since fixed**: `validateBase` (the `range`-bearing
  half) and `validateCustomWindowResult` now both call two extracted
  helpers, `validateSharedResultFields` (everything but `range`/
  `anchorMonth`) and `validateWindowLikeFields` (endDate/maxTrades/
  endingBalance/trades/worstCase, also shared with
  `validatePrecomputedResult`'s own "window" branch) -- so a future rule
  change to any of these shared checks can no longer land in one
  validator's copy and silently miss the other, which is exactly the
  risk this write-time safety net (issue #47) exists to close.
- **Live-verified, real numbers, no S3 write** (full 503-ticker S&P 500
  universe, real Yahoo network calls, all 252 real anchors, throwaway
  Vitest file deleted before commit -- same technique issue #31's own
  live verification used): full run (every fetch pool + solving all 5
  preset ranges + all 252 custom anchors) completed in **154.0s (~2.6
  minutes)**, 0 of 503 tickers skipped, **431.5KB** total across all 252
  custom-anchor result objects' serialized JSON -- comfortably inside the
  pipeline Lambda's 15-minute timeout, and S3 storage growth is
  negligible against the $20/month budget. See
  `docs/plans/issue-11-plan.md` section 1.6 for the full run's numbers.

### Merged with issue #13's short-selling mode

Issues #11 and #13 were developed in parallel branches and merged after
both had independently landed on `main`/this branch -- `CustomWindowResult`
originally had no `longShort` field, and `apps/pipeline`'s
`buildCustomWindowResults` originally called the long-only-only
`optimizeBothDirections` (issue #31's own best/worst sharing) rather than
issue #13's `optimizeAllVariants`. Integrated at merge time, not left as
two features sitting side by side:

- **`CustomWindowResult` gained the same `longShort: LongShortResult`
  sibling field `WindowResult`/`IntradayDayResult` already carry** (see
  that field's own doc comment in `results-schema.ts`) -- the same
  additive-sibling pattern issue #13 already established, applied to this
  third whole-window-shaped result type.
- **`validateWindowLikeFields` (the shared validator both
  `validatePrecomputedResult`'s "window" branch and
  `validateCustomWindowResult` call) now also owns the long+short
  cross-checks and the `validateAllTradesAreLong` guard**, not just the
  long-only fields it validated before this merge -- so `CustomWindowResult`
  gets `longShort.endingBalance >= endingBalance` /
  `longShort.worstCase.endingBalance <= worstCase.endingBalance` checked
  for free the moment it grows a `longShort` field, with no separate
  custom-anchor-specific validation code to keep in sync.
- **`apps/pipeline`'s `computeWindowOptimization`** (the shared
  windowed-slice + DP helper `buildWindowResults` and
  `buildCustomWindowResults` both call -- see `apps/pipeline/CLAUDE.md`)
  **now calls `optimizeAllVariants` instead of `optimizeBothDirections`**,
  so every whole-window result -- preset range or custom anchor -- gets
  computed off the same one shared `OptimizerState` per window, all 4
  direction x instrument-set combinations at once, exactly like issue
  #13's own `buildWindowResults` already did before this merge (which,
  before the merge, called `optimizeAllVariants` directly rather than
  going through this shared helper at all -- issue #11's
  `computeWindowOptimization` didn't exist yet on issue #13's own branch).
- **`buildCustomWindowResults` also gained the same per-anchor try/catch
  containment `buildWindowResults` already has** (see
  `apps/pipeline/CLAUDE.md`'s "Code review follow-up: issue #13
  short-selling PR" section) -- a genuinely new correctness need this
  merge surfaced, not carried over from either branch alone: once a
  custom anchor's window is solved via the same `optimizeAllVariants` a
  preset range's is, it's exposed to the identical short-payoff-overflow
  risk (see "Short-selling mode" above), and with up to ~252 anchors
  computed per run, letting one anchor's overflow abort every other
  already-computable anchor would have been a much larger regression than
  it would be for just the 2 window ranges.
