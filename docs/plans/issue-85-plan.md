# Plan: issue #85 -- portfolio chart redesign (benchmark + design, no implementation)

Status: plan only, per the issue's own delegation note -- no implementation
in this worktree. Unlike issue #75's plan (which needed a real timed
benchmark before a data-model decision could be made at all), this issue's
two open forks are design/architecture calls, not capacity questions -- so
this plan's "load-bearing" section is the reasoning behind each decision,
not a live measurement. Read `apps/web/src/components/PortfolioChart.tsx`,
`apps/web/src/lib/portfolio-series.ts`, and
`apps/web/src/lib/chart-label-layout.ts` in full before this plan -- the
sections below build directly on their current shape rather than
re-explaining it.

## 0. One-paragraph summary

**Decision A (on-chart labels): remove them, delete
`chart-label-layout.ts` outright.** Section 2 makes the case: the exact
ticker/date/price information the labels duplicate is already rendered,
unconditionally, immediately adjacent to the chart in both result
models (`TradeList`'s always-visible prose for the window model,
`IntradayTradeList`'s row list for the per-day model) -- a stronger
duplication argument than the issue's own framing, which only names the
hover/tap tooltip and the collapsed `ChartDataTable` as the overlap.
**Decision B (relationship to #84): not blocked on #84, and most of this
redesign already generalizes cleanly to #84's future chained-balance
curve without rework -- except the on-chart label system, which would
have needed a second redesign at 1Y's ~252-day scale regardless.**
Section 3 works through which parts of today's architecture do and don't
survive #84 unchanged. Section 4 gives concrete mockup directions for the
visual redesign itself (gain/loss coloring, a reveal animation, marker
shape, axis treatment) built on tokens and animation patterns this app
already has (`--status-good`/`--status-critical`, the two-layer
reduced-motion gating `HeroStat`'s `.hero-figure-accent-animate` and
`ResultsPanel`'s `.results-fade-in` already establish) rather than
inventing a new vocabulary.

## 1. Current architecture recap

- **`PortfolioChart.tsx`**: hand-rolled SVG, log-scaled y-axis, one flat
  `--series-1` accent on the line/area-fill/markers, up to 6 markers (one
  open + one close per trade, at most 3 trades). Each marker gets a
  two-line on-chart text label (`primaryText`: "Buy AAPL" /
  `secondaryText`: date + price), positioned by `resolveLabelOffsets`
  (`chart-label-layout.ts`) to avoid overlapping any other label's
  estimated bounding box. A hover/tap/keyboard-driven tooltip readout
  sits below the chart (`aria-live="polite"`), and a collapsed
  `<details>`/`ChartDataTable` gives every point in a plain table,
  always available but not open by default.
- **`portfolio-series.ts`**: pure client-side derivation of
  `PortfolioPoint[]` (`{ date, value, event }`) from a result's trades --
  flat-until-open, annotate at open (no value change), flat-through-hold,
  jump at close. `appendTradeSteps` is shared by `derivePortfolioSeries`
  (window model, arbitrary calendar dates) and
  `deriveIntradayPortfolioSeries` (one intraday day, datetimes within
  that single date). Neither function assumes "at most 3 trades" or
  "at most one day" in its own logic -- see section 3.
- **`chart-label-layout.ts`**: a standalone, unit-tested collision-
  avoidance module -- per-character width estimation (no real DOM
  measurement is possible for SVG `<text>`, see its own doc comment),
  greedy same-direction stacking, and a bounds-clamping fix (a real bug
  found in code review: an unbounded stack could push a label off the
  visible viewBox) -- built entirely to keep at most 6 short strings from
  overlapping.
- **Gain/loss color vocabulary already established elsewhere**:
  `--status-good`/`--status-critical` (`globals.css`), used by
  `TradeRow.tsx` (`isGain = returnFraction >= 0`, i.e. flat counts as
  good) and `HeroStat.tsx`'s multiplier badge + reveal-accent glow
  (`isMultiplierGain = endingBalance / startingCapital >= 1`, the same
  ">= is good" convention, deliberately looser than `HeroStat`'s own
  strict `isGain = endingBalance > startingCapital`, which exists only to
  gate the celebration confetti). `PortfolioChart.tsx` is the one place
  in this app that still renders a value series in a single flat accent
  color regardless of outcome.
- **Reveal-animation precedent already established elsewhere**:
  `HeroStat.tsx`'s `.hero-figure-accent`/`.hero-figure-accent-animate`
  (issue #77) and `ResultsPanel.tsx`'s `FadeInWrapper`/`.results-fade-in`
  both use the same two-layer reduced-motion guard -- a component-level
  derived value (`useReducedMotionAtMount`, latched once at mount, shared
  by both) decides whether to add the `-animate`/`.results-fade-in`
  class at all, and a `@media (prefers-reduced-motion: reduce)` rule is
  defense-in-depth for a future caller that skips the check. Neither does
  real DOM measurement (`getBBox`/path length) -- both are plain CSS
  `@keyframes` on `opacity` (`.results-fade-in`) or `text-shadow`/
  `opacity` (`.hero-figure-accent-animate`).

## 2. Decision A: on-chart labels -- remove, delete `chart-label-layout.ts`

**The issue's own framing already leans this direction** ("very likely
the single largest concentration of both visual clutter and incidental
complexity"), but flags it as a real tradeoff, not a free win, and asks
for an explicit answer -- so here it is, with the fact that tips it from
"probably" to "yes."

**The duplication is stronger than the issue's own framing.** The issue
names two overlapping surfaces (the hover/tap tooltip, the collapsed
`ChartDataTable`) and treats "a user who never hovers or taps" as the
real cost of removal. But reading `ResultsPanel.tsx` shows a third,
**unconditional, always-adjacent** surface that already exists and that
neither the issue nor a first reading of `PortfolioChart.tsx` alone would
surface:

- **Window model** (`ResultsPanel.tsx` line ~361-370): `PortfolioChart`
  is immediately followed by `TradeList`, which renders as always-visible
  prose ("Had you known, you'd have bought AAPL on 2024-03-01 at
  $142.50 ... Finally, you'd have sold on 2024-06-10 at $198.20 ..." --
  see `narrate-trades.ts`'s `NarratableTrade`, which carries `ticker`,
  `buyLabel`, `sellLabel`, and both prices). No gate, no click needed --
  it renders in the same view as the chart, every time.
- **Intraday-daily model** (`ResultsPanel.tsx` line ~755-764):
  `PortfolioChart` is immediately followed by `IntradayTradeList`
  (`TradeRow`-based rows: "Buy AAPL at 10:15 at $142.50 -> Sell at 14:30
  at $145.10 (+1.8%)"). This _is_ gated -- but by the same
  `DailyGuessForm` gate that also gates `PortfolioChart` itself (issue
  #34/#80's "Per-day breadth made visible" section in this file's own
  CLAUDE.md is explicit that the gate is untouched and applies uniformly)
  -- so relative to the chart, the trade list is never _more_ hidden than
  the chart itself. Whenever a user can see the chart, they can also see
  this list, right below it.

So a user who never hovers or taps the chart does not lose the
ticker/date/price information the on-chart labels carried -- they get it
from the very next thing on the page, in both models, unconditionally.
The "at-a-glance" property the issue worries about losing is preserved
by a surface this app already ships, not a hypothetical future addition.

**The complexity/clutter cost is real and concrete, not just asserted**:
`chart-label-layout.ts` is ~187 lines of pure logic (per-character width
estimation calibrated against two font sizes, greedy stacking, a
bounds-clamping fix for an off-canvas edge case found in code review) plus
its own test file, built to solve overlap for at most 6 short strings.
`PortfolioChart.tsx` itself carries a `markerLabels` array construction,
an `anchorFor` helper, a `labelYs` call, and two `<text>` elements per
marker in the render map -- all of it in service of information that
sections above show is already available one scroll-length away.

**Decision: remove the on-chart text labels, delete
`chart-label-layout.ts` and `chart-label-layout.test.ts` entirely.**
Concretely, in `PortfolioChart.tsx`:

- Delete the `resolveLabelOffsets` import, the `anchorFor` function, the
  `markerLabels`/`labelYs` computations, and the two `<text>` elements
  per marker in the render `.map`.
- **Keep** `eventLabelVerb`/`eventTooltipVerb` (from `trade-math.ts`'s
  `tradeVerbs`/`tradeVerbsPast`) -- they're still needed by the hover
  tooltip readout and `ChartDataTable`, neither of which this decision
  touches.
- **Keep** `PortfolioPoint`/`PortfolioEvent` and every derive function in
  `portfolio-series.ts` completely unchanged -- the event data isn't
  going away, only its on-chart text rendering is. See section 5 for why
  this plan doesn't find a restructuring win in `portfolio-series.ts`
  itself, despite the issue explicitly inviting one.
- Markers (the small circles at each open/close point) stay -- they're
  cheap, real visual anchors for the tooltip/keyboard-navigation
  interaction, and losing them entirely (not just their labels) would
  actually regress discoverability. See section 4 for a proposed shape
  distinction (open vs. close) that recovers a little of the lost
  information wordlessly, without reintroducing a text-collision problem.

## 3. Decision B: relationship to issue #84

**Not blocked on #84**, per the issue's own scope, and this section
doesn't wait for #84's plan (`docs/plans/issue-84-plan.md`, being written
concurrently in a sibling worktree this same round) -- it's grounded in
#84's actual issue text instead. Reading #84 directly:

- **What #84 changes**: for 1W/1M/3M/1Y, each day's `startingCapital`
  chains from the _previous_ day's `endingBalance` instead of resetting
  to a fixed value. `HeroStat`/`WorstCaseStat`/`PortfolioChart`/
  `IntradayTradeList` "need to make it visually clear that a day's
  starting figure came from the previous day's result" -- but #84's own
  Out of Scope section is explicit that it does **not** implement a
  continuous multi-day chart: "doesn't require implementing #84's
  compounding chart here." Today's `DayOverview` + single-selected-day
  drill-down (`deriveIntradayPortfolioSeries`, one day's chart at a time)
  stays the actual per-day UI after #84 ships. #84 only requires that a
  chained-in starting figure read as inherited, not as a reset.
- **What #84's own issue body flags as a likely-but-not-guaranteed
  future step**: this issue's (#85's) own Background section names a
  possible follow-up -- once balances chain, a single continuous curve
  across an entire window's days becomes _possible_ and _would likely be
  a more compelling visual_ than restyling today's isolated-day view.
  That's explicitly framed as a future direction, not something #84
  itself builds, and not something #85 is asked to build either.

**Given that, this redesign's job is narrower than "prepare for a
continuous curve"**: don't ship something that assumes today's
single-isolated-day shape is the permanent, only shape a per-day chart
will ever have. Concretely, checking each piece of this plan's own
direction against that requirement:

| Piece                                              | Assumes single-day is permanent?                       | Why / why not                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| -------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PortfolioPoint`/`PortfolioEvent` shape            | No                                                     | Already generic -- `date` is any timestamp-parseable string (calendar date _or_ datetime, see `isPortfolioDatetime`), not scoped to one day. A future multi-day series is just more points with real cross-day datetimes; no shape change needed.                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `appendTradeSteps`/`derivePortfolioSeries`         | No                                                     | Already trade-sequence-generic, already used by the window model across an _entire multi-year_ range today. A hypothetical `deriveChainedIntradayPortfolioSeries` could very plausibly reuse it as-is, feeding it a flattened list of trades across days instead of one day's trades -- the exact "portfolio-series.ts is fair game to restructure" door the issue leaves open, this plan just doesn't find a need to walk through it _now_, since nothing needs restructuring to stay compatible.                                                                                                                                                                                                      |
| `buildTimeScale`/`toTimestamp` (x-axis)            | No                                                     | Already scales an arbitrary timestamp range, not a bounded "one day" domain -- confirmed by reading `chart-scales.ts`'s `buildTimeScale`, which takes any `[minTs, maxTs]` domain.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Gain/loss line/fill/marker coloring (section 4)    | No                                                     | A single `endingValue >= startingValue` check over the _whole plotted series_ generalizes unchanged whether that series is one day's 6 points or a year's several hundred.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Reveal animation (section 4)                       | No                                                     | A CSS `opacity`/transform keyframe on the whole chart group has no dependency on point count.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **On-chart text labels + `chart-label-layout.ts`** | **Yes -- this is the one piece that doesn't survive.** | The whole module's own design brief is "at most 6 markers" -- `MAX_STACK_LEVELS`, the brute-force pairwise overlap check, and the per-character width estimate are all sized and reasoned about at that scale. A hypothetical 1Y chained curve could carry on the order of 200+ open/close markers (one trading day can have `maxTradesPerDay` same-day trades, times ~252 trading days). Per-marker text labels at that density would be unreadable regardless of how good the collision-avoidance algorithm is -- the fix wouldn't be a tuning knob on today's module, it would be a fundamentally different design (e.g. label only local extrema, or drop labels in favor of the tooltip entirely). |

**This is a second, independent reason Decision A lands on removal, not
just a coincidence of two unrelated conclusions**: even setting aside
section 2's trade-list-adjacency argument entirely, the on-chart label
system is the one piece of today's chart that a plausible #84 follow-up
would force a second redesign of. Removing it now both simplifies the
chart today and avoids carrying dead-end complexity that #84's own
future direction would likely obsolete anyway.

**One thing this plan explicitly does _not_ attempt**: designing or
scoping the actual multi-day continuous curve itself. That remains a
distinct future issue (not #84, which explicitly excludes it, and not
this one, whose own Out of Scope section says the same) -- flagging where
the eventual boundary sits (a new `deriveChainedIntradayPortfolioSeries`-
shaped function, most likely reusing `appendTradeSteps` per the table
above, plus per-day boundary markers/gridlines DayOverview's row list
doesn't currently need) is as far as this plan goes, since scoping it for
real needs #84's shipped schema in hand, not just its issue text.

## 4. Concrete visual redesign directions

Not pixel-perfect mockups -- concrete enough that an implementer isn't
left guessing at values, verified live (screenshot, both light... no,
this app is dark-mode-only since issue #76, so: verified live in the
app's one theme) at implementation time per the issue's own acceptance
criteria, not here.

### 4.1 Gain/loss-aware line, fill, and marker coloring

- **Threshold**: `isGain = plotted[plotted.length - 1].value >=
plotted[0].value` -- the _same_ ">= is good" convention `TradeRow`
  (`returnFraction >= 0`) and `HeroStat`'s multiplier badge/reveal-accent
  (`endingBalance / startingCapital >= 1`) already use, extended to a
  fourth call site rather than inventing a fifth slightly-different
  threshold. A flat/no-trade window (start === end) renders "good" —
  consistent with how the rest of the app already treats flat as
  good-or-neutral, not bad.
- **Color**: replace every `var(--series-1)` reference in the SVG (line
  `stroke`, gradient `<stop>` `stopColor`s, marker `circle` `fill`, hover
  point `fill`, focus-ring `ring-[var(--series-1)]` class) with a
  computed `seriesColor = isGain ? "var(--status-good)" :
"var(--status-critical)"`. Keep `--gridline`/`--baseline`/
  `--text-muted` (gridlines, baseline, axis text) neutral and untouched --
  only the data itself (the thing actually being judged gain/loss)
  should carry the accent color, matching the dataviz skill's own
  reserve-accent-for-data convention already implicit in how this chart
  treats gridlines vs. the line today.
- **`--series-1` itself**: stays defined in `globals.css` (still used
  elsewhere, e.g. `--series-1-wash`) but `PortfolioChart.tsx` stops being
  a consumer of it directly.

### 4.2 Marker shape: recover a sliver of the removed labels' meaning

A small, cheap addition, not required to satisfy Decision A but worth
doing given how little it costs: distinguish "open" markers (no value
change, purely an annotation) from "close" markers (the point where
value actually moves) by **shape**, not text -- an open marker renders as
a hollow ring (`fill="none"`, `stroke={seriesColor}`, same radius), a
close marker as today's filled dot (`fill={seriesColor}`). This is the
same open/close distinction the old label text conveyed via the verb
("Buy" vs. "Sell") and TradeRow's own rows still convey by full sentence
-- here it's conveyed wordlessly, at zero collision risk (no bounding-box
math needed for a marker's own shape), and only adds an `event.type`
branch to the existing marker render map, nothing new to compute.

### 4.3 Reveal animation on mount

Recommend the **same low-complexity approach `.results-fade-in` already
uses**, not a real path-length stroke-draw-in (which would need a `ref` +
effect to call `getTotalLength()`, a hydration-safe initial
`stroke-dasharray`/`stroke-dashoffset` story, and meaningfully more new
code for a fancier but not obviously-better effect at this chart's scale):

- A new `@keyframes portfolio-chart-reveal` in `globals.css`: `opacity:
0` + a small `translateY` (e.g. `8px`) at `from`, `opacity: 1` +
  `translateY(0)` at `to`, applied to the `<g>` wrapping the area fill +
  line + markers (not the gridlines/axis, which should be immediately
  present so the chart doesn't look broken mid-animation) over roughly
  500-600ms `ease-out`.
- **Same two-layer reduced-motion gate as `.hero-figure-accent-animate`/
  `.results-fade-in`**: `PortfolioChart` derives `animateReveal =
!useReducedMotionAtMount()` once at mount (the same shared hook, same
  precondition it already documents -- only safe from a client-only
  success-branch mount, which is exactly where `PortfolioChart` is always
  rendered from) and conditionally adds the class; a `@media
(prefers-reduced-motion: reduce)` rule under the keyframe is
  defense-in-depth, matching both existing precedents exactly.
- **Re-fires on every genuine new result**, the same way `HeroStat`'s
  reveal already does: since `PortfolioChart` is always freshly mounted
  by `ResultsPanel`'s existing remount-on-new-result behavior (a changed
  `heroKey`-equivalent identity), no new key plumbing is needed here --
  it gets this for free from the same mechanism `HeroStat`'s count-up
  already relies on.

### 4.4 Axis / gridline treatment

- **Keep** `niceLogTicks(..., 5)` and the current hairline `--gridline`
  weight (1px) -- issue #76's dark-mode-only settling already tuned these
  values (`packages/core`/this file's own "Surface elevation" note
  covers the broader dark-mode contrast pass), and nothing about this
  redesign's own goals (decluttering labels, adding color) implies the
  gridlines themselves were the problem. Re-tune only if a live
  screenshot at implementation time shows the now-colored line/fill
  competing with them (plausible given `--status-good`'s `#0ca30c` is a
  more saturated green than `--series-1`'s blue) -- if so, the cheap fix
  is lowering `--gridline`'s opacity slightly, not changing tick density
  or weight.
- **X-axis stays start/end-date-only** (no new tick labels) -- correct
  as-is for today's at-most-3-trade window, and per section 3, adding
  intermediate date ticks is a concern for the _eventual_ multi-day-curve
  follow-up (where a 1Y span genuinely needs more than two date labels to
  orient the viewer), not this issue.
- **Not recommended**: a persistent "current value" label pinned to the
  final point (a middle-ground some chart UIs use to keep _one_
  always-visible label without the full per-marker system). Considered
  and set aside -- `HeroStat`'s big headline figure already shows the
  exact same ending value at page-load-visible, top-of-page prominence,
  so a second copy of the identical number on the chart's own last point
  would be pure duplication with no new information, unlike the
  ticker/date/price the removed per-trade labels carried. If a future
  screenshot pass at implementation time finds the chart's endpoint reads
  ambiguous without it, this is the first thing worth reconsidering --
  flagged here rather than silently ruled out forever.

## 5. Data model simplification: what actually changes

The issue explicitly invites restructuring `portfolio-series.ts`'s two
derive functions and `appendTradeSteps` "if a simpler shape falls out of
whatever visual direction is chosen." **This plan's direction doesn't
produce one** -- worth stating explicitly rather than leaving the
invitation unaddressed:

- `PortfolioPoint`/`PortfolioEvent` are unchanged in shape -- the event
  data (ticker, direction, price, open/close type) is still consumed by
  the tooltip and `ChartDataTable`, so nothing about removing the
  _on-chart text rendering_ of that data removes the data itself from
  the model.
- `appendTradeSteps`, `derivePortfolioSeries`, and
  `deriveIntradayPortfolioSeries` need **no changes** under this plan --
  they were never the source of the complexity being cut (see section
  1's own recap: none of the "at most 3 trades" / "at most 6 markers"
  assumptions live in `portfolio-series.ts`; they live entirely in
  `chart-label-layout.ts` and in `PortfolioChart.tsx`'s own
  `markerLabels`/`labelYs`/`anchorFor` machinery, all deleted by Decision
  A). The actual simplification this issue asks for is fully satisfied by
  deleting `chart-label-layout.ts` and its call sites -- there is no
  separate, additional win available in `portfolio-series.ts` itself for
  this redesign to chase.

## 6. Test impact (qualitative -- no code written for this plan-only issue)

- **`apps/web/src/lib/chart-label-layout.test.ts`**: deleted (module
  deleted).
- **`apps/web/src/lib/chart-label-layout.ts`**: deleted.
- **`apps/web/src/components/PortfolioChart.test.tsx`**: the
  "point-label collision avoidance" describe block is deleted (nothing
  left to assert -- no on-chart `<text>` per marker any more). New
  coverage needed: gain/loss color selection (a gain fixture asserts
  `--status-good` reaches the line/fill/marker `fill`/`stroke`, a loss
  fixture asserts `--status-critical`, a flat/zero-trade fixture asserts
  the ">= is good" convention lands on `--status-good`), the reveal
  animation's class-gating (mirroring `HeroStat.test.tsx`'s "reveal
  accent" describe block shape: class present with motion allowed, class
  absent under `prefers-reduced-motion: reduce`, stubbing
  `matchMedia`/`useReducedMotionAtMount` the way that file already does),
  and the open/close marker shape distinction (a hollow-ring open marker
  vs. a filled-dot close marker, if section 4.2's suggestion ships).
- **No change needed** to `portfolio-series.test.ts` (see section 5) or
  to `chart-scales.test.ts`/`chart-scales.ts` (untouched by this plan's
  direction).
- **`globals.css`**: new `@keyframes portfolio-chart-reveal` +
  `.portfolio-chart-reveal`/reduced-motion-media-query rule, no CSS unit
  tests in this repo (none of the existing animation CSS has any --
  covered instead by the component-level class-gating tests above, same
  as `.hero-figure-accent-animate`/`.results-fade-in` today).

## 7. Acceptance-criteria mapping (for the implementation pass)

Not performed here (plan-only), listed so the eventual implementation PR
has a direct checklist against this plan's decisions:

- Live screenshot verification (gain, loss, Max-range astronomical-scale,
  zero-trade window, dark mode) -- per this app's established
  throwaway-debug-route + headless-Chromium convention
  (`apps/web/CLAUDE.md`'s own "Headless-browser screenshot verification"
  section), same technique issues #35/#36/#45/#77 already used.
- On-chart-labels question: answered above (section 2) -- removed,
  reflected by deleting `chart-label-layout.ts` and its call sites.
- #84-relationship question: answered above (section 3) -- not blocked,
  and section 3's table is the explicit "how this does/doesn't need to
  change once #84 ships" writeup the issue asks for.
- `chart-label-layout.ts`'s tests: deleted (module deleted, not kept and
  updated -- there's nothing left for them to cover).
- `pnpm lint`/`typecheck`/`build`/`test`/`format:check`: unaffected by
  this plan-only pass (no code changed); the implementation PR needs all
  five, per this repo's standard working agreement.

## For the manager

No genuine, unresolved judgment call is left open by this plan -- both
forks the issue flagged (on-chart labels, relationship to #84) have an
explicit answer with rationale above, and section 4's visual directions
are concrete enough to implement directly. Two low-stakes implementer
choices are flagged rather than mandated, since neither changes the
plan's core decisions and both are cheap to revisit after a real
screenshot:

1. **Marker shape distinction (section 4.2)**: a nice-to-have, not a
   requirement of Decision A -- the implementer could ship without it and
   still fully satisfy the issue's acceptance criteria.
2. **Reveal animation approach (section 4.3)**: this plan recommends the
   cheaper CSS-fade approach over a real stroke-draw-in animation for
   simplicity; if the implementer finds the fade reads as too subtle once
   rendered, upgrading to a measured stroke-draw is a contained,
   optional follow-up, not a rework of this plan's other decisions.
