# Plan: issue #28 - per-day intraday trading model (1M/3M/1Y, 60m bars)

Status: draft for review, no implementation yet. Written against the repo
at commit `2965c6a`.

## 1. Data fetch: 60-minute bars in `packages/core`

**Reuse, not duplicate.** `yahoo-client.ts`'s `fetchDailyCloses` already
has all the machinery this needs: retry/backoff, `BlockedError` /
`TickerNotFoundError` / `UnexpectedResponseError` / `TransientFetchError`,
UA header, timeout, malformed-shape guards. None of that is
interval-specific. Plan:

- Extract the request/parse/retry loop into a private
  `fetchChartSeries(symbol, url, options)` helper that both
  `fetchDailyCloses` and a new `fetchIntradayBars` call. The only things
  that differ between daily and 60m are: the `interval` query param, the
  `period2` day-padding (daily pads by a full day since bars are
  timestamped near market open, not midnight - unnecessary and arguably
  wrong for intraday, where `to` should be used close to as-is), and the
  returned type's field naming.
- New public function:
  ```ts
  export interface IntradayBar {
    /** Local datetime the bar starts at, e.g. "2026-08-21T14:30:00" (no
     *  timezone suffix - local to the exchange, matching how DailyClose's
     *  date string is already exchange-local, not UTC). */
    datetime: string;
    close: number;
  }
  export async function fetchIntradayBars(
    symbol: string, from: Date, to: Date,
    options: { fetchImpl?: typeof fetch } = {},
  ): Promise<IntradayBar[]>
  ```
  Interval is hardcoded to `60m` inside this function for now (not a
  parameter) - the issue is explicit that finer granularities are
  deferred to #29/#30, and a premature `interval` parameter would be
  speculative generality this codebase's style avoids elsewhere (see
  `MAX_REASONABLE_TRADES`'s comment on rejecting-not-anticipating). When
  #29/#30 land, widening this to a parameter is a small, low-risk change.
