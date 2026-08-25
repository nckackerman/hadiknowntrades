# Plan: issue #105 -- "Watch it happen" replay for the 1W range

Status: plan only, per the manager's own decision to require a written
plan + independent review before implementation (matching this repo's
plan-first convention for design/blast-radius work -- #75, #84, #85,
#106). No implementation in this worktree.

## 0. One-paragraph summary

1W is the intraday-daily model's own closest-to-window-model case: up to
**15 worst-case trades** (7 calendar days back -> ~5 trading days x
`DEFAULT_MAX_TRADES_PER_DAY = 3`, confirmed against `preset-ranges.ts`
and `pipeline.ts` directly, not assumed), not the ~63/~186/~750 that make
1M/3M/1Y need issue #106's day-chunking redesign. **Correcting the
issue's own figure**: at `use-trade-replay.ts`'s unmodified pacing this
plays in **~31.8s, not "~27s"** (the hook's own header comment gives the
exact formula, `2100ms x trades + 300ms`, worked out in section 2 below)
-- clearly not "still workable" as the issue's Background speculates, so
pacing genuinely needs tightening, not just verifying. The core walk
mechanism itself, however, needs **no new segment-builder or chunking
abstraction** -- `use-trade-replay.ts`'s existing per-point
`buildSegments`/RAF/phase machinery is confirmed data-shape-agnostic
(`PortfolioPoint`/`PortfolioEvent` are identical between
`derivePortfolioSeries` and `deriveWholeRangeIntradaySeries`) and can be
reused **directly**, once pacing becomes a parameter and one concrete,
previously-undiscovered bug is fixed (section 5: the hook's date-reading
code assumes a plain calendar date and silently produces `"Invalid
Date"` against a chained intraday series' datetime-labeled points).

For the hero/reveal component (section 3): **no new `HeroAndWorstCase`-
based component is needed, and this plan deliberately diverges from
issue #106's sibling plan sketch here, with a stated reason.** #106's
plan (written before this one, without a shipped 1W to read) proposed a
`WholeRangeReplay.tsx` composing `HeroAndWorstCase` -- but
`WholeRangeBalance.tsx` **already is** this range's hero component (the
one place its ending balance is headlined), unlike the window model,
which has no page-level equivalent outside `HeroAndWorstCase`. Composing
through `HeroAndWorstCase` instead would render the exact same "$X ->
$Y" figure twice, once in `WholeRangeBalance`'s own already-revealed
headline and again in a parallel `HeroAndWorstCase`. This plan instead
extends `WholeRangeBalance` itself with a `heroSlot`-equivalent overlay
prop (following that exact, already-proven overlay-not-replace pattern)
and a new worst-case sibling stat, and wraps it in a new
`WholeRangeReplay.tsx` that owns the replay button, the animated
overlay, and the whole-range chart -- see section 3 for the full design
and section 3.5 for what this means for #106's own eventual
reconciliation pass.

The worst-case figure itself needs **zero new pipeline work** -- issue
#84's chained per-track `startingCapital` on `IntradayWorstCaseResult`/
`IntradayLongShortResult` (confirmed live in `intraday-optimizer.ts`)
already makes it a single rescale away, exactly as #106's plan also
found. The replay button sequences with `WholeRangeBalance`'s existing
guess-then-reveal gate by construction, not by a second check: the new
component only ever computes real chart data once `rangeGuess !== null`
(the existing `wholeRangePoints` memo in `ResultsPanel.tsx` already
returns `[]` pre-reveal), so there is nothing to replay before the guess
is submitted, with no bypass and no duplicate gate.

## 1. Architecture recap (read in full before this plan, and before any

follow-up build issue)

