# Plan: issue #84 -- chain per-day starting capital across the window

Status: plan only, per the issue's own suggested approach (a plan-first
pass mirroring issue #75's shape) -- no implementation in this worktree.

## 0. One-paragraph summary

For 1W/1M/3M/1Y, `IntradayResult.days[]` currently resets every day to
the same flat configured `startingCapital` (`$20` by default) -- each
day is an independent "what would $20 have become" scenario, explicitly
documented as a deliberate #28-era design call in
`intraday-optimizer.ts`. This issue retires that reset and threads a
single running balance across the window instead: day N (N > 0) starts
from day N-1's ending balance, chained **independently per track** (the
long-only best case, the worst case, and the long+short variant, each
with its own running balance). This plan's answers to the four questions
the issue flags:

1. **`RESULTS_SCHEMA_VERSION` bumps 6 -> 7.** Confirmed, not just
   rubber-stamped -- section 3. **Revised**: this is now backed by a
   concrete additive shape change (two new fields, see point 4 below),
   a stronger justification than the pure-semantics argument this
   section originally led with alone.
2. **The guess-then-reveal spoiler needs a UX change, but a narrow one**:
   the existing per-day guess mechanic stays unchanged in its own
   mechanics (each day judged independently, in any order, against a
   fixed nominal capital -- section 4.1); a _new_, separate, count-gated
   (not order-gated) "whole-range running balance" headline is added,
   locked until every day in the range has been individually revealed
   -- section 4.
3. **`StartingCapitalInput`'s rescale-by-ratio approach is mathematically
   sound for every existing display once each track is paired with its
   own chained starting capital, but "unchanged" was wrong as originally
   claimed** -- section 5. **Revised (a real bug caught in independent
   review, verified against the actual code, not just conceded)**: two
   real `apps/web` call sites (`WorstCaseStat` under both modes;
   `HeroStat` and `dayOverviewRows` under long+short mode) currently
   rescale one track's `endingBalance` using a _different_ track's
   `startingCapital` -- valid before chaining (every track shared one
   flat value) but wrong once tracks diverge independently. The fix
   needs both a schema addition (point 4) and a small, mechanical
   `apps/web` fix (pass each track's own `startingCapital`, not a
   reused shared one) -- not a pure display-logic correction alone.
4. **The three (really four) tracks chain independently off their own
   prior-day value**, applied as one new post-processing pass strictly
   _after_ the existing granularity-override merge and per-range slice,
   not inside `optimizeIntradayDays` itself -- section 6, with a proof
   sketch that every existing write-time cross-check invariant survives
   chaining unmodified. **Revised**: this design requires
   `IntradayWorstCaseResult` and `IntradayLongShortResult` to each gain
   their own `startingCapital` field (currently absent -- both types
   only ever needed one implicitly-shared, flat value pre-chaining) --
   see sections 3 and 6.2.

## 1. Architecture recap (what this issue touches, read in full first)