- New date/time helper alongside `unixToLocalDateString`:
  `unixToLocalDateTimeString(unixSeconds, gmtoffsetSeconds)` returning
  `YYYY-MM-DDTHH:MM:SS`. **This is where the existing documented DST
  caveat stops being inert.** `packages/core/CLAUDE.md` already flags
  this: daily bars are safely mid-morning so a 1hr DST error never flips
  the calendar date, but that reasoning does not obviously extend to
  every 60m bar - the first bar of the day sits right at market open
  (9:30 ET) and the last near market close (16:00 ET), and Yahoo's
  `gmtoffset` reflects the *request-time* offset, not the historically
  correct one for that specific historical bar. A DST-boundary week could
  misattribute a 9:30am bar to the wrong calendar day if the offset used
  is off by an hour in the wrong direction. **This needs a real check
  against live data during implementation** (e.g. fetch a known
  DST-transition week and confirm every bar's date-bucketing is right),
  not an assumption - flagged as an open question below.
- Error-shape nuance: `fetchDailyCloses` treats `body.chart.error` as
  "ticker has no data" (`TickerNotFoundError`). For intraday, the same
  field is also how Yahoo reports "interval not available for this date
  range" (per the issue's verified retention table, e.g. `"1m data not
  available for startTime=... range must be within the last 30 days"`).
  Since the pipeline will only ever request a 60m range comfortably
  inside the 730-day cap (see §4), this should never actually fire for
  us - but if it ever does, it'll surface as a misleading
  `TickerNotFoundError` for what's actually a caller-side range bug, not
  a real "this ticker doesn't exist." Documented as a known
  sharp edge rather than solved (not worth a new error class for a path
  that shouldn't be reachable given how the pipeline calls it).
- `apps/core`'s index barrel needs `fetchIntradayBars` / `IntradayBar`
  exported alongside the existing daily-close exports.

## 2. Per-day optimizer

**Key design decision: this needs no new DP.** The issue's computational
note says each trading day is an independent sub-problem - solve each day
separately and concatenate. `optimizer.ts`'s `optimizeTrades()` already
operates on `Map<string, { date: string, close: number }[]>` where `date`
is just an opaque, sortable, unique string key - it never assumes
calendar-day semantics. So a "per-day optimizer" is a thin wrapper that:

1. Groups a window's `IntradayBar[]` per ticker by calendar date (the
   `YYYY-MM-DD` prefix of `datetime`).
2. For each date present in the window (sorted), builds a
   `Map<string, IntradayBar[]>` containing only that date's bars across
   all tickers, and calls `optimizeTrades(dayBars, { startingCapital, maxTrades: n })`
   directly - reusing the existing DP, tie-break, and validation
   unchanged.
3. Collects one result per day.

This lives in a new `packages/core/src/intraday-optimizer.ts`:

```ts
export interface IntradayDayResult {
  date: string;               // YYYY-MM-DD
  startingCapital: number;
  endingBalance: number;
  trades: IntradayTrade[];
}

export interface IntradayTrade {
  ticker: string;
  buyDate: string;   // YYYY-MM-DD, same as sellDate (same-day only)
  buyTime: string;   // HH:MM:SS local
  buyPrice: number;
  sellTime: string;
  sellPrice: number;
}

export function optimizeIntradayDays(
  barsByTicker: Map<string, IntradayBar[]>,
  options: { startingCapital: number; maxTradesPerDay: number },
): IntradayDayResult[]
```

Internally, `optimizeTrades`'s returned `Trade.buyDate`/`sellDate` will
literally contain the full `datetime` string we fed it (since it just
echoes back whatever key/date string the caller supplied) - the wrapper
splits that back into `{ date, time }` before returning, so the public
`IntradayTrade` shape is unambiguous instead of silently overloading
`Trade.buyDate` to sometimes mean "date" and sometimes "full timestamp."
This matters for reuse safety: `Trade` is already imported and rendered
in `apps/web` (`TradeList.tsx`, `PortfolioChart.tsx`, `format-date.ts`),
all of which assume `buyDate`/`sellDate` are plain calendar dates and
parse them as `${date}T00:00:00Z`. Reusing `Trade` unmodified for
intraday output would silently corrupt those call sites' date parsing
(collapsing every intraday point to midnight) rather than erroring -
worth a real regression to avoid, hence the distinct `IntradayTrade`
type.

- Days with zero tickers having any bars (holidays, or a data gap) are
  skipped entirely, not included as an empty-trades day - consistent
  with how `runPipeline` already drops empty per-ticker slices before
  calling the optimizer (`if (sliced.length > 0) windowed.set(...)`).
- `startingCapital` resets to the same value (`$20` by default) **every
  day independently** - it does not compound across days. This is the
  biggest judgment call in this plan (see Open Questions §7) but is what
  the issue's own framing implies: "no state carries across days" plus
  the acceptance criteria's example ("the max money they could have made
  on 8/21") describes each day as its own self-contained scenario, not a
  running portfolio.

## 3. Results schema (`packages/core/src/results-schema.ts`)

Bump `RESULTS_SCHEMA_VERSION` to `2`. Rather than two independently
versioned shapes (which `apps/web`'s `getResultsResponse` isn't built to
handle - it checks one global `RESULTS_SCHEMA_VERSION` regardless of
range), make `PrecomputedResult` a discriminated union so one version
number covers both shapes and the reader branches on a `model` field:

```ts
export type ResultModel = "window" | "intraday-daily";

interface PrecomputedResultBase {
  schemaVersion: number;
  range: PresetRange;
  generatedAt: string;
  dataAsOf: string;
  startingCapital: number;
  universeSize: number;
  skippedTickers: string[];
}

export interface WindowResult extends PrecomputedResultBase {
  model: "window";
  startDate: string | null;
  endDate: string;
  maxTrades: number;          // was implicit/undocumented before; now explicit, see #5
  endingBalance: number;
  trades: Trade[];
}

export interface IntradayResult extends PrecomputedResultBase {
  model: "intraday-daily";
  endDate: string;
  maxTradesPerDay: number;
  days: IntradayDayResult[];
}

export type PrecomputedResult = WindowResult | IntradayResult;
```

- **Backward compatibility: none, deliberately.** This is a hard cutover,
  matching how `getResultsResponse` already treats any schema mismatch as
  a hard 502 (`schema_mismatch`), not a soft-degrade path. Given this is
  "a learning project, not high-stakes production" (root CLAUDE.md), a
  brief window of `schema_mismatch` errors immediately after deploy,
  until the pipeline's next run rewrites all 5 range keys, is acceptable
  rather than worth the complexity of a version-negotiating reader.
- **Real deploy-ordering hazard worth flagging explicitly**: 5Y/MAX are
  functionally unchanged by this issue (still `WindowResult`), but they
  still get a `schemaVersion` bump (2) and a new required `model: "window"`
  field, purely because the version number is global. That means *all
  five* range files need to be rewritten by a pipeline run before or
  atomically with deploying the new `apps/web` (which will reject
  `schemaVersion: 1` objects, including 5Y/MAX's, once deployed) - not
  just the three ranges this issue actually changes behavior for.
  Concretely this means: deploy pipeline first, manually trigger one
  real run (writes all 5 keys with `schemaVersion: 2`), confirm via S3
  the objects are correct, *then* deploy `apps/web`. That manual trigger
  is a real-AWS action and needs the user's explicit go-ahead per this
  repo's working agreement - not performed in this plan, called out here
  as a required step in the implementation PR's rollout, not skipped
  silently.
- `resultKey(range)` is unaffected - still one key per range,
  `results/{RANGE}.json`; the shape at that key just differs by range now.

## 4. `apps/pipeline` wiring

`runPipeline()` currently loops over all 5 `PRESET_RANGES` uniformly with
one daily-close fetch. Split into two parallel paths:

- **5Y/MAX**: unchanged fetch (`fetchDailyCloses`, full history from
  `earliestDate`) and unchanged `optimizeTrades` call, just adding
  `model: "window"` and `maxTrades` to the written object.
- **1M/3M/1Y**: a second, independent universe fetch via
  `fetchIntradayBars`, requested over a window comfortably covering all
  three (1Y is the widest, so fetch `asOf` minus ~400 calendar days to
  `asOf` - padding past exactly 366 days for weekends/holidays safety
  margin, still nowhere near the 730-day cap), then sliced locally per
  range by calendar date - same "fetch once, slice many" pattern already
  used for daily closes (see `apps/pipeline/CLAUDE.md`), just as a
  second, parallel intraday fetch rather than folded into the existing
  one.
- `fetchUniverseHistory` (the bounded-concurrency + `BlockedError`/
  `UnexpectedResponseError`-abort worker pool in `pipeline.ts`) is
  already generic over "a fetch function returning some array of
  `{date, close}`-shaped things" in spirit, even though it's currently
  typed concretely against `fetchDailyCloses`'s signature. Generalize its
  type signature (not its logic - the logic is already interval-agnostic)
  so both the daily and intraday fetches reuse the exact same worker
  pool/abort/skip code instead of a copy-pasted second version.
- **Judgment call on fetch independence**: run the daily and intraday
  universe fetches concurrently (`Promise.all`) rather than serially, and
  treat their abort conditions independently - a systemic `BlockedError`
  on the *intraday* fetch (e.g. Yahoo disables the 60m interval, or
  starts blocking it specifically) shouldn't take down 5Y/MAX, which
  don't depend on it, and vice versa. Concretely: if the intraday fetch
  aborts or the resulting per-range `days` list ends up empty (mirroring
  the existing "zero tickers succeeded" guard, generalized to "zero days
  produced any result"), refuse to overwrite the existing 1M/3M/1Y S3
  objects for *those three ranges only*, while 5Y/MAX still write
  normally if their own fetch succeeded. This is a natural extension of
  the existing "don't overwrite good data with an empty run" principle,
  just scoped per-path instead of globally all-or-nothing.
- `n` (max trades per day) lives as a new named constant
  `DEFAULT_MAX_TRADES_PER_DAY = 3` in `apps/pipeline/src/pipeline.ts`,
  next to the existing `DEFAULT_MAX_TRADES`, threaded through
  `RunPipelineOptions.maxTradesPerDay` the same way `maxTrades` already
  is - matching the issue's explicit ask ("a real named parameter... not
  a hardcoded literal, matching the style of `DEFAULT_MAX_TRADES`"). Kept
  as a distinct constant from `DEFAULT_MAX_TRADES` even though both
  currently equal 3, since they're conceptually different knobs (trades
  per whole window vs. trades per day) that could reasonably diverge
  later - collapsing them into one shared constant would be a coincidence
  today, not an invariant worth encoding.
- While at it: `WindowResult.maxTrades` (added to the schema in §3) means
  `runPipeline` should also stop leaving that value implicit/undiscoverable
  downstream - small, free correctness improvement alongside the schema
  bump the issue already requires, in the spirit of the global instruction
  to fix things noticed along the way.

## 5. `apps/web`: API + UI

- `results-api.ts`'s `getResultsResponse` needs no structural change
  beyond importing the updated `PrecomputedResult` union and bumping the
  imported `RESULTS_SCHEMA_VERSION` - it already just JSON-parses and
  version-checks generically, doesn't inspect the shape itself.
- `use-results.ts` / `ResultsState` are unaffected (still just "the
  fetched `PrecomputedResult`").
- `ResultsPanel.tsx` branches on `state.data.model`:
  - `"window"`: today's existing render path, unchanged.
  - `"intraday-daily"`: new path (see UI proposal below).
- **UI proposal (minimal but real, matching acceptance criteria's "at
  minimum today's/most-recent day")**:
  - A day selector, mirroring `RangeSelector`'s controlled-component
    pattern: a native `<select>` of `data.days[].date`, defaulting to the
    **last** entry (most recent trading day = "today" from the user's
    perspective, since the pipeline runs nightly and the most recent
    day in the window is the latest close available). This satisfies the
    "at minimum" bar directly, while giving real (not stubbed) access to
    every other day in the window too, since the data already contains
    it - a plain "only show today, nothing else" UI would be strictly
    less useful for the same amount of data already being shipped down
    the wire.
  - Selected day synced to the URL (`?range=1M&day=2026-08-21`), same
    reasoning as the existing `?range=` param: shareable/bookmarkable.
  - `HeroStat` and `TradeList` reused as-is for the selected day's
    `startingCapital`/`endingBalance`/`trades` - both already operate on
    exactly that shape, no changes needed there.
  - **`PortfolioChart` needs real adaptation, not a drop-in reuse.**
    Traced this concretely: `PortfolioChart.tsx`'s `toTimestamp()` parses
    every point as `` `${isoDate}T00:00:00Z` `` and `format-date.ts`'s
    `formatDate` does the same - both hardcode "this string is a plain
    calendar date," which collapses every point in a single intraday day
    to the same midnight timestamp if fed raw. Two options: (a) extend
    `toTimestamp`/`formatDate` to accept a full local datetime string
    too (a `hasTime` flag or a second formatting function
    `formatDateTime`), and feed the chart a day's trades reshaped into
    the existing `PortfolioPoint`/`derivePortfolioSeries` shape using
    `buyTime`/`sellTime` instead of `buyDate`/`sellDate`; or (b) treat
    this as genuinely out of scope for #28's UI and ship only the
    day selector + `HeroStat` + `TradeList` for the intraday path,
    leaving the chart as a `WindowResult`-only component for now, with a
    simple "the day's trades are listed below" placeholder instead of a
    chart. Leaning towards (a) since it's a bounded, mechanical change
    (two functions gain a datetime-aware branch) and a day view with no
    chart at all feels like a visibly incomplete v1 - but flagged as an
    open question below since it's real, non-trivial scope the issue
    text doesn't resolve either way.
  - Copy fix while in this area: `ResultsPanel.tsx` currently hardcodes
    "at most 3 sequential all-in trades" regardless of what the data
    actually says - should read `maxTrades`/`maxTradesPerDay` off the
    fetched result (now available per §3) instead, for both the window
    and intraday copy. Small, in-scope-adjacent correctness fix matching
    the global instruction to fix clearly-off things noticed along the
    way, not deferred as a separate issue.

## 6. Testing / verification plan (not performed in this phase)

- Unit tests: `fetchIntradayBars` (mocked fetch, same style as
  `yahoo-client.test.ts`), `unixToLocalDateTimeString` (including a
  DST-transition-week case once verified live), `optimizeIntradayDays`
  (multi-day, multi-ticker fixtures; a day with zero data; a day with one
  ticker only), the updated `results-schema` union, `pipeline.test.ts`'s
  split-path behavior (5Y/MAX fetch failing independently of 1M/3M/1Y),
  and the new `ResultsPanel` day-selector behavior.
- Live verification (once per this repo's working agreement, **not**
  performed in this Phase-1 plan): a real `fetchIntradayBars` call
  against Yahoo for a real symbol, confirming the 60m bar shape, the
  730-day cap behavior at the boundary, and the DST-bucketing question
  from §1.
- The full pipeline-against-real-S3 verification (`aws lambda invoke`
  style, as previously done for issue #5) requires the user's explicit
  go-ahead per the hard constraint in this task - not performed here,
  called out as a required step before merge.

## 7. Open questions / judgment calls this plan made without a resolving
   answer in the issue text

1. **Per-day starting capital: resets to $20 every day, does not
   compound across days.** This is the single biggest interpretive call
   in this plan. The issue's phrasing supports it ("no state carries
   across days," "the max money they could have made on 8/21" read as a
   self-contained daily scenario) but never says so explicitly, and a
   compounding reading (yesterday's ending balance becomes today's
   starting capital) is also defensible and arguably more narratively
   interesting ("if you kept doing this every day..."). Flagging for
   explicit confirmation before implementation, since it changes both
   the schema (`IntradayDayResult.startingCapital` would become
   redundant/always-$20 vs. genuinely per-day-varying) and the DP
   structure (independent per-day calls vs. threading a running balance
   between them, which is still O(days) and still fits the "no cross-day
   state in the *search*" computational note even if a compounding
   reading were chosen for the *display*).
2. **DST bucketing at 60m granularity** - flagged concretely in §1, needs
   a live check against a real DST-transition week before trusting the
   existing `unixToLocalDateString` reasoning extends to hourly bars.
3. **Chart adaptation for the intraday day view** (§5) - real, non-trivial
   scope; recommend option (a) (extend the chart to understand
   intraday datetimes) but this wasn't resolved by the issue text and is
   worth a explicit go/no-go before implementation, since option (b)
   (no chart, list-only) is a meaningfully smaller PR.
4. **Deploy ordering** (§3) - pipeline-first-then-web is the only safe
   order given the global schema version bump; needs to be an explicit
   step in the PR's own description/checklist, and the manual pipeline
   trigger needs the user's go-ahead as a real-AWS action.
5. **Whether the intraday fetch window for 1Y should itself be padded to
   guarantee an intraday-covered "most recent day" always exists** - e.g.
   if the pipeline runs before market close, the 60m fetch's last day may
   have partial bars only, same general "dataAsOf can lag endDate" shape
   the window model already handles (`dataAsOf` field), but worth
   confirming a partial trading day (mid-day pipeline run, or a
   half-day holiday session) produces a sensible partial-day result
   rather than an implicitly-wrong one.
