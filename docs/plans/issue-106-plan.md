# Plan: issue #106 -- "Watch it happen" replay coverage for 1M/3M/1Y

Status: plan only, per the issue's own scope -- no implementation in this
worktree. Produces this design doc so a follow-up build issue (or
issues) can be filed agent-ready afterward.

## 0. One-paragraph summary

1M/3M/1Y (the intraday-daily model, up to ~63/~186/~750 total trades
respectively) cannot reuse the shipped window-model replay's per-trade-
event pacing (`use-trade-replay.ts`'s `TRANSITION_MS`/`EVENT_PAUSE_MS`)
unmodified -- at that pacing, 1Y alone would run ~26 minutes. This plan's
answer is a **day/chunk-based reveal, capped to a fixed number of
animation steps regardless of range**, not a per-range-tuned pacing
scheme: group the whole-range chained series into at most `NUM_CHUNKS`
(40, tuned by feel) roughly-equal day-clusters, reveal each cluster as
one fast tween, and pause only on a cluster containing at least one real
trade to show a lightweight date-range/trade-count callout instead of a
per-trade narration. Because the chunk count is capped, worst-case total
duration is bounded by the same ceiling for 3M and 1Y (~14s) regardless
of their very different day counts, with 1M coming in lower
automatically (~7s) since it has fewer real days than the cap. This
answers "one build issue or split further" too: **one build issue**,
since 1M/3M/1Y share one mechanism and one set of constants by
construction, the same reasoning issue #96 used to cover the whole
window model (5Y/MAX/custom-anchor) in one issue. The hero/reveal
component is a new `WholeRangeReplay.tsx` (parallel to `TradeReplay.tsx`),
reusing `HeroAndWorstCase`'s existing `heroSlot` overlay and
`PortfolioChart`'s existing `revealedCount`/`interactive` props as-is (both
already shape-agnostic over window vs. chained-intraday series, confirmed
by reading the code, not assumed). Replay is scoped to the whole-range
chart only (not the per-day drill-down) and gated identically to
`WholeRangeBalance`'s existing guess-then-reveal control -- the button
only appears once the range guess is already revealed. One genuinely new
piece of UI this plan recommends: a whole-range **worst-case** figure,
which turns out to need **zero new pipeline/schema work** -- issue #84's
per-day chained `startingCapital`/`endingBalance` on
`IntradayWorstCaseResult` already makes the final day's own chained
worst-case balance a single rescale away, exactly mirroring how
`wholeRangeFinalBalance` is already computed for the best-case track
today.

**A correction to this issue's own Background, verified rather than
assumed**: the sibling 1W issue (#105) has **not landed**, and has no
open PR (`gh issue view 105` shows `state: OPEN`; `gh pr list --search
"105"` returns zero results; no `105`-referencing branch exists). There
is no shipped 1W implementation to read or build on. This plan proceeds
by designing 1M/3M/1Y's own hero/reveal component and gate sequencing
independently, but flags the sequencing risk this creates for the
manager (section 6).

## 1. Architecture recap: what's already reusable, verified against the real code

Read in full before this plan (and before any follow-up build issue):
`apps/web/src/lib/use-trade-replay.ts`, `apps/web/src/components/
TradeReplay.tsx`, `apps/web/src/lib/portfolio-series.ts`, `apps/web/src/
components/PortfolioChart.tsx`, `apps/web/src/components/
WholeRangeBalance.tsx`, `apps/web/src/components/HeroAndWorstCase.tsx`,
`apps/web/src/components/ResultsPanel.tsx` (the intraday-daily branch,
currently lines ~559-746), and `apps/web/CLAUDE.md`'s "Trade replay:
'Watch it happen'" and "Rewind-to-start-date intro beat" sections (five
code-review rounds' worth of subtle bugs already found and fixed there
-- this plan's design deliberately reuses that hook's machinery rather
than re-deriving a second copy of any of it, specifically to inherit
those fixes for free).

**Already generic enough to need zero changes:**

