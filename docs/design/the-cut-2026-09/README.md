# The Cut — design decisions (Sep 2026)

A new guessing game: assuming perfect (hindsight) knowledge, how many of the
S&P 500's real-weight-ranked companies should you have held to maximize
profit over a window, and how much would that have beaten the real S&P 500?
Ownership is **sequential** — holding company #176 means also holding
#1-175, not an arbitrary subset. This doc records the decisions from a
three-way design/PM/staff-engineer review pass (plus a follow-up correction)
so the four build issues below don't have to re-derive them. No interactive
mockup was built for this one (unlike `../order-lineup-2026-08/`) — judged
disproportionate for a mechanic this much simpler to describe in prose;
revisit that call if the guess-loop UI turns out to need more iteration than
expected once it's actually played.

## The mechanic

For a chosen preset window (reuse the existing 1W/1M/3M/1Y/5Y/Max ranges —
this is a whole-window question, not a daily-rotating puzzle like The
Order/Lineup/Beat the Bench; there's no natural "what changes today" hook
for portfolio breadth over a long window):

1. Companies are ordered #1..#500 by **real S&P index weight** (see
   "Weighting data" below), not alphabetically — an alphabetical prefix has
   no economic meaning and would strip the "perfect knowledge" premise of
   any real content.
2. A candidate portfolio of prefix length N holds companies #1..N, with
   capital allocated **in proportion to their real weights, renormalized
   among just the N held** — not an equal split. This was a real course
   correction mid-review: the initial framing assumed equal-weighting for
   simplicity, but equal-weighting a "buy the biggest N" prefix would let a
   single small company added at N+1 swing the result as much as adding
   Apple, which doesn't reflect what "holding the top N by size" means in
   the real market.
3. `portfolioReturn(N) = cumWeightedReturn[N] / cumWeight[N]`, where
   `cumWeightedReturn[N] = Σ_{i≤N} effectiveWeight_i × ratio_i` and
   `cumWeight[N] = Σ_{i≤N} effectiveWeight_i`. `ratio_i` is ticker i's
   window buy-and-hold return (end close / start close — the same
   computation `apps/pipeline`'s `computeBenchmark` already does per
   ticker, generalized across the universe). `effectiveWeight_i` is the
   ticker's real weight if it has valid start/end closes for the window,
   else 0 — a ticker missing data mid-window (not yet IPO'd, delisted,
   fetch failure) is excluded from that prefix's average, and dividing by
   `cumWeight[N]` (rather than a fixed denominator) is exactly what makes
   the remaining held weights renormalize to sum to 1, with no separate
   step needed and no dead/uninvested cash.