- **`optimizeIntradayDays`** (`packages/core/src/intraday-optimizer.ts`)
  solves each trading day independently via `optimizeAllVariants`, with
  the _same_ `startingCapital` argument on every call (see
  `OptimizeIntradayOptions.startingCapital`'s doc comment: "Applied
  fresh every day"). Each day's `endingBalance = startingCapital *
ratio_day`, where `ratio_day` is entirely a function of that day's own
  prices -- **capital-invariant**, confirmed by reading `computeLevel`/
  `runCandidatePass` (`optimizer.ts`): the DP's `g`/ratio arrays never
  reference `startingCapital` at all, only per-ticker price ratios; the
  final `endingBalance` is `startingCapital * value[maxTrades]` (the
  DP's own best ratio). This is the load-bearing fact that makes
  chaining a "how balances thread across days" change, not an
  optimizer/DP change, exactly as the issue's own Background says.
- **`apps/pipeline`'s `buildIntradayResults`** (`pipeline.ts`) solves
  the DP **once**, over the full fetched intraday history (not once per
  range), then _slices_ the resulting day array per range
  (`INTRADAY_RANGES.map`, `days = sourceDays.filter((day) => day.date >=
startDateString && day.date <= endDateString)`) -- a deliberate,
  documented optimization (re-solving the same day up to 4x for nested
  ranges was a real, code-review-fixed cost). **This is the single most
  load-bearing architectural fact for this plan**: since 1W/1M/3M/1Y are
  nested subsets of the same underlying day array, but
  each range needs its _own_ chain starting fresh at the configured
  capital on _its own_ first day (not wherever the shared array's global
  first day is), chaining cannot live inside `optimizeIntradayDays` (it
  has no idea which range(s) will later slice its output) or before the
  per-range slice -- it must be a new step applied to each range's
  _already-sliced_ `days` array, independently per range. Section 6
  works through this in full.
- **Granularity overrides** (3M's 5-minute bars, 1M/1W's 1-minute bars)
  merge two independently-solved day arrays via `mergeDaysByGranularity`/
  `mergeDayVariants`, picking each of the long-only and long+short
  bundles _independently_ by comparing `endingBalance`s -- a comparison
  that is only meaningful because **both sides were solved with the
  identical, flat `startingCapital`** (see that function's own doc
  comment: "both solved with the same startingCapital, so directly
  comparable"). This is the second load-bearing fact: chaining must
  also happen _after_ this merge, not before -- if the two granularities
  chained independently before merging, their day-N `startingCapital`s
  would generally differ (they cover different, independently-chained
  day subsets), and `mergeDayVariants`' endingBalance comparison would
  silently become an apples-to-oranges comparison between two different
  bases, breaking its own "keeps whichever day's outcome is actually
  higher" invariant. Confirmed by reading `mergeDaysByGranularity`,
  `mergeDayVariants`, and `buildIntradayResults`'s actual call order
  (`sixtyMinuteDays` -> per-override solve+merge -> `granularityOverrides`
  map -> final per-range slice) directly, not assumed.
- **`RESULTS_SCHEMA_VERSION`** (`results-schema.ts`, currently 6) gates
  every `PrecomputedResult`/`CustomWindowResult`/`CustomAnchorsManifest`
  -- see `packages/core/CLAUDE.md`'s bump history (2 for #28, 3 for #31,
  4 for #12, 5 for #13, 6 for #75). Documented criterion: "a shape
  change a reader needs to know about." No prior bump has been for a
  _pure semantics_ change (same field names/types, different meaning)
  -- this issue is the first candidate for that, which is exactly why
  the issue itself flagged it as worth confirming rather than assuming.
- **Write-time self-validation** (`validatePrecomputedResult`,
  `validateIntradayDay`, issue #47) currently checks each day
  independently: `startingCapital`/`endingBalance` are positive finite
  numbers, plus the existing same-day cross-checks
  (`worstCase.endingBalance <= endingBalance`,
  `longShort.endingBalance >= endingBalance`,
  `longShort.worstCase.endingBalance <= worstCase.endingBalance`) --
  see `validateWorstNotExceedingOptimal`/`validateLongShortNotBelowLongOnly`/
  `validateLongShortWorstNotAboveLongOnlyWorst`. Nothing today checks
  _across_ days at all -- chaining introduces the first such
  cross-day invariant this codebase will have (section 6.3).
- **apps/web's rescale mechanism** (`rescale-starting-capital.ts`,
  issue #15): `rescaleFromStartingCapital(value, from, to) = value *
(to / from)`, a pure linear scale that works because `endingBalance =
startingCapital * multiplier` and `multiplier` never depends on
  `startingCapital`. Every dollar-figure component
  (`HeroStat`/`WorstCaseStat`/`DayOverview`/the chart) is _supposed_ to
  call this with a **same-day, same-track `(startingCapital, endingBalance)`
  pair** as the "from" side -- but today, two real call sites don't
  (section 4.1 traces exactly which, and why that was harmless before
  chaining but isn't after). Section 4.1/5 work through the fix and why
  the underlying mechanism still doesn't need to change for every
  _existing_ display, only how two call sites feed it; section 5 also
  covers why a _new_ display this issue needs can't reuse the same
  per-day pattern at all, even once fixed.

## 2. Scope confirmation against the issue's own text

- Chain `startingCapital`/`endingBalance` across `days[]` for 1W/1M/3M/1Y
  only. 5Y/MAX (`buildWindowResults`, a wholly separate function/model)
  are untouched -- confirmed by reading `runPipeline`: the window and
  intraday paths share no code below `runPipeline` itself.
- Three (really four, see section 6.1) independently-chained series per
  day: long-only best, long-only worst (`worstCase`), long+short best
  (`longShort`), long+short worst (`longShort.worstCase`) -- matching
  the issue's explicit "not from that previous day's long-only figure"
  instruction.
- Optimizer/DP itself (`optimizer.ts`, `computeLevel`) is untouched --
  confirmed above, ratios are capital-invariant.
- No live-recompute -- still nightly precompute, unaffected by this
  issue.

## 3. Does `RESULTS_SCHEMA_VERSION` need to bump? Yes, 6 -> 7

The issue's own text argues yes but asks for it to be confirmed, not
assumed. **Revised from this plan's original draft**: the strongest
justification isn't the semantics-change argument this section
originally led with -- it's a concrete, additive shape change section
6.2's design actually requires, found (and verified against the real
code) during independent review of this plan.

**The real, load-bearing reason: two new fields are required, not
optional.** `IntradayWorstCaseResult` and `IntradayLongShortResult`
(`intraday-optimizer.ts`) currently have no `startingCapital` field of
their own -- confirmed by reading both interfaces directly:

```ts
export interface IntradayWorstCaseResult {
  endingBalance: number;
  trades: IntradayTrade[];
}
export interface IntradayLongShortResult {
  endingBalance: number;
  trades: IntradayTrade[];
  worstCase: IntradayWorstCaseResult;
}
```

Pre-chaining this was harmless: every track's `startingCapital` was the
identical flat constant, so `IntradayDayResult.startingCapital` alone
was enough to reconstruct any track's own ratio
(`endingBalance / startingCapital`), and nothing needed its own copy.
**Once the four tracks chain independently (section 6.1) and drift
apart day by day, that's no longer true** -- `IntradayWorstCaseResult`'s
own `endingBalance` and `IntradayLongShortResult`'s own `endingBalance`
(and its nested `worstCase.endingBalance`) each need their own
`startingCapital` to be independently interpretable at all, both for a
new cross-day write-time check (section 6.4) and for `apps/web` to
rescale each track correctly (section 5). This is an unambiguous,
textbook case for `RESULTS_SCHEMA_VERSION`'s own bump criterion -- new
required fields on an already-versioned type, exactly the same class of
change issue #31's `worstCase` sibling field and issue #13's `longShort`
sibling field each already bumped this constant for.

**The semantics-change argument still applies too, as a secondary,
reinforcing point, not the load-bearing one**: `apps/web`'s own UI
(section 4/5) needs to render _differently_ depending on whether a
given `IntradayResult` was computed under the reset-per-day model or
the chained model -- the new "whole-range running balance" headline
(section 4.2) and the "carried over from the previous day" framing
(section 4.3) are both actively _wrong_ against pre-chaining (schema-6)
stored data, and there's no reliable way to detect that from the data
alone (a schema-6 day landing at exactly `startingCapital ===
previousDay.endingBalance` by sheer no-trade-day coincidence is
indistinguishable field-by-field from a genuinely chained one). Worth
keeping in the record since it would independently justify a bump even
in a hypothetical alternate design that needed no new fields at all --
but the additive-fields argument above is the one this issue's actual
design (section 6.2) is squarely inside precedent for, so it should
lead.

**Recommendation: bump to 7, the same global constant, not a narrower
mechanism.** Two narrower alternatives considered and rejected:

- **A new boolean field (`chained: true`) instead of a version bump**:
  rejected as a worse fit for the exact same reason `RESULTS_SCHEMA_VERSION`'s
  own bump history has never used a field-level flag for a
  cross-cutting semantics change -- it would need `validatePrecomputedResult`
  to special-case its own cross-day check on that flag's presence, and
  every reader would need its own "if chained, else" branch forever, a
  second permanent discriminant living alongside `schemaVersion` for no
  real benefit over just bumping the version once and rewriting every
  stored result on the next pipeline run (which happens anyway, nightly,
  regardless of which mechanism is chosen).
- **A version bump scoped to just `IntradayResult`, not the whole
  `PrecomputedResult`/`CustomWindowResult`/`CustomAnchorsManifest`
  family**: rejected because `RESULTS_SCHEMA_VERSION` has never been
  partitioned this way in this codebase's history (every prior bump,
  even one touching only one of the two models, bumped the single
  shared constant -- e.g. issue #28's bump changed 5Y/MAX's _stored
  shape_ not at all beyond a new `model`/`maxTrades` field, yet still
  used the same shared version). Splitting it now would be new
  complexity this issue doesn't need: 5Y/MAX and the custom-anchor
  family are completely unaffected by this issue's actual change, so
  their own stored JSON doesn't even need rewriting on the rollout
  pipeline run -- only the version _number_ they carry moves, which
  costs nothing.

Same rollout hazard every prior bump has already documented: the
pipeline write and the `apps/web` deploy need to happen together (or
pipeline first), a real-AWS action needing the user's explicit go-ahead,
not performed in this plan-only pass.

## 4. The guess-then-reveal spoiler problem

Restating the mechanism precisely, since the issue's own one-sentence
version compresses a real subtlety: once chained, a day's `startingCapital`
is the literal dollar product of every prior day's own ratio. If
`apps/web` renders that real number for day 12 (to satisfy "visibly
communicate this day's start came from the previous day," an explicit
acceptance criterion), a user who has _never guessed or revealed_ days
1-11 individually can read day 12's own starting figure and instantly
back out `(day 12's starting capital) / (configured capital)` = the
exact cumulative product of days 1-11's ratios, in one glance, zero
effort -- a real, immediate leak of information the per-day guessing
game (issue #34) is specifically built to protect one day at a time.

### 4.1 The core guessing mechanic is unaffected in its own mechanics, but two real `apps/web` call sites need a mechanical fix, not zero changes

**Key finding**: `rescaleFromStartingCapital(value, from, to)` reduces
algebraically to `to * (value / from)`, and when `value`/`from` are the
_same day's own, same-track_ `(startingCapital, endingBalance)` pair,
`value / from` is exactly that track's capital-invariant per-day ratio
(section 1) -- so the rescaled result is `to * ratio_day` **regardless
of whether `from` is chained or flat**. This is the correct foundation
for "the guessing game's own math doesn't change under chaining," and
it still holds after the fix below.

**This plan's original draft overstated the conclusion, and an
independent review caught it, verified here against the actual code,
not taken on faith**: "zero changes" is wrong. The cancellation above
only holds when `value` and `from` are drawn from the _same_ track --
and today's call sites don't reliably do that, because
`IntradayWorstCaseResult`/`IntradayLongShortResult` have no
`startingCapital` field of their own (section 3), so every existing
call site had no choice but to reuse `IntradayDayResult.startingCapital`
(the long-only track's value) as the "from" argument regardless of
which track's `endingBalance` it was rescaling. Pre-chaining this was
harmless (every track shared the identical flat value); post-chaining
it silently mixes tracks. Traced directly against `ResultsPanel.tsx`:

- **`HeroAndWorstCase`'s `WorstCaseStat` rescale is wrong under _both_
  modes** (`ResultsPanel.tsx`, the `<HeroAndWorstCase>` call site):
  `worstCaseEndingBalance` is `dayVariant.worstCase.endingBalance` --
  under mode `"long"` that's the **worst** track's own value; under
  `"long-short"` it's the **long-short-worst** track's value. Either
  way it's rescaled via `rescaleFromStartingCapital(worstCaseEndingBalance,
startingCapital, displayStartingCapital)` where `startingCapital` is
  `activeDay.startingCapital` -- the **long-only** track's value, never
  the actual source track's own. Since `worst <= long-only` on
  essentially every real trading day, this would show a systematically
  wrong (inflated, since it divides by a smaller-than-correct `from` on
  a losing/underperforming day, or otherwise simply incorrect) number
  from the very first day chaining ships, not just in some rare edge
  case.
- **`HeroStat` itself is wrong under `"long-short"` mode specifically**
  (correct under `"long"`, since `dayVariant.endingBalance` and
  `startingCapital={activeDay.startingCapital}` happen to be the same
  track there): under `"long-short"`, `endingBalance` is
  `dayVariant.endingBalance` = `activeDay.longShort.endingBalance`
  (the long-short-best track), still paired with `activeDay.startingCapital`
  (long-only).
- **`dayOverviewRows`' per-row figure has the identical bug under
  `"long-short"` mode**: `rescaleFromStartingCapital(variant.endingBalance,
day.startingCapital, effectiveStartingCapital)` -- `variant.endingBalance`
  is `day.longShort.endingBalance` under that mode, still paired with
  `day.startingCapital` (long-only).

**The fix, once the schema carries each track's own `startingCapital`
(section 6.2), is small and mechanical -- not a redesign**: every one of
these call sites needs to pass the _same track's own_ `startingCapital`
as the "from" argument instead of reusing `activeDay.startingCapital`/
`day.startingCapital` unconditionally. Concretely: `dayOverviewRows`
rescales via `variant.startingCapital` (the already-mode-selected
`Variant<IntradayTrade>` -- see `selectVariant`) instead of
`day.startingCapital`; `HeroAndWorstCase` needs its worst-case rescale's
"from" argument to be the worst-case track's own `startingCapital`
(`dayVariant.worstCase.startingCapital`, itself mode-selected the same
way), not the same `startingCapital` prop `HeroStat` uses for the
best-case track. `HeroAndWorstCaseProps` gains a second starting-capital
field (the worst-case track's own) alongside the existing one, rather
than one shared prop trying to serve both stats. Once each call site
pairs `endingBalance`/`startingCapital` from the _same_ track again,
the cancellation argument above holds exactly as originally claimed,
and the guessing game's own mechanics (guess-then-reveal, any order,
against a fixed nominal capital) genuinely need no design change --
only this plumbing fix.

### 4.2 The actual leak only exists in a _new_ display this issue's own acceptance criteria requires

The leak is specifically in showing the _true_ chained absolute dollar
amount (not the ratio-based figure above) -- which nothing in the app
does today, but which the issue's own acceptance criteria require
_something_ new to show ("a day's starting point came from the previous
day's result rather than a fresh $20"). This plan's recommendation
narrows the spoiler question to exactly that new surface, rather than
treating the whole feature as newly at risk:

**Recommendation: add one new, clearly separate "whole-range running
balance" headline, gated by a _count_ of revealed days, not by
requiring sequential order.**

- A new element (parallel to the window model's single `HeroStat`,
  rendered above `DayOverview`) shows `$[effectiveStartingCapital] ->
$[the range's true final chained balance]` for the whole visible
  range -- the actual "if I time-traveled back to day 0 with $20 and
  rode the whole window" narrative the issue's own Background frames as
  the real product premise.
- This number is masked until **every day in the currently-viewed range
  has been individually guessed/revealed** (a simple `revealedCount ===
data.days.length` check against the same per-day guess storage
  `dayOverviewRows` already consults) -- while masked, render a neutral,
  count-progress placeholder ("Reveal all N days below to see the
  window's full running balance -- N of M revealed so far"), not a fake
  number and not a hidden element.
- **Deliberately count-gated, not a forced-sequential-reveal
  requirement**: a user can still guess days in any order (issue #80's
  own free-browsing design is untouched) -- the headline simply doesn't
  unlock until the count reaches the total, regardless of which order
  got there. This avoids the much larger UX overhaul a true forced-order
  reveal would need (gating every row's clickability on its predecessor,
  contradicting `DayOverview`'s own explicit "pick one below" free-choice
  design) while still fully protecting the one number that is a
  genuine, total, zero-effort leak of the entire range's answer.
- **Once unlocked, the correct computation is a _single_ rescale from
  the range's own root, not a per-day rescale** -- see section 5 for
  why this is the one place the existing rescale pattern must NOT be
  reused as-is.

### 4.3 The "carried over" framing itself must not leak a number either

Communicating _that_ chaining happened (a separate acceptance-criteria
requirement from communicating the _magnitude_) can be done with zero
new numeric leakage: `DayOverview`'s list already shows every day's date
in order, ungated -- adding a short, non-numeric structural note (e.g.
"carried over from {previous day's date}" on every row after the first,
and a corrected intro sentence -- see below) communicates the mechanism
without revealing any dollar amount at all, since the _previous date_ is
already fully visible, ungated information (every row's own date is
shown regardless of guess status today).

- **`DayOverview`'s own intro copy needs a real, required text fix, not
  just a nice-to-have**: today's sentence ("N independently-computed
  trading days in this range...") becomes literally false once days
  chain -- days are no longer independently computed with respect to
  capital. Reword to something like "N trading days in this range, each
  starting from the previous day's real result" (exact copy is an
  implementation-time wording call, not a design decision this plan
  needs to pin down).
- **`DailyGuessForm`'s prompt gains one honest clause acknowledging
  chaining exists**, without changing what's being guessed: e.g. "This
  day's real starting balance actually carried over from {previous
  day's date}'s result -- but for this guess, picture it starting fresh:
  what do you think $[X] turned into on {date}?" The guess itself stays
  exactly the existing ratio-based question (section 4.1); this is
  purely a framing/copy addition, not a mechanic change.

### 4.4 Why "acceptable as-is" (no UX change) was rejected as the answer

Rejected, not silently skipped: the acceptance criteria explicitly
require _both_ "visibly communicate chaining happened" and "the spoiler
question has an explicit answer" -- doing nothing at all would satisfy
neither. Once _any_ real UI surfaces the true chained magnitude (which
the first requirement demands), the spoiler exists as a real bug unless
addressed, so "as-is" was never actually available as an answer once
this plan takes the first acceptance criterion seriously rather than
finding a way to satisfy it that avoids the second one entirely (e.g. a
design that shows a day's real chained value _only_ using purely
non-numeric language everywhere, with no numeric leak anywhere, was
considered but rejected as under-delivering on "visibly communicate" --
a user who actually wants to see the real running balance is a
completely reasonable thing for this product to offer, per the issue's
own Background framing; masking it entirely would just move the gap
from "spoiler risk" to "the feature's own headline number is never
actually shown," which isn't a real resolution either).

## 5. `StartingCapitalInput`'s rescale-by-ratio: corrected on two fronts, not just confirmed

The issue's own text asked this to be verified, not assumed. **Revised
from this plan's original draft**, which claimed every existing display
needed "zero changes" -- true of the underlying _math_, false of the
_current call sites_, per section 4.1's corrected finding:

**The rescale mechanism itself is sound for every existing display,
once each call site pairs a track's `endingBalance` with that _same_
track's own `startingCapital`** -- a same-track pair's ratio is
preserved by chaining (capital-invariant by construction, section 1),
so `rescaleFromStartingCapital` needs no new logic, no new utility
function, and no change to what it computes. **What's actually
required is the fix section 4.1 details**: give `IntradayWorstCaseResult`/
`IntradayLongShortResult` their own `startingCapital` fields (section
6.2), and update `HeroAndWorstCase`/`dayOverviewRows` in
`ResultsPanel.tsx` to read each track's own field instead of reusing
`activeDay.startingCapital`/`day.startingCapital` (the long-only
track's value) for every track. Small and mechanical once the schema
carries the fields, but a real, necessary code change -- not the "zero
changes" this plan originally claimed.

**A second, independent gap (not affected by the fix above): the new
whole-range running-balance headline (section 4.2) must NOT reuse the
per-day rescale pattern at all, even the corrected same-track version**
-- this part of the original finding holds up under review. A per-day
rescale, even a correctly same-track-paired one, uses that day's own
(now day-varying, chained) `startingCapital` as the "from" argument,
which _algebraically cancels the chaining out_ (section 4.1's own
derivation: `value * (to/from)` simplifies to `to * ratio`, independent
of `from`). Applying that same per-day formula to try to show the
_true_ chained absolute dollar amount would silently produce the wrong
number -- exactly the same "as if fresh" figure the per-day displays
correctly show, not the real carried-over amount. **The correct
rescale for the whole-range headline is a single rescale from the
_range's own root_ starting capital** (`data.days[0].startingCapital`,
which is always the pipeline's flat configured constant -- every
range's chain starts fresh there, per the issue's own Scope, and this
value is identical across all four tracks on day 0 by construction, so
it's safe to use as the "from" root regardless of which track's final
balance is being displayed), applied once to the range's final chained
`endingBalance` for whichever track `mode` currently selects:

```
rescaleFromStartingCapital(
  selectVariant(finalDay, finalDay.longShort, mode).endingBalance,
  // the range's true final chained balance for the selected track, in pipeline-root terms
  data.days[0].startingCapital,
  // the range's own root -- identical across all four tracks on day 0, so this
  // single value is the correct "from" regardless of which track is selected
  effectiveStartingCapital,      // the user's chosen display capital
)
```

(The original draft's snippet used unconditional `finalDay.endingBalance`,
implicitly always the long-only track -- updated here to select the
same track `mode` has the rest of the page showing, for consistency
with every other mode-aware display on the page. This refinement is
new in this revision, not part of the bug the independent review
flagged, but worth fixing alongside it while touching this section.)

This is the same `rescaleFromStartingCapital` _function_ (no new
utility needed), just called with a different, deliberately
non-per-day pair of arguments than every existing call site uses --
worth a clear doc comment at the new call site specifically warning
against "helpfully" simplifying it to the per-day pattern, since that
simplification is exactly the bug this section exists to head off.

## 6. Pipeline design: where chaining actually lives

### 6.1 Four independently-chained series, not three

The issue's prose says "three parallel result tracks" but
`IntradayLongShortResult` itself is `{ endingBalance, trades, worstCase }`
-- i.e. long+short has its own best _and_ worst. Reading the issue's
"each internally consistent... not from that previous day's long-only
figure" instruction literally, this plan chains **four** independent
running balances per range: long-only best (`endingBalance`), long-only
worst (`worstCase.endingBalance`), long+short best
(`longShort.endingBalance`), long+short worst
(`longShort.worstCase.endingBalance`) -- each strictly off its own
previous day's own chained value, never cross-referencing another
track's balance. This groups naturally into the issue's own "three
tracks" framing (long+short is one track that happens to carry two
numbers, same as it already does today).

### 6.2 Schema addition, then applied once per range, after slicing, after the override merge

**Schema addition, required before the chaining pass below can be
written (section 3's own load-bearing finding)**: `IntradayWorstCaseResult`
and `IntradayLongShortResult` (`intraday-optimizer.ts`) each gain their
own `startingCapital: number` field:

```ts
export interface IntradayWorstCaseResult {
  startingCapital: number; // new
  endingBalance: number;
  trades: IntradayTrade[];
}
export interface IntradayLongShortResult {
  startingCapital: number; // new -- this track's own (long-short-best) chained capital
  endingBalance: number;
  trades: IntradayTrade[];
  worstCase: IntradayWorstCaseResult; // its own nested `startingCapital` is the long-short-worst track's
}
```

Adding the field to `IntradayWorstCaseResult` alone covers _two_ of the
four tracks for free, since `IntradayLongShortResult.worstCase` reuses
that same interface -- `IntradayDayResult.worstCase.startingCapital` is
the worst track's own value, `IntradayDayResult.longShort.worstCase.startingCapital`
is the long-short-worst track's own, with no separate type needed for
either. `IntradayDayResult.startingCapital` (unchanged) remains the
long-only track's own value, and the new `IntradayLongShortResult.startingCapital`
covers the long-short-best track -- all four tracks now independently
readable.

With that in place, a new function (e.g. `chainStartingCapital(days:
IntradayDayResult[], rootStartingCapital: number): IntradayDayResult[]`)
is called inside `buildIntradayResults`'s existing `INTRADAY_RANGES.map`
loop, immediately after `days = sourceDays.filter(...)` (the existing
per-range slice) and before that range's `IntradayResult` object is
assembled:

```
let longOnlyCapital = rootStartingCapital;
let worstCapital = rootStartingCapital;
let longShortCapital = rootStartingCapital;
let longShortWorstCapital = rootStartingCapital;

const chainedDays = days.map((day) => {
  // Preserve each track's own capital-invariant ratio from the
  // unchained (flat-startingCapital) solve before overwriting.
  const longOnlyRatio = day.endingBalance / day.startingCapital;
  const worstRatio = day.worstCase.endingBalance / day.startingCapital;
  const longShortRatio = day.longShort.endingBalance / day.startingCapital;
  const longShortWorstRatio = day.longShort.worstCase.endingBalance / day.startingCapital;

  const chained: IntradayDayResult = {
    ...day,
    startingCapital: longOnlyCapital,
    endingBalance: longOnlyCapital * longOnlyRatio,
    worstCase: {
      ...day.worstCase,
      startingCapital: worstCapital,
      endingBalance: worstCapital * worstRatio,
    },
    longShort: {
      ...day.longShort,
      startingCapital: longShortCapital,
      endingBalance: longShortCapital * longShortRatio,
      worstCase: {
        ...day.longShort.worstCase,
        startingCapital: longShortWorstCapital,
        endingBalance: longShortWorstCapital * longShortWorstRatio,
      },
    },
  };
  longOnlyCapital = chained.endingBalance;
  worstCapital = chained.worstCase.endingBalance;
  longShortCapital = chained.longShort.endingBalance;
  longShortWorstCapital = chained.longShort.worstCase.endingBalance;
  return chained;
});
```

(This is the corrected version of this pseudocode -- the plan's
original draft omitted the three new `startingCapital: ...` lines
above, which is exactly the gap an independent review caught: without
them, `IntradayWorstCaseResult`/`IntradayLongShortResult` would still
have no way to expose their own chained capital, and section 4.1's
`apps/web` fix would have nothing to read.)

`trades`/`barIntervalMinutes` are untouched by this pass -- trades hold
literal ticker prices, never dollar allocations, so they need no
rescaling at all under chaining (confirmed by reading `Trade`'s/
`IntradayTrade`'s fields: `openPrice`/`closePrice` are market prices,
not position sizes).

**Why this must run _after_ the override merge and the per-range
slice, restated concretely against section 1's finding**:
`sourceDays`/`mergedDays` (whichever a range reads from) stay solved
with the flat, non-chained `startingCapital` exactly as they are
today, so `mergeDayVariants`' endingBalance comparisons keep comparing
two genuinely equal-basis numbers -- completely unaffected by this
issue. Chaining is purely a per-range _post-processing_ step on
already-finalized, already-merged, already-sliced day arrays. This
also means `mergeDaysByGranularity`/`mergeDayVariants` themselves need
**zero code changes** for this issue -- a real scope-reduction finding
worth calling out, since those two functions carry some of the most
carefully-proven logic in this file (see `apps/pipeline/CLAUDE.md`'s
own "Code review follow-up" section) and this design avoids touching
either.

### 6.3 Every existing per-day cross-check invariant survives chaining, by induction -- new proof, needs live verification before shipping

`validatePrecomputedResult`'s three existing per-day cross-checks
(`worstCase.endingBalance <= endingBalance`, `longShort.endingBalance >=
endingBalance`, `longShort.worstCase.endingBalance <=
worstCase.endingBalance`) all currently rely on every track sharing the
_same_ `startingCapital` on a given day -- true before chaining (flat
constant) but no longer generally true after (four independently-drifting
per-track capitals). Do the checks still hold?

**Yes, by induction, given two facts already established elsewhere in
this codebase**: (1) all four tracks start from the _identical_ root
capital on day 0 of every range (this plan's own design, section 6.2);
(2) for _any_ single day, at the _same_ capital, the three ratio
orderings already hold unconditionally by construction of the DP itself
(`worst_ratio <= longOnly_ratio`, `longOnly_ratio <= longShort_ratio`,
`longShort_worst_ratio <= worst_ratio` -- the last one is exactly what
`validateLongShortWorstNotAboveLongOnlyWorst` already checks today, and
since it holds for _any_ common capital fed into that day's
`optimizeAllVariants` call, dividing both sides by that capital shows
it's actually a capital-invariant _ratio_ statement, not tied to
whatever specific capital happened to be used to observe it).

Given (1) and (2): each track's chained capital on day N is
`root * (product of that track's own daily ratios for days 0..N-1)`.
Since every factor in, say, the long+short-best product is `>=` the
corresponding factor in the long-only-best product (fact 2, applied
day-by-day) and all factors are positive, the cumulative products
preserve that same `>=` ordering at every N (induction). Multiplying
each track's day-N capital (already ordered) by that same day's own
ratio (also ordered, fact 2) preserves the final `endingBalance`
ordering too, since all four quantities are positive
(`a<=b, c<=d, a,b,c,d>0 => a*c <= b*d`). The same argument, run with the
other two ratio orderings, covers the other two cross-checks.

**This is a different, simpler argument than `mergeDayVariants`' own
reciprocal-flip proof** (`pipeline.ts`'s own doc comment, which needed a
non-trivial correction mid-implementation once already, per
`apps/pipeline/CLAUDE.md`) -- that proof was needed because a
cross-_source_ merge combines two _different_ days' worth of ratios;
chaining never does that (every track's chain is built entirely from
its _own_ day-by-day ratios, in order), so the much simpler "ratio
ordering is preserved under same-signed cumulative products" argument
suffices and the reciprocal machinery isn't needed at all.

**Not trusted blindly, per this codebase's own established discipline**
(the exact same "provably safe, still worth containing" posture
`mergeDayVariants` already uses, especially given that function's own
proof needed a real correction once): implementation should (a) add a
defensive per-day check inside `chainStartingCapital` itself that falls
back safely (same "contain, report via a failures/skippedDays channel,
never crash the whole run" pattern every other per-day risk in this
file already uses) if a violation is ever observed, and (b) run a
randomized brute-force live check (same technique
`mergeDayVariants`' own 20,000-trial verification used) against a real
multi-day chained sequence before this ships, not just trust this
proof on paper.

### 6.4 New write-time invariant: cross-day chaining itself

`validateIntradayDay`'s existing per-day checks stay mostly unaffected
(still "is this a positive finite number," independent of chaining) but
now also need to check the three _new_ `startingCapital` fields
(section 6.2) with the same `isPositiveFiniteNumber` predicate every
other starting-capital/ending-balance field already uses -- a small,
mechanical addition to an existing check, not a new category on its
own.

**Revised from this plan's original draft, which described this check
as though the fields it needs already existed -- they didn't (section
3), so as originally written this check had nowhere to read three of
the four tracks' own `startingCapital` from and couldn't actually be
implemented.** With section 6.2's schema addition in place, a new
**cross-day** check is added to `validatePrecomputedResult`'s intraday
branch, iterating `days[]` in order, once per track:

- `days[i].startingCapital === days[i-1].endingBalance` (long-only)
- `days[i].worstCase.startingCapital === days[i-1].worstCase.endingBalance` (worst)
- `days[i].longShort.startingCapital === days[i-1].longShort.endingBalance` (long-short-best)
- `days[i].longShort.worstCase.startingCapital === days[i-1].longShort.worstCase.endingBalance` (long-short-worst)

for `i > 0` (exact equality is safe and appropriate here, unlike a
tolerance-based check -- the pipeline literally copies the previous
day's already-computed number forward for each track, no new
arithmetic introduces float drift), plus, for day 0 of every range, all
four tracks' own `startingCapital` equal to `result.startingCapital`
(the range's own configured root -- section 6.2's design keeps all four
tracks starting from that identical value). This is the first cross-day
validation this codebase has ever needed -- worth calling out explicitly
in `results-schema.ts`'s own doc comments as a new category, not folded
silently into the existing per-day loop's language.

## 7. Test impact (qualitative)

- `intraday-optimizer.test.ts`: gains coverage for the new
  `IntradayWorstCaseResult.startingCapital`/`IntradayLongShortResult.startingCapital`
  fields (section 6.2) -- `optimizeIntradayDays` itself still doesn't
  change behaviorally, but every fixture that builds/asserts on one of
  these two shapes needs the new field added, the same mechanical,
  high-count-but-low-risk churn `RESULTS_SCHEMA_VERSION`'s own bump
  history already documents recurring on every prior additive-field
  bump (e.g. issue #31's original `worstCase` field).
- `pipeline.test.ts`/`pipeline.custom-range.test.ts`: every existing
  intraday fixture's expected `startingCapital`/`endingBalance` per day
  (now four independent pairs per day, not one shared value) needs
  updating to chained values; a new focused test file (matching
  this codebase's own "small, dedicated file" precedent for a risky new
  mechanism, e.g. `pipeline.chained-capital.test.ts`) covers: day-0 root
  equality across all four tracks, cross-day chaining equality, the
  four-track independence (a fixture where the tracks' rankings
  genuinely diverge across days), and that 5Y/MAX fixtures are
  byte-for-byte unaffected.
- `results-schema.test.ts`: new coverage for the cross-day check
  (section 6.4), both a passing chained fixture and a deliberately
  broken one.
- `apps/web`: `ResultsPanel.test.tsx` gains new coverage specifically
  for the two real call-site fixes section 4.1 identifies -- a
  chained fixture where the four tracks' rankings genuinely diverge, to
  confirm `WorstCaseStat` (both modes) and `HeroStat`/`dayOverviewRows`
  (long+short mode) each rescale from their own track's `startingCapital`,
  not the long-only track's, not just on paper; existing guess-then-
  reveal coverage should be re-run against chained fixtures too, to
  confirm the guessing game's own mechanics genuinely need no design
  change per section 4.1's revised conclusion. Also new coverage for
  the whole-range headline's count-gating (masked at partial reveal,
  unlocked at full reveal, correct root-based rescale for the selected
  mode) and `DayOverview`'s corrected copy/per-row "carried over" note.
- Live verification (per this repo's working agreement, at least once
  before shipping): a real local pipeline run (the same
  `local-run.ts`/`local-file-result-reader.ts` throwaway technique
  `apps/pipeline/CLAUDE.md`/`apps/web/CLAUDE.md` already document, real
  Yahoo data, no S3 write) for at least one per-day range, hand-checking
  a chain of consecutive days' `startingCapital`/`endingBalance` against
  their own ratios, confirming section 6.3's invariant-preservation
  claim against real data, not just the fixture-level tests above.

## For the manager

Two genuine judgment calls this plan couldn't resolve unilaterally:

1. **The whole-range running-balance headline's exact reveal gate**
   (section 4.2): this plan recommends count-gated (unlocks once every
   day in the range has been individually revealed, any order), not
   order-gated (forced sequential reveal) or ungated. This is a real
   product-feel tradeoff -- count-gating is less disruptive to issue
   #80's existing free-browsing design but means a user who reveals 61
   of 62 days in a 3M range still can't see the headline until the very
   last one, which could read as an oddly strict "one more" gate rather
   than a natural payoff. Worth the user's own sign-off before
   implementation, same as every other real product-feel call in this
   repo's history gets one.
2. **Exact copy/wording for the "carried over" framing** (section 4.3)
   and the masked-headline placeholder text (section 4.2) -- this plan
   deliberately left these as implementation-time wording calls rather
   than pinning down final copy, consistent with how this repo
   generally treats exact UI strings as an implementer/reviewer call
   rather than a plan-level decision, but flagging here in case the
   manager wants to weigh in on tone before implementation starts.