- `PortfolioPoint`/`PortfolioEvent` (`portfolio-series.ts`) are the
  identical shape for both `derivePortfolioSeries` (window model) and
  `deriveWholeRangeIntradaySeries` (chained intraday, issue #91) --
  confirmed by reading both functions. `wholeRangePoints`
  (`ResultsPanel.tsx`'s own memo) is already exactly the array shape
  `use-trade-replay.ts` and `PortfolioChart` consume.
- `PortfolioChart`'s `revealedCount`/`interactive` props (round 3 of
  #96's own code review) are already shape-agnostic over which x-axis
  branch (`isChainedIntradaySeries`) applies -- confirmed by reading the
  scale-building `useMemo`, which is keyed on the full `points` array
  regardless of `revealedCount`. No `PortfolioChart` change needed at
  all for this issue.
- `HeroAndWorstCase`'s `heroSlot` prop (an overlay, not a replacement --
  see that component's own doc comment) is generic over what content
  gets overlaid; nothing about it is window-model-specific.
- `lib/easing.ts`'s `tweenValue` (the shared ease-out-cubic tween,
  extracted in #96's own round three) is reusable for a chunk-level
  balance tween exactly as-is.
- `use-reset-when-changed.ts` (the shared "adjust state during render
  when a tracked value changes" idiom, extracted in #96's round four) is
  the correct tool for the same class of live-prop-mid-flight problem
  this new hook will also face (a `ModeToggle`/`StartingCapitalInput`
  edit mid-playback, or a `DayOverview` day switch that doesn't affect
  `wholeRangePoints` at all and must NOT reset replay -- see section 3.4).

**Needs new code, not a reuse of the existing implementation as-is:**

- `use-trade-replay.ts`'s own `buildSegments` walks `points` one index at
  a time, pausing `EVENT_PAUSE_MS` on _every_ point carrying a real
  event -- structurally wrong at this scale (see section 3.1's numbers).
  The RAF/phase/rewind/reset scaffold around it, however, is reusable.
- `TradeReplay.tsx`'s `calloutText` narrates one trade at a time
  ("Bought AAPL on Mar 12, 2025 at $142.00") -- the wrong narration
  granularity once a single animation step can span multiple days and
  up to `maxTradesPerDay * chunkDayCount` trades (section 3.1).
- No whole-range worst-case figure exists anywhere today (confirmed:
  `WholeRangeBalance.tsx` has no `WorstCaseStat`-equivalent, and
  `ResultsPanel.tsx`'s intraday-daily branch never computes a whole-range
  worst-case balance, only `wholeRangeFinalBalance` for the best-case
  track). Section 3.3 resolves this.

## 2. Why unmodified per-event pacing genuinely cannot work here (the numbers, worked through)

`use-trade-replay.ts`'s own doc comment confirms the window model's
pacing: a trade contributes 3 points (open/flat/close) via
`appendTradeSteps`, and each trade costs `3 * TRANSITION_MS (300ms) + 2 *
EVENT_PAUSE_MS (600ms) = 2100ms` (2 of the 3 point-to-point transitions
pause on a real event; the middle "flat" point has none). A 1-trade
window plays in ~2.4s, a 3-trade window in ~6.6s -- both confirmed
against the hook's own doc comment.

Applying that unmodified per-trade cost to the whole-range trade
ceilings this issue's own Background states (1M ~63 trades, 3M ~186, 1Y
~750, all derived from `DEFAULT_MAX_TRADES_PER_DAY = 3`
`apps/pipeline/src/pipeline.ts:109` times each range's real trading-day
count):

| Range | Worst-case trades | Unmodified total                   | vs. Lambda-adjacent "tens of minutes" framing |
| ----- | ----------------- | ---------------------------------- | --------------------------------------------- |
| 1M    | ~63               | ~63 × 2100ms ≈ 132.6s (~2.2 min)   | already unwatchable                           |
| 3M    | ~186              | ~186 × 2100ms ≈ 390.6s (~6.5 min)  | unwatchable                                   |
| 1Y    | ~750              | ~750 × 2100ms ≈ 1,575s (~26.3 min) | matches the issue's own framing exactly       |

This confirms the issue's own numbers arithmetically (not just cites
them) and rules out "just tighten `TRANSITION_MS`/`EVENT_PAUSE_MS`" as a
sufficient fix on its own -- even an aggressive 10x tightening leaves 1Y
at ~2.6 minutes, still not "watchable." A different _mechanism_, not a
tuning knob, is required -- exactly what the issue's own Scope section
asks this plan to name.

## 3. Resolving the issue's own Scope questions

### 3.1 Pacing/animation mechanism + target durations per range

**Mechanism: day-level chunking, capped to a fixed total step count
(`NUM_CHUNKS`), not a per-range-tuned duration.** This combines two of
the issue's own named example mechanisms ("per-day chunking with
skippable/fast-forwarded no-trade days" and "a capped total duration
with a proportional... time budget") into one design, rather than
picking one in isolation -- the combination is what makes a single set
of constants work across three ranges whose day counts differ by more
than 10x.

**Step 1 -- group `wholeRangePoints` into day clusters.** Every point in
`deriveWholeRangeIntradaySeries`'s output already carries a real
calendar day via `portfolio-series.ts`'s exported `calendarDayOf`
(the same function issue #93's chained-intraday x-axis bucketing already
uses to group points by day) -- a chunk builder can walk `points` once,
grouping consecutive points sharing a `calendarDayOf` value into a
`DayGroup` (`{ date, points, hasTrade }`), with **no new pipeline field
and no change to `deriveWholeRangeIntradaySeries` itself**. This mirrors
`chart-scales.ts`'s own `buildChainedIntradayXPositions`, which already
does the identical day-grouping walk for a different purpose (x-axis
slot assignment) -- worth building the new grouping function alongside
that file's existing one, or extracting a shared "group points by day"
helper if the two turn out structurally identical once written (a real
implementation-time call, not pinned here).

**Step 2 -- cluster day groups into at most `NUM_CHUNKS` chunks.**
`chunkCount = min(dayGroups.length, NUM_CHUNKS)`; each chunk holds
`ceil(dayGroups.length / chunkCount)` consecutive day groups. For 1M
(~21 trading days, under the cap) this produces one chunk per day --
i.e. day-level granularity falls out for free without a separate code
path. For 3M (~62 days) and 1Y (~250 days), chunks span multiple
consecutive days each.

**Step 3 -- reveal one chunk per animation step.** Each step: (a) a
`CHUNK_TRANSITION_MS` tween of the running balance from the chunk's
starting value to its ending value (the same `tweenValue` curve
`use-trade-replay.ts` already uses per-segment, just applied once per
chunk instead of once per point) while `revealedCount` jumps straight to
the chunk's last point (matching the existing "the chart never
interpolates a position between two real points" principle -- only the
_display figure_ tweens, exactly `ReplayFrame.currentValue`'s existing
documented contract); (b) if the chunk contains **zero** real trades
(every day group in it has `hasTrade === false`), advance immediately to
the next chunk with no pause -- the "skippable/fast-forwarded no-trade
days" the issue names literally; (c) if the chunk contains **at least
one** real trade, pause `CHUNK_PAUSE_MS` and show a lightweight callout
naming the chunk's date range, trade count, and net change (see below)
-- deliberately **not** a per-trade narration (see the callout-voice
paragraph below for why).

**Constants (tuned by feel, matching this codebase's own established
precedent for `TRANSITION_MS`/`EVENT_PAUSE_MS`/`REWIND_MS` -- "doesn't
need to be exact," per issue #96's own scope note, and left as an
implementer/reviewer call in section 6, not pinned as a hard requirement
here):**

- `NUM_CHUNKS = 40`
- `CHUNK_TRANSITION_MS = 120`
- `CHUNK_PAUSE_MS = 220` (only for a chunk with >=1 trade)

**Worst-case total duration** (every chunk contains a trade -- the
realistic upper bound, analogous to how #96's own "3-trade window in
6.6s" already assumes every trade produces a pause):
`usedChunks × (CHUNK_TRANSITION_MS + CHUNK_PAUSE_MS)`, where `usedChunks
= min(dayCount, NUM_CHUNKS)`:

| Range | Trading days (~) | usedChunks  | Worst-case total       | Typical (not every day trades) |
| ----- | ---------------- | ----------- | ---------------------- | ------------------------------ |
| 1M    | 21               | 21          | 21 × 340ms ≈ **7.1s**  | ~4-5s                          |
| 3M    | 62               | 40 (capped) | 40 × 340ms ≈ **13.6s** | ~7-10s                         |
| 1Y    | 250              | 40 (capped) | 40 × 340ms ≈ **13.6s** | ~7-10s                         |

**The 3M/1Y worst-case durations land on the identical ~14s ceiling by
construction, not coincidence** -- this is the entire point of capping
`NUM_CHUNKS` rather than deriving a per-day pause budget from a
per-range-tuned total (an approach this plan tried first and rejected:
a fixed per-day pause reused across ranges blows past any reasonable
target once day count exceeds ~30-40, and a total-budget-divided-by-
day-count formula degenerates at 1Y's 250 days, since even a minimal
per-day transition time alone already consumes the whole budget before
any pause time is left -- worked through and rejected during this plan's
own drafting). 1M lands lower automatically because it has fewer real
days than the cap, with **no separate 1M-specific constant needed** --
this is also why one shared mechanism genuinely covers all three ranges
(see section 3.2).

**Target playback durations to state in the follow-up build issue's own
Scope section** (matching the style of #96's "roughly 3-6 seconds for a
typical 1-3 trade window" and #105's proposed "~10-15 seconds" for 1W):
**1M: roughly 4-7 seconds. 3M and 1Y: roughly 7-14 seconds, sharing the
same ~14s worst-case ceiling.**

**Callout voice is deliberately a new, distinct register from the
per-trade narration -- not reused as-is.** `TradeReplay.tsx`'s
`calloutText` narrates exactly one trade
(`"${verb} ${ticker} on ${date} at ${price}."`) via a `ReplayEvent`
carrying a single `PortfolioEvent`. A chunk here can span up to
`chunkDayCount * maxTradesPerDay` trades (e.g. a 7-day 1Y chunk at up to
3 trades/day = up to 21 trades) -- narrating each individually inside one
`CHUNK_PAUSE_MS` pause is not "watch it happen," it's an unreadable
blur regardless of how the pause duration is tuned. Recommend a
day/date-range summary sentence instead, e.g. `"{startDate}–{endDate}: N
trades, $X → $Y."` (exact copy is an implementation-time wording call,
consistent with how this repo already treats every other exact-copy
question -- see `WholeRangeBalance.tsx`'s own guess-prompt wording, never
pinned at the plan stage). **One free, natural degenerate case worth
keeping**: a chunk that happens to contain exactly one day with exactly
one trade (common for 1M, where chunks are single days) can use the
_existing_ single-trade `calloutText`/`tradeVerbsPastCapitalized` voice
unchanged -- the new summary sentence is only needed once a chunk's
trade count exceeds 1, so the build issue should design the callout
function to fall through to the existing narration for that case rather
than always using the new summary wording, keeping the two voices
consistent wherever they'd say the same thing anyway.

**Skip-to-end stays available identically throughout**, reusing the
exact same button/handler #96/#97 already established (no new control) --
if anything, more load-bearing here than for the window model, since
even the _capped_ worst case (~14s) is long enough that a user who just
wants the answer benefits from it more than a ~6.6s window-model replay
ever did.

**Shared hook design, not a forked copy of `use-trade-replay.ts`.**
Recommend generalizing the existing hook rather than writing a second,
independent one: extract the "walk points one at a time, pause on any
event" logic (`buildSegments`) behind a pluggable segment-builder
argument, and add a second builder (`buildChunkSegments`, per the design
above) that produces the identical `Segment[]` shape `tick()` already
consumes. Every other piece of the hook -- the `idle -> rewinding ->
playing -> done` phase machine, the rewind intro beat, `skipToEnd`, the
`useResetWhenChanged`-based mid-flight reset, the corrupted-price
defensive catch, `completedRuns` -- is untouched and shared verbatim,
inheriting five rounds of already-fixed correctness work for free rather
than risking reintroducing any of it independently in a second hook.
This is the same "shared, not copy-pasted" instinct this codebase
already applies everywhere else (`trade-math.ts`, `easing.ts`,
`use-reset-when-changed.ts`) -- a build issue should treat "does this
generalize `use-trade-replay.ts` cleanly, or does it need its own
`use-whole-range-replay.ts`" as its own first implementation decision,
with a strong prior toward generalizing given how much correctness work
already lives in the existing hook.

### 3.2 One build issue, or split further?

**Recommendation: one build issue, covering 1M/3M/1Y together.**

The chunk-cap design in 3.1 is what makes this defensible, not just
convenient: 1M/3M/1Y share **one mechanism and one set of constants**
(`NUM_CHUNKS`/`CHUNK_TRANSITION_MS`/`CHUNK_PAUSE_MS`), with no
per-range branch or per-range-tuned value anywhere in the design. This
is the identical shape of argument that let issue #96 cover the entire
window model (5Y, MAX, and every custom-window anchor) as one issue
despite those ranging from a handful of trades to a 21-year span -- the
mechanism doesn't change per range, only the data fed into it does.
Splitting 1M off from 3M/1Y (the alternative the issue's own Scope
section raises) would buy nothing: there's no natural mechanism
boundary between them the way there is between the window model's
per-event pacing and this issue's chunk-based pacing.

The one real reason to split would be if 1M's own worst-case duration
(~7s) felt qualitatively different enough from 3M/1Y's (~14s) to
warrant a different target -- rejected, since 1M's lower number is an
_emergent property_ of the same shared design (fewer real days than the
cap), not a sign it needs different code.

### 3.3 Hero/reveal component + the whole-range worst-case question

**No shipped 1W precedent exists to reuse (see section 0's correction)**
-- this plan designs the component fresh, but in a shape a later #105
implementation (or a reconciliation pass, if #105 lands first) should be
able to converge on rather than diverge from, since both share the
identical `WholeRangeBalance`/whole-range-chart architecture. See
section 6 for the sequencing risk this creates.

**New component: `WholeRangeReplay.tsx`, parallel to `TradeReplay.tsx`.**
Composes `HeroAndWorstCase` (via its existing `heroSlot` overlay, no
change needed there) + the whole-range `PortfolioChart` instance, the
same wiring shape `TradeReplay.tsx` already establishes for the window
model's `HeroAndWorstCase` + chart pairing. Rendered from
`ResultsPanel.tsx`'s intraday-daily branch in place of the current bare
`<PortfolioChart key={...} points={wholeRangePoints} />` line (currently
line 659), inside the same `rangeGuess !== null` block that already
wraps `BenchmarkStat` and the chart today (see 3.4).

**Whole-range worst-case figure: genuinely new UI, but zero new
computation.** `IntradayWorstCaseResult` has carried its own chained
`startingCapital`/`endingBalance` since issue #84 (confirmed by reading
`intraday-optimizer.ts`'s interface directly) -- exactly the same field
`ResultsPanel.tsx`'s existing `wholeRangeFinalBalance` already reads off
`finalDay`'s _best-case_ track:

```ts
// Existing, today (ResultsPanel.tsx ~line 615):
const wholeRangeFinalBalance = finalDay
  ? rescaleFromStartingCapital(
      selectVariant<IntradayTrade>(finalDay, finalDay.longShort, mode).endingBalance,
      data.startingCapital,
      effectiveStartingCapital,
    )
  : 0;

// New, parallel, same rescale-from-root pattern -- NOT the per-day
// rescale pattern (see apps/web/CLAUDE.md's own "silently cancels out"
// warning, which applies identically here):
const wholeRangeWorstCaseBalance = finalDay
  ? rescaleFromStartingCapital(
      // mode-aware worst-case track, mirroring dayWorstCaseStartingCapital's
      // own mode branch above in the same file
      mode === "long"
        ? finalDay.worstCase.endingBalance
        : finalDay.longShort.worstCase.endingBalance,
      data.startingCapital,
      effectiveStartingCapital,
    )
  : 0;
```

This is exactly the same single-rescale-from-root pattern
`wholeRangeFinalBalance` already uses (deliberately _not_ the per-day
`rescaleFromStartingCapital(dayValue, day.startingCapital, ...)` pattern,
which algebraically cancels chaining back out -- see
`apps/web/CLAUDE.md`'s "rescaleFromStartingCapital's per-day pattern
silently cancels out chaining" section, which applies identically to a
worst-case rescale as it does to the best-case one). **No pipeline
change, no schema bump, no new field** -- this is purely an `apps/web`
read of data already being written.

**Recommendation: render this new worst-case figure via
`HeroAndWorstCase`'s existing `WorstCaseStat` half**, the same
unconditional-rendering, muted-tone treatment every other `WorstCaseStat`
instance in this app already gets (issue #31's own "fixed muted tone...
not meant to compete with the hero figure" design decision) -- no new
component needed, `WholeRangeReplay.tsx` just passes
`wholeRangeWorstCaseBalance`/its own `startingCapital` straight into the
`worstCaseEndingBalance`/`worstCaseStartingCapital` props
`HeroAndWorstCase` already accepts.

### 3.4 Guess-then-reveal gate relationship

**Reuse `WholeRangeBalance`'s existing gate unchanged; don't build a
second one.** `ResultsPanel.tsx`'s intraday-daily branch already gates
`BenchmarkStat` and the whole-range chart behind `rangeGuess !== null`
(the same guess `WholeRangeBalance` itself owns) -- confirmed by reading
the current render tree (lines 639-661). `WholeRangeReplay` (replacing
the bare `<PortfolioChart>` call at line 659) sits inside that exact
same conditional block, so the "Watch it happen" button (like
`TradeReplay`'s own button) only ever becomes reachable once the guess
is already revealed -- matching #105's own stated resolution requirement
for 1W ("the replay button should only appear once that guess is
revealed, don't bypass or duplicate that flow") even though #105 itself
hasn't shipped, since this is the only sequencing choice consistent with
`WholeRangeBalance`'s already-established design (one guess, scoped to
the whole range, unlocking everything that would otherwise spoil it).

**One real wrinkle worth flagging for the build issue, traced from
`use-trade-replay.ts`'s own existing mid-flight reset behavior**: a
`DayOverview` day switch changes `ResultsPanel`'s `activeDay`/`selectedDay`
state, but **does not** change `wholeRangePoints` (that memo depends on
`state`/`startingCapital`/`mode`/`rangeGuess`, not `activeDay` -- confirmed
by reading its dependency array) -- so browsing to a different day
mid-replay must **not** reset or interrupt whole-range playback, unlike
a `ModeToggle`/`StartingCapitalInput` edit (which _does_ change
`wholeRangePoints`' contents and correctly should reset, via the same
`useResetWhenChanged([points], ...)` mechanism the window model already
uses). This falls out for free from reusing that exact mechanism
unmodified -- worth a regression test in the build issue confirming a
day switch mid-whole-range-replay leaves playback undisturbed, the
mirror image of #96's own "mode switch mid-playback correctly resets"
test.

### 3.5 Whole-range chart only, not the per-day drill-down

**Recommendation: whole-range chart only** -- no replay for
`dayVariant`/`IntradayTradeList` (the single selected day's own trade
list below `DayOverview`). Reasoning:

- Every individual day's content already renders unconditionally,
  ungated, instantly (issue #91 removed per-day guessing entirely) --
  there's no "reveal" moment happening at the per-day level for a replay
  to dramatize; the guess-then-reveal drama in this model is entirely
  scoped to the whole range now.
- A per-day replay would need its own separate button/state per day (up
  to 250 of them for 1Y), a materially larger scope than this plan's own
  chunked whole-range mechanism, for a payoff (re-watching a single
  day's <=3 trades animate) the window model's existing pacing already
  covers cheaply if a day were ever surfaced that way.
- Matches #105's own explicit "Out of scope: per-day drill-down replay"
  decision for 1W -- consistent across the whole "Watch it happen"
  feature area (1W/1M/3M/1Y all share the same per-day/whole-range split)
  rather than diverging without a specific reason to.

## 4. Implementation surface for the follow-up build issue (by file path)

- **`apps/web/src/lib/use-trade-replay.ts`** -- generalize to accept a
  pluggable segment-builder (default: today's per-point `buildSegments`;
  new: a day-chunk builder), per section 3.1's recommendation. Possibly
  renamed if the generalization changes its public shape meaningfully
  (an implementation-time call).
- **`apps/web/src/lib/portfolio-series.ts`** -- a new day-grouping helper
  (or reuse/extract one shared with `chart-scales.ts`'s
  `buildChainedIntradayXPositions`, per section 3.1) -- no change to
  `deriveWholeRangeIntradaySeries` itself.
- **New: `apps/web/src/components/WholeRangeReplay.tsx`** -- parallel to
  `TradeReplay.tsx`, per section 3.3.
- **`apps/web/src/components/ResultsPanel.tsx`** -- the intraday-daily
  branch (currently ~lines 604-661): add `wholeRangeWorstCaseBalance`
  (section 3.3's snippet) alongside the existing `wholeRangeFinalBalance`
  computation, and replace the bare `<PortfolioChart>` call (line 659)
  with `<WholeRangeReplay>`, inside the same `rangeGuess !== null` block.
- **No changes expected**: `PortfolioChart.tsx`, `HeroAndWorstCase.tsx`,
  `WholeRangeBalance.tsx`, any pipeline/schema file, per sections 1 and
  3.3.

## 5. Test impact (qualitative)

- A new `use-trade-replay.test.ts` (or `use-whole-range-replay.test.ts`,
  depending on the generalize-vs-fork call in section 3.1) covering: a
  fixture with more day-groups than `NUM_CHUNKS` correctly caps chunk
  count; a no-trade chunk advances with zero pause; a mixed
  single-trade-in-a-chunk case falls through to the existing single-trade
  callout voice (section 3.1's "free degenerate case"); a day switch
  (an unrelated prop, not `points`) leaves an in-flight chunked replay
  undisturbed (section 3.4).
- `WholeRangeReplay.test.tsx` mirroring `TradeReplay.test.tsx`'s existing
  coverage shape: idle/rewinding/playing/done rendering, the multiplier
  badge staying present throughout playback (the exact class of bug
  #96's round-five review caught once already), reduced-motion full
  bypass, and the new worst-case figure rendering unconditionally
  alongside the hero figure in every phase.
- `ResultsPanel.test.tsx` gains coverage for `wholeRangeWorstCaseBalance`'s
  rescale (both modes, mirroring the existing
  `wholeRangeFinalBalance`/mode coverage) and confirms `WholeRangeReplay`
  only renders once `rangeGuess !== null`.
- Live verification (per this repo's working agreement) should include a
  real local-pipeline-run measurement of actual worst-case playback
  duration for at least 3M or 1Y against real data (the same
  `local-run.ts`/headless-Chromium technique this repo's `apps/web/
CLAUDE.md` already documents at length) -- this plan's ~7-14s figures
  are worked through analytically from the issue's own trade-count
  ceilings, not yet measured against a real browser's actual RAF
  scheduling overhead at ~40 chunks.

## 6. For the manager

Two things this plan could not resolve unilaterally:

1. **#105 has not landed** (confirmed via `gh issue view 105` and `gh pr
list --search "105"` -- open issue, zero PRs, no branch). The
   delegation prompt that produced this plan assumed real 1W
   implementation choices existed to read and build on; they don't yet.
   This plan designed 1M/3M/1Y's hero/reveal component
   (`WholeRangeReplay.tsx`) and gate sequencing independently, in a shape
   intended to be reconcilable with whatever #105 eventually ships (same
   `WholeRangeBalance` gate, same `HeroAndWorstCase`/`heroSlot` reuse
   pattern) -- but there's a real risk of two independently-built,
   subtly-diverging components if both issues proceed without one having
   read the other's actual code. Recommend either sequencing 1M/3M/1Y's
   build issue strictly after #105 lands (so it can literally extend/
   reuse #105's own component), or explicitly assigning one of the two
   to extract the shared pieces once both exist -- a scheduling call, not
   an engineering one, and the manager's is the right seat for it.
2. **The exact `NUM_CHUNKS`/`CHUNK_TRANSITION_MS`/`CHUNK_PAUSE_MS`
   values** (section 3.1) are proposed and worked through analytically,
   but -- consistent with how this repo has treated every prior pacing
   constant (`TRANSITION_MS`/`EVENT_PAUSE_MS`/`REWIND_MS`, all "tuned by
   feel") -- are left as an implementer/reviewer call to finalize against
   a real browser and real data, not pinned as a hard requirement here.
   Worth the manager's awareness mainly because the _shape_ of the
   mechanism (chunk-capped, not per-range-tuned) is the load-bearing
   design decision this plan is confident in; the specific numbers are
   not.