4. The best N is `argmax` over portfolioReturn(N) for every N where
   `cumWeight[N] > 0`. An N where every one of the first N companies lacks
   window data is excluded from the argmax entirely (not scored as 0/NaN).
   Ties: smallest N wins (a determinism rule, not an economic claim — same
   spirit as the optimizer's alphabetical tie-break).
5. This whole curve is computable as **two O(500) prefix-sum arrays**, one
   pass, no DP, no per-N recomputation from scratch — cheap even against
   this repo's existing optimizer benchmarks.

## Weighting data

`packages/core/src/sp500-constituents.ts` today has `{symbol, name,
sector}` only — no cap/weight data, sourced from a Wikipedia-mirrored
dataset. That can't be stretched to cover this; the mechanic needs real
relative weight _magnitudes_, not just an ordinal rank.

**Recommended source: State Street's published SPY holdings CSV**
(ssga.com) — a real, intentionally downloadable data file (per-holding
weight %, dated at the source), not a scraped page, so it doesn't raise the
anti-bot/ToS concern that ruled out Stooq for this app's main price data
(see `packages/core/CLAUDE.md`'s "Data source" section for that precedent
and the empirical-verification bar it sets — confirm live that this file
downloads cleanly before committing, same discipline). iShares' IVV
holdings CSV is a credible structurally-identical fallback/cross-check.

Store the raw weight as a `weight: number` field directly on
`SP500Constituent` — not a separately-derived market-cap number (two
numbers that could drift out of sync), and not a stored rank (rank is
purely a derived, display-only sort over `weight`, computed on demand;
storing it separately risks disagreeing with `weight` after a partial
refresh). Static snapshot, refreshed on the same manual cadence as the
existing constituent list, dated in the file header.

**Explicit caveat, stronger than the existing constituent-list
limitation**: applying today's _weight_ retroactively across a
multi-year window is a bigger simplification than applying today's mere
_membership/rank_ retroactively — weight drifts continuously even when
membership and rank order are stable day to day. Document this plainly
next to the field and in player-facing copy, consistent with this app's
"not investment advice, not a predictor, retrospective toy" framing.

## Baseline comparison

The game's own N=500 case (this fixed universe, fully held, real-weighted)
is the internally-consistent baseline for "how much did this beat the full
S&P 500" — same weighting scheme, same universe, only N differs. It should
also now **closely track** the app's existing real SPY `BenchmarkResult`
(already computed per range), since both are cap/weight-based, but treat
that as a **live-measured, documented tolerance**, not an exact-equality
assertion. A real, explainable gap will remain regardless of data quality:

- Real SPY continuously rebalances as caps change; this game's N=500 case
  is a single static buy-and-hold at one fixed (today's) weight snapshot
  held the whole window — a structurally different computation.
- Today's weights and constituent list are applied across the whole
  historical window (the existing "current snapshot applied retroactively"
  limitation, now compounded by weight's faster drift — see above).
- Free-float adjustment: real index weights are float-adjusted; a
  published-weight snapshot approximates but won't be bit-identical.

Keep an _exact_ self-consistency invariant (N=500 with the identical
formula and no exclusions must equal a plain full-universe weighted
average — pure arithmetic, fully testable) separate from the _measured_
N=500-vs-SPY tolerance (a real number to observe and document once built,
per this repo's "benchmarked not estimated" discipline — see the MAX-range
astronomical-balance note in `packages/core/CLAUDE.md` for the same
"measure and document the real number" posture applied to a different
surprising result).

## Interaction

Multi-guess with feedback (not a one-shot reveal): a native
`<input type="range" min="1" max="500">` paired with a numeric input, a
horizontally-scrollable strip of ticker symbols (rank + symbol only — no
company names or logos; this app has never shown logos anywhere and
shouldn't introduce that asset type here) that auto-scrolls to track the
slider, and 5-6 guesses with two-part feedback: directional (too
high/too low — glyph + text, never color alone) and a named closeness band
on rank-distance ("ice cold"/"cold"/"warm"/"hot"). Score primarily on **%
of the available edge over the N=500 baseline actually captured** by the
guess (a guess 50 ranks off in a flat stretch of the curve can be nearly
free; 5 ranks off across a steep stretch can cost the whole edge) — show
rank-distance too, as a secondary, human-readable stat.

Reveal: a new small hand-rolled SVG chart (no existing chart component
fits — `PortfolioChart`/`BeatTheBenchChart` are both time/bar-domain, this
needs N on the x-axis), log-scale y-axis reusing `chart-scales.ts`'s
tick machinery, marking the player's guess, the true best N, and the
N=500/SPY baseline (dashed, muted, de-emphasized).

Number formatting: reuse `format-currency.ts`'s existing
`formatHeroCurrency`/`formatAxisCurrency`/`formatMultiplier` — this app has
a documented history of the same rounding bug recurring across
independently-written formatters.

Streak/status: collapsed tile shows a plain-language status pill (no gold);
gold `--accent-reward` reserved for the expanded panel's genuinely-earned
streak figures, following the post-#186 condensation convention. Derive
current/best streak from a persisted, bounded guess history on every read
(`order-storage.ts`'s precedent) rather than storing a raw streak number.

## Storage

New sibling result type in `packages/core/src/results-schema.ts` (not a
`WindowResult` union member, not a bolted-on field — same reasoning
`CustomWindowResult`/`BenchmarkResult` already established), its own S3
key per range (e.g. `results/sp500-prefix/{RANGE}.json`), computed nightly
in `apps/pipeline` alongside the other per-game builders, reusing
already-fetched per-ticker daily closes (no new fetch). No
`RESULTS_SCHEMA_VERSION` bump needed — a new key nothing existing reads,
same precedent Beat the Bench's own storage established — but reuse the
same version constant on the new object for writer/reader-drift
protection. New thin `/api/sp500-prefix` route following
`api/the-order/route.ts`'s pattern. No new AWS/infra work.

## Naming and scope

Shipped name: **The Cut**. One issue per stage below, in dependency order
(not a 6-issue epic split like Order/Lineup got — this needs no
daily-selection algorithm and reuses far more existing infrastructure):

1. Data foundation — real weight snapshot.
2. Core selection algorithm (`packages/core`).
3. Pipeline integration + storage schema.
4. Web UI + API (the actual playable game).

**Explicitly not a Beat the Bench variant** — Beat the Bench is
single-day/intraday market-timing (toggle in/out, bar-by-bar); The Cut is
whole-window portfolio-breadth with no timing/toggle component at all.
Worth saying up front so a future reader doesn't conflate this with
backlog issues #225/#226 (Beat the Bench's own pending mechanics).

**Explicitly out of scope for v1** (documented here so it doesn't get
silently re-proposed and re-litigated — see root `CLAUDE.md`'s
`backlog`/`wontfix` conventions if any of these get formally deferred
later): true historical (per-window-start) weighting, daily
rotation/streak-reset tied to a calendar day, an equal-weighted or
cap-weighted-toggle alternate mode, and any recap/sharing surface (no
per-game recap surface currently exists in this app at all — see
`apps/web/CLAUDE.md`'s note that `DailyRitual.tsx` was removed outright).
