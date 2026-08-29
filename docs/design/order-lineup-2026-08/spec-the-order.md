# The Order — design spec (resolving issue #189's parked gaps)

Status: design spec only, no code. Resolves the six unresolved gaps issue
#189's independent staff-designer + staff-PM review flagged before parking
"The Order." Written against the shipped app as of issue #197
(`PlaceholderGameTile.tsx`'s placeholder tile) and #133/#186 (`CallBoard.tsx`,
`BeatTheBench.tsx`, `daily-ritual.ts`).

> **Superseded in two places by direct human iteration on the mock -- read
> this file's sibling `README.md` first, it's the authoritative summary of
> what actually shipped in the mock and why.** In short: (1) the daily
> pool below (curated 240-ticker allowlist, S&P-intersected) was replaced
> with a much simpler Magnificent Seven-only pool -- 5 of the 7 shown per
> day; (2) a "lock a slot the instant it scores exact" mechanic was added
> on top of this spec's own Mastermind-style feedback, which this document
> predates. Everything else here (the scoring function, the WCAG glyph
> system, the streak-chip call, the recap copy, the "no secret pool
> needed" reasoning) is exactly what shipped -- kept in full below as the
> real reasoning behind those parts, not superseded.

---

## Concept

Each day, five real S&P 500 stocks are pulled from yesterday's actual
close-to-close trading day and shown to the player in shuffled order,
identified by ticker and company name only (no price, no percent). The
player rearranges them into what they believe was the real worst-to-best
performance order for that day, submits the guess, and gets per-slot
Mastermind-style feedback (exact / close / far) telling them how right each
slot was — without revealing which slots are which kind of wrong. They get
a small, fixed number of attempts to land the exact order before the real
order and the real percentage moves are revealed either way. It is a daily,
under-two-minute deduction puzzle built entirely out of the same real,
already-computed daily-close data this app's own hindsight optimizer reads
— never a fabricated puzzle layered on top of the product, but a second,
game-shaped lens on the exact same real trading day the rest of the app is
already showing.

---

## Daily-selection algorithm

This was the genuinely open-ended gap. The rule below is concrete, was
validated against real S&P 500 daily-close data pulled live during this
design pass (210 real tickers, 19 real trading days, 2026-08-04 through
2026-08-28 — see the tables below), and is stated precisely enough to
implement without further judgment calls beyond the two flagged as open
questions at the end.

### Step 1 — the candidate pool: a curated "recognizable" allowlist, intersected against the live constituent list

`packages/core/src/sp500-constituents.ts` has no market-cap or trading-volume
field at all — the issue's own suggested "middle N percentile of trading
volume/market cap" filter isn't something this repo's existing data can
compute today. Two options were weighed:

- Add a new market-cap/volume data source (another Yahoo endpoint, a new
  fetch path) purely to compute a percentile filter.
- Ship a small, curated, committed allowlist of tickers judged recognizable
  by an ordinary reader of financial news — a static asset, refreshed the
  same way `sp500-constituents.ts` itself is refreshed ("re-fetch and
  regenerate, or ask Claude to refresh it").

**Recommendation: the curated allowlist**, as a new `packages/core/src/
order-recognizable-tickers.ts`, in the same spirit as (and living next to)
`sp500-constituents.ts`. Reasoning: every S&P 500 constituent already clears
a real liquidity/market-cap floor by definition of index membership, so the
actual product problem was never "exclude illiquid names" — real S&P 500
members go all the way down to companies most casual readers have never
heard of (e.g. `AOS` / A. O. Smith, `ALLE` / Allegion). A volume/cap
percentile filter computed today wouldn't reliably separate "recognizable"
from "obscure" the way the issue actually means it; a curated list does,
directly, and costs nothing to maintain beyond an occasional refresh pass —
this app already accepts that kind of manual-refresh asset for the
constituent list itself.

**This was validated as a real, load-bearing step, not a formality.** Built
a 240-ticker draft allowlist (major mega-caps across every sector, plus
well-known consumer/growth names) and intersected it against the actual,
current `SP500_CONSTITUENTS` snapshot: **210 of 240 matched; 30 did not** —
including names most people would call "recognizable" (`SHOP`, `SPOT`,
`SNAP`, `ZM`, `SNOW`, `DOCU`, `PINS`, `RBLX`, `MSTR`, `TEAM`, `TWLO`, `NET`,
`ZS`, `MDB`, `OKTA`, `HUBS`, `EA`, `ATVI`, `ASML`, `ETSY`, `AAL`, `K`, `LNC`,
`DFS`, `BK`, `ILMN`, `AVB`, `EQR`, `W`, `SQ`) — because they simply aren't
S&P 500 members in the current constituent snapshot. **The intersection
step is not optional**: an allowlist authored from memory alone will
regularly reference tickers that aren't in the actual index, and the
selection algorithm must fail closed (drop the ticker from the day's pool)
rather than crash or silently include a non-member.

### Step 2 — that day's real cross-sectional return distribution

For "yesterday" (the most recent real trading day the nightly pipeline has
already fetched daily closes through — no new Yahoo calls needed; this
reuses the same daily-close data `packages/core`'s optimizer already reads),
compute each pool ticker's real close-to-close percent return:
`(close_yesterday / close_dayBefore - 1) * 100`.

**Real distribution, pulled live for this design pass** (the 210-ticker
intersected pool, 19 real trading days):

| date       |   n | min     | p10    | p25    | median | p75   | p90   | max     | stdev  |
| ---------- | --: | ------- | ------ | ------ | ------ | ----- | ----- | ------- | ------ |
| 2026-08-04 | 210 | -9.72%  | -1.21% | -0.05% | 0.87%  | 2.47% | 4.29% | 29.45%  | 3.13%  |
| 2026-08-05 | 210 | -7.04%  | -2.32% | -0.96% | 0.14%  | 0.98% | 2.01% | 6.71%   | 1.99%  |
| 2026-08-06 | 210 | -19.66% | -2.62% | -1.18% | -0.24% | 0.82% | 1.84% | 7.31%   | 2.87%  |
| 2026-08-07 | 210 | -5.97%  | -1.19% | -0.44% | 0.47%  | 1.44% | 2.83% | 17.43%  | 2.43%  |
| 2026-08-10 | 210 | -4.48%  | -2.25% | -1.32% | 0.07%  | 1.21% | 2.99% | 11.48%  | 2.31%  |
| 2026-08-11 | 210 | -5.99%  | -1.75% | -0.75% | 0.16%  | 0.87% | 1.80% | 6.70%   | 1.62%  |
| 2026-08-12 | 210 | -5.74%  | -2.21% | -0.87% | 0.14%  | 1.10% | 2.27% | 9.87%   | 1.97%  |
| 2026-08-13 | 210 | -8.40%  | -1.02% | -0.23% | 0.57%  | 1.78% | 3.33% | 17.78%  | 2.18%  |
| 2026-08-14 | 210 | -5.94%  | -2.25% | -0.79% | 0.12%  | 0.79% | 1.77% | 6.50%   | 1.64%  |
| 2026-08-17 | 210 | -6.19%  | -2.98% | -2.22% | -0.95% | 0.00% | 1.17% | 5.55%   | 1.74%  |
| 2026-08-18 | 210 | -9.16%  | -2.87% | -0.76% | 0.09%  | 1.37% | 2.13% | 4.41%   | 2.10%  |
| 2026-08-19 | 210 | -7.87%  | -3.04% | -1.19% | 0.36%  | 2.06% | 3.78% | 176.97% | 12.51% |
| 2026-08-20 | 210 | -23.55% | -3.16% | -1.94% | -0.84% | 0.00% | 1.29% | 7.58%   | 2.47%  |
| 2026-08-21 | 210 | -5.14%  | -1.11% | -0.28% | 0.76%  | 1.47% | 2.39% | 8.86%   | 1.82%  |
| 2026-08-24 | 210 | -6.51%  | -2.05% | -0.72% | 0.40%  | 1.28% | 2.04% | 5.44%   | 1.78%  |
| 2026-08-25 | 210 | -4.07%  | -1.80% | -0.99% | -0.18% | 0.69% | 2.15% | 14.36%  | 1.88%  |
| 2026-08-26 | 210 | -5.77%  | -1.84% | -0.94% | 0.14%  | 0.77% | 1.63% | 4.02%   | 1.41%  |
| 2026-08-27 | 210 | -4.60%  | -2.25% | -1.51% | -0.69% | 0.05% | 1.82% | 22.58%  | 3.41%  |
| 2026-08-28 | 210 | -12.71% | -2.51% | -1.08% | -0.03% | 1.19% | 2.27% | 5.76%   | 2.14%  |

Two things this table settles that a formula alone wouldn't:

- **The bulk of the distribution (p10–p90) is narrow — typically a 3–6
  percentage-point band centered near zero.** A "correct order" built from
  5 stocks drawn at random from an unfiltered pool would very often be a
  fight over hundredths of a percent between the middle three names — real
  noise, exactly the "arbitrary" failure mode issue #189 named.
  Cross-referencing individual moves confirms this: on 2026-08-19, `MRNA`
  moved **+176.97%** (a real, single-day biotech-news spike) and the very
  next day gave back **-23.55%**; `PLTR` moved **+29.45%** on 2026-08-04;
  `CRM` moved **+22.58%** and `DDOG`/`APP` moved **-19%** on other days in
  this same window. Any one of those, included in a candidate-5 pool
  unfiltered, would make the puzzle trivial — "the one that's up 177% is
  obviously last" needs no deduction at all.
- **This is why a trim step against single-name outliers is load-bearing,
  not defensive boilerplate.** It is the mechanism that keeps day-to-day
  puzzle difficulty roughly consistent even though real market volatility
  genuinely isn't.

### Step 3 — the concrete selection rule

```
pool = intersect(orderRecognizableTickers, currentSp500Constituents)
returns = { ticker -> pctReturn } for every pool ticker on the target day
trimmed = drop the top 5% of `returns`, ranked by ABS(return)   // outlier guard
sorted  = trimmed, sorted ascending by return
picks   = sorted[round(p * (sorted.length - 1))] for p in [0.08, 0.27, 0.50, 0.73, 0.92]
          (advance to the next index on a percentile collision, so 5
          picks are always 5 distinct tickers)
```

Rank-percentile picks, not a fixed-magnitude band (e.g. "pick 5 whose
returns are >= 2pp apart"): a percentile pick is _always_ well-defined
regardless of how wide or narrow that specific day's real dispersion is —
it spans the trimmed distribution's full width by construction, rather than
occasionally coming up short on an unusually quiet day the way a fixed
absolute-gap requirement would.

Two guardrails, checked after picking, both cheap and rare to trip:

- **Minimum total spread**: `max(picks) - min(picks) >= 1.5pp`. If not met
  (an unusually flat trading day), retry once with wider spacing
  (`[0.02, 0.26, 0.50, 0.74, 0.98]`); if that still fails, hold the
  previous day's puzzle rather than ship one with an unreadable spread.
- **Minimum adjacent gap**: every consecutive pair of the 5 sorted picks
  must be `>= 0.15pp` apart (guards specifically against the "two
  ideal-looking picks that are actually a coin-flip-close tie" case issue
  #189 called out — a near-tie between two of the five is a worse UX than
  a slightly narrower overall spread).

### Real validation: this exact rule, run against the 5 most recent real trading days

| date       | pool | trimmed | picks (ticker, real return)                                   | spread | min adjacent gap |
| ---------- | ---: | ------: | ------------------------------------------------------------- | -----: | ---------------: |
| 2026-08-24 |  210 |     199 | PANW -1.95%, PSX -0.37%, NUE 0.41%, PH 1.25%, HIG 2.12%       | 4.06pp |           0.79pp |
| 2026-08-25 |  210 |     199 | STZ -1.88%, AMAT -0.86%, RCL -0.24%, V 0.45%, DASH 1.94%      | 3.82pp |           0.61pp |
| 2026-08-26 |  210 |     199 | IBM -1.84%, SPG -0.86%, PM 0.09%, XEL 0.63%, MO 1.54%         | 3.39pp |           0.54pp |
| 2026-08-27 |  210 |     199 | CCL -2.50%, IDXX -1.51%, AMGN -0.76%, TTWO -0.19%, PAYX 1.28% | 3.78pp |           0.57pp |
| 2026-08-28 |  210 |     199 | DDOG -2.45%, PLD -0.81%, STT -0.02%, ADP 0.98%, T 2.28%       | 4.73pp |           0.79pp |

Every one of the 5 real days lands comfortably inside a readable band
(3.4–4.7pp total spread, 0.5–0.8pp minimum gap between neighbors) with real,
familiar tickers, and the neither-guardrail-tripped case was the norm, not
an edge case — the guardrails exist for the tail, not the common path.

---

## Rules & flow

- **idle** — a compact tile identical in shape to `BeatTheBench.tsx`'s/
  `CallBoard.tsx`'s own compact cards (icon, title, one-line subtitle, a
  status pill). No tickers, no returns, nothing revealed. Clicking it
  expands in place, exactly like both real games (`<details>`/`<summary>`
  for The Call Board's own pattern is the better fit here too, since this
  is also a "reveal a static, non-fetching board" case, not a stateful
  timer-driven game like Beat the Bench).
- **in-progress** — expanded view shows the 5 tickers + company names in
  shuffled slots (no price, no percent), an editable current-guess row with
  per-slot up/down move controls (button-based, not drag-and-drop — matches
  this app's existing "no drag library, plain buttons with `aria-pressed`/
  `role=\"group\"`" convention, e.g. The Call Board's own bucket buttons),
  a "Submit guess" button, and an attempts-remaining counter ("3 guesses
  left"). The very first row is pre-filled with the shuffled order (not
  blank) so a first-time player can submit immediately for an uninformed
  baseline guess rather than being blocked by an empty form.
- **after each guess** — the submitted arrangement locks into a compact
  history row (5 small glyph cells, exact/close/far — see below), the
  attempts counter decrements, and a **new editable row is seeded from the
  just-submitted arrangement** (not a fresh shuffle) so the player can
  incrementally adjust rather than re-enter all 5 slots from scratch each
  time — this is what keeps 4 attempts inside a ~2-minute session (see
  "Attempt limit & pacing" below).
- **win** — triggered the instant a submitted guess is all-exact (5/5 ★).
  Reveals the real order with real percent returns next to each ticker,
  replaces the editable row with a solved state, and shows how many
  attempts it took. No confetti/`CelebrationBurst` — see the retention
  section below for why gold/reward treatment here is deliberately
  restrained.
- **lose** — triggered once the attempt limit is exhausted without an
  all-exact guess. Reveals the real order and real percent returns exactly
  the same way a win does (never leaves the player without the answer —
  matches this app's own hindsight ethos of "you find out what was true
  either way"), captioned as "out of guesses" rather than any punitive
  framing, and shows the best (most-exact) guess made.

---

## Feedback mechanics

### Scoring, precisely

For a submitted guess `G` (ticker at each of 5 slots, worst-to-best) against
the real order `A`:

```
for slot i in 1..5:
  guessedTicker           = G[i]
  actualPositionOfTicker  = index of guessedTicker within A   (1..5)
  distance = |i - actualPositionOfTicker|

  feedback[i] = "exact" if distance == 0
              | "close" if distance == 1
              | "far"   if distance >= 2
```

**Distance is rank-distance (position within the 5-slot permutation), not
return-magnitude distance.** This was the one genuinely open scoring
question, and rank-distance is the right answer for a specific, concrete
reason: the input the player is manipulating is a discrete permutation of 5
known items, not a set of continuous numbers, so a magnitude-based
"how many percentage points off" metric would mean something different
every single day (a 1pp miss is "close" on a flat day like 2026-08-17 but
barely distinguishable from noise on a volatile one like 2026-08-19) —
whereas "off by one position" means exactly the same thing regardless of
that day's real dispersion. This mirrors the same reasoning `CallBoard.tsx`'s
own `callOutcomeFor` already uses for its near-miss/far-miss split: a
_classification_ built for what's meaningful to a player, not a second raw
score.

A win is exactly "all 5 slots score `exact`" — equivalent to `G === A`.

### WCAG-compliant glyph system

Directly modeled on `CallBoard.tsx`'s own `OUTCOME_STYLES`/`callOutcomeFor`
(the pattern this repo already uses to satisfy WCAG 1.4.1 elsewhere):
every cell carries a real glyph _and_ an sr-only sentence, on top of color —
never color alone, closing the exact regression issue #189 flagged in the
original mockup (color-only feedback dots).

| feedback | glyph | color token                                 | sr-only text (per cell)                 |
| -------- | :---: | ------------------------------------------- | --------------------------------------- |
| exact    |   ★   | `--accent-reward` on `--accent-reward-wash` | "{TICKER}: exact position."             |
| close    |   ~   | `--text-secondary` on `--surface-2`         | "{TICKER}: close, off by one position." |
| far      |   ✕   | `--status-critical` on `--surface-2`        | "{TICKER}: far off."                    |

A visible legend (glyph + label, matching `CallBoard`'s own "What each mark
means" list) sits below the history strip so the mapping is discoverable
without relying on memorized color meaning either.

**Token check against `globals.css`'s own decision record**: `--accent-reward`
gold is reserved for genuinely _earned_ state — an exact match is earned
(the player produced it), so gold here matches the token's documented job
exactly, the same as `CallBoard`'s own exact-call cells. No new tokens
needed.

---

## Attempt limit & pacing

**Recommendation: 4 attempts.**

Reasoning, worked from the search space rather than a round number:

- 5! = 120 possible orderings, but per-slot rank-distance feedback is
  considerably more informative per guess than classic Mastermind's own
  peg-count feedback (which only reports aggregate right-color/right-position
  counts, not _which_ slot). Real Mastermind (4 pegs, 6 colors, 1296
  possibilities, no repeats disallowed) typically allows 8–12 guesses
  _specifically because_ its feedback is aggregate, not per-slot.
- With per-slot feedback and a _known, closed_ candidate set (the 5
  tickers are visible from the very first attempt — nothing hidden about
  _which_ items exist, only their true order), an attentive player can
  usually resolve most of the permutation within 2–3 informed guesses; a
  4th guess is the deliberate cushion that turns "usually solvable" into
  "reliably solvable by a careful player without feeling like a coin
  flip," without stretching into "keep grinding."
- Pacing math against the issue's own "under ~2 minutes" target: each
  attempt costs roughly 10–20s to reorder + submit, plus 5–10s to read the
  feedback row = ~25–30s per attempt. 4 attempts x ~30s = **under 2
  minutes at the ceiling**, with most real solves finishing well before
  the 4th attempt is ever needed.
- A "reveal now" bail-out is available at any point (mirrors this app's own
  established pattern of never trapping a player who wants to stop early —
  e.g. `DailyGuessForm`'s optional-not-forced framing) so a player who
  isn't interested in grinding out attempt 4 isn't required to.

---

## Retention mechanic recommendation

**Yes to streak tracking as an internal stat — no to a chip on the
collapsed tile.**

Issue #189 records two real, relevant precedents in this exact codebase,
and the right answer is to follow both rather than pick one:

1. **A persistent streak badge was tried in the hero and explicitly
   killed.** That was the app's single most prominent, always-visible
   surface — the lesson to take from that isn't "never show a streak
   anywhere," it's "don't put ongoing gamification pressure on the
   surface every visitor sees whether they're playing or not."
2. **The two shipped games already disagree with each other on this, and
   that disagreement is itself informative.** `CallBoard.tsx` tracks and
   displays `currentStreak`/`bestStreak` — but only _inside_ the expanded
   board's "Your record" stats row, in gold (`--accent-reward`, matching
   the token's documented "earned state" job), never on the collapsed
   tile face. `BeatTheBench.tsx`'s own compact tile deliberately shows
   only a done/todo badge with **no** streak or history at all, and its
   own doc comment states why: no persisted-history storage mechanism
   exists for it yet, not a philosophical objection to streaks per se.

The Order should follow The Call Board's shape exactly: track
`currentStreak`/`bestStreak` (consecutive/best solved-within-limit days) as
plain numeric stats rendered inside the expanded panel once solved (or
after a loss, showing the streak reset to 0), colored `--accent-reward`
gold, sitting next to the attempts-used figure — **never** surfaced as a
badge, flame icon, or any other always-visible element on the collapsed
tile. This gives the mechanic a genuine, earned reward moment for a player
who opens the game (consistent with gold's own documented "you earned
this" job) without reintroducing the always-on gamification pressure the
hero-level badge was killed specifically for avoiding, and without
building a second bespoke retention pattern this app doesn't already have
a precedent for.

---

## Recap-line copy proposal

`lib/daily-ritual.ts`'s `buildRecapText` already establishes the exact
discipline to extend, not reinvent: every existing line is **relative,
never a leak of the underlying answer** (`benchRecapClause` reports a gap,
never the real day's direction/size; `callsRecapClause` reports "N of 3
called," never which buckets). The Order's line follows the identical
shape:

```ts
export function orderRecapClause(order: {
  solved: boolean;
  attemptsUsed: number;
  maxAttempts: number;
  bestExactCount: number;
}): string {
  return order.solved
    ? `solved in ${order.attemptsUsed} of ${order.maxAttempts}`
    : `${order.bestExactCount} of 5 exact after ${order.attemptsUsed} guesses`;
}
```

Rendered as: `The Order: solved in 2 of 4.` or
`The Order: 3 of 5 exact after 4 guesses.`

Neither branch names a single ticker, a single return figure, or the real
order itself — a recipient learns _how the player did_, never _what the
market did that day_, matching the exact protection `benchRecapClause`
already gives Beat the Bench.

**Inclusion rule: follow `callsRecapClause`'s always-render shape, not
`benchRecapClause`'s whole-recap-blocking one.** `buildRecapText` returns
`null` entirely whenever `bench === null` (Beat the Bench hasn't been
played that day) — gating the _entire_ recap on a single mechanic. Adding
a second required mechanic the same way would compound that requirement
(now the recap needs _both_ Bench and Order played before it exists at
all), which is a real behavior change to an already-shipped feature this
spec has no mandate to make. The Call Board's own line has no such gate —
it always renders, reporting "0 of 3 called" honestly when nothing's been
called yet. The Order's line should do the same: always render, with an
honest "not played yet today" fallback clause when nothing's been
submitted, so a human implementer doesn't have to silently decide this
either way later.

---

## Rotation/repeat-avoidance proposal

**No secret-pool mechanism is warranted here, and building one would be
wasted effort — say so explicitly, per the issue's own instruction.**

Beat the Bench's Mystery Day exists to protect a genuine secret: the real
date of a specific historical session, revealed only after settlement, so
a player can't look it up mid-game. The Order has no equivalent secret to
protect — the "answer" is simply what the real market did on the most
recent trading day, which is public information the instant that day
closes (the same day this app's own daily hero and range explorer already
show). There's nothing here for a pool-plus-reveal-endpoint mechanism to
guard.

**Day-to-day repetition is already structurally unlikely, for free**: the
selection rule (Step 3 above) is keyed off "yesterday's real close-to-close
return," which is a genuinely different number for every ticker on every
real trading day — so which five tickers land near the target percentiles
changes daily along with the market itself, with no seeding or pool
management required. This was directly observable in the 5-day real
validation table above: zero ticker overlap across all 5 consecutive real
days' picks.

**One lightweight guard is still worth adding, cheaply, for the rare quiet
stretch where two adjacent days could coincidentally pick an overlapping
set**: if the newly selected 5-ticker set shares **4 or more** tickers with
the immediately preceding day's set, retry the pick with the same widened
percentile spacing the spread guardrail already uses
(`[0.02, 0.26, 0.50, 0.74, 0.98]`) before falling back to holding the
previous day's puzzle. This reuses machinery the selection algorithm
already needs (Step 3's own guardrail retry path) rather than adding a
second, independent rotation system — exactly the "don't over-engineer
secrecy here" instruction this issue gave, applied to the one place a
lightweight check is actually worth its cost.

---

## Tie to hindsight premise

Issue #189 already names this as The Order's strongest point relative to
The Lineup, and this spec's job is to make the connection concrete rather
than assert it:

- **The candidate data is not fabricated for the game — it's the exact
  same daily-close series `packages/core`'s own optimizer already reads**
  to compute "what was the best possible 3-trade outcome." The Order asks
  a narrower, more human-scaled version of the identical underlying
  question the whole app is built around: not "what was the _optimal_
  sequence of trades across the whole S&P 500," but "_could you have told,
  after the fact, which of these five real stocks did best?_" — the same
  hindsight lens, at a scale a player can actually hold in their head.
- **Playing it teaches the same lesson the app's own hero card already
  teaches, from the opposite direction.** The daily hero shows a player
  the _optimizer's_ answer for a single stock's own trades and lets them
  read the real percent moves after the fact. The Order asks the player to
  _predict_ that same kind of real, after-the-close ranking _before_
  seeing the numbers, then shows them exactly how their instinct compared
  to reality — a player who consistently finds this hard (which the real
  data above suggests most days genuinely are, once obvious outliers are
  filtered out) directly experiences why "hindsight is easy, foresight
  isn't" in a way a paragraph of disclaimer copy can't. That's the same
  point this app's own `AboutSection` disclaimer states in words
  ("not a predictor... not investment advice") — The Order is a second,
  playable way to arrive at the identical conclusion.
- **The outlier-trimming step itself is a small, honest lesson too.** A
  player who gets good enough to notice which trading days feel "too
  easy" (an obvious single-stock earnings mover in the pool) is
  implicitly learning the same real-market fact the trim step exists to
  correct for: most days are genuinely hard to rank by eye, and the rare
  days that aren't are rare specifically _because_ something unusual
  happened to one name.

The Lineup, by contrast (per issue #189's own framing, unaffected by this
spec), never touches this app's own computed hindsight data at all — its
3-letter-ticker constraint is a genre mechanic wearing a stock-market skin,
with no connection to what only this app's optimizer computes.

---

## Open questions left for the human to decide

1. **Who maintains `order-recognizable-tickers.ts`, and how often?** This
   spec proposes a curated, committed allowlist (Step 1) as the practical
   answer given this repo has no market-cap/volume dataset — but a static,
   hand-authored list needs a refresh cadence (index reconstitution happens
   annually; individual constituent changes happen more often) or it will
   quietly drift the way the 30/240 mismatch found during this pass already
   shows can happen. Worth deciding whether this piggybacks on
   `sp500-constituents.ts`'s own refresh process or gets its own.
2. **Should the recognizable-allowlist filter eventually be replaced by a
   real market-cap/volume percentile, if a data source for one becomes
   available for some other feature?** This spec's curated-list answer is a
   pragmatic substitute for the issue's own suggested filter, not a
   rejection of the idea — if this app ever adds a market-cap/volume data
   source for an unrelated reason, revisiting this specific choice would be
   worth a fresh look rather than assumed settled.
3. **Exact interaction affordance for reordering 5 slots** — this spec
   recommends per-slot up/down move buttons (matching this app's existing
   no-drag-library convention) but doesn't fully spec touch-target sizing,
   animation on reorder, or whether a "shuffle again" control belongs on
   the very first attempt row. A UI-implementation pass, not a design-gap,
   but flagged since it wasn't resolved here.
4. **Whether "close" (rank-distance 1) deserves a visually distinct treatment
   for the boundary slots (1 and 5) vs. the middle slots (2–4).** A distance
   of 1 always exists for a middle slot (two neighbors) but only exists in
   one direction for the two end slots — this asymmetry is real but was
   judged not to need special-casing in the scoring itself (the same
   distance-1 definition already applies correctly either way); whether the
   _UI_ should visually hint at this asymmetry is left open.
5. **The exact 4-attempt figure is a considered estimate, not something
   playtested against real users.** The reasoning above (search-space
   comparison to Mastermind, a ~30s-per-attempt pacing estimate) is
   principled but unverified against how an actual first-time player
   performs — worth a short real playtest before locking this number in,
   the same way this app's other pacing constants (e.g. Beat the Bench's
   `BASE_TICK_MS`, this repo's own `apps/web/CLAUDE.md` notes) were tuned
   against a stated target and then measured, not just estimated once.
