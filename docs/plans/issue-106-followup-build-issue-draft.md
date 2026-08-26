# Draft: follow-up build issue for #106 (NOT FILED)

**This file is a draft of content for `gh issue create`, for the
manager to review before filing -- it is not itself a permanent project
doc, and nothing in it has been filed on GitHub as of this PR.** It's
built from the reconciled `docs/plans/issue-106-plan.md` (same PR),
which itself reconciles #106's original design against issue #105's
real, shipped 1W implementation. Read that plan in full before filing --
this draft summarizes it into the repo's own agent-ready issue shape
(see `gh issue view 105` or `gh issue view 96` for the convention this
follows), it doesn't replace it.

---

## Suggested title

Gamified replay: extend "Watch it happen" to 1M/3M/1Y (chunked whole-range playback)

## Suggested body

```markdown
## Goal

Extend "Watch it happen" replay (issues #96/#97/#107/#108 for the
window model; #105 for 1W) to the remaining intraday-daily ranges --
1M/3M/1Y -- via a day/chunk-based reveal mechanism, since their trade
counts (up to ~63/~186/~750) are far too large for #105's per-trade-
event pacing to stay watchable.

## Background

- `apps/web/src/components/ResultsPanel.tsx`'s intraday-daily branch
  (currently ~lines 604-720) already renders `<WholeRangeReplay>`
  (`apps/web/src/components/WholeRangeReplay.tsx`, issue #105) for every
  intraday-daily range -- 1W, 1M, 3M, and 1Y alike. Today it only
  actually shows a "Watch it happen" button and a worst-case stat for
  1W: `ResultsPanel.tsx`'s own `replaySupported` local (~line 665) is
  hardcoded `range === "1W"`, and `WholeRangeReplay.tsx`'s own
  `replaySupported` prop (its doc comment, ~lines 71-101) ANDs that into
  both the button's `canReplay` gate and whether a `worstCase` object
  ever reaches `WholeRangeBalance`. **This issue's job is to widen that
  one gate for 1M/3M/1Y -- doing so is what turns on both the replay
  button and the worst-case stat for those ranges; it is not a separate
  future decision.**
- `WholeRangeReplay.tsx`'s own `useTradeReplay(points, WHOLE_RANGE_REPLAY_PACING)`
  call (~line 222) uses a hardcoded internal pacing constant
  (`WHOLE_RANGE_REPLAY_PACING`, ~lines 156-160: `transitionMs: 130,
