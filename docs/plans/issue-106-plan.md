# Plan: issue #106 -- "Watch it happen" replay coverage for 1M/3M/1Y

Status: plan only, per the issue's own scope -- no implementation in this
worktree. Produces this design doc so a follow-up build issue (or
issues) can be filed agent-ready afterward.

## Reconciled against issue #105 (shipped)

This plan was originally written before issue #105 (the 1W "Watch it
happen" replay) had landed, and its own section 0/6 explicitly flagged
that gap and said the eventual 1M/3M/1Y build issue should be
reconciled against #105's real implementation once it shipped, not
built from this plan's original guess. #105 has since shipped (plan PR
#115, implementation PR #116, both merged to `main`) -- see
`apps/web/CLAUDE.md`'s "'Watch it happen' replay for 1W" section for the
full shipped design history, including its own two rounds of
independent review. This revision reconciles that gap: sections 0, 1,
3.1, 3.3, 3.4, 4, 5, and 6 below are rewritten against the real shipped
code (`WholeRangeReplay.tsx`, `WholeRangeBalance.tsx`,
`use-trade-replay.ts`'s real `pacing` parameter, `format-date.ts`'s real
`toPortfolioTimestamp`, `ResultsPanel.tsx`'s real `replaySupported`/
worst-case wiring). Everything else -- the day-count/trade-ceiling math
in section 2, the chunk-cap mechanism's steps 1-3 and constants in
section 3.1, the one-issue-covers-all-three-ranges argument in section
3.2, and the whole-range-chart-only scoping in section 3.5 -- was
independently re-verified against the current code rather than assumed
still correct, and holds unchanged. The headline changes:

- **Component approach**: #105 already built the real
  `WholeRangeReplay.tsx` -- composing the extended
  `WholeRangeBalance.tsx`, not `HeroAndWorstCase` (this plan's original
  sketch). The follow-up build issue extends that same shipped
  component, not a new one -- see section 3.3.