`apps/web/src/lib/use-trade-replay.ts`, `apps/web/src/components/
TradeReplay.tsx`, `apps/web/src/lib/portfolio-series.ts`, `apps/web/src/
components/PortfolioChart.tsx`, `apps/web/src/components/
WholeRangeBalance.tsx`, `apps/web/src/components/HeroAndWorstCase.tsx`,
`apps/web/src/components/ResultsPanel.tsx` (the intraday-daily branch,
currently lines ~563-749), `apps/web/src/lib/format-date.ts`, and
`apps/web/CLAUDE.md`'s "Trade replay," "Rewind-to-start-date intro
beat," "Carrying the ticking date readout through forward playback
(issue #107)," and "Marker pulse, shake, and speech-bubble callout
during trade replay (issue #108)" sections -- five-plus rounds of
code-review-caught bugs already fixed there, several of which this plan
deliberately reuses rather than re-derives (section 5).

**Already generic enough to need zero changes, confirmed by reading the
code directly:**

- `PortfolioPoint`/`PortfolioEvent` (`portfolio-series.ts`) -- identical
  shape returned by `derivePortfolioSeries` (window model) and
  `deriveWholeRangeIntradaySeries` (chained intraday, issue #91).
  `ResultsPanel.tsx`'s own `wholeRangePoints` memo is already exactly
  this shape.
- `use-trade-replay.ts`'s `buildSegments`/`replayEventFor`/`initialFrame`/
  `finalFrame` -- all operate purely on `.value` and `.event`, never on
  `.date`'s format. No `Trade`-vs-`IntradayTrade` dependency anywhere in
  this file.
- `PortfolioChart`'s `revealedCount`/`interactive`/`landing` props
  (issue #96 round 3, issue #108) -- already shape-agnostic over the
  `isChainedIntradaySeries` x-axis branch; the scale-building `useMemo`
  is keyed on the full `points` array regardless of `revealedCount`.
- `TradeReplay.tsx`'s `calloutText` -- already calls `formatDateTime`
  (format-aware, not the plain-date-only `formatDate`), so a single
  trade's callout narrates correctly for either series shape already.
  1W stays at one-trade-per-pause (no chunking, unlike 1M/3M/1Y), so
  this needs no new "chunk narration" voice the way #106's plan requires
  -- confirms this plan's core thesis that 1W is close enough to
  window-model scale for a materially simpler design.
- `lib/easing.ts`'s `tweenValue`, `use-reset-when-changed.ts`'s
  `useResetWhenChanged` -- reusable as-is.
- `IntradayWorstCaseResult`/`IntradayLongShortResult` already carry
  their own chained `startingCapital` (confirmed directly in
  `packages/core/src/intraday-optimizer.ts` lines 116-141) -- issue #84
  shipped this; #106's plan's "zero new pipeline work" finding for a
  whole-range worst-case figure applies identically here.

**Needs new code, but small and additive, not a fork -- see sections 3
and 5:**

- `use-trade-replay.ts`'s pacing constants (`TRANSITION_MS`/
  `EVENT_PAUSE_MS`/`REWIND_MS`) are module-level, not parameters --
  needs to become an optional, defaulted parameter so 1W's replay can
  use tighter values than the window model's without forking the hook.
- `use-trade-replay.ts`'s two date-reading call sites assume a plain
  calendar date (`formatDate`, `Date.parse(\`${date}T00:00:00Z\`)`) --
  a real, previously-undocumented bug against a datetime-labeled chained
  series (section 5).
- No `WorstCaseStat`-equivalent exists for the whole-range headline
  today (confirmed: `WholeRangeBalance.tsx` has no such stat, and
  `ResultsPanel.tsx`'s intraday-daily branch never computes a whole-range
  worst-case balance, only `wholeRangeFinalBalance` for the best-case
  track) -- section 3 resolves this.

## 2. Correcting the issue's own pacing figure, worked through with real numbers

`use-trade-replay.ts`'s own header comment gives the authoritative
per-trade cost formula, confirmed against its own two worked examples
("a 1-trade window plays in ~2.4s, a 3-trade window in ~6.6s"): for `n`
trades, the walk produces `3n + 1` segments (an initial
start-to-first-open segment, then per trade: open->flat, flat->close,
and close-to-next-open), of which `2n` land on a real event (each
trade's own open and close) and therefore pause. Total time:

```
total_ms(n) = (3n + 1) x TRANSITION_MS + 2n x EVENT_PAUSE_MS
            = (3n + 1) x 300 + 2n x 600
            = 2100n + 300
```

Verified against both of the hook's own documented examples: `n=1` ->
`2100 + 300 = 2400ms` (matches "~2.4s"); `n=3` -> `6300 + 300 = 6600ms`
(matches "~6.6s" exactly).

**Applying this to 1W's real worst case (15 trades, confirmed in section
2.1 below), unmodified pacing plays in `2100 x 15 + 300 = 31,800ms ~
31.8s`, not the issue body's "~27s" figure.** The issue's own number
appears to come from a simpler (and inexact) `15 x 1800ms` estimate --
2 pauses of `600ms` plus their own `300ms` transitions per trade, which
undercounts the "close of trade N to open of trade N+1" transition
segments and the leading boundary segment. **This plan trusts the
hook's own documented, twice-verified formula over the issue body's
unverified estimate, per this plan's explicit mandate to confirm rather
than trust the issue body's numbers as-is.**

Either way, the conclusion is the same and stronger than the issue's own
hedge ("that's still plausibly workable... verify live, and cap/tighten
pacing if it drags"): **31.8s is well outside a "watch it happen"
feel**, especially compared to the window model's established ~2.4-6.6s
and #106's own proposed ~4-14s target for 1M/3M/1Y. Pacing needs
tightening for 1W, not just live-verifying as an afterthought.

### 2.1 Confirming "15 trades worst case" itself

`packages/core/src/preset-ranges.ts`: `presetRangeStartDate("1W", asOf)`
returns `daysBeforeUtc(asOf, 7)` -- 7 calendar days back. Seven calendar
days always spans exactly one full week, so it covers 5 weekdays
(possibly fewer around a market holiday, never more). `apps/pipeline/src/
pipeline.ts` line 109: `const DEFAULT_MAX_TRADES_PER_DAY = 3;`, and
`INTRADAY_RANGES` (line 163) includes `"1W"`. `5 trading days x 3
trades/day = 15` -- confirmed exactly, matching the issue body's own
figure (unlike the ~27s pacing estimate, which this plan corrects
above).

### 2.2 Proposed pacing: parameterize, don't hardcode a second copy

**Recommendation: `useTradeReplay` gains an optional second parameter,
`pacing?: ReplayPacing` (`{ transitionMs, eventPauseMs, rewindMs }`),
defaulting to the current window-model constants** (so `TradeReplay.tsx`
needs zero changes -- it simply doesn't pass the parameter). 1W's own
`WholeRangeReplay.tsx` passes a tighter, module-level constant object
(not an inline literal -- its identity must stay stable across renders,
the same "identity stability" discipline this file already applies to
`points`/`landing` elsewhere, or the RAF effect's own `[phase, points]`-
style dependency array would restart on every parent render).

**Concrete starting values, tuned by feel against the `2100n + 300`-style
formula above (not pinned as a hard requirement -- see section 6, matching
this repo's own established "tuned by feel" precedent for every prior
pacing constant)**:

```
WHOLE_RANGE_REPLAY_PACING = {
  transitionMs: 150,   // half of the window model's 300ms
  eventPauseMs: 250,   // ~42% of the window model's 600ms
  rewindMs: 700,        // unchanged -- REWIND_MS is a fixed intro beat, not per-trade
}
```

Worst case (15 trades): `(3x15+1) x 150 + 2x15 x 250 = 6900 + 7500 =
14,400ms ~ 14.4s` -- comfortably inside the issue's own suggested
"10-15 seconds" target. A typical 1W result (many real weeks produce 0-3
trades total across all 5 days, not the worst-case ceiling) plays far
faster, well under 5s.

**Target playback durations to state in the build issue's own Scope
section**: worst-case (15 trades) ~14s; typical (0-3 trades) ~2-5s.
**Requires live verification against real current 1W data before
shipping**, per this repo's own working agreement -- these are worked
out analytically from the hook's own documented formula, not yet
measured against a real browser's RAF scheduling overhead, matching the
same caveat #106's plan states for its own ~7-14s chunk-based figures.

## 3. Hero/reveal component: extend `WholeRangeBalance`, don't compose through `HeroAndWorstCase`

### 3.1 Why this plan diverges from #106's own sketch, stated explicitly

#106's plan (section 3.3) proposes a `WholeRangeReplay.tsx` that
"Composes `HeroAndWorstCase` (via its existing `heroSlot` overlay, no
change needed there) + the whole-range `PortfolioChart` instance" --
written without a shipped 1W to check that assumption against, per that
plan's own section 0 correction.

**Read against the actual `WholeRangeBalance.tsx`, this assumption
doesn't hold.** `WholeRangeBalance` already renders a genuine hero-style
headline once revealed (`text-xl font-semibold ... sm:text-2xl`, "$X ->
$Y", the same visual register `HeroStat`'s value row uses) -- it is
_already_ this range's one hero moment, just without `HeroStat`'s
count-up/celebration machinery and without a worst-case sibling.
Composing a _second_, independent `HeroAndWorstCase` alongside it (as
#106's sketch implies, since nothing in that sketch says
`WholeRangeBalance`'s own headline should stop rendering) would put the
identical dollar figure on screen twice: once in `WholeRangeBalance`'s
own static revealed state, and again in a parallel `HeroAndWorstCase`
showing the same number a few lines below or beside it. That's a real
product redundancy this plan can catch and avoid now, precisely because
a shipped 1W exists to check the assumption against -- exactly the kind
of divergence-with-reason #106's own plan invited a later reconciliation
pass to make.

**This plan's answer: extend `WholeRangeBalance` itself, don't build a
parallel hero.** `HeroAndWorstCase`'s own `heroSlot` prop already
proved, twice (issues #96/#97/#107's own code-review history), that
"overlay animated content on an existing static component's own slot,
without replacing or unmounting it" is the correct shape for this exact
kind of problem (a component with real, protected internal state --
here, the guess-then-reveal form -- that a sibling animated feature
needs to sit on top of without disturbing). `WholeRangeBalance`'s
guess-then-reveal form is exactly such protected state, arguably more so
than `HeroStat`'s own count-up/mount timing, since it also owns
persisted `localStorage` writes (`range-guess-storage.ts`) that must
never be touched by anything replay-related.

### 3.2 Concrete design

**`WholeRangeBalance.tsx` gains two new props** (both effectively
required in practice, since this plan's only real caller will always
pass them -- left as an implementation-time call whether to make them
strictly required or optional-with-a-sensible-default, matching this
component's own existing convention of documenting "every real call site
passes this" rather than defending an unused default):

- `worstCase: { startingCapital: number; endingBalance: number }` --
  rendered as a `<WorstCaseStat>` sibling next to the headline, in the
  same `flex flex-col gap-4 sm:flex-row sm:items-end sm:gap-8` row shape
  `HeroAndWorstCase` already establishes for the day-level pairing above
  it (visual consistency between the two "hero rows" on the same page).
  Rendered only inside the `revealed` branch, same as the headline
  itself -- no new gate, reuses the existing `guess !== null` check this
  component already computes.
- `revealSlot?: ReactNode` -- overlays _just_ the headline `<p>` (not
  the "You guessed $X" line below it, not the worst-case stat), via the
  exact same CSS idiom `HeroAndWorstCase`'s own `heroSlot` already uses:
  the headline `<p>` moves inside a `relative` wrapper, gets
  `invisible`/`aria-hidden` conditionally on `revealSlot`'s presence,
  and `revealSlot` paints as an `absolute inset-0` sibling. The "You
  guessed $X" paragraph, the `sr-only` status region, and the entire
  guess-form branch are all completely untouched by this prop -- it can
  only ever affect the headline `<p>`'s own visual slot.

**New component: `WholeRangeReplay.tsx`**, sibling to `TradeReplay.tsx`,
composing `WholeRangeBalance` (extended as above) plus the whole-range
`PortfolioChart`:

```
interface WholeRangeReplayProps {
  rangeLabel: string;
  startingCapital: number;            // display starting capital
  points: readonly PortfolioPoint[];  // wholeRangePoints, from ResultsPanel
  worstCaseEndingBalance: number;     // raw, native-root -- see 3.3
  worstCaseStartingCapital: number;
  guess: number | null;
  guessStartingCapital: number | null;
  onSubmitGuess: (guess: number, startingCapital: number) => void;
}
```

- Calls `useTradeReplay(points, WHOLE_RANGE_REPLAY_PACING)` directly
  (section 2.2, section 5).
- Computes `revealSlot` (only during `"rewinding"`/`"playing"`) the same
  "Rewinding to"/"Watching {date}" + tweened "$X -> $Y" shape
  `TradeReplay.tsx` already established -- reusing `WholeRangeBalance`'s
  own typography, which needs to export its label/value-row class names
  the same way `HeroStat.tsx` already exports `heroLabelClassName`/
  `heroValueRowClassName` for exactly this reuse (issue #96 round four's
  own precedent, applied a second time rather than hand-copying string
  literals a second time).
- Renders `<WholeRangeBalance ... worstCase={...} revealSlot={...} />`
  unconditionally (same as today), then -- **only once `guess !== null`**
  -- the "Watch it happen"/"Skip to end" button row and the whole-range
  `PortfolioChart` (`revealedCount`/`interactive`/`landing`, identical
  wiring shape to `TradeReplay.tsx`). Returns a Fragment of these two
  top-level blocks, not one wrapping div -- explicitly avoiding the
  exact `gap-8`-collapsing bug issue #96's own round-one code review
  found and fixed for `TradeReplay.tsx`'s identical shape.
- `calloutText` is reused directly rather than hand-copied a second time
  -- worth extracting `TradeReplay.tsx`'s private `calloutText` function
  into a small shared module (e.g. alongside `trade-math.ts`'s existing
  verb-pair helpers, or its own `replay-callout.ts`) as part of this
  build issue's own implementation surface, since it's currently a
  private, unexported function.

**`ResultsPanel.tsx` changes**: replace the `<WholeRangeBalance>` call
(currently line 634) with `<WholeRangeReplay>`, passing the two new
worst-case values (computed unconditionally, alongside the existing
`wholeRangeFinalBalance`, per section 3.3) and `wholeRangePoints`;
delete the bare `<PortfolioChart key={...} points={wholeRangePoints} />`
call (currently line 663) entirely, since `WholeRangeReplay` now owns
rendering that chart internally. `BenchmarkStat` and the explanatory
paragraph stay exactly where and how gated as today (`rangeGuess !==
null`, unchanged) -- this plan touches only the headline/worst-case/
chart trio, not the whole gated fragment.

### 3.3 The worst-case figure's own computation (mirrors #106's corrected design, verified against real code)

Same corrected pattern #106's plan section 3.3 arrived at after its own
independent review caught a double-rescale risk -- worth re-deriving
briefly here since it's directly load-bearing for this plan's own
`WholeRangeReplay` props, not just cited:

```ts
// Alongside the existing wholeRangeFinalBalance computation
// (ResultsPanel.tsx, currently ~line 619) -- computed unconditionally,
// same cost profile as that existing computation (a couple of field
// reads off finalDay, no new traversal).
const wholeRangeWorstCaseEndingBalance = finalDay
  ? mode === "long"
    ? finalDay.worstCase.endingBalance
    : finalDay.longShort.worstCase.endingBalance
  : 0;
// The range's own root -- identical across all four independently-
// chained tracks on day 0 by issue #84's own chaining design. Passed
// RAW (not pre-rescaled the way wholeRangeFinalBalance is for
// WholeRangeBalance's own plain finalBalance prop) -- WorstCaseStat
// does its own single rescale internally via effectiveStartingCapital,
// the same raw-value contract every other WorstCaseStat/HeroAndWorstCase
// caller in this app already uses. Pre-rescaling here too would
// double-rescale -- see apps/web/CLAUDE.md's "rescaleFromStartingCapital's
// per-day pattern..." section and #106's plan section 3.3 for the full
// derivation of why this specific pair must stay raw.
const wholeRangeWorstCaseStartingCapital = data.startingCapital;
```

`WholeRangeReplay` passes these straight through to `WholeRangeBalance`'s
new `worstCase` prop; `WholeRangeBalance` rescales via
`rescaleFromStartingCapital(worstCase.endingBalance,
worstCase.startingCapital, startingCapital)` internally before handing
the result to `WorstCaseStat` -- the exact same single-rescale contract
`HeroAndWorstCase` already establishes for its own worst-case stat.

### 3.4 Guess-then-reveal gate: sequencing, not a second gate

**The replay button and chart never need their own independent check
against `rangeGuess`** -- they're gated by construction, the same way
`BenchmarkStat`/the existing bare chart call already are today:
`ResultsPanel.tsx`'s `wholeRangePoints` memo (confirmed by reading its
current code) already returns `[]` whenever `rangeGuess === null`.
`WholeRangeReplay` receives this same `points` prop; with `points.length
< 2`, `useTradeReplay`'s own `play()` guard already makes the hook
permanently inert (`play()` is a no-op), and this plan's own button
row -- rendered only once `guess !== null`, the same value already
threaded to `WholeRangeBalance` -- never even mounts pre-reveal. This is
not a second gate duplicating `WholeRangeBalance`'s own: it's the same
`guess`/`rangeGuess` value, read at the same two places
(`WholeRangeBalance` and now also `WholeRangeReplay`) that
`ResultsPanel.tsx` already reads it today (the `<WholeRangeBalance>`
call and the `{rangeGuess !== null && (...)}` block wrapping
`BenchmarkStat`/the chart) -- no new sequencing risk introduced.

**One real wrinkle worth flagging for the build issue, identical to
#106's plan section 3.4's own finding for the same reason**: a
`DayOverview` day switch changes `ResultsPanel`'s `activeDay`/
`selectedDay` state but does **not** change `wholeRangePoints` (that
memo's dependency array is `[state, startingCapital, mode, rangeGuess]`,
confirmed directly -- `activeDay`/`selectedDay` aren't in it) -- so
browsing to a different day mid-replay must not reset or interrupt
whole-range playback, unlike a `ModeToggle`/`StartingCapitalInput` edit
(which does change `wholeRangePoints`' contents and correctly should
reset, via the same `useResetWhenChanged([points], ...)` mechanism the
window model already uses). This falls out for free from reusing that
exact mechanism unmodified -- worth a regression test confirming it
(section 4), mirroring #96's own "mode switch mid-playback correctly
resets" test.

### 3.5 What this means for #106's own eventual reconciliation pass

#106's plan explicitly deferred filing its own build issue until #105
ships, specifically so it could reconcile with #105's real choices
rather than diverge from them unverified (#106 plan section 0/6.1).
This plan's divergence from #106's `HeroAndWorstCase`-based sketch is
exactly the kind of thing that reconciliation pass needs to absorb: once
this issue ships, 1M/3M/1Y's own build issue should extend
`WholeRangeBalance`'s new `worstCase`/`revealSlot` props (not introduce
a second, `HeroAndWorstCase`-based hero pattern for the same range
type), and its own day-chunk segment builder (this plan's section 5
notes `useTradeReplay` will already have grown a `pacing` parameter by
then, which #106's own segment-builder generalization can layer on top
of directly) should target the identical `WholeRangeReplay`-shaped
composition this plan establishes, swapping in a chunked pacing profile
and chunk-summary callout voice instead of 1W's per-trade one. Concretely:
`WholeRangeBalance`'s new props, `WholeRangeReplay.tsx`'s overall shape,
and `useTradeReplay`'s new `pacing` parameter are all groundwork this
plan recommends #106's own follow-up build issue reuse directly, not
reconsider from scratch.

## 4. Guess-then-reveal, worst-case, and the DayOverview independence: test impact (qualitative)

- `use-trade-replay.test.ts`: gains coverage for the new `pacing`
  parameter (defaults preserved when omitted; a custom pacing object's
  values actually drive the RAF timing) and the date-formatting fix
  (section 5) against a fixture using datetime-labeled points.
- `WholeRangeBalance.test.tsx`: new coverage for the `worstCase`/
  `revealSlot` props -- worst-case stat renders only once revealed;
  `revealSlot` overlays only the headline, leaving the guess form/
  "You guessed" line/sr-only region unaffected in every state.
- `WholeRangeReplay.test.tsx`, mirroring `TradeReplay.test.tsx`'s
  existing coverage shape: idle/rewinding/playing/done rendering; the
  button/chart genuinely absent pre-reveal (not just visually hidden);
  a day switch (`DayOverview`, an unrelated prop) leaves an in-flight
  replay undisturbed (section 3.4); reduced motion's full bypass;
  worst-case figure computed via the raw/native-root contract (section
  3.3), not a pre-rescaled one.
- `ResultsPanel.test.tsx`: coverage for the two new
  `wholeRangeWorstCaseEndingBalance`/`wholeRangeWorstCaseStartingCapital`
  computations (both modes, mirroring existing `wholeRangeFinalBalance`
  coverage), and that `WholeRangeReplay` (not a bare `PortfolioChart`)
  is what's rendered post-reveal.
- Live verification (per this repo's working agreement): a real
  local-pipeline-run measurement of actual 1W worst-case playback
  duration against real current data (the established `local-run.ts`/
  headless-Chromium technique), since section 2.2's ~14.4s figure is
  worked out analytically, not yet measured against real RAF scheduling
  overhead -- plus the reduced-motion full-bypass check and a
  day-switch-mid-replay screenshot pass confirming section 3.4's claim.

## 5. Does this reuse `use-trade-replay.ts` directly? Yes, with one real fix found, not zero changes

**The hook's core walk machinery (segments, phase state, RAF scheduling,
the mid-flight points-reference reset, `completedRuns`) needs zero
changes** -- confirmed by reading every line of `use-trade-replay.ts`:
nothing in `buildSegments`, `replayEventFor`, `initialFrame`,
`finalFrame`, or the two RAF effects reads `.date` in a way that assumes
a particular format; they only read `.value`/`.event`.

**But two call sites inside the same file genuinely do assume a plain
calendar date, and would break silently against `deriveWholeRangeIntraday
Series`'s datetime-labeled points (e.g. `"2025-08-21T09:30:00"`) --
this is a real, previously-undocumented bug this plan's own verification
pass found, not a hypothetical:**

1. **The rewind effect's target-date parse**: `Date.parse(\`${points[0]!
   .date}T00:00:00Z\`)`. Given a window-model point (`"2025-08-21"`), this
correctly produces `"2025-08-21T00:00:00Z"`. Given a chained-intraday
point (`"2025-08-21T09:30:00"`), this produces
`"2025-08-21T09:30:00T00:00:00Z"`-- a malformed ISO string with two`T`s, which `Date.parse`returns`NaN`for. The rewind's own tween
target would be`NaN`, and `formatEpochAsDate(NaN)`renders`"Invalid
   Date"` for the entire rewind beat.
2. **`displayDate`'s "playing" branch**: `formatDate(points[index]!
.date)`. `formatDate` (`format-date.ts`) unconditionally does the exact
   same `Date.parse(\`${isoDate}T00:00:00Z\`)` -- the identical bug,
   this time for the whole rest of forward playback (issue #107's own
   extended readout), not just the rewind beat.

**Both are small, surgical fixes, not a redesign -- and both should
reuse existing, already-correct logic rather than invent a third copy of
the same "is this a datetime or a plain date" check.**
`PortfolioChart.tsx` already has exactly the right logic, privately:

```ts
function toTimestamp(date: string): number {
  return new Date(isPortfolioDatetime(date) ? `${date}Z` : `${date}T00:00:00Z`).getTime();
}
```

**Recommendation**: extract this into `format-date.ts` as an exported
function (e.g. `toPortfolioTimestamp`), alongside `isPortfolioDatetime`/
`formatDateTime` -- the same "single canonical place this detection
happens" convention `isPortfolioDatetime`'s own doc comment already
establishes for the format check itself. `PortfolioChart.tsx` imports it
instead of keeping its own private copy; `use-trade-replay.ts`'s rewind
effect calls it for the target-epoch computation instead of its own
inline `Date.parse`. For `displayDate`'s "playing" branch, replace the
bare `formatDate(points[index]!.date)` call with `formatDateTime(points
[index]!.date, true)` -- `formatDateTime` already delegates to
`formatDate` unconditionally for a plain-date point (`includeDate` is
simply ignored in that branch, confirmed by reading the function), so
this is a safe, zero-behavior-change swap for the window model and the
correct multi-day-aware format (`"Aug 21, 9:30 AM"`) for the chained
intraday case -- no new `spansMultipleDays`/`includeDate` plumbing
needed on the hook's own public API, since `true` is always the correct
value for any series a caller would ever animate through (a single day
in isolation is never what this hook walks; only whole multi-day
window/whole-range series are).

**With these two fixes plus the `pacing` parameter (section 2.2), the
hook is genuinely, fully reusable as-is for 1W -- confirming a firm
"yes" to question 5, not a "yes with an asterisk."** This is the
concrete basis for this plan's broader claim that 1W needs a materially
simpler design than 1M/3M/1Y: no new segment-builder abstraction, no
day-grouping/chunking, no new `Segment`/`ReplayEvent` fields -- just a
pacing parameter and a two-line date-handling fix, both of which are
also correctness fixes worth having regardless of this feature (the
`formatDate`-on-a-datetime bug would already be live and wrong for the
window model's rewind beat's own `points[0]` read if that series' first
point were ever, hypothetically, datetime-labeled -- not reachable
today given `derivePortfolioSeries` only ever produces plain-date
points, but worth the general robustness gain regardless).

## 6. Implementation surface for the follow-up build issue (by file path)

- **`apps/web/src/lib/format-date.ts`** -- export `toPortfolioTimestamp`
  (extracted from `PortfolioChart.tsx`'s private `toTimestamp`).
- **`apps/web/src/components/PortfolioChart.tsx`** -- import
  `toPortfolioTimestamp` instead of defining it locally. No other
  change.
- **`apps/web/src/lib/use-trade-replay.ts`** -- add the optional
  `pacing` parameter (section 2.2) with defaults matching today's
  constants; fix the two date-handling call sites (section 5) using the
  newly-exported `toPortfolioTimestamp`/`formatDateTime`.
- **`apps/web/src/components/WholeRangeBalance.tsx`** -- add
  `worstCase`/`revealSlot` props (section 3.2); export its label/
  value-row class names for `WholeRangeReplay.tsx` to reuse (mirroring
  `HeroStat.tsx`'s existing `heroLabelClassName`/`heroValueRowClassName`
  exports).
- **New: `apps/web/src/components/WholeRangeReplay.tsx`** -- per section
  3.2.
- **New or relocated: a shared `calloutText`-equivalent module** --
  extracting `TradeReplay.tsx`'s currently-private `calloutText` so
  `WholeRangeReplay.tsx` can reuse it without a second copy (section
  3.2).
- **`apps/web/src/components/ResultsPanel.tsx`** -- the intraday-daily
  branch (currently ~lines 604-665): add
  `wholeRangeWorstCaseEndingBalance`/`wholeRangeWorstCaseStartingCapital`
  (section 3.3) alongside the existing `wholeRangeFinalBalance`
  computation; replace the `<WholeRangeBalance>` call with
  `<WholeRangeReplay>`; delete the bare `<PortfolioChart>` call.
- **No changes expected**: `TradeReplay.tsx` (its own defaults keep it
  byte-for-byte behaviorally identical once `pacing` becomes optional),
  `HeroAndWorstCase.tsx`, `HeroStat.tsx` (beyond the already-established
  export convention this plan reuses, not extends), any pipeline/schema
  file.

## 7. For the manager

Two things this plan could not resolve unilaterally:

1. **The exact `WHOLE_RANGE_REPLAY_PACING` values** (section 2.2) are
   proposed and worked through analytically against the hook's own
   documented formula, but -- consistent with how this repo has treated
   every prior pacing constant -- are left as an implementer/reviewer
   call to finalize against real data and a real browser, not pinned as
   a hard requirement here.
2. **Whether `WholeRangeBalance`'s new `worstCase`/`revealSlot` props
   should be strictly required or optional-with-a-default** (section
   3.2) -- a small API-shape call this plan didn't think worth blocking
   on, since either choice produces the identical behavior for this
   issue's own single real call site; worth the implementer's/
   reviewer's own judgment at build time, matching how this repo
   generally treats this exact class of prop-shape decision (e.g.
   `BenchmarkStat`'s `rangeLabel`, left optional with no live caller
   relying on the default).

Also worth the manager's explicit awareness, not left ambiguous: this
plan's section 3 is a genuine, reasoned **divergence** from #106's
sibling plan's own `HeroAndWorstCase`-based sketch for the whole-range
hero component, not an oversight or a missed cross-reference -- section
3.1 states the reasoning (avoiding a duplicated headline figure), and
section 3.5 states what this plan recommends #106's own eventual build
issue reuse versus reconsider once it's filed.