eventPauseMs: 220, rewindMs: 700`), tuned and live-verified only
  against 1W's own worst case (15 trades / 50 points / 49 segments / 30
  event-pauses). `use-trade-replay.ts`'s `useTradeReplay` (its own
  `pacing?: ReplayPacing` parameter, ~lines 99-103/346-349) already
  supports a caller-supplied pacing object -- but even the tightest
  reasonable pacing can't make 1Y's ~750-trade, ~2,500-point series
  watchable at _per-trade_ granularity (see the reconciled plan's
  section 2's own worked numbers: ~26 minutes unmodified, still
  multiple minutes even at a 10x tightening). This range group needs a
  genuinely different reveal _mechanism_ -- day/chunk-based, not a
  pacing tweak -- not just a new `ReplayPacing` object plugged into the
  existing per-trade walk.
- `apps/web/src/lib/use-trade-replay.ts`'s own `buildSegments`
  (~lines 167-186) walks `points` one index at a time, pausing on every
  real event -- this is the piece that needs a second, pluggable
  implementation (a day-chunk segment-builder), not the RAF/phase/
  rewind/reset scaffold around it (`isReplayLive`/`canReplayFor`,
  ~lines 36-51; the `idle -> rewinding -> playing -> done` phase
  machine; `useResetWhenChanged`-based mid-flight reset; `completedRuns`),
  all of which is already shape-agnostic and directly reusable.
- `apps/web/src/lib/replay-callout.ts`'s `calloutText`/`chartLandingFor`
  (~lines 23-53) are the real, shared single-trade narration/marker-
  effect functions #105 extracted specifically so a second whole-range
  caller could reuse them -- still the right voice for a chunk
  containing exactly one day with exactly one trade (a common case for
  1M, where chunks default to single days), but a genuine multi-trade
  chunk needs a new, distinct summary voice (a date range + trade count
  - net change, not a per-trade narration -- narrating up to ~21 trades
    inside one pause is an unreadable blur, not "watch it happen").
- `apps/web/src/lib/portfolio-series.ts`'s exported `calendarDayOf`
  (line 174) already gives a day-grouping key for
  `deriveWholeRangeIntradaySeries`'s output (line 215) with no pipeline
  change needed -- the same function `chart-scales.ts`'s
  `buildChainedIntradayXPositions` already uses for a different purpose
  (x-axis slot assignment).
- `apps/pipeline/src/pipeline.ts`'s `DEFAULT_MAX_TRADES_PER_DAY = 3`
  (line 109) and `INTRADAY_RANGES` (line 163, includes `"1M"`/`"3M"`/
  `"1Y"`) are what produce this group's real worst-case trade ceilings:
  1M ~21 trading days (~63 trades), 3M ~62 (~186), 1Y ~250 (~750).
- Read `docs/plans/issue-106-plan.md` (this repo, reconciled against
  #105) in full before implementing -- it works through the day/chunk-
  cap mechanism's exact steps and constants (section 3.1), why one
  issue should cover all three ranges (section 3.2), and exactly what
  "extend `WholeRangeReplay.tsx`" means concretely (section 3.3). Also
  read `apps/web/CLAUDE.md`'s "Trade replay: 'Watch it happen'",
  "Rewind-to-start-date intro beat", "Carrying the ticking date readout
  through forward playback", "Marker pulse, shake, and speech-bubble
  callout", and "'Watch it happen' replay for 1W" sections -- several
  rounds of subtle bugs (stale mid-flight prop resets,
  `aria-hidden`-on-focusable-element, axis-domain reflow on partial
  reveal, a worst-case stat leaking to every range unconditionally) were
  already found and fixed across the window-model and 1W builds; this
  extension should inherit those fixes by reusing the existing
  machinery, not risk reintroducing any of them independently.

## Scope

- A day/chunk-based reveal mechanism for `use-trade-replay.ts`: group
  the whole-range chained series into at most `NUM_CHUNKS` (~40, tuned
  by feel) roughly-equal day-clusters, reveal each cluster as one fast
  tween, and pause only on a cluster containing at least one real trade
  to show a lightweight date-range/trade-count/net-change callout
  instead of a per-trade narration. See the reconciled plan's section
  3.1 for the exact steps and starting constants
  (`CHUNK_TRANSITION_MS`/`CHUNK_PAUSE_MS`, expressed as a real
  `ReplayPacing` object, not a separate ad hoc constant pair).
- Generalize `use-trade-replay.ts` to accept a pluggable segment-builder
  (default: the existing per-point `buildSegments`; new: the day-chunk
  builder above), reusing its phase machine/rewind beat/`skipToEnd`/
  reset/`completedRuns` scaffold unmodified. A widened `Segment`/
  `ReplayEvent` shape (or a new variant) is expected -- the existing
  types are sized for exactly one trade per pause.
- A new chunk-summary callout function alongside the existing, shared
  `calloutText` in `lib/replay-callout.ts` -- falling through to the
  existing single-trade voice for the one-day/one-trade degenerate case
  (common for 1M), using the new summary voice only once a chunk's own
  trade count exceeds 1.
- Promote `WholeRangeReplay.tsx`'s currently-hardcoded
  `WHOLE_RANGE_REPLAY_PACING` module constant to a real `pacing:
ReplayPacing` prop, and extend the component to build its callout/
  landing from either voice depending on which segment-builder the
  underlying hook used for a given range. Extend the same, real, shipped
  component -- don't build a second, parallel one (see the reconciled
  plan's section 3.3 for the full "why," and section 6 item 2 for the
  fallback if the widened types make this genuinely awkward in
  practice).
- Widen `ResultsPanel.tsx`'s `replaySupported` local to cover 1M/3M/1Y
  (not just 1W), and thread the new chunk-mode `ReplayPacing` object
  into `WholeRangeReplay`'s new `pacing` prop for those three ranges
  (1W keeps using its own existing `WHOLE_RANGE_REPLAY_PACING`).
- Target playback durations (worked through in the reconciled plan's
  section 3.1, worth restating and re-verifying live rather than
  assuming): 1M roughly 4-7s; 3M and 1Y roughly 7-14s, sharing the same
  ~14s worst-case ceiling regardless of their very different day counts.
- Match the existing replay feature's established accessibility posture
  (a single `aria-live="polite"` status region, skip-to-end control,
  full bypass under reduced motion) -- all of this is already inherited
  for free from `use-trade-replay.ts`'s reused scaffold and
  `WholeRangeReplay.tsx`'s reused composition, not something to
  re-derive.

## Out of scope

- Any change to the shipped window-model replay (#96/#97/#107/#108) or
  the shipped 1W replay (#105) themselves, beyond the generalization
  this issue's own scope requires (the pluggable segment-builder, the
  `pacing` prop).
- Per-day drill-down replay (`dayVariant`/`IntradayTradeList`) -- this
  feature area (1W/1M/3M/1Y alike) stays whole-range-chart-only, per
  every prior issue's own scoping and the reconciled plan's section 3.5.
- Any pipeline/schema change -- the worst-case figures this issue
  unlocks are already computed unconditionally by `ResultsPanel.tsx`
  today (issue #105); no new data is needed.
- Re-litigating whether 1M/3M/1Y should be one issue or split further --
  already decided (one issue) in the reconciled plan's section 3.2, for
  the same reason issue #96 covered the entire window model in one
  issue: one mechanism, one set of constants, no per-range branch.

## Acceptance criteria

- A "Watch it happen" affordance appears for 1M/3M/1Y results with at
  least one trade, gated the same way 1W's already is (no button under
  reduced motion or a zero-trade result; only reachable once the
  whole-range guess is already revealed, via the same
  `WholeRangeBalance` gate 1W already uses -- no second, independent
  gate).
- The whole-range worst-case stat ("Worst case, same budget") now
  renders for 1M/3M/1Y too, once revealed -- confirming the
  `replaySupported` widening actually unlocks it, not just the button.
- Worst-case (max-trade) playback for each of 1M/3M/1Y completes within
  its own stated target duration (roughly 4-7s for 1M, 7-14s for 3M/1Y)
  -- verify live against real current data rather than assuming the
  analytical estimates hold; #105's own real-data measurement (~14.4s
  against a ~13.0s analytical estimate) is a concrete reason to expect
  some real-browser-overhead margin erosion here too.
- A day/chunk with no real trades advances with no pause (the
  "skippable/fast-forwarded no-trade days" behavior); a chunk with a
  real trade pauses and shows a callout appropriate to its own trade
  count (the existing single-trade voice for exactly one trade, the new
  summary voice for more than one).
- A `DayOverview` day switch mid-replay leaves an in-flight 1M/3M/1Y
  replay fully undisturbed (mirroring 1W's own already-verified
  behavior) -- `wholeRangePoints`' dependency array still doesn't
  include `activeDay`/`selectedDay`.
- A genuine `points`-identity change mid-replay (a `ModeToggle`/
  `StartingCapitalInput` edit) correctly resets to idle, mirroring the
  window model's and 1W's own established behavior.
- 1W's own existing replay behavior, pacing, and worst-case stat are
  unaffected by this change -- confirm via the existing
  `WholeRangeReplay.test.tsx`/`ResultsPanel.test.tsx` 1W coverage still
  passing unmodified (beyond whatever mechanical updates the new
  `pacing`-as-a-prop signature requires).
- All four routine checks (lint, typecheck, `pnpm build`, `pnpm test`)
  plus `pnpm format:check` pass.
- Live-verified via screenshot/recording through at least one real 3M or
  1Y result with multiple trades and multiple no-trade chunks, plus the
  reduced-motion fallback and a day-switch-mid-replay check -- the same
  `local-run.ts`/headless-Chromium technique `apps/web/CLAUDE.md`
  documents at length.
```