- **Pacing**: `useTradeReplay` already has a real, shipped `pacing?:
ReplayPacing` parameter (issue #105). This plan's chunk-based design
  still needs a new segment-builder (pacing alone doesn't reduce 1Y's
  ~750-trade point count), but the chunk-level constants this plan
  proposed (`CHUNK_TRANSITION_MS`/`CHUNK_PAUSE_MS`) are now literally
  instances of the real `ReplayPacing` shape, not a separate ad hoc
  constant pair -- see section 3.1.
- **Worst-case figure**: already built and shipped, gated behind a real
  `replaySupported: boolean` prop currently hardcoded to `range ===
"1W"` (a post-PR independent review caught and fixed an early version
  that leaked it to every range unconditionally -- see
  `apps/web/CLAUDE.md`'s own "Independent-review follow-up" note). This
  build issue's job is to widen that one gate -- it is what unlocks the
  worst-case stat for 1M/3M/1Y, not a separate future decision. See
  section 3.3.
- **Date-parsing fix**: already shipped, generally (not 1W-specific) --
  `format-date.ts`'s `toPortfolioTimestamp`/`formatDateTime` are already
  the shared, correct implementation `use-trade-replay.ts` calls.
  Nothing left to do here. See section 1.

## 0. One-paragraph summary

1M/3M/1Y (the intraday-daily model, up to ~63/~186/~750 total trades
respectively -- 1M ~21 trading days, 3M ~62, 1Y ~250, all times
`DEFAULT_MAX_TRADES_PER_DAY = 3`, `apps/pipeline/src/pipeline.ts:109`,
re-confirmed against the current code and unchanged since this plan's
first draft) cannot reuse the shipped per-trade-event pacing
(`use-trade-replay.ts`'s real `DEFAULT_PACING`, `transitionMs: 300,
eventPauseMs: 600, rewindMs: 700`) unmodified -- at that pacing, 1Y
alone would run ~26 minutes (section 2). This still requires a
genuinely different reveal _mechanism_, not a tuning knob: a **day/
chunk-based reveal, capped to a fixed number of animation steps
regardless of range** (`NUM_CHUNKS`, tuned by feel), pausing only on a
chunk containing at least one real trade. Because the chunk count is
capped, worst-case duration is bounded by the same ~14s ceiling for 3M
and 1Y regardless of their very different day counts, with 1M coming in
lower automatically (~7s). One build issue, covering all three ranges,
for the same reason issue #96 covered the entire window model in one
issue: 1M/3M/1Y share one mechanism and one set of constants by
construction (section 3.2).

**This revision's real work, now that #105 has shipped and there's real
code to reconcile against, not just a design sketch**: the hero/reveal
component this issue needs is not a new one. #105 already built
`WholeRangeReplay.tsx` -- composing the extended `WholeRangeBalance.tsx`
(its own `worstCase`/`revealSlot` props), not `HeroAndWorstCase` as this
plan's own first draft assumed. #105's reasoning for that choice (stated
in its own plan section 3.1, and in `WholeRangeReplay.tsx`'s own header
comment) holds identically for 1M/3M/1Y: `WholeRangeBalance` is already
the range's one hero moment for every intraday-daily range, not just
1W, so composing a second, parallel `HeroAndWorstCase` would still
duplicate the same "$X -> $Y" figure. This plan's own follow-up build
issue should extend that real, shipped component (and the real, shipped
`useTradeReplay` pacing parameter, and the real, shipped
`replaySupported` gate) rather than building a parallel implementation
from this plan's original, pre-#105 guess. Section 3.3 works out exactly
what "extend" means concretely: a `pacing` prop threaded through instead
of hardcoded, a second (chunk-based) segment-builder plugged into a
generalized `useTradeReplay`, and `replaySupported` widened from `range
=== "1W"` to include 1M/3M/1Y.

**The worst-case figure needs zero new computation, same finding as
before -- but it's now already built, not just designed.**
`ResultsPanel.tsx` already computes `wholeRangeWorstCaseEndingBalance`/
`wholeRangeWorstCaseStartingCapital` unconditionally, for every
intraday-daily range including 1M/3M/1Y (issue #105 -- see that file's
own doc comment on those two locals). The only reason 1M/3M/1Y don't
show the stat today is `replaySupported`'s own `range === "1W"` gate,
deliberately narrowed post-#105 by independent review specifically to
avoid shipping this stat to the larger ranges ahead of this issue's own
design work (`apps/web/CLAUDE.md`'s "Independent-review follow-up" note
says so explicitly). **This build issue is what that note is pointing
at**: widening `replaySupported` is what turns the worst-case stat on
for 1M/3M/1Y, not a separate future decision to make.

## 1. Architecture recap: what's already reusable, verified against the real code

Read in full before this plan (and before any follow-up build issue):
`apps/web/src/lib/use-trade-replay.ts`, `apps/web/src/components/
TradeReplay.tsx`, `apps/web/src/components/WholeRangeReplay.tsx` (issue
#105 -- the real, shipped 1W hero/reveal component this issue extends,
not a new one), `apps/web/src/components/WholeRangeBalance.tsx` (its
real `worstCase`/`revealSlot` props), `apps/web/src/lib/
portfolio-series.ts`, `apps/web/src/components/PortfolioChart.tsx`,
`apps/web/src/lib/replay-callout.ts` (issue #105's shared
`calloutText`/`chartLandingFor`), `apps/web/src/lib/format-date.ts` (its
real `toPortfolioTimestamp`), `apps/web/src/components/ResultsPanel.tsx`
(the intraday-daily branch, currently ~lines 604-720), and
`apps/web/CLAUDE.md`'s "Trade replay: 'Watch it happen'", "Rewind-to-
start-date intro beat", "Carrying the ticking date readout through
forward playback", "Marker pulse, shake, and speech-bubble callout", and
"'Watch it happen' replay for 1W" sections in full (the last of these is
new since this plan's first draft -- it's the real design/review history
this revision reconciles against, not a hypothetical).

**Already generic enough to need zero changes -- both what the original
plan already found, and what #105 additionally shipped as directly
reusable, not something this issue needs to build:**

- `PortfolioPoint`/`PortfolioEvent` (`portfolio-series.ts`), `wholeRangePoints`
  (`ResultsPanel.tsx`'s own memo), `PortfolioChart`'s `revealedCount`/
  `interactive` props, `HeroAndWorstCase`'s `heroSlot` prop (unused by
  this issue's own component choice, but still generic and untouched),
  `lib/easing.ts`'s `tweenValue`, `use-reset-when-changed.ts` -- unchanged
  from the original plan's own findings, re-confirmed against the
  current code.
- **`use-trade-replay.ts`'s `pacing?: ReplayPacing` parameter is real and
  shipped (issue #105)**, not something this issue needs to add.
  `ReplayPacing` (`{ transitionMs, eventPauseMs, rewindMs }`) already
  defaults to the window model's own constants when omitted, and both
  RAF effects already include `pacing` in their own dependency arrays --
  a genuinely different `pacing` object (by reference) already restarts
  the effect correctly. This issue's own chunk-level constants
  (`CHUNK_TRANSITION_MS`/`CHUNK_PAUSE_MS` in the original draft, section
  3.1) are literally instances of this same real type, not a new
  parallel constant shape to invent.
- **`format-date.ts`'s `toPortfolioTimestamp`/`formatDateTime` are
  already the shared, correct implementation (issue #105) -- the
  date-parsing bug this plan's own first draft flagged as still needing
  a fix is already fixed, generally, not 1W-specifically.**
  `use-trade-replay.ts`'s rewind effect already calls
  `toPortfolioTimestamp` instead of an inline `Date.parse`, and
  `displayDate`'s "playing" branch already calls
  `formatDateTime(points[index]!.date, true)` instead of a bare
  `formatDate(...)` call -- both fixes apply to _any_ datetime-labeled
  chained-intraday series, including 1M/3M/1Y's own
  `deriveWholeRangeIntradaySeries` output, not just 1W's. Nothing left
  to do here; this plan's own earlier discussion of this as a future fix
  is stale.
- **`lib/replay-callout.ts`'s `calloutText`/`chartLandingFor` (issue
  #105) are the real, shared single-trade narration/marker-effect
  functions**, already extracted out of `TradeReplay.tsx`'s own former
  private copy specifically so a second whole-range caller (originally
  1W's `WholeRangeReplay.tsx`, now this issue's chunk mode too) can reuse
  them rather than hand-copying. This plan's own "free degenerate case"
  (a chunk containing exactly one day with exactly one trade falls
  through to the existing single-trade callout voice, section 3.1)
  literally _is_ a call to this real, already-shared `calloutText`
  function -- no new narration function needed for that case, only for
  the genuine multi-trade-chunk summary sentence.
- **`use-trade-replay.ts`'s `isReplayLive`/`canReplayFor` (issue #105)**
  are real, shared exported helpers (`TradeReplay.tsx` and
  `WholeRangeReplay.tsx` both already use them, replacing what were two
  independently-hand-derived copies) -- directly reusable by whatever
  hook this issue's chunk mode ends up calling, for the same "idle/done"
  and "has trades and motion is allowed" checks.
- **`WholeRangeReplay.tsx` itself (issue #105)** already owns the entire
  composition surface this issue needs for 1M/3M/1Y too: the
  guess-then-reveal gate (reusing `WholeRangeBalance`'s own `guess`
  value, no second gate), the `children` slot (so the methodology
  paragraph/`BenchmarkStat` keep their pre-existing position relative to
  the chart), the `chartKey` contract (stable across phase transitions,
  matching `TradeReplay.tsx`'s own `heroKey`), and the `DayOverview`-
  independence property (section 3.4) -- all range-agnostic
  infrastructure already built and live-verified for 1W. This issue's
  real work is extending it, per section 3.3, not re-deriving any of
  this from scratch.

**Still needs new code -- genuinely 1M/3M/1Y-specific, not covered by
#105's own 1W-scoped shipped work:**

- A day/chunk-based segment-builder for `use-trade-replay.ts`, per
  section 3.1 -- #105's own shipped `buildSegments` still walks `points`
  one index at a time, pausing on every real event; structurally wrong
  at 1M/3M/1Y's scale for the same reason this plan's first draft
  already worked out (section 2), and #105's `pacing` parameter alone
  doesn't change the _number_ of steps, only their speed.
- A chunk-summary callout voice (a new function alongside
  `lib/replay-callout.ts`'s existing `calloutText`, not a replacement for
  it -- see the "free degenerate case" note above).
- `WholeRangeReplay.tsx`'s own `pacing` (currently a hardcoded internal
  module constant, `WHOLE_RANGE_REPLAY_PACING`, tuned and live-verified
  only against 1W) needs to become a real prop, threaded by
  `ResultsPanel.tsx` per range group, and `replaySupported` needs
  widening from its current `range === "1W"` to include 1M/3M/1Y. See
  section 3.3.

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

Confirmed against the real, now-shipped code (issue #105):
`use-trade-replay.ts`'s `DEFAULT_PACING` is exactly `{ transitionMs:
300, eventPauseMs: 600, rewindMs: 700 }` -- the same numbers this
section's own table already assumed. Nothing in issue #105 changed
these defaults or this section's own math; it only added the `pacing`
parameter as an opt-in override, which is what section 3.1 below builds
on.

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
per-range-tuned total. **Worked through and rejected during this plan's
own drafting, with the actual numbers, not just prose**: the rejected
alternative picks a target total per range (say 1Y's own ~15s) and
derives `perDayPauseMs = (targetTotalMs - dayCount × dayTransitionMs) /
tradeDayCount`. At a plausible `dayTransitionMs = 60`, 1Y's 250 days
alone already cost `250 × 60ms = 15,000ms` -- **the entire 15s target,
before a single pause is budgeted at all**. The formula then has zero
(or negative) budget left to divide across trade days, forcing
`perDayPauseMs` down to whatever floor it's clamped to (e.g. an 80ms
minimum) regardless of the target -- so worst-case total becomes
`15,000ms + 250 × 80ms = 35,000ms ≈ 35s`, **more than double the 15s
target the formula was supposed to guarantee**, purely because day count
alone already exceeded the transition budget before pauses entered the
picture. 3M (62 days, `62 × 60ms = 3,720ms` of transitions against an
~11s target) doesn't hit this failure mode, which is exactly the
problem: **the per-day-tuned-budget formula's own correctness depends on
day count staying comfortably under the target, an assumption 1Y
violates on its own transition cost alone** -- it isn't a tuning
problem fixable by picking different constants, it's a structural
mismatch between "budget scales with target duration" and "cost scales
with day count," which diverge once day count grows large enough. The
chosen `NUM_CHUNKS`-capped design in Steps 1-3 above sidesteps this
entirely by making chunk count (not day count) the thing multiplied
against the constants, with day count only affecting how many real days
each chunk groups together -- 1M lands lower automatically because it
has fewer real days than the cap, with **no separate 1M-specific
constant needed** -- this is also why one shared mechanism genuinely
covers all three ranges (see section 3.2).

**Target playback durations to state in the follow-up build issue's own
Scope section** (matching the style of #96's "roughly 3-6 seconds for a
typical 1-3 trade window" and #105's real, live-measured "~14.4s" 1W
worst case): **1M: roughly 4-7 seconds. 3M and 1Y: roughly 7-14 seconds,
sharing the same ~14s worst-case ceiling.**

**Callout voice is deliberately a new, distinct register from the
per-trade narration -- not reused as-is.** `lib/replay-callout.ts`'s
real, shared `calloutText` narrates exactly one trade
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
_existing_, real, shared `calloutText` voice unchanged -- the new
summary sentence is only needed once a chunk's trade count exceeds 1, so
the build issue should design the callout function to fall through to
the existing narration for that case rather than always using the new
summary wording, keeping the two voices consistent wherever they'd say
the same thing anyway.

**Skip-to-end stays available identically throughout**, reusing the
exact same button/handler #96/#97/#105 already established (no new
control) -- if anything, more load-bearing here than for the window
model or 1W, since even the _capped_ worst case (~14s) is long enough
that a user who just wants the answer benefits from it more than a
~6.6s window-model replay ever did.

**Shared hook design, reusing the real, shipped scaffold -- not a
forked copy, and not a hypothetical "if #105 ships a pacing param" any
more, since it already has.** Recommend generalizing
`use-trade-replay.ts` rather than writing a second, independent hook:
extract the "walk points one at a time, pause on any event" logic
(`buildSegments`) behind a pluggable segment-builder argument, and add a
second builder (`buildChunkSegments`, per the design above). This is
not a claim that the two builders produce an identical `Segment`/
`ReplayEvent` shape -- they can't, structurally: the shipped `Segment`/
`ReplayEvent` types are sized for exactly one trade per pause (one
`PortfolioEvent`, one nullable `TradeReturn`), and this plan's own
dual-voice callout design (a multi-trade date-range summary for a real
chunk, falling through to the existing single-trade `calloutText`/
`chartLandingFor` only in the one-day/one-trade degenerate case, per
section 1's note above) needs materially richer per-chunk data those
types can't hold as written -- at minimum a trade count and a date
range, likely the underlying day-group list itself. `Segment`/
`ReplayEvent` (or a widened variant/union) will need new fields or a
new case to carry that, not a type-compatible drop-in.

**What's already, genuinely reusable unmodified, confirmed against the
real shipped code rather than assumed**: the phase machine (`idle ->
rewinding -> playing -> done`), the rewind intro beat, `skipToEnd`, the
`useResetWhenChanged`-based mid-flight reset, the corrupted-price
defensive catch, `completedRuns`, the real `pacing?: ReplayPacing`
parameter (issue #105 -- this issue's own chunk-level constants are
literal `ReplayPacing` instances, per section 1), and the real,
already-exported `isReplayLive`/`canReplayFor` helpers -- none of this
actually depends on `Segment`'s own internal shape, only on `tick()`
walking _some_ ordered list of steps and calling `setFrame`/pausing on
demand, so it inherits both #96's original five rounds of correctness
work _and_ #105's own additional fixes (the pacing parameter itself,
the two date-formatting bugs, the `isReplayLive`/`canReplayFor`
extraction) for free either way. A build issue should treat "does this
generalize `use-trade-replay.ts` cleanly with a widened `Segment`/
`ReplayEvent` shape, or does it need its own
`use-chunked-trade-replay.ts`" as its own first implementation
decision, with a strong prior toward generalizing the scaffold (even
though the segment _data_ itself must genuinely widen) given how much
now-doubly-proven correctness work already lives in the existing hook
-- see section 3.3 for the parallel component-level version of this
same "generalize, don't fork" question, and section 6 for why this plan
states a recommendation but leaves the final call to the implementer/
reviewer.

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

**#105 is itself a further precedent for this reasoning, not just #96**:
1W shipped as its own single issue precisely because it needed a
materially _simpler_ design (no chunking at all, per that issue's own
plan section 0) than 1M/3M/1Y -- the two are different enough in
mechanism to deserve separate issues, exactly as #106 and #105 already
are. Nothing about #105 shipping first changes this section's own
conclusion that 1M/3M/1Y themselves belong in one issue together.

### 3.3 Hero/reveal component + the whole-range worst-case question

**#105 already shipped a real 1W precedent -- this section extends it,
not a fresh design.** This plan's own first draft designed a hero/
reveal component fresh, in a shape intended to converge with whatever
#105 shipped. #105 shipped `WholeRangeReplay.tsx`, composing the
extended `WholeRangeBalance.tsx` (its own new `worstCase`/`revealSlot`
props) rather than `HeroAndWorstCase` -- a deliberate divergence from
this plan's own original sketch, stated explicitly in
`docs/plans/issue-105-plan.md` section 3.1 and in `WholeRangeReplay.tsx`'s
own header comment: `WholeRangeBalance` already _is_ the range's one
hero moment (the one place its ending balance is headlined), for every
intraday-daily range, not just 1W -- composing a second, parallel
`HeroAndWorstCase` would render the exact same "$X -> $Y" figure twice.
That reasoning applies identically to 1M/3M/1Y, which share the
identical `WholeRangeBalance`/whole-range-chart architecture 1W does.
This plan's own reconciliation: **extend the real, shipped
`WholeRangeReplay.tsx`, don't build a second component.**

**Extend the same component, not a sibling -- concretely, and why.**
`WholeRangeReplay.tsx` already owns exactly the composition surface
1M/3M/1Y need too: the guess-then-reveal gate (reusing
`WholeRangeBalance`'s own `guess` value), the `children` slot (keeping
the methodology paragraph/`BenchmarkStat` in their pre-existing position
relative to the chart -- a real regression #105's own code review caught
once already when this slot was missing, see `apps/web/CLAUDE.md`'s
"nine total" code-review section), the `chartKey` contract (stable
across phase transitions, matching `TradeReplay.tsx`'s own `heroKey`),
`canReplayFor`/`isReplayLive`-based gating, and the
`replaySupported`-gated `worstCase` object forwarded to
`WholeRangeBalance`. A second, sibling component (e.g. a hypothetical
`ChunkedWholeRangeReplay.tsx`) would have to duplicate every one of
those -- exactly the "two hand-kept-in-sync copies" trap this codebase's
own history keeps finding and fixing (`HeroAndWorstCase`'s `heroSlot`
extraction; `isReplayLive`/`canReplayFor`/`chartLandingFor`/`calloutText`
all independently re-derived once by #105's own first draft, then
extracted into shared functions once code review caught it -- see
`apps/web/CLAUDE.md`'s own "Trade replay" and "'Watch it happen' replay
for 1W" sections for both instances of this exact pattern). The real
per-range difference is confined to two things, both already narrow,
swappable seams:

1. **Pacing.** `WHOLE_RANGE_REPLAY_PACING` is currently a hardcoded
   internal module constant in `WholeRangeReplay.tsx`, tuned and
   live-verified only against 1W's own worst case -- not a prop. This
   build issue needs to promote it to a real `pacing: ReplayPacing`
   prop (no default -- every caller should pass one explicitly, the same
   "no silent fallback by omission" convention `trade-math.ts`'s own
   `direction` parameter already established), with `ResultsPanel.tsx`
   choosing `WHOLE_RANGE_REPLAY_PACING` for 1W and a new
   `CHUNKED_WHOLE_RANGE_REPLAY_PACING` (this plan's own
   `NUM_CHUNKS`/`CHUNK_TRANSITION_MS`/`CHUNK_PAUSE_MS` from section 3.1,
   expressed as a real `ReplayPacing` object) for 1M/3M/1Y.
2. **The underlying walk mechanism.** Per section 3.1, this needs a
   second, chunk-based segment-builder plugged into a generalized
   `use-trade-replay.ts`, producing a widened `Segment`/`ReplayEvent`
   shape. `WholeRangeReplay.tsx`'s own rendering logic (the `revealSlot`
   overlay, the `landing`/`activeCallout` wiring into `PortfolioChart`)
   needs a small, corresponding branch to build its callout string from
   either a real single-trade `ReplayEvent` (via the existing
   `calloutText`) or a chunk summary (via a new function alongside it,
   per section 3.1) -- the same kind of narrow, discriminated branch
   this file already has for other range-dependent behavior
   (`replaySupported`), not a rewrite of the component's own structure.

**Recommendation: extend `WholeRangeReplay.tsx` in place with these two
seams, rather than forking it.** This is the natural extension of
section 3.1's own "generalize `use-trade-replay.ts`, don't fork it"
recommendation one layer up the stack -- if the hook genuinely
generalizes cleanly (section 3.1's own stated prior), the component that
consumes it should too. Flagged explicitly in section 6 as an
implementer/reviewer call, not pinned as an unconditional requirement:
if the widened `Segment`/`ReplayEvent` union turns out awkward enough in
practice that `WholeRangeReplay.tsx`'s own rendering logic gets
genuinely harder to follow with both voices inline, a sibling component
wrapping a **shared** lower-level composition (extracting just the
guess-gate/`children`-slot/`chartKey`/`PortfolioChart` wiring into
something both call) is an acceptable fallback -- but that's a real
implementation-time judgment call once the widened types exist to look
at, not a decision to make on paper now.

**The worst-case figure: already computed, already wired -- this
issue's job is only to widen one gate.** `ResultsPanel.tsx` already
computes `wholeRangeWorstCaseEndingBalance`/
`wholeRangeWorstCaseStartingCapital` unconditionally, for every
intraday-daily range (issue #105 -- see that file's own doc comment on
those two locals, and `apps/web/CLAUDE.md`'s "chained per-day starting
capital" section for why `data.startingCapital` is correct as the
worst-case track's own "from" value here, not just the best-case
track's). Both values already reach `WholeRangeReplay`'s own
`worstCaseEndingBalance`/`worstCaseStartingCapital` props for every
range today, computed the identical raw/native-root way this plan's own
first draft worked out (its own original "corrected design" discussion
is now moot -- the real code already does exactly what that discussion
recommended, no double-rescale bug to design around). The _only_ reason
1M/3M/1Y don't show the stat today is `WholeRangeReplay.tsx`'s own
`replaySupported` prop, currently hardcoded `range === "1W"` in
`ResultsPanel.tsx` -- deliberately narrowed by a post-PR independent
review specifically to avoid shipping this stat (and the replay button)
to the larger ranges ahead of this issue's own design work
(`apps/web/CLAUDE.md`'s "Independent-review follow-up (post-PR)"
section documents the exact bug this caught: `WholeRangeBalance`
renders a `WorstCaseStat` sibling whenever a non-`undefined` `worstCase`
object reaches it, with no range awareness of its own). **State this
plainly for the build issue: widening `replaySupported` to include
1M/3M/1Y is what unlocks the worst-case stat for those ranges -- it is
not a separate future decision still to be made, it is this issue's own
scope**, exactly as this plan's own original section 0 anticipated when
it first flagged the worst-case question as something this build issue
should resolve.

### 3.4 Guess-then-reveal gate relationship

**Reuse `WholeRangeBalance`'s existing gate unchanged; don't build a
second one -- and this is now proven in production for 1W, not just
designed.** `WholeRangeReplay.tsx` (issue #105, shipped) already sits
inside `ResultsPanel.tsx`'s `guess !== null` block, gated by the exact
same `guess`/`rangeGuess` value `WholeRangeBalance` itself owns -- the
"Watch it happen" button only ever becomes reachable once the guess is
already revealed, with no second, independent gate. This is unchanged
by this reconciliation; 1M/3M/1Y's own extension keeps using the
identical gate, since the underlying guess-then-reveal mechanism
(`WholeRangeBalance`, issue #91) is already range-agnostic.

**The `DayOverview`-independence wrinkle is also already proven, not
just designed.** `wholeRangePoints`' dependency array
(`[state, startingCapital, mode, rangeGuess]`) still doesn't include
`activeDay`/`selectedDay`, so a day switch mid-replay still doesn't
change `points`' own identity and still doesn't trigger
`use-trade-replay.ts`'s `useResetWhenChanged([points], ...)` reset --
live-verified for a real 1W result (`apps/web/CLAUDE.md`'s own "'Watch
it happen' replay for 1W" section: "a day switch mid-replay leaving an
in-flight replay fully undisturbed"). This applies identically to
1M/3M/1Y once this issue's own chunk-based hook variant reuses the same
`useResetWhenChanged` mechanism (section 3.1's own "what's already,
genuinely reusable unmodified" list) -- no new design work needed here,
only a regression test extending coverage to the chunk-mode hook,
mirroring the existing 1W test.

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
- Matches #105's own real, shipped scoping -- confirmed by reading
  `WholeRangeReplay.tsx` and `ResultsPanel.tsx`'s real render tree,
  "Watch it happen" never touches `dayVariant`/`IntradayTradeList` --
  consistent across the whole feature area (1W/1M/3M/1Y all share the
  same per-day/whole-range split) rather than diverging without a
  specific reason to.

## 4. Implementation surface for the follow-up build issue (by file path)

- **`apps/web/src/lib/use-trade-replay.ts`** -- generalize to accept a
  pluggable segment-builder (default: today's real per-point
  `buildSegments`; new: a day-chunk builder), per section 3.1. The real
  `pacing?: ReplayPacing` parameter already exists (issue #105) and
  needs no change -- the chunk builder's own constants are just a new
  `ReplayPacing` object passed in by the caller. Possibly renamed if the
  generalization changes its public shape meaningfully (an
  implementation-time call).
- **`apps/web/src/lib/portfolio-series.ts`** -- a new day-grouping helper
  (or reuse/extract one shared with `chart-scales.ts`'s
  `buildChainedIntradayXPositions`, per section 3.1) -- no change to
  `deriveWholeRangeIntradaySeries` itself.
- **`apps/web/src/lib/replay-callout.ts`** -- a new chunk-summary callout
  function alongside the existing, real `calloutText`/`chartLandingFor`
  (issue #105) -- extending this shared module, not replacing anything
  in it (the existing single-trade voice is still the correct one for
  the one-day/one-trade degenerate case, per section 3.1).
- **`apps/web/src/components/WholeRangeReplay.tsx`** -- **extend the
  real, shipped component (issue #105), not a new one.** Promote its
  currently-hardcoded `WHOLE_RANGE_REPLAY_PACING` module constant to a
  required `pacing: ReplayPacing` prop; add whatever branch is needed to
  build a callout/landing from either a single-trade `ReplayEvent` or a
  chunk summary, depending on which segment-builder the underlying hook
  call used (section 3.3). If the widened types make this genuinely
  awkward in practice, a sibling component sharing an extracted common
  composition layer is an acceptable fallback -- see section 3.3's own
  hedge and section 6.
- **`apps/web/src/components/ResultsPanel.tsx`** -- the intraday-daily
  branch (currently ~lines 604-720): widen the existing
  `replaySupported` local (currently `range === "1W"`) to also cover
  1M/3M/1Y, and pass the right `pacing` object per range group
  (`WHOLE_RANGE_REPLAY_PACING` for 1W, a new chunk-mode pacing constant
  for 1M/3M/1Y) into `WholeRangeReplay`'s new `pacing` prop.
  `wholeRangeWorstCaseEndingBalance`/`wholeRangeWorstCaseStartingCapital`/
  `wholeRangeTradeCount` are already computed unconditionally today
  (issue #105) and need no change.
- **No changes expected**: `PortfolioChart.tsx`, `HeroAndWorstCase.tsx`,
  `WholeRangeBalance.tsx` (its `worstCase`/`revealSlot` props already
  exist and are already range-agnostic), any pipeline/schema file, per
  sections 1 and 3.3.

## 5. Test impact (qualitative)

- `use-trade-replay.test.ts` gains coverage for the new chunk segment-
  builder (whichever module ends up owning it, per section 3.1/4): a
  fixture with more day-groups than `NUM_CHUNKS` correctly caps chunk
  count; a no-trade chunk advances with zero pause; a mixed
  single-trade-in-a-chunk case falls through to the existing, real
  `calloutText` voice (section 3.1's "free degenerate case" -- this is
  now literally a call to the already-shared function, not a new one);
  a day switch (an unrelated prop, not `points`) leaves an in-flight
  chunked replay undisturbed (section 3.4) -- mirroring the equivalent,
  already-passing 1W test for the per-point hook, not writing this
  coverage shape from scratch.
- `WholeRangeReplay.test.tsx` **already exists** (issue #105) and
  already covers idle/rewinding/playing/done rendering, `canReplay`
  (zero-trade result, reduced motion), "Skip to end" availability, the
  `children`-slot ordering, the worst-case figure's raw/native-root
  rescale contract, and the `replaySupported`-gated worst-case stat --
  this issue extends that existing file with 1M/3M/1Y-specific cases
  (the new `pacing` prop actually driving different RAF timing per
  range group; the chunk-mode callout voice; `replaySupported` now
  covering 1M/3M/1Y, not just excluding them) rather than writing a new
  test file.
- `ResultsPanel.test.tsx` **already covers**
  `wholeRangeWorstCaseEndingBalance`/`wholeRangeWorstCaseStartingCapital`
  (both modes) and a per-`range` `it.each(["1M", "3M", "1Y"])` case
  confirming no worst-case stat renders on those ranges today (issue
  #105's own independent-review fix) -- this issue's own test change is
  to update that `it.each` case's expectation (the stat _should_ now
  render for those ranges once `replaySupported` widens) rather than add
  new coverage from scratch, plus a new case confirming the "Watch it
  happen" button now appears for 1M/3M/1Y too.
- Live verification (per this repo's working agreement) should include a
  real local-pipeline-run measurement of actual worst-case playback
  duration for at least 3M or 1Y against real data (the same
  `local-run.ts`/headless-Chromium technique `apps/web/CLAUDE.md`
  documents at length, and the same technique #105's own post-PR
  independent review used to verify 1W against real data for the first
  time) -- this plan's ~7-14s figures are worked through analytically
  from the issue's own trade-count ceilings, not yet measured against a
  real browser's actual RAF scheduling overhead at ~40 chunks. #105's
  own real-data 1W measurement (~14.4s against a ~13.0s analytical
  estimate, ~11% over) is a concrete data point that this plan's own
  chunk-based estimates should expect a similar real-browser-overhead
  margin, not treat the ~7-14s figures as exact.

## 6. For the manager

The original sequencing question (item 1 in this section's own first
draft -- whether to hold this issue until #105 shipped, or proceed in
parallel with a later reconciliation pass) is now resolved by
construction: #105 has shipped, and this revision _is_ that
reconciliation pass. Nothing left to decide there.

Three things this plan still could not resolve unilaterally:

1. **The exact `NUM_CHUNKS`/`CHUNK_TRANSITION_MS`/`CHUNK_PAUSE_MS`
   values** (section 3.1) are proposed and worked through analytically,
   but -- consistent with how this repo has treated every prior pacing
   constant, now including #105's own real, live-measured
   `WHOLE_RANGE_REPLAY_PACING` (tuned, then verified ~11% over its own
   analytical estimate against real browser overhead) -- are left as an
   implementer/reviewer call to finalize against a real browser and real
   data, not pinned as a hard requirement here. Worth the manager's
   awareness mainly because the _shape_ of the mechanism (chunk-capped,
   not per-range-tuned, expressed as a real `ReplayPacing` object) is
   the load-bearing design decision this plan is confident in; the
   specific numbers are not, and #105's own real measurement is a
   concrete reason to expect some margin erosion once measured live
   here too.
2. **Whether 1M/3M/1Y's own chunk mode generalizes the real, shipped
   `WholeRangeReplay.tsx`/`use-trade-replay.ts` in place, or needs a
   sibling component/hook sharing an extracted common layer** (sections
   3.1/3.3) -- this plan's own strong recommendation is to generalize in
   place, given how much now-doubly-proven correctness work (#96's five
   review rounds, #105's own additional fixes) already lives in the
   existing hook/component, but it explicitly flags the widened
   `Segment`/`ReplayEvent` union as the one place this could turn out
   awkward enough in practice to warrant the fallback instead. A real
   implementation-time call, not resolved here.
3. **Whether the worst-case stat's `replaySupported` widening should
   ship atomically with the replay button, or could in principle ship
   as a smaller, earlier change** -- this plan's own recommendation
   (section 3.3) is atomic: both are already gated by the identical
   prop, and there's no product reason to reveal the worst-case figure
   for 1M/3M/1Y ahead of the feature that was the actual reason it was
   held back post-#105. Flagged only because it's a real, if minor,
   scoping option a reviewer might otherwise wonder about.
