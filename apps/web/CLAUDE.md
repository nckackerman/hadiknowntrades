@AGENTS.md

The real app (issues #7/#8/#10): `GET /api/results?range=...` (thin S3
read, see `src/lib/results-api.ts`), a `useResults` fetch state machine,
and a range selector + hero stat + portfolio chart + trade list + an
always-visible methodology/disclaimer section. Live-verified against the
real deployed S3 bucket (see `infra/CLAUDE.md`'s "Current deployment
state"), not just fixtures.

## Chart: hand-rolled SVG, no library

`PortfolioChart.tsx` is plain SVG, not a charting library -- the dataviz
skill's own `components.md` frames every chart as "assembled in plain
HTML/SVG," and this is a single-series step chart with at most 6 markers,
so a library would mean fighting its defaults to hit the skill's exact
specs rather than saving effort. Don't reach for a library here without
re-checking that reasoning still holds (e.g. if the chart grows more
series or interaction complexity than this).

`chart-scales.ts`'s `niceLogTicks` had a real bug once (fixed, see git
history): whole powers of ten are only useful as gridline ticks when they
actually fall inside the padded y-domain, and a domain narrower than one
decade (a flat result, or a modest gain on a short range) can have none
at all -- every gridline/label rendered off the visible chart for that
case. If you ever touch this function, keep (or add to) the test that
asserts every returned tick is within `[min, max]` -- the original test
suite didn't check that and let the bug ship.

### X-axis: day-bucketed for chained intraday, linear time for the window model (issue #93)

`PortfolioChart.tsx`'s x-axis used to be a single linear scale
(`buildTimeScale`) over real epoch-millisecond timestamps for every
series. That's a real problem for issue #91's whole-range intraday chart
(`deriveWholeRangeIntradaySeries`, chaining many real per-day
trading-hour timestamps): overnight (~73% of a day) and weekend (~65hr)
market-closed stretches carry no data, but a linear time scale still
gives them proportional pixel width -- most of the chart rendered as flat
dead space, with actual trading activity crushed into thin slivers.

Fixed by branching the x-scale on `isChainedIntradaySeries` (`includeDate
&& isPortfolioDatetime(points[0].date)` -- `includeDate` alone isn't
enough, since it's true for almost any real window-model result too, just
because its points fall on different calendar dates):

- **Chained multi-day intraday series** (datetime-labeled, multi-day):
  `buildChainedIntradayXPositions` -- every distinct calendar day gets an
  **equal-width slot** (ordinal _by day_), with points placed linearly
  by real timestamp _within_ their own day's slot. Ordinal by day, not by
  point (a real bug caught in code review on this issue's own PR, fixed
  before merge): a day chained by `deriveWholeRangeIntradaySeries`
  produces a different point count depending on how many trades happened
  that day -- 1 point for a no-trade day, up to 10 at
  `DEFAULT_MAX_TRADES_PER_DAY = 3` (`appendTradeSteps` pushes 3 points
  per trade, plus the day's own leading point). An earlier version of
  this fix spaced points evenly _by index_ across the whole series,
  which gave a single busy day disproportionate width purely because it
  has more plotted points -- on a 5-day range, one maxed-out day among
  four quiet ones could claim roughly 70% of the chart's width despite
  being 1 of 5 trading days, trading the original calendar-dead-time
  distortion for a new trade-activity-count distortion instead of fixing
  anything. Bucketing by day first (then placing a day's own points
  linearly within its slot) avoids both problems: dead time between days
  is gone, and a day's own trade count no longer skews how much width it
  gets. The series' very first and last points are explicitly pinned to
  the plot's edges (`buildChainedIntradayXPositions`' own doc comment
  has the exact reasoning) -- otherwise a no-trade first or last day
  (a single point, which would otherwise center in its slot) would leave
  the line, and the start/end axis labels pinned to those same edges,
  visibly not reaching the edge.
- **Window model** (plain-date points, 5Y/Max): unchanged, still
  `buildTimeScale`. This is a deliberate, considered choice, not an
  oversight -- **don't extend day-bucketing here if this comes up
  again.** The window model's points are sparse trade _events_ (window
  start, each trade's open/close, window end), and the real elapsed time
  between them is meaningful holding duration (a 3-day hold vs. a
  3-year hold), not dead time. Evenly spacing them the way day-bucketing
  does for intraday would misrepresent that duration, not fix anything.

`revealNearestPoint`, keyboard `stepFocus`, the crosshair, the
reveal-on-mount animation, the two-label (start/end) x-axis text, and
`ChartDataTable` all needed zero changes -- they were already
index/point-order-based, not pixel-time-based, so the branch is entirely
contained to the scale-construction `useMemo`.

Two more findings from this issue's own `high` code review, both fixed
before merge:

- **`buildChainedIntradayXPositions` orders day slots by each day's own
  minimum timestamp, not by first appearance in `dayKeys`.** The first
  version assigned slot order purely by which day it saw first while
  scanning the input array -- fine as long as `dayKeys` arrives
  chronologically sorted and each day is contiguous (which
  `deriveWholeRangeIntradaySeries`, the one real caller today, always
  produces), but nothing enforced that invariant, so a future pipeline
  bug (a bad merge/backfill producing out-of-order or non-contiguous
  days) could silently scramble slot order with no crash. Sorting by
  each day's own min timestamp before assigning indices closes this
  regardless of input order -- see `chart-scales.test.ts`'s own
  regression test for a concrete before/after example.
- **`calendarDayOf` (`portfolio-series.ts`) delegates to
  `format-date.ts`'s `isPortfolioDatetime`** for its datetime-vs-plain-date
  check, rather than a second `date.includes("T")` -- that function's own
  doc comment already calls itself "the single canonical place this
  detection happens" specifically so two copies can't drift.

A third, smaller finding (the window-model x-position branch was an
inline IIFE nested in a ternary, harder to read than a named sibling
function) was also addressed: it's now `buildWindowModelXPositions` in
`chart-scales.ts`, matching `buildChainedIntradayXPositions`'s
`(timestamps, range) => number[]` shape and independently unit-tested.

One review finding was heard but **not** acted on, a deliberate call:
`isChainedIntradaySeries` infers series kind from data shape
(`includeDate && isPortfolioDatetime(...)`) rather than an explicit kind
the caller (`ResultsPanel.tsx`) already knows and could pass down. This
is the same shape-sniffing pattern `isPortfolioDatetime`/`toTimestamp`/
`formatDateTime` already used throughout this file before this issue --
consistent with existing convention, not a new anti-pattern introduced
here. Threading an explicit `seriesKind` prop through `PortfolioChart`
and both `ResultsPanel.tsx` call sites would be a real, larger
refactor of how series metadata flows through the component tree,
out of proportion for this issue's actual scope (the x-axis dead-space
problem). Worth doing if a genuinely ambiguous series shape ever shows
up in practice -- not preemptively.

Live-verified via before/after screenshots (a throwaway debug route per
this file's own "Screenshotting a component locally" technique, plus a
`git stash` of just the fix to capture the "before" state): a 5-trading-day
chained series went from 4 of 5 days crushed into the left half of the
chart with the 5th isolated far to the right, to all 5 days evenly spaced
and individually readable. The window-model screenshot was pixel-identical
in shape before/after (still a real-time-proportional ramp), confirming
no regression there. (That live-verification screenshot predates the
by-point -> by-day fix above, but the visual result -- 5 evenly-spaced
days -- looks identical either way for a series where every day happens
to have exactly one trade; the two approaches only diverge once a day's
trade count differs from its neighbors', which is exactly what the
`chart-scales.test.ts`/`PortfolioChart.test.tsx` regression tests for
this fix now cover.)

## Headless-browser screenshot verification: possible without sudo (issue #36)

Earlier note here said Playwright's Chromium fails to launch on missing
OS-level shared libs (`libnss3`, `libnspr4`, `libnssutil3`,
`libasound.so.2`) and needs a `sudo apt-get install`/`playwright
install-deps` that no agent has an interactive password for. That's
still true, but there's a no-root workaround, verified live (issue #36):
`apt-get download` (unlike `install`) doesn't need root and fetches the
`.deb`s straight into the cwd; `dpkg-deb -x <pkg>.deb <dir>` extracts one
without installing it system-wide; then point `LD_LIBRARY_PATH` at the
extracted `usr/lib/x86_64-linux-gnu` when launching Chromium:

```bash
apt-get download libnspr4 libnss3 libasound2t64   # libnssutil3.so ships inside the libnss3 .deb, no separate package
dpkg-deb -x libnspr4_*.deb extracted
dpkg-deb -x libnss3_*.deb extracted
dpkg-deb -x libasound2t64_*.deb extracted
LD_LIBRARY_PATH=$PWD/extracted/usr/lib/x86_64-linux-gnu node your-script.js
```

The cached browser binary itself (`~/.cache/ms-playwright/chromium-*`)
may also be a stale revision if `playwright` (the npm package, not just
the browser) gets freshly installed at a newer version than whatever
last downloaded it -- `npx playwright install chromium` re-fetches the
matching build the same way `pnpm add`/`pnpm install` already reaches
the network for packages, no extra setup needed. `playwright` isn't a
project dependency (no reason to ship a browser automation library in
this app); add it with `pnpm add -D -w playwright` for one verification
session and revert `package.json`/`pnpm-lock.yaml` afterward rather than
leaving it installed.

UI changes can now get an actual rendered screenshot, not just component
tests and traced fixture data -- worth reaching for on any visual/layout
change, not only decorative ones.

**Screenshotting a component locally when there's no real S3 data
(issue #45)**: this machine has no `RESULTS_BUCKET` env var and no AWS
credentials wired up for local `next dev`, so `/?range=...` 500s on
`/api/results` before any real page ever renders -- there's no fixture
route to fall back to either. Don't let that block a screenshot
verification: add a throwaway route (e.g.
`src/app/debug-hero-stat/page.tsx`) that imports the component directly
and renders it with hardcoded props, screenshot that, then delete the
route before committing -- it never needs to touch the results-API path
at all. Worked cleanly for HeroStat's multiplier badge (rendered four
prop combinations -- big gain, flat, loss, "Max"-scale astronomical gain
-- on one throwaway page in a single screenshot pass).

## Client-side animation (`useCountUp`, issue #35)

`HeroStat.tsx`'s count-up reveal (`lib/use-count-up.ts`) is a plain
`requestAnimationFrame` loop, no library. A few things that weren't
obvious going in, worth knowing before the next animation in this
milestone (#36):

- **jsdom in this repo's Vitest setup has no `window.matchMedia` at
  all** (checked the actual jsdom 30 source, not assumed) -- calling it
  unguarded throws in every test that mounts the component. Guard with
  `typeof window.matchMedia !== "function"` and stub it per-test with
  `vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches, ... }))`
  the way `HeroStat.test.tsx`/`use-count-up.test.ts` do.
- jsdom **does** implement `requestAnimationFrame`/`cancelAnimationFrame`
  (Vitest's jsdom environment defaults `pretendToBeVisual: true`), but
  it's backed by a real ~16.67ms `setInterval`, not a fake-timers-friendly
  clock. Don't wait on real frames in a test -- `vi.spyOn(window,
"requestAnimationFrame").mockImplementation(cb => { cb(...); return 1;
})` to fire (or withhold) a frame deterministically and synchronously.
- The `react-hooks/set-state-in-effect` lint (see `use-results.ts`'s own
  note on it) also bites animation code: don't branch-and-`setState`
  synchronously at the top of the effect body (e.g. "if reduced motion,
  jump to the end"). Fold that check into the `requestAnimationFrame`
  callback itself instead, so every `setValue` call happens inside a
  callback from an external system (the pattern the lint wants) --
  this also means the very first render (server and client hydration
  alike) is always the same fixed starting value, sidestepping any
  hydration-mismatch risk from reading `matchMedia` during render.
- Accessibility for a value that animates: don't wire `aria-live` to a
  per-frame value (spams assistive tech with every intermediate
  number, and the issue explicitly calls this out). Simpler and more
  robust: mark the visible animating element `aria-hidden="true"` and
  render a second, static `sr-only` element holding the final value the
  whole time -- no dependency on aria-live announcement timing at all.

HeroStat's celebration burst (`lib/should-celebrate.ts`,
`components/CelebrationBurst.tsx`, issue #36) layers on top of the same
count-up: fires once the tween lands on an actual gain
(`endingBalance > startingCapital`, a live prop comparison -- not an
assumption every reveal is a win), a plain CSS keyframe animation on a
couple dozen absolutely-positioned `<span>`s, no canvas/library
(~+0.4KB gzip on the page's JS chunk, measured by diffing
`.next/static/chunks` against a `main` build byte-for-byte).

- The obvious `useEffect` + `setState` version of "trigger once the
  reveal lands" (`useEffect(() => { if (condition) setTriggered(true)
}, [condition])`) trips `react-hooks/set-state-in-effect` --
  unconditionally, not just for the "branch-and-jump at the top of the
  effect body" shape `useCountUp` already worked around (see above).
  The fix here was different: skip the effect+state entirely and
  compute the gate as a plain derived value during render
  (`isGain && settled && !prefersReducedMotion()`), which sidesteps
  both the lint and a whole hook. This is only hydration-safe because
  `settled` is provably `false` on the SSR-matching first render for
  any real gain (it can't become `true` before useCountUp's RAF loop
  ticks at least once, which never happens before mount) -- `&&`
  short-circuits before `prefersReducedMotion()` (the only part that
  touches `window`) ever runs during that render. A derived value that
  _could_ be true on the very first render wouldn't get this same
  safety for free.
- The burst overlay is scoped to just the number row (a `relative` div
  wrapping only the `<p>` with the figures), not the whole `HeroStat`
  flex column -- an earlier version wrapped the outer container and the
  confetti spawned overlapping the small "Starting from" caption above
  the numbers instead of the numbers themselves (caught by an actual
  screenshot, not by the unit tests, which only assert the burst
  renders somewhere).
- **Known, accepted fragility (found in #36's `high` code review, not
  fixed -- decorative feature, not worth a bigger refactor yet):**
  `shouldCelebrate.ts`'s doc comment claims no one-shot latch is needed
  because "the props that feed it don't change after the reveal lands,"
  but `prefersReducedMotion()` is a live `window.matchMedia` read, not a
  prop -- if the OS-level reduced-motion setting is toggled mid-tween or
  mid-burst on a render that happens to re-run (HeroStat isn't
  `React.memo`'d), `shouldCelebrate`'s result can genuinely flip after
  the burst has already fired, either suppressing a celebration that
  already landed on a real gain or unmounting an in-progress burst
  mid-fall. Relatedly, `settled` (`HeroStat.tsx`) is derived via strict
  `animatedEndingBalance === endingBalance` float equality against
  `useCountUp`'s private "lands on the exact target" behavior rather
  than an explicit flag the hook exposes -- fragile to a future tween
  change, but not wired up to break today. If either of these actually
  bites (flaky celebration reports, or `useCountUp`'s tick logic
  changes), the real fix is `useCountUp` returning an explicit
  `{ value, settled }` pair instead of a bare number, and
  `shouldCelebrate` latching `prefersReducedMotion()` once at the
  render where `isGain && settled` first goes true rather than
  re-reading it every render.

### Multiplier badge (issue #45)

`HeroStat.tsx`'s "(345x)" badge sits in the same flex row as the dollar
figures (inside the existing `<p>`, still inside the burst's `relative`
wrapper -- no new wrapping div needed) and is deliberately computed from
the final `endingBalance`/`startingCapital` props, not
`animatedEndingBalance` -- it's correct on the very first render with no
mid-tween intermediate value, so unlike the dollar figures it needs no
`aria-hidden`/`sr-only` pairing at all.

It reuses `TradeRow.tsx`'s established gain/loss coloring convention
(`--status-good`/`--status-critical`), but **deliberately at a different
threshold than this same component's own `isGain`**: the badge treats an
exact 1x (flat) result as a gain (`multiplier >= 1`, matching TradeRow's
own `returnFraction >= 0`), while `isGain` (`endingBalance >
startingCapital`, strict) stays untouched because it also gates the
celebration burst, where "exactly broke even" should never fire
confetti. Don't unify these into one flag -- they answer different
questions (what color reads as bad vs. what's worth celebrating) and
happen to only look the same at a glance.

`formatMultiplier` (`format-currency.ts`) reuses `formatCurrency`'s
compact-suffix/scientific-notation ladder via two extracted helpers,
`scaleToCompactUnit` (the K/M/B/T step) and a `prefix`/`suffix`-
parameterized `formatScientific` -- the multiplier ladder differs from
the currency one only in having no `$`/no-cents-vs-cents branch for its
own sub-1000 case (a plain `toFixed`, not an `Intl.NumberFormat`, since
there's no currency-style cents concept for a unitless ratio) and in
appending `x` as a suffix instead of `$` as a prefix. Verified live via
a throwaway route (see "Screenshotting a component locally" above) that
a "Max"-range-scale ending balance (~$716M from $20) renders as
`(35.8Mx)`, not a wall of digits.

`formatMultiplier`'s sub-1000 plain-number branch had a rounding-overflow
bug (found in `/code-review`, fixed): a value in roughly `[999.5, 1000)`
(e.g. `999.95`) took the plain-number branch since `abs < 1000`, but
`.toFixed(0)` then rounded it up to the string `"1000"` -- a bare
`"1000x"` instead of stepping up to the compact ladder's `"1Kx"`, the
exact class of overflow `scaleToCompactUnit` already guarded against one
tier up (e.g. `999,600` stepping up to `"1M"` rather than showing
`"1000K"`). Fixed by checking `Number(abs.toFixed(digits)) >= 1000` and
falling through to `formatCompactOrScientific` when it does;
`scaleToCompactUnit` itself had to grow a fallback for this (its
`COMPACT_UNITS.findIndex` returns `-1` for an `abs` just under 1000,
since no K/M/B/T threshold is actually crossed -- now defaults to the
smallest unit, K, in that case). **`formatCurrency`'s own sub-1000
branch has this exact same latent bug and was not fixed** (out of scope
for issue #45's multiplier badge, which only touches `formatMultiplier`)
-- confirmed live that both `plainCurrencyWhole.format(999.6)` and
`plainCurrencyWithCents.format(999.995)` round to `"$1,000"`/
`"$1,000.00"` via `Intl.NumberFormat`'s own rounding rather than stepping
up to `"$1K"`. If this is ever worth fixing, `formatCurrency`'s plain
branch can't reuse `formatMultiplier`'s exact guard as-is since it
formats via `Intl.NumberFormat`, not `toFixed`, but the same "check
whether rounding at display precision reaches 1000, step up into the
ladder if so" shape applies.

## Two result models since issue #28: window vs. intraday-daily

`ResultsPanel.tsx` branches on the fetched `PrecomputedResult`'s
`model` field:

- `"window"` (5Y/MAX, and every range before #28): unchanged rendering
  path -- `HeroStat` + `PortfolioChart` + `TradeList` over the whole
  window's trades.
- `"intraday-daily"` (1W/1M/3M/1Y, 1W since issue #60): a `DayOverview`
  (issue #80; a scrollable row list, replacing the original `DaySelector`
  plain `<select>` -- see "Per-day breadth made visible" below) picks
  which day's `IntradayDayResult` to view, defaulting to the most recent
  day. Selected day is URL state
  (`?day=YYYY-MM-DD`, owned by `ResultsPage.tsx` the same way `?range=`
  already is) -- cleared on range change, since a day selected under one
  range's data isn't meaningful for another range's day list.
  `HeroStat`/`PortfolioChart` are reused as-is per selected day;
  `IntradayTradeList` (not `TradeList` -- different field shape,
  `buyTime`/`sellTime` instead of `buyDate`/`sellDate`) renders that
  day's trades. Only `IntradayTradeList` still shares row markup via
  `TradeRow.tsx` -- `TradeList` moved to its own prose rendering (issue
  #32), see "Prose trade narration" below for the full story.

`PortfolioChart.tsx` and `format-date.ts` are now datetime-aware, not
date-only: `PortfolioPoint.date` is either a plain calendar date (window
model) or a full local datetime (`YYYY-MM-DDTHH:MM:SS`, one intraday
day's chart, via `portfolio-series.ts`'s `deriveIntradayPortfolioSeries`)
-- detected by `format-date.ts`'s exported `isPortfolioDatetime` (a "T"
separator check), the single shared place this detection happens.
`PortfolioChart`'s `toTimestamp` and `format-date.ts`'s own
`formatDateTime` both call it rather than each re-implementing the same
check -- a real duplication caught in code review before this note was
written; don't reintroduce a second copy of the check.

## Render-crash boundaries: `app/error.tsx` + `app/global-error.tsx` (issue #46)

Two files, two tiers, together giving full-tree coverage -- neither one
alone catches everything:

- **`app/error.tsx`** catches render-time throws that `useResults`'s
  fetch-only state machine never sees (see the "Two result models" note
  above and `use-results.ts`) -- it wraps `page.tsx` (and everything
  under it) in a React error boundary Next installs automatically, per
  the App Router `error.js` file convention.
- **`app/global-error.tsx`** exists because `error.js` explicitly does
  **not** wrap the `layout.js`/`template.js` in its own segment (see
  `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/error.md`'s
  own "It does not wrap the layout.js ... To handle errors in the root
  layout, use global-error.js"). A throw inside `layout.tsx` itself (its
  `next/font/google` calls, its own JSX) would fall through `error.tsx`
  entirely and hit Next's default unstyled overlay -- `global-error.tsx`
  is the dedicated catch for exactly that gap, one directory, sibling to
  `error.tsx` and `layout.tsx`.

A few things worth knowing before touching either:

- **`error.js`'s fallback component receives both `reset` and `retry`**,
  not just `reset` (confirmed straight from
  `node_modules/next/dist/client/components/error-boundary.d.ts`'s
  `ErrorInfo` type, not the docs prose alone -- `retry` only stabilized
  in Next 16.3.0, so anything in training data or older blog posts that
  only mentions `reset` predates it). The official guidance is to prefer
  `retry()` "in most cases" since it re-fetches the segment before
  re-rendering; both files here deliberately still use `reset()` instead,
  since a render-time throw is a client-side bug in already-fetched
  data, not a stale-fetch problem `retry`'s re-fetch would help with.
  `global-error.tsx` gets the same `ErrorInfo` shape (`error`/`reset`/
  `retry`) -- it's the same underlying boundary mechanism, just installed
  one level higher, around the root layout instead of around `page.tsx`.
- `global-error.tsx` **must render its own `<html>`/`<body>`** -- it
  replaces the root layout entirely when it fires, so there's no outer
  `layout.tsx` left to supply them. Per Next's own docs, it also doesn't
  get the app's global styles/fonts for free ("global-error and the
  built-in 500 page render their own document and do not include your
  global styles"). This file's approach: no import of `./globals.css` or
  `next/font` at all -- plain inline `style` props, with the actual color
  values hand-copied from `globals.css`'s tokens rather than referenced
  (there's no shared `:root` to reference into). If `globals.css`'s
  `--status-critical`/`--background`/etc. values ever change, update the
  copies in `global-error.tsx` too -- nothing enforces that they stay in
  sync. Since issue #76 (dark mode only), both files hand-copy the same
  single set of dark values unconditionally -- no `prefers-color-scheme`
  media query in either place any more, so there's only one set of
  numbers to keep in sync, not two.
- `next build`'s own type-checking pass is happy with `error.tsx` as-is,
  but running `tsc --noEmit` directly (skipping `next typegen`) fails on
  an unrelated pre-existing error in `layout.tsx` (`Cannot find name
'LayoutProps'` -- a Next-generated ambient type). Always run the
  package's own `pnpm run typecheck` script (which runs `next typegen`
  first), not a bare `tsc --noEmit`, or this looks like a bug the new
  code introduced when it isn't one.
- `error.tsx` is tested by mounting a small test-local class component
  that mirrors Next's real `ErrorBoundaryHandler` shape (catch a throw,
  hand `error`/`reset` to the fallback) around a deliberately-throwing
  child -- see `app/error.test.tsx`. Next's actual boundary isn't
  practically testable under RTL/jsdom, so this mirrors its contract
  instead of exercising the real one; if that ever changes, prefer
  driving the real boundary. `global-error.test.tsx` skips that
  indirection and just renders `<GlobalError>` directly with hand-built
  `error`/`reset` props -- there's no render-time throw to catch here
  (it's a plain fallback component, same as `error.tsx`'s own
  `ErrorPage`), so there's nothing the fake boundary would add.

## Chart pointer interaction: tap support (issue #44)

`PortfolioChart`'s hover tooltip/crosshair used to only be reachable by
a mouse hover (`onPointerMove`) -- on a touch device a single tap fires
`pointerdown` + `pointerup` with **no** intervening `pointermove`, so the
richest interaction on the chart was undiscoverable via tap alone. Fix:
the nearest-point lookup that used to live only in `handlePointerMove`
is now a shared `revealNearestPoint` function wired to both
`onPointerDown` and `onPointerMove` -- same handler, so mouse and touch
behavior can't drift apart.

Testing this needed one non-obvious jsdom fact: **jsdom's SVG elements
report a zero-size `getBoundingClientRect` by default** (checked live,
not assumed) -- `revealNearestPoint` divides by `rect.width` to map a
`clientX` into the chart's internal viewBox space, so an unstubbed test
resolves every synthetic pointer event to `NaN`/`Infinity` regardless of
`clientX`, silently picking `hoverIndex = 0` every time (the `nearest
Distance` comparison against `Infinity` never advances past the fallback
index). `PortfolioChart.test.tsx` stubs `getBoundingClientRect` on the
`<svg>` per-test to return the component's own `WIDTH`/`HEIGHT`
constants so `scaleX` comes out to `1` -- do the same for any future
test that fires pointer events at a specific coordinate on this chart.

**`onPointerCancel` matters here, not just `onPointerLeave` (found in
#44's `high` code review):** revealing the tooltip on `pointerdown`
means a touch that starts a page-scroll gesture over the chart briefly
shows the crosshair before the browser takes the touch over for native
scrolling -- at which point it fires `pointercancel`, not `pointerup`,
and per the Pointer Events spec `pointerout`/`pointerleave` "may not be
dispatched" following a cancel. Without an `onPointerCancel` handler
clearing `hoverIndex` the same way `onPointerLeave` does, the tooltip
stays visibly pinned to wherever the touch landed even after the chart
scrolls out of view.

## Prose trade narration (issue #32)

`TradeList.tsx` (the window model's whole-window trade list, 5Y/MAX --
see "Two result models" above) **replaces** its previous TradeRow-based
row list with flowing prose, rather than showing prose alongside the old
rows. Reasoning: the app's whole hook _is_ the "had I known" framing
(it's the product's name), the window model has at most 3 trades so
there's nothing a table adds over a few sentences that a table's
structure earns its own screen space for, and keeping both would just
show the same handful of numbers twice. `TradeRow.tsx` itself is
untouched -- it still backs `IntradayTradeList` (issue #28's per-day,
time-labeled trades), which **keeps its row-list rendering for now**:
that list can run up to `maxTradesPerDay` same-day trades (not capped at
3 the way the window model is), and per-day intraday narration wasn't
this issue's acceptance criteria -- worth a consistency pass later using
the same building blocks below, not a reason to block this issue.

**Real list semantics underneath the prose styling (`high` code review
finding, fixed):** the prose is rendered as an `<ol>` of per-trade
`<li>`s, not a bare `<p>` of sibling `<span>`s -- a screen reader still
gets "list, 3 items" and per-item navigation, exactly like the old
TradeRow-based rendering gave for free, even though it visually reads as
one flowing paragraph. The trick is `display: inline` on the `<li>`
(`globals.css`'s `.trade-narration-item`) -- Tailwind's own preflight
already strips `list-style`/margin/padding from `ol`/`li` (checked
directly in `node_modules/tailwindcss/preflight.css`, not assumed), so
the only default left to override is `<li>`'s own `display: list-item`,
which would otherwise force each trade onto its own line. Verified both
that the visual result is unchanged (screenshot) and that the semantics
are real (`TradeList.test.tsx` asserts `getByRole("list")` and
`getAllByRole("listitem")` returns one entry per trade).

The narration logic lives in `lib/narrate-trades.ts`, deliberately
decoupled from React and from _which_ date/time formatter produced a
trade's buy/sell label (`NarratableTrade` takes already-formatted
`buyLabel`/`sellLabel` strings, not a `Trade` or `IntradayTrade`) --
that's what would let `IntradayTradeList` reuse it later by formatting
its own time-of-day labels and writing its own "at" (vs. "on")
sentence template, with zero changes to this module.

- Handles 1/2/3-trade sequences (and defensively, 0) via one rule with
  no per-count branching: the first trade gets "Had you known, you'd
  have", the _last_ trade gets "Finally, you'd have" (checked after the
  first-trade case, so a 1-trade sequence reads as "Had you known", not
  "Finally"), anything in between gets "Then you'd have". A 2-trade
  sequence's second trade is both "not first" and "last" and gets
  "Finally" -- reads fine as "lastly", not just "the final of >=3".
- Narrates a running, fully-reinvested portfolio balance per trade
  ("turning your $20.00 into $25.07 ... turning that into $32.51 ..."),
  computed client-side from `trades[]` + `startingCapital` (a new
  `TradeList` prop -- `ResultsPanel.tsx`'s window-model branch now
  passes `data.startingCapital` alongside `data.trades`) rather than
  read from anywhere in the schema -- no pipeline/schema change needed,
  since it's exactly the same multiplicative chain `optimizer.ts` itself
  uses to derive `endingBalance`, so the last trade's narrated ending
  balance matches the result's own `endingBalance` (modulo float noise).
  This is deliberately _not_ asserted equal in a test to the fetched
  `endingBalance` -- narrate-trades.ts is unit-tested purely against its
  own inputs, no fixture-level cross-check to the pipeline's own
  optimizer exists today.

  **Shared compounding helper (`high` code review finding, fixed):** this
  running-balance loop and `portfolio-series.ts`'s `appendTradeSteps` (the
  chart's step-function series) used to be two independent copies of the
  same `balance * sellPrice/buyPrice` compounding chain -- a real drift
  risk despite a comment claiming reuse. Both now call
  `lib/trade-math.ts`'s `compoundBalance(startBalance, buyPrice,
sellPrice)`, one implementation instead of two. `trade-math.test.ts`
  adds the fixture-level cross-check the paragraph above says doesn't
  exist elsewhere: it runs the same trade sequence through both
  `narrateTrades` and `derivePortfolioSeries` and asserts they agree on
  every post-trade balance -- a regression guard against exactly this
  drift, not just a test of `compoundBalance` in isolation.

- This is also where the Max-range astronomical-number quirk (see
  `packages/core/CLAUDE.md`'s "Fun/expected product quirk" note) shows
  up _inside_ the trade list itself, not just in HeroStat -- a running
  balance mid-sequence can already be in the millions before the final
  trade. Handled the same way HeroStat's multiplier badge (issue #45)
  handles it: every dollar figure in the prose goes through the
  existing `formatHeroCurrency` compact/scientific ladder, never a bare
  template-literal `$`, so it reads "$248M" rather than a wall of
  digits. No separate disclaimer copy was added here -- verified live
  (screenshot below) that correct number formatting alone reads
  sensibly at that scale, consistent with how the multiplier badge
  didn't need one either; the always-visible `AboutSection` disclaimer
  covers the "this is hypothetical" framing app-wide already.

  **`formatCurrency`'s own sub-$1,000 rounding-overflow bug, fixed
  (found in a straggler code-review pass on this PR):** issue #45's
  `format-currency.ts` note used to say this exact bug (a value in
  roughly `[999.5, 1000)` rounds *up* to a bare "$1,000"/"$1,000.00"
  instead of stepping to the compact ladder's "$1K") was confirmed live
  in `formatCurrency` too but left unfixed as out of scope for #45,
  which only touched `formatMultiplier`. This trade list's own
  per-trade `endBalance` is a genuinely new value with no prior UI
  surface that can land in that range mid-sequence, so the
  previously-theoretical case became reachable in prose users read
  closely -- `formatCurrency` now carries the identical
  `Number(abs.toFixed(digits)) >= 1000` overflow guard
  `formatMultiplier` already had, with a regression test in
  `format-currency.test.ts` for both `formatHeroCurrency` (cents) and
  `formatAxisCurrency` (no cents).

- A trade's own per-leg return (`sellPrice / buyPrice - 1`) and the
  running-balance growth ratio for that same leg are always identical
  (an all-in, fully-reinvested trade means the portfolio's return for a
  leg _is_ the ticker's own price return for that leg) -- so there's
  only one percent computed per trade, colored via the same
  `isGain = returnFraction >= 0` (flat counts as a gain) convention
  `TradeRow.tsx` already established. **Actually shared now, not just
  claimed as reused (`high` code review finding, fixed):** both
  `TradeRow.tsx` and this module call `lib/trade-math.ts`'s
  `computeTradeReturn(buyPrice, sellPrice)` instead of each computing
  `sellPrice / buyPrice - 1` and `returnFraction >= 0` independently --
  a prior comment here claimed this was "reused rather than re-derived"
  when it was in fact copy-pasted between the two files; see
  `trade-math.ts`'s own doc comment for the full history. Generic for a
  loss leg (`sellPrice < buyPrice`) without any special wording or
  branching -- relevant once #31 (worst-case contrast, still backlog as
  of this issue) ships, since today's optimizer never actually produces
  one.
- Verified live via the same throwaway-debug-route technique issue #45
  documented above (no local `RESULTS_BUCKET`/AWS creds): rendered 1/2/3
  trade sequences, a sequence with a synthetic losing leg, and a
  Max-range-scale sequence (a few 100-400x legs compounding $20 to
  ~$248M) on one page, screenshotted in both light and dark, then
  deleted the route before committing.
- **Defensive guard against a corrupted stored price (found in a
  straggler code-review pass on this PR):** unlike `packages/core`'s
  `optimizer.ts` (validates `endingBalance` is finite before returning)
  and the pipeline's write-time `validatePrecomputedResult` (issue #47),
  `results-api.ts`'s read path only checks `schemaVersion`/`model` on a
  stored result -- it never re-validates field-level values like an
  individual trade's `buyPrice`/`sellPrice`. `trade-math.ts`'s
  `computeTradeReturn`/`compoundBalance` (used by `narrateTrades` here,
  and by `TradeRow.tsx`/`portfolio-series.ts` too) now throw
  `InvalidTradePriceError` for a non-finite or non-positive price rather
  than silently computing `Infinity`/`NaN` -- notably dangerous for
  `isGain`, since `Infinity >= 0` is `true`, which would otherwise
  render a corrupted leg in "gain" green with garbage figures. This
  throws during render, caught by the same `app/error.tsx`/
  `app/global-error.tsx` boundaries issue #46 already added for any
  other render-time throw -- a visible, caught failure instead of a
  silently-wrong number.
- **Empty-`trades` fallback (found in the same pass):** `TradeList`'s
  primary empty state ("No trade would have beaten holding cash over
  ...") still lives in `ResultsPanel.tsx`, which owns the range-specific
  copy -- but `TradeList` itself now also renders a brief generic "No
  trades to show." fallback if `narrateTrades` ever returns `[]`,
  instead of a silently blank bordered box, in case a future caller
  (e.g. `IntradayTradeList` reusing this narration path, per the note
  above) doesn't carry `ResultsPanel`'s own empty-array guard.

## Importing `@hadiknowntrades/core`

Import it by its normal package specifier
(`from "@hadiknowntrades/core"`) - that works fine with `next build`'s
Turbopack bundler. If a _new_ `Module not found: Can't resolve
'./something.js'` error ever comes from inside `packages/core/src/...`
during a build, don't add a `.js` extension or a workaround here first -
see `packages/core/CLAUDE.md`'s "Internal imports" note: the fix belongs
in `packages/core`'s own relative-import style, not in how this app
imports the package.

## OG share card (issue #33): `/api/og/[range]`, Satori-rendered, ISR-cached

`src/app/api/og/[range]/route.tsx` renders a 1200x630 PNG share card
("$20 -> $48,203 - Max range") via Next's `ImageResponse` (`next/og`,
Satori under the hood -- JSX/CSS to PNG, no headless browser). Content
comes from `src/lib/og-card.ts`'s `buildOgCardContent` (pure, unit
tested); pixels come from `src/components/OgCard.tsx`'s `renderOgCard`
(split out specifically so it's callable directly, bypassing the route
entirely -- see "Live verification without headless-browser or real S3"
below).

- **Scope: only the "window" result model (5Y, MAX today) gets a card.**
  `buildOgCardContent` returns `null` for an "intraday-daily" result
  (1W/1M/3M/1Y, issue #28; 1W since issue #60) and the route turns that into a 404 -- not an
  oversight. That model has no single top-level `endingBalance` to
  headline (per-day results don't compound, see
  `packages/core/CLAUDE.md`), and picking which day's result a card
  would even feature is its own product decision. Deliberately keyed off
  the result's actual `model` field, not a hardcoded range list, so a
  future model/range change stays correct with no list to remember to
  update.
- **Caching: real ISR (`export const dynamic = "force-static"` +
  `export const revalidate = 86400`), not just a `Cache-Control` header
  like `/api/results` uses.** This was a deliberate choice over that
  route's own pattern: `/api/results` is fully dynamic per request
  (`force-dynamic`) and relies on downstream caches respecting its
  header, so its own handler still runs every request with nothing in
  front of it. This route's handler -- which does real Satori/PNG
  rendering, not a cheap JSON passthrough -- only runs once per range
  per 24h; verified live via `next start` + curl: `x-nextjs-cache: MISS`
  on the first request, `HIT` (no re-render) on the second. 24h matches
  the pipeline's nightly cadence, the same staleness tolerance
  `/api/results` already documents.
  - This route deliberately has **no `generateStaticParams`** -- adding
    one would make `next build` read from S3 at build time, which this
    sandboxed dev environment has no credentials for. Omitting it means
    every range is rendered (then cached) on its first real request
    instead, identically in production, and keeps `next build` fully
    offline-safe here (confirmed: `next build`'s route summary lists
    `/api/og/[range]` as `○ (Static)`, `/api/results` as `ƒ (Dynamic)`,
    exactly the intended split).
    - **Confirmed live (not just inferred from docs) that this isn't
      just a sandbox-convenience workaround -- it would be a real
      regression against this app's actual deployment split.** Adding
      `generateStaticParams` (returning all of `PRESET_RANGES`) plus
      `export const dynamicParams = false` and rebuilding: `next build`
      eagerly invoked this route's own `GET` once per range (confirmed
      with a temporary `console.error` inside the handler, printed
      during "Generating static pages"), baking in the
      `server_misconfigured` 500 (no `RESULTS_BUCKET` at build time) as
      each range's _initial_ cached entry -- and surprisingly also
      flipped the build summary from `○ (Static)` to `ƒ (Dynamic)` for
      this route. Since this app's real deploy topology has S3 access
      at _runtime_ (the deployed Lambda) but not at _build_ time (no
      `RESULTS_BUCKET` in CI/local builds -- see `infra/CLAUDE.md`'s env
      var contract note, which is pipeline-specific, not web-build-time),
      this would ship every deploy with a guaranteed-broken card for a
      full 24h post-deploy even though the real bucket is reachable the
      whole time. Reverted; this is why route param validation (below)
      is a plain in-handler check instead of Next's
      `generateStaticParams`/`dynamicParams` mechanism, despite that
      being the more textbook-idiomatic way to bound a dynamic segment.
  - **Known, accepted rough edge**: an _error_ response (misconfigured
    bucket, a range not published yet, corrupt data) gets cached by
    Next's Full Route Cache the same as a successful render, for the
    same 24h window -- there's no "don't cache non-2xx" carve-out for
    route handlers the way `fetch`'s own Data Cache has. Not engineered
    around (throwing instead of returning a `Response` isn't a
    documented, reliable escape hatch for ISR'd route handlers either) --
    these are rare, operational failure modes, and a stale error for up
    to a day is no worse than the staleness the rest of this
    precomputed-nightly app already accepts everywhere else.
  - **Route-param validation (found in code review, fixed)**: the raw
    `[range]` segment used to reach `getResultsResponse` (which
    case-folds via `parseRange`) with no earlier check at all. Combined
    with `force-static` + default `dynamicParams: true`, every distinct
    string under `[range]` -- a case variant of a valid range
    (`/api/og/max`), or pure garbage (`/api/og/not-a-range`) -- got its
    own separate Satori render (for case variants of a real range) or S3
    round-trip (for garbage), each becoming its own separately-cached
    24h entry for what's ultimately either duplicate or useless content.
    Fixed with `results-api.ts`'s `isCanonicalRange` (an _exact-case_
    membership check against `PRESET_RANGES`, deliberately not
    case-folding like `parseRange` does for `/api/results`' query
    param), called first thing in the route handler, before
    `getResultsResponse` or any rendering. Rejects with 404 +
    `Cache-Control: no-store`.
    - **Verified live (`next build` + `next start` + curl) exactly what
      this guard does and doesn't fix**: a case variant (`/api/og/max`)
      and garbage (`/api/og/not-a-range`) both now 404 immediately, with
      no S3 read and no Satori render -- confirmed by the response
      returning instantly with no `[api/results]` log line. **But** the
      guard does _not_ stop Next's Full Route Cache from still creating
      a cache entry for that exact rejected path -- `x-nextjs-cache` was
      `MISS` then `HIT` on a second request to the same rejected path,
      identical to a legitimate range. This is the same "no carve-out
      for non-2xx" limitation as the rough edge documented above, just
      for a 404 instead of a 5xx/502. Accepted: the fix's actual value is
      eliminating the _wasted expensive work_ (duplicate renders, S3
      round-trips) per rejected path, not eliminating cache-slot growth
      from someone enumerating garbage strings -- the only mechanism
      that would fully close that (`generateStaticParams` +
      `dynamicParams = false`) was tried and reverted for the reason
      above. Low real-world severity for this project (a small learning
      app, not a target for that kind of enumeration), not engineered
      around further.
  - This route reuses `getResultsResponse` (`/api/results`'s own logic)
    in-process rather than re-implementing S3-read-plus-validate a
    second time, so both routes can't drift on what counts as a
    valid/corrupt/not-yet-published result. Its error body is `{ error,
message }` JSON -- this route reads the `message` field back out
    rather than using the plain HTTP status line, since a
    `Response.json`-built response's `statusText` is an uninformative
    empty string in practice (verified live: curling an unsupported
    range returned `status=400` with an _empty_ `statusText`, only
    fixed by reading the JSON body's own `message` instead).
- **Live verification without a headless browser or real S3, without
  contaminating the committed diff**: this dev environment has neither
  (see this file's own "Headless-browser screenshot verification"
  note for the browser side; `RESULTS_BUCKET`/AWS credentials for the
  S3 side). Two throwaway techniques, both removed before committing:
  1. A small `@vitest-environment node`-tagged test file that imports
     `renderOgCard` directly and writes each fixture's PNG to disk for
     visual inspection -- no route, no server, no S3 at all. **Must
     override the environment to `node`**: this project's
     `vitest.config.mts` defaults every test to `jsdom` (see its own
     comment), and under jsdom, `next/og`'s PNG rasterization (resvg,
     WASM-based) fails outright with `Unsupported input` -- something
     about jsdom's globals confuses it. Plain `node` has no such issue;
     confirmed by toggling only the environment tag with everything
     else unchanged.
  2. For a true end-to-end HTTP check (through Next's real routing,
     `ImageResponse`'s content-type/status handling, and the ISR
     cache itself, not just the render function in isolation): a
     temporary in-memory `ResultReader` swapped in for `reader` when
     `RESULTS_BUCKET` is unset, `next build` + `next start` against a
     real local port, then `curl`. This is what produced the
     `x-nextjs-cache: MISS`/`HIT` evidence above. Reverted immediately
     after -- `git diff`/`git status` should show none of this in the
     final commit.
- **The astronomical-number (scientific-notation) formatting branch
  actually was live-verified against Satori (found missing in code
  review, then checked)**: the PR's original live verification covered
  a gain/modest-gain/loss, but never a MAX-range-scale result large
  enough to trip `format-currency.ts`'s `formatScientific` (the
  `×`/superscript-digit branch, past `SCIENTIFIC_THRESHOLD` = 1e15) --
  a real risk since Satori renders through its own bundled font, which
  might lack glyphs for `×` or the Unicode superscript digits
  (`¹`/`⁹`/etc.) and either render tofu or throw. Checked via technique
  1 above with `endingBalance = 4.2e19` (`startingCapital` fixed at
  `$20`, so this drives both the dollar figure _and_ the
  `endingBalance/startingCapital` multiplier well past the threshold):
  rendered cleanly as `$4.20×10¹⁹` and `(2.10×10¹⁸x)`, no tofu, no
  throw, no fallback needed. Satori's bundled font does have these
  glyphs -- `og-card.ts`/`OgCard.tsx` needed no changes for this case.

## localStorage pattern (issue #34, first use of browser storage in this app)

`lib/local-storage.ts` is the one place this app ever touches
`window.localStorage` directly - `readLocalStorage`/`writeLocalStorage`
wrap every call in a `typeof window === "undefined"` guard (no `window`
during any server render) plus a `try`/`catch` (a real read/write can
still throw even with `window` present - Safari's private-browsing mode
historically forced quota to 0 so every _write_ threw, and a user/
enterprise policy can disable site storage entirely, which throws on
_reads_ too). Both functions degrade to "acts as if nothing was ever
saved" (`null` / `false`) rather than propagating the exception - a
`localStorage`-backed feature should never be able to crash the page.

**Any future feature that wants localStorage should build on
`local-storage.ts`, not call `window.localStorage` itself**, and follow
the same two-layer shape `lib/daily-guess-storage.ts` establishes:

- A thin, feature-specific module (`daily-guess-storage.ts`) that owns
  one namespaced key prefix (`hikt:daily-guess:` here) and JSON-encodes/
  decodes its own small shape, treating a parse failure or a
  wrong-shaped value as "nothing stored" rather than throwing - a
  hand-edited or stale-format value in storage is exactly as untrusted
  as a value that was never written. Namespace your own prefix distinctly
  (e.g. `hikt:<feature>:`) so two features' keys can never collide;
  no coordination beyond that is needed between independent features.
- A `"use client"` hook (`use-daily-guess.ts`) that reads the current
  value once via a `useState` initializer and exposes a setter that
  writes through to storage before updating state - see that file for
  why reading storage directly in the initializer (not deferred to an
  effect the way `use-count-up.ts`/`should-celebrate.ts` defer their own
  `window.matchMedia` reads) is safe _only_ because it's used exclusively
  from `ResultsPanel`'s `success` branch, which never renders during SSR
  (see `use-results.ts`: the fetch state machine always starts
  `"loading"` and only reaches `"success"` after a client-only effect
  resolves) - reusing this shortcut from a tree that _can_ render on the
  server would reintroduce the hydration-mismatch risk those other hooks
  deliberately avoid.
- Keyed per some natural identifier the feature already has (a
  `(range, date)` pair here, not just the date - see below) via the same
  "adjust state during render when a prop changes" idiom `use-results.ts`
  established for range changes - a changed key must re-read storage
  fresh, not carry over the previous key's in-memory state.

## Daily guessing game (issue #34) -- REMOVED by issue #91, kept for history

**Superseded.** Issue #91 removed per-day guessing entirely -- every
individual day's `HeroStat`/worst-case stat/trade list now renders
unconditionally, no `DailyGuessForm`, no per-(range, date, mode) gate.
`DailyGuessForm.tsx`, `use-daily-guess.ts`, and `daily-guess-storage.ts`
are deleted. The page's only remaining guess-then-reveal control is
`WholeRangeBalance`, scoped to the whole range -- see "Whole-range-only
guessing (issue #91)" below for the current model. The section below
this note is left as-is as a historical record of what issue #34
originally shipped and why (its own reasoning about `(range, date,
mode)` keying still informed #91's simpler `(range, mode)` key) -- do
not treat anything below as describing current behavior.

`ResultsPanel.tsx`'s intraday-daily branch (see "Two result models"
above) gates `HeroStat`, `PortfolioChart`, and the trade list behind a
`DailyGuessForm` prompt ("what do you think $20 turned into on
{date}?") for whichever day is currently active - the window model
(5Y/MAX) is untouched, since a whole-window result barely changes day to
day and was never a meaningful thing to guess against (see the issue's
own rationale). `DayOverview` (issue #80; `DaySelector` before it) and
the day-picker row itself stay visible throughout - browsing to a
different day never requires guessing the day you're passing through,
only whichever day is currently selected when its content would
otherwise render.

- `guess === null` (`useDailyGuess`, backed by `daily-guess-storage.ts`)
  is the single gate: `null` renders `DailyGuessForm` in `HeroStat`'s
  slot in the top row; non-null renders the real `HeroStat` there
  instead, plus the methodology paragraph, a "You guessed $X" line, the
  chart, and the trade list, all below. Submitting a guess (or finding
  one already stored for this exact `(range, date)` pair on mount) is
  what causes `HeroStat` to mount for the first time - which is also,
  for free, the moment its existing count-up/celebration choreography
  fires (see the "Client-side animation" section above). No animation
  code needed touching for this feature at all: controlling _when_
  `HeroStat` mounts was enough to make the reveal line up with the
  guess.
- **Guesses are keyed by `(range, date)`, not just `date`** (a real bug
  found in code review, fixed) - `daily-guess-storage.ts`'s key includes
  `range` (`ResultsPanel` passes its own `range` prop into
  `useDailyGuess(range, activeDay.date)`), and both functions'
  signatures take `range` first. This matters because the _same_
  calendar date can carry a genuinely different result depending on
  which range you're viewing it under: 1M and 3M each layer their own
  granularity override (1-minute and 5-minute bars respectively) on the
  shared 60-minute base, merged independently per date (see
  `apps/pipeline/src/pipeline.ts`'s `buildIntradayResults`/
  `mergeDaysByGranularity`), so `endingBalance`/`trades`/
  `barIntervalMinutes` for one date can differ across 1M/3M/1Y. Since
  `selectedDay` resets to "most recent day" on a range switch (usually
  the same calendar date across ranges), a date-only key would let a
  guess made on the 1M tab silently satisfy the guess-gate for the same
  date on 3M/1Y too - skipping straight to a reveal the user never
  actually guessed against. Any future change to this feature must keep
  passing `range` through, not just `date`.
- **A key-format change needs a migration or a fallback read, not just a
  bump to `keyFor` (real bug, found in code review on issue #13's own
  PR, fixed)**: issue #13 added `mode` as a third key segment
  (`range:date:mode`, see "Long-only vs. long+short mode" below), but
  the first version of that change had no fallback for the pre-#13
  two-part key format -- a user who'd already guessed under the old
  `range:date` key would get silently re-prompted forever after deploy,
  since `getDailyGuess` only ever looked up the new three-part key and
  the old entry was permanently orphaned. Fixed: `getDailyGuess` falls
  back to the legacy two-part key specifically for `mode === "long"`
  (the one mode that existed before this issue -- `"long-short"` never
  had an old-format entry to fall back to) when the new-format key comes
  up empty. Worth remembering as a general lesson for this module:
  _any_ future key-format change here needs the same treatment, not just
  a `keyFor` edit.
- `DailyGuessForm` accepts any non-negative number, including exactly
  `0` (a plausible guess: "the trade went to zero") - validity is
  `draft.trim() !== "" && Number.isFinite(parsed) && parsed >= 0`, not
  just a truthy check on the parsed number, since `Number("")` coerces
  to `0` and would otherwise let an empty field silently submit as a
  valid zero guess. `daily-guess-storage.ts`'s `isStoredGuess` mirrors
  this same `>= 0` check (a gap found in code review, fixed) - a
  negative value can only reach storage via a hand-edited/corrupt entry
  (no real form submission produces one), and is treated the same as
  "never guessed" rather than rendering as a nonsense "You guessed
  -$5.00".
- Tests that assert on a day's actual revealed content
  (`ResultsPanel.test.tsx`'s "intraday-daily model" describe block) all
  submit a guess first via a shared `submitAnyGuess` helper - the
  original pre-#34 versions of several of these tests asserted on
  `HeroStat`/chart/trade-list content directly on render, which no
  longer holds now that content is gated. `localStorage` persists across
  tests within one file (one jsdom `window` per test file, not per test),
  so this describe block clears it in an `afterEach` to keep tests from
  leaking guesses into each other.

## Per-day breadth made visible: `DayOverview` (issue #80)

Before this issue, an intraday-daily range (1W/1M/3M/1Y) showed exactly
one day's <=`maxTradesPerDay` result at a time -- correct (every trading
day is independently computed, see `intraday-optimizer.ts`), but nothing
in the UI communicated that a range like 3M actually holds ~62 of these
independent results, easy to misread as "the whole window only produced
3 trades." `DayOverview.tsx` replaces `DaySelector.tsx` (deleted by this
issue, not kept alongside it -- two controls for picking the same day
would just compete) with a scrollable list of row buttons, one per
trading day in `data.days`, rendered above the existing single-day
drill-down in `ResultsPanel.tsx`'s intraday-daily branch.

- **The real design decision this issue's own Scope section flagged as
  requiring a documented call**: what happens to the existing
  guess-then-reveal gate (`DailyGuessForm`, issue #34) in the new view.
  Answer: **the single-day drill-down's guess gate is completely
  untouched** -- `DayOverview` doesn't bypass it, doesn't add a second
  gate, and doesn't reveal anything the gate already protects. Instead,
  each row's own **trade count** (`variant.trades.length`) is shown
  _ungated_, for every day, guessed or not, while each row's own
  **dollar ending balance** stays gated exactly like the drill-down
  below it -- `null` (a "Guess to reveal" placeholder) until
  `getDailyGuess(range, date, mode)` finds a stored guess for that
  specific day. The reasoning: a trade count carries none of the
  dollar-outcome information the guessing game actually tests ("what did
  $20 turn into"), so showing it for every day is exactly what makes the
  range's breadth visible at a glance without spoiling a single day's
  answer -- while the one thing worth protecting (the dollar figure)
  gets the identical per-`(range, date, mode)` protection every other
  guess-gated figure on the page already has.
- **Row click both picks a day and reveals what it is** -- one control
  doing what `DaySelector`'s bare `<select>` plus the guess gate used to
  take two ("pick a day," then separately, "guess before you see its
  trade count") for one of those two things (trade count). Clicking an
  unguessed day's row still routes to that day's own fresh
  `DailyGuessForm` for its dollar figure, same as picking it via the old
  `DaySelector` did.
- `<ul>`/`<li>` of full-width `<button>` rows, not a `<table>` -- unlike
  `PortfolioChart.tsx`'s own read-only `ChartDataTable` disclosure
  ("View chart data as a table"), every row here is a primary
  interactive control, and a `<button>` isn't a valid direct child of
  `<tr>` per the HTML spec. See `DayOverview.tsx`'s own doc comment for
  the full reasoning.
- `ResultsPanel.tsx`'s `dayOverviewRows` calls `daily-guess-storage.ts`'s
  exported `getDailyGuess` directly (not through the `useDailyGuess`
  hook, which only ever tracks one `(range, date, mode)` triple at a
  time -- the one currently active below) once per day in `data.days`.
  **A top-level `useMemo`, not a plain computation inside the
  intraday-daily render branch (real bug, found in `high` code review on
  this issue's own PR, fixed)**: the first version recomputed this --
  up to ~252 `localStorage.getItem` + `JSON.parse` calls for 1Y -- on
  _every_ `ResultsPanel` render, contradicting this very section's own
  original "not on every keystroke" claim; in reality every successfully-
  parsed `StartingCapitalInput` keystroke changes the `startingCapital`
  prop and re-renders the whole panel, which re-ran the full per-day
  scan each time. Hoisted to a top-level `useMemo` (unconditional, per
  the Rules of Hooks, alongside `activeDay`/`points`) with dependency
  array `[state, activeDay, startingCapital, mode, range, guess]` fixes
  this for real: it now only recomputes on an actual fetch/day/mode/
  capital/range/guess change, not on every render. **`guess` (from
  `useDailyGuess`, the _active_ day's own guess) is a deliberate
  dependency despite never being read in the memo's body** -- each row
  re-derives its own guessed status independently via `getDailyGuess`,
  but submitting a guess changes only `guess`, none of the other five
  dependencies, so without it in the array this memo would keep
  returning the stale pre-guess rows (the just-revealed day's row stuck
  on "Guess to reveal") until some unrelated dependency happened to
  change too -- an `eslint-disable-next-line react-hooks/exhaustive-deps`
  on that line documents why, the same precedented pattern
  `use-count-up.ts`/`use-chart-tap-hint.ts`/
  `use-hydrated-local-storage-state.ts` already use for an intentional
  hook-dependency deviation.
- **The selected row scrolls into view on mount and on every selection
  change (real bug, found in the same `high` code review, fixed)**: the
  list is height-capped (`max-h-72 overflow-y-auto`) and the selected
  day defaults to the _most recent_ one (`ResultsPanel`'s own fallback)
  -- the last entry in this ascending-date list. Without an explicit
  scroll, the list always rendered scrolled to the top on load for any
  range with more days than fit in ~288px (1M/3M/1Y), leaving the
  actually-active row below the fold -- defeating the "at a glance"
  point of this whole component. Fixed with a `selectedRef` attached
  only to the currently-selected row's `<button>` and a `useEffect`
  keyed on `selected` calling `scrollIntoView({ block: "nearest",
behavior })`. Guarded two ways, both matching this app's established
  conventions for a browser API jsdom doesn't fully implement (see
  `prefers-reduced-motion.ts`'s own `matchMedia` guard): a
  `typeof element.scrollIntoView === "function"` check -- confirmed live
  against the actual jsdom install that it has **no** `scrollIntoView`
  at all, not even a no-op stub, unlike `getBoundingClientRect` (see
  "Chart pointer interaction" above); and `behavior: "auto"` instead of
  `"smooth"` under `prefersReducedMotion()` -- still scrolls (this is
  functionally necessary, not decorative motion worth skipping
  entirely, unlike `.chart-tap-hint-pulse`'s own reduced-motion
  treatment), just without the animation. `DayOverview.test.tsx`
  regression-tests all of this directly (mount, a `selected` change, no
  redundant scroll on an unrelated re-render, both motion branches, and
  that the component never throws under jsdom's real scrollIntoView-less
  default) by assigning a `vi.fn()` onto `Element.prototype.scrollIntoView`
  per test and reading `.mock.instances[0]` to confirm which row's
  button it was actually called on.
- No `.surface-card` shadow elevation on `DayOverview`'s list container
  -- same "control chrome, not a content card" bucket issue #77's
  surface-elevation pass put `DaySelector`'s own `<select>` in (see
  `globals.css`'s own comment), despite this list showing more
  information per row than a bare `<select>` ever did.
- **Verified live against a real, fresh local pipeline run** (not just
  fixtures), the same throwaway technique documented in this issue's own
  Background section: `apps/pipeline/src/local-run.ts` (real
  `runPipeline`, a reduced ~20-ticker universe for speed, real Yahoo
  network calls, writing to local disk) + `apps/web/src/lib/local-file-
result-reader.ts` (a `ResultReader` reading that local directory,
  swapped in via a `LOCAL_RESULTS_DIR` env var in
  `app/api/results/route.ts`) + `next dev` + a headless-Chromium
  screenshot (see "Headless-browser screenshot verification" above).
  Confirmed on 3M (62 real trading days, real per-day trade counts):
  every day's row shows its own trade count immediately; every row's
  dollar figure reads "Guess to reveal" until guessed; submitting a
  guess for the active day reveals only that row's balance, leaving
  every other unguessed day's placeholder intact; clicking an earlier,
  unguessed day's row both highlights it (`aria-current`) and re-prompts
  a fresh `DailyGuessForm` scoped to that day. All scaffolding (the two
  files above, the route.ts env-var branch, a temporary `tsx`/
  `playwright` devDependency) was reverted before the PR's final commit,
  per this same convention.

## Worst-case contrast stat (issue #31)

`WorstCaseStat.tsx` is a small, deliberately de-emphasized sibling to
`HeroStat` -- reuses `formatHeroCurrency`/`formatMultiplier` as-is, no
count-up animation, no `CelebrationBurst`. Two product decisions
confirmed by the human user before implementation (both were left open
in `docs/plans/issue-31-plan.md` as judgment calls for the
implementer/reviewer):

- **Fixed muted tone (`--text-muted`), not dynamic gain/loss coloring**
  -- unlike `HeroStat`'s multiplier badge (`--status-good`/
  `--status-critical`). This is a secondary contrast stat, not meant to
  compete visually with the hero figure or read as an alert; a fixed
  tone also sidesteps the rare "worst case is still a net gain" edge
  case (see `optimizeWorstTrades`'s own doc comment,
  `packages/core/src/optimizer.ts`) ever rendering in celebratory green.
- **Gated behind the same `guess !== null` reveal condition** as the
  rest of a day's content in the intraday-daily model (issue #34) --
  reuses that existing gate structurally (rendered inside the same
  ternary's non-null branch in `ResultsPanel.tsx`, right alongside
  `HeroStat`) rather than adding a second, parallel condition. Showing
  the worst-case figure before the guess is submitted would partially
  spoil "the real answer" the guessing game is built around. The window
  model (5Y/MAX) has no guessing game at all, so its `WorstCaseStat`
  renders ungated, immediately next to `HeroStat`.

Screenshot-verified (same throwaway-debug-route technique documented
above, no local `RESULTS_BUCKET`/AWS creds) in both light and dark themes
across four scenarios -- a typical gain, Max-range astronomical scale, the
rare "worst case is still a net gain" edge case, and an empty/no-trades
day -- confirming the stat reads as smaller and visually muted relative
to `HeroStat` in every case, per the acceptance criteria's "a clear
contrast... not competing for attention."

## Configurable starting capital (issue #15)

A pure-frontend feature, no `packages/core`/`apps/pipeline` change --
`optimizer.ts`'s `endingBalance = startingCapital * finalMultiplier`,
and `finalMultiplier` is derived entirely from price ratios, never from
`startingCapital` itself, so the optimal trade sequence and its
multiplier are identical regardless of what a user enters; only the
displayed dollar amounts scale linearly. Confirmed by reading
`optimizer.ts` end to end before scoping this issue this way, not
assumed.

- **`lib/rescale-starting-capital.ts`'s `rescaleFromStartingCapital`**
  is the one general-purpose rescale (`value * (to / from)`), but the
  portfolio chart doesn't actually call it: `derivePortfolioSeries`/
  `deriveIntradayPortfolioSeries` (`portfolio-series.ts`) are already
  pure linear scalings of whatever `startingCapital` they're handed, so
  `ResultsPanel` gets a correctly-rescaled chart for free by just
  passing the user's chosen capital into those functions directly
  instead of the precomputed one -- no second rescale call needed
  there. See `portfolio-series.test.ts`'s own rescaling tests for that
  equivalence spelled out explicitly.
- **`HeroStat`'s rescale is deliberately layered on top of, not fed
  into, `useCountUp`/`shouldCelebrate`.** A new `displayStartingCapital`
  prop (default `startingCapital`, a no-op ratio of 1) scales the
  already-tweened `animatedEndingBalance` and the final `endingBalance`
  for display only; `startingCapital`/`endingBalance` themselves are
  untouched and keep driving the count-up tween and the gain check
  exactly as before. The alternative -- feeding the user's chosen
  capital straight into `startingCapital`/`endingBalance` -- would
  either leave the _visible_ (non-sr-only) figure frozen stale after a
  capital edit (`useCountUp` is deliberately mount-only, see issue #35's
  own note above, so a prop change alone never re-tweens it) or require
  keying `HeroStat` on the capital too, which would replay the 1.2s
  reveal animation and the celebration burst on every edit -- neither
  acceptable for what should be an instant rescale.
- **`use-starting-capital.ts` persists to localStorage -- this app's
  first use of browser storage** (`"hikt:startingCapital"`), going
  through `lib/local-storage.ts`'s `readLocalStorage`/`writeLocalStorage`
  rather than calling `window.localStorage` directly -- see this file's
  own "localStorage pattern" section above, which #34 (built after this
  issue's original implementation, then rebased past it) established as
  the one place this app should ever touch `window.localStorage`
  directly. **This issue's own first draft got this wrong** (called
  `window.localStorage.getItem`/`setItem` straight from
  `use-starting-capital.ts`, duplicating the try/catch/SSR-guard logic)
  -- caught in code review during a rebase past #34 and fixed to build on
  the shared helper instead, per that section's own instruction for any
  future localStorage feature. `#34`'s own key namespacing note still
  applies unchanged: `"hikt:startingCapital"` and `daily-guess-storage.ts`'s
  `"hikt:daily-guess:"` prefix don't collide, no coordination needed.
- **Hydration safety for the localStorage read (the same tradeoff
  `use-count-up.ts`/`prefers-reduced-motion.ts` already accept for
  `matchMedia`, see above):** the hook always starts at
  `DEFAULT_STARTING_CAPITAL` (20) on every render including the first
  client render during hydration, correcting to whatever's actually
  stored only after mount -- reading `localStorage` during render would
  make a returning visitor's client-hydration render disagree with the
  server-rendered HTML. The one wrinkle here versus the `matchMedia`
  precedent: the natural "read storage, then setState" shape at the top
  of a mount effect trips `react-hooks/set-state-in-effect` (a direct,
  unconditional-looking `setState` as the effect's first statement) --
  fixed by deferring the read+setState into a `queueMicrotask` callback
  instead of calling it as the effect's own first statement, mirroring
  how `use-count-up.ts` folds its own conditional `setValue` into the
  `requestAnimationFrame` callback rather than calling it synchronously
  in the effect body.
- **`StartingCapitalInput` needed the same lint fix a second time, for
  a different reason, and the fix that worked wasn't a `useEffect` at
  all.** It keeps a local `draft` string (so the user can freely
  clear/retype without every keystroke being clamped), but a real bug
  surfaced only by live-reloading the page (not the unit tests): the
  draft was seeded once via `useState(String(value))` at mount, so when
  `use-starting-capital.ts`'s post-mount hydration correction changed
  the committed `value` out from under it, the field kept showing its
  stale initial text forever. The fix is **not** a
  `useEffect(() => setDraft(String(value)), [value])` -- that shape
  trips `react-hooks/set-state-in-effect` too, for the more usual reason
  this rule exists (mirroring a prop into state is exactly what the
  rule wants done during render instead). The actual fix: a
  `trackedValue` companion state and an `if (value !== trackedValue)`
  check evaluated during render, the identical "adjusting state when a
  prop changes" shape `use-results.ts`'s own `trackedRange` already
  uses -- re-syncing `draft` this way doesn't fight free typing of a
  blank/invalid mid-edit draft, since `value` only actually changes when
  `onChange` fires (never on every keystroke).
- **That `trackedValue` resync had a second, more subtle bug of its own
  (found in `high` code review, fixed): it couldn't tell "`value` changed
  because I just committed my own edit" apart from "`value` changed for
  some genuinely external reason," and unconditionally resynced `draft`
  in both cases.** Concretely: typing `"020"` character-by-character
  commits `onChange(2)` after the second character (`parseStartingCapital("02")`
  parses to `2`), which round-trips back into this controlled component's
  `value` prop on the very next render -- and the old code snapped
  `draft` from `"02"` back to `"2"` right then, silently eating the
  leading zero the user had just typed, on nearly every keystroke that
  happened to change the _parsed_ number, not just some rare edge case.
  Fixed with a second companion state, `lastEmitted` (the parsed value
  from this component's own most recent `onChange` call, set in
  `handleChange` the same event-handler tick as `onChange` itself, so
  React's automatic batching guarantees it's already updated by the time
  the resulting `value`-prop-changed render runs) -- the `trackedValue`
  branch only actually calls `setDraft` when `value !== lastEmitted`,
  i.e. only for a value change this input didn't itself just cause.
  **Deliberately plain `useState`, not a `useRef`**, even though a ref
  would also happen to work given the batching guarantee above: the
  `react-hooks/refs` lint (a real one, not hypothetical -- it fired
  immediately when this was first tried as a ref) flags reading
  `ref.current` during render at all, since refs are documented as not
  meant to drive rendering output; state doesn't have that restriction.
  A regression test for the exact `"020"` scenario lives in
  `StartingCapitalInput.test.tsx`, driven by `fireEvent.change` per
  keystroke rather than `userEvent.type` -- `userEvent.type` has its own
  documented quirks simulating text entry into `<input type="number">`
  in jsdom that happened to paper over this exact bug, so it doesn't
  reproduce it even on the unfixed code.
- Verified live (not just unit tests) via a throwaway route per the
  "Screenshotting a component locally" convention above, in both
  directions: typing a large starting capital (`$1,000,000`) against a
  Max-range-scale multiplier renders `$1M -> $35.8T`, correctly through
  the existing large-number formatting ladder rather than overflowing
  or breaking layout; and a full page reload after setting a non-default
  value correctly restores both the input field's own text and the
  rescaled hero/chart figures from localStorage -- this second check is
  exactly what caught the `StartingCapitalInput` staleness bug above,
  which no unit test happened to exercise.
- **Every dollar-figure-displaying component `ResultsPanel` renders must
  be threaded the same `effectiveStartingCapital` (`startingCapital ??
<precomputed>`) local variable it already computes for `HeroStat`/
  `StartingCapitalInput`/the chart's `points` -- never the raw
  precomputed `data.startingCapital`/`activeDay.startingCapital`
  directly.** This was gotten wrong twice by real merges/rebases past
  this issue, not just once, both caught in code review rather than by a
  test (the tests that would have caught them didn't exist yet at the
  time):
  - `TradeList` (issue #32's prose narration, landed after this issue's
    original implementation): the merge auto-resolved with **no
    conflict** and silently left `<TradeList trades={data.trades}
startingCapital={data.startingCapital} />` -- the hero stat above it
    showed rescaled figures while the trade narration below it still
    said "turning your $20.00 into ...". No-conflict auto-merges are
    exactly the case to double check by hand after any rebase that
    crosses this issue, not just the hunks git actually flags.
  - `DailyGuessForm` (issue #34's guess-before-reveal prompt, also landed
    after this issue's original implementation): its prompt read
    `activeDay.startingCapital` directly. Unlike `TradeList` above, this
    _was_ a real conflicting hunk (both issues touch the same top row of
    the intraday branch), but resolving a conflict by picking a side (or
    naively unioning both) doesn't re-derive the correct value on its
    own -- the fix still had to explicitly swap in
    `effectiveStartingCapital`.
  - Regression tests for both now live in `ResultsPanel.test.tsx`
    (rendering with a non-default `startingCapital` prop and asserting
    the rescaled figure appears in `TradeList`'s narration /
    `DailyGuessForm`'s prompt, and that the raw `$20.00` does not) --
    the kind of test that would have caught either bug at merge time.
- **A third `effectiveStartingCapital` miss, this time in the "You
  guessed $X" line itself (found in a second-round `high` code review,
  fixed)**: `ResultsPanel.tsx`'s intraday-daily branch renders that line
  from `useDailyGuess`'s `guess` -- the raw dollar amount the user typed
  into `DailyGuessForm` -- which used to render unrescaled even after a
  post-reveal starting-capital edit, while `HeroStat`/the chart right
  next to it rescaled live via the same `effectiveStartingCapital` this
  file already threads everywhere else. Unlike the two misses above, the
  fix isn't just "swap in `effectiveStartingCapital`" -- rescaling `guess`
  correctly needs to know _what starting capital it was guessed against_,
  which nothing captured before this fix. `daily-guess-storage.ts`'s
  `StoredGuess` now carries `startingCapital` alongside `guess` (and
  `saveDailyGuess`/`useDailyGuess`'s `submitGuess` both take an explicit
  `startingCapital` argument -- `ResultsPanel.tsx` passes its own
  `effectiveStartingCapital` at the moment of submission, the same value
  `DailyGuessForm`'s prompt was showing), and the display line rescales
  via `rescaleFromStartingCapital(guess, guessStartingCapital,
effectiveStartingCapital)` -- the same general-purpose helper this
  file's own top section already documents, applied to a dollar figure
  that (unlike the chart/TradeList/HeroStat) genuinely needs its _origin_
  capital tracked explicitly rather than always being re-derived fresh
  from the current one. Regression test in `ResultsPanel.test.tsx`:
  submit a guess under one starting capital, `rerender` with a different
  one, assert the guessed figure rescales (and the stale unrescaled
  figure is gone) the same way `HeroStat` already does.
- **A microtask-window race in `use-starting-capital.ts`'s mount-time
  hydration read (found in the same review pass, fixed)**: the "hydrate
  from storage after mount" correction (see the hydration-safety
  paragraph above) is deferred into a `queueMicrotask` callback to dodge
  `react-hooks/set-state-in-effect`, which leaves a window between mount
  and that microtask actually running where nothing stopped a real
  `setStartingCapital` call from landing -- and, without a guard, the
  microtask would still apply the stale persisted value on top of it
  once it finally ran, silently discarding the update with no error.
  Fixed with a `userSetRef` (`useRef(false)`, flipped `true` synchronously
  inside `setStartingCapital` before its own `setStartingCapitalState`
  call) that the microtask checks before applying the stored value,
  bailing out if a real update already happened. Deliberately a `useRef`
  here, not a second `useState` the way `StartingCapitalInput`'s own
  `trackedValue`/`lastEmitted` resync (documented above) uses -- the
  distinction that section's own paragraph draws still holds: a ref is
  only unsafe for state that's _read during render_ (`react-hooks/refs`
  really does flag that, confirmed there), and this ref is read
  exclusively inside the microtask callback, never during render.
  **Honest note on reproducing this as a test**: under this app's actual
  `local-storage.ts` backing, the write from an in-window
  `setStartingCapital` call is synchronous, so by the time the deferred
  microtask actually reads storage, it normally already sees that same
  fresh value -- no observable clobber, coincidentally, since read and
  write share one synchronous, always-fresh backing store. The regression
  test in `use-starting-capital.test.ts` forces the race window open
  anyway by mocking `readLocalStorage` to keep returning a fixed stale
  value regardless of what's actually written (standing in for a future
  storage backing where a read can genuinely lag behind a very recent
  write -- a cache, a network-backed store), confirmed to fail without
  the `userSetRef` guard and pass with it.

### `rescaleFromStartingCapital`'s per-day pattern silently cancels out per-day capital chaining (issue #84 -- shipped; found while planning, confirmed against real chained data at implementation time)

Worth knowing before reusing the established
`rescaleFromStartingCapital(dayEndingBalance, day.startingCapital,
effectiveStartingCapital)` pattern (`HeroStat`, `WorstCaseStat`,
`DayOverview`'s per-row figure all call it this way) anywhere a day's own
`startingCapital` varies from day to day (true since issue #84 shipped
per-track chaining, `apps/pipeline`'s `chainStartingCapital` -- day N's
`startingCapital` is day N-1's own `endingBalance`, not a flat constant):
this call shape is `value * (to / from)` where `value` is always `from *
someRatio` for that same day -- algebraically, `from` cancels out of
the result completely, leaving `to * someRatio`, **regardless of what
`from` actually equals**. That's exactly why every existing per-day call
site keeps working correctly even though a day's own `startingCapital`
now varies: they all still show "as if this one day started fresh at
`$[to]`," never the day's _actual_ absolute dollar amount. Fine (even
desirable) for a per-day, ratio-based display that's meant to be
capital-invariant either way -- but a real trap for the one display this
issue _does_ need to show a day range's _true_ chained absolute figure:
`WholeRangeBalance.tsx`'s headline deliberately does NOT reuse this
per-day call shape (see its own doc comment, and `ResultsPanel.tsx`'s own
`wholeRangeFinalBalance` computation) -- it rescales once from the
range's own root capital (`data.startingCapital`, identical to
`data.days[0].startingCapital` by the chaining design's own construction)
to the final chained day's own ending balance for whichever `mode`
currently selects, never from a specific day's own (chained,
day-varying) `startingCapital`.

**Two real call sites _did_ need a fix once chaining shipped, caught in
the plan's own independent review before code was written, then verified
against real fixtures at implementation time**: `HeroAndWorstCase`'s
`WorstCaseStat` rescale (both modes) and `HeroStat`/`dayOverviewRows`
under long+short mode were all rescaling one track's `endingBalance` from
a _different_ track's `startingCapital` (`activeDay.startingCapital`, the
long-only track's, reused unconditionally for every track) -- harmless
pre-chaining (every track shared one flat value) but silently wrong once
tracks diverge. Fixed by threading each track's own `startingCapital`
(now a real field on `IntradayWorstCaseResult`/`IntradayLongShortResult`,
see `packages/core/CLAUDE.md`) through instead of reusing
`activeDay.startingCapital` everywhere -- see `HeroAndWorstCaseProps`' own
`worstCaseStartingCapital` field and `ResultsPanel.tsx`'s
`dayStartingCapital`/`dayWorstCaseStartingCapital` locals for the exact
fix. **This is the third time this exact class of mistake -- a component
reading the wrong-track/un-threaded field instead of the correct one --
has bitten this codebase**, after the two `effectiveStartingCapital`
misses documented above (issue #15's `TradeList`/`DailyGuessForm`, and
the "You guessed $X" line); worth treating any future per-track/per-day
field addition with the same suspicion.

## Buy-and-hold (SPY) comparison stat (issue #12)

`components/BenchmarkStat.tsx` is a single prose `<p>`, not a
`HeroAndWorstCase`-style wrapper -- it's one leaf render per branch (like
`PortfolioChart`), not multiple children sharing duplicated layout
markup, so there's no wrapper to factor out the way `HeroAndWorstCase`
(issue #31's own code-review cleanup) was for `HeroStat`+`WorstCaseStat`.
Placed directly below the existing methodology `<p>` in both of
`ResultsPanel`'s render branches (window and intraday-daily) -- confirmed
with a real screenshot (both branches, both themes, per this file's own
"Headless-browser screenshot verification" section) that it reads as
secondary context rather than competing with the hero figures.

- **Reuses `effectiveStartingCapital`/`rescaleFromStartingCapital`
  (issue #15)**, the exact same pattern `HeroStat`'s
  `displayStartingCapital` prop already established -- no second rescale
  mechanism. `startingCapital` passed to `BenchmarkStat` is the
  precomputed result's own value (`data.startingCapital`, the level
  `benchmark.endingBalance` was actually computed relative to), not
  `activeDay.startingCapital` in the intraday-daily branch -- both are
  numerically identical in practice (same pipeline constant), but
  `data.startingCapital` is the field the benchmark was actually
  attached alongside.
- **`rangeLabel` prop disambiguates the intraday-daily model's real
  juxtaposition**: `BenchmarkStat` is a whole-_range_ figure, but
  everything else in that branch (`HeroStat`, the chart, the trade list)
  is scoped to whichever single day is selected. Passing
  `rangeLabel={RANGE_COPY[range]}` only in that branch renders "Buying
  and holding SPY **over the past month** instead..."; the window branch
  omits the prop (that whole view is already range-scoped, and the
  methodology paragraph right above already names the range, so the
  disambiguation would be redundant there).
- **Gated behind the same guess-then-reveal condition as the rest of a
  day's content (issue #34)** in the intraday-daily branch -- it sits
  inside the `guess !== null && (...)` fragment, between the methodology
  paragraph and the "You guessed $X" line. Showing it pre-guess would
  partially spoil the real answer the guessing game is built around,
  same reasoning `WorstCaseStat` is already gated there.
- **`null` renders nothing at all** (`BenchmarkStat` returns `null`
  early) -- consistent with this app's general silent-graceful-degrade
  posture (e.g. the OG card route's model-based 404), not a visible
  "unavailable" placeholder. A real, deliberate product choice, not an
  oversight -- flagged as one in the original plan's own open questions,
  kept as-is here.
- No gain/loss coloring on the figures, unlike `HeroStat`'s multiplier
  badge or `TradeRow`'s per-trade return badge -- deliberate simplicity:
  this is a comparison figure, not itself a "did the optimizer win"
  signal.

## Long-only vs. long+short mode (issue #13)

`lib/mode.ts` owns `Mode` (`"long" | "long-short"`) and `parseMode` --
same shape as `results-api.ts`'s own `parseRange`, but deliberately its
own module rather than folded into that file, since mode is a pure
frontend display concept with no schema/API meaning of its own (the
pipeline always computes and stores both variants; the frontend just
picks which one to show). `ResultsPage.tsx` owns the selected mode as URL
state (`?mode=long|long-short`, case-insensitive on read, same pattern
`?range=`/`?day=` already use there) via `ModeToggle.tsx` (a second pill
toggle next to `RangeSelector`, same controlled-component shape) --
**not** a localStorage-persisted preference like
`use-starting-capital.ts` -- confirmed by the human user as a genuine
product decision, not left to guesswork: "which trade set is being
shown" is core, shareable content state (the same category `?range=`/
`?day=` occupy), not a personal display preference like starting
capital. A missing/unrecognized `?mode=` falls back to `"long"`
(`DEFAULT_MODE`), so an existing shared link with no `mode` param keeps
showing exactly what it showed before this toggle existed.

- **`ResultsPanel.tsx`'s `selectVariant` is the single place "which
  variant to read" gets decided** -- every dollar-figure/trade-list
  consumer (`HeroAndWorstCase`, `PortfolioChart` via
  `derivePortfolioSeries`/`deriveIntradayPortfolioSeries`,
  `TradeList`/`IntradayTradeList`) is threaded its result instead of
  reading the raw top-level `endingBalance`/`trades`/`worstCase` fields
  directly. This mirrors the exact shape of mistake this file's own
  "Configurable starting capital" section already documents happening
  _twice_ for `effectiveStartingCapital` (issue #15) -- a component
  quietly reading the un-threaded/wrong-variant field instead of the
  selected one, caught only in code review rather than by a test that
  didn't exist yet at the time. `ResultsPanel.test.tsx`'s own "mode
  (issue #13)" describe block is the regression-test-up-front version of
  that lesson, applied before the equivalent bug had a chance to ship
  once for this feature (render with `mode="long-short"` and assert the
  `longShort` variant's figures/tickers appear, the long-only ones
  don't). **Code review follow-up, fixed**: this issue's own first draft
  still built the `{endingBalance, trades, worstCase}` object passed into
  `selectVariant` independently at all four call sites -- exactly the
  duplication-drift risk this doc comment already names, reintroduced by
  the very feature that documents it. Fixed by passing the real result
  object (`data`/`activeDay`/their own `longShort` field) straight
  through instead: `WindowResult`/`IntradayDayResult`/`LongShortResult`/
  `IntradayLongShortResult` already have `endingBalance`/`trades`/
  `worstCase` as own top-level fields with these exact names and shapes,
  so they satisfy `selectVariant`'s `Variant<T>` parameter structurally
  with no intermediate object to keep in sync at all (TypeScript's
  excess-property check only applies to fresh object literals, not
  existing typed variables) -- a stronger fix than "extract one shared
  helper," since there's no construction step left to forget to call.
- **`HeroStat`'s `heroKey` is keyed on mode too, not just range/day** --
  switching modes surfaces a genuinely different trade sequence (a new
  `endingBalance`, potentially a completely different set of tickers),
  much closer to a range/day switch than to a `startingCapital` edit (an
  instant rescale of the _same_ trades, deliberately _not_ keyed, per
  this file's own "Configurable starting capital" section) -- so a mode
  switch remounts `HeroStat` and replays its reveal animation, the same
  as switching range or day does.
- **`daily-guess-storage.ts`'s guess key extends to `(range, date,
mode)`, not just `(range, date)`** -- the identical argument this
  file's own "Daily guessing game" section already makes for why `range`
  alone wasn't enough (the same calendar date can carry a genuinely
  different result depending on range) applies one axis further: the
  same `(range, date)` can now carry a genuinely different
  `endingBalance` depending on mode. Without this, a guess submitted
  under `mode=long` would incorrectly satisfy the guess-gate for the same
  `(range, date)` under `mode=long-short` too, skipping straight to a
  reveal the user never actually guessed against. `useDailyGuess` gained
  a required third `mode` parameter (not optional/defaulted, same
  "no silent fallback by omission" reasoning `trade-math.ts`'s own
  `direction` parameter uses below) and re-checks storage fresh whenever
  any of `range`/`date`/`mode` changes, via the same "adjust state during
  render when a prop changes" idiom this hook already used for
  range/date.
- **`lib/trade-math.ts`'s `computeTradeReturn`/`compoundBalance` both
  gained a required `direction` parameter** (not optional/defaulted --
  same reasoning `InvalidTradePriceError` already established for bad
  prices: a silent long-only fallback by omission would be exactly the
  kind of correctness bug this file's own error-throwing convention
  guards against). A short's math mirrors `optimizer.ts`'s own
  reciprocal-price payoff exactly (`openPrice/closePrice` instead of
  `closePrice/openPrice`), so a rendered trade's narrated return/balance
  always matches what the optimizer itself used to compound
  `endingBalance` -- no drift between two implementations of the same
  math, the same property this module's own header comment already
  documents as the reason it exists.
- **`lib/narrate-trades.ts`/`TradeRow.tsx` both gained direction-aware
  verb pairs**: "bought"/"sold" (narration) or "Buy"/"Sell" (`TradeRow`)
  for a long, "shorted"/"covered" or "Short"/"Cover" for a short --
  standard finance terminology. `TradeRow`'s `buyLabel`/`sellLabel` props
  renamed to `openLabel`/`closeLabel` to match the schema rename below.
  **Code review follow-up, fixed**: this issue's own first draft
  hand-rolled this exact verb-pair mapping independently in _four_
  places -- `TradeRow.tsx`'s own `verbsFor`, `narrate-trades.ts`'s own
  `verbsFor`, and `PortfolioChart.tsx`'s `eventLabelVerb`/
  `eventTooltipVerb` -- two of which had already started commenting
  "same wording" without actually sharing any code. Extracted into
  `trade-math.ts`'s `tradeVerbs` (the capitalized "Buy"/"Sell" pair) and
  `tradeVerbsPast` (the lowercase "bought"/"sold" pair) -- the same
  module this codebase's own header comment already says fixed exactly
  this class of drift once for the return/balance math
  (`computeTradeReturn`/`compoundBalance`); all four call sites now call
  one of these two instead of re-deriving the mapping.
- **`lib/portfolio-series.ts`'s `PortfolioEvent.type` generalizes from
  `"buy" | "sell"` to `"open" | "close"`, plus a new `direction` field**
  -- a short's "open" event (no value jump, same as a long's "buy") and
  "close" event (the point value actually jumps, same as a long's
  "sell") stay structurally analogous to the existing long annotations,
  just relabeled and direction-tagged. `appendTradeSteps`'s
  `compoundBalance` call threads `direction` through, same reasoning as
  `trade-math.ts` above.
- **`PortfolioChart.tsx` branches on the event type in _five_ places, not
  four** (a real miscount corrected during this issue's implementation,
  not just a rename pass): the marker's above/below positioning logic
  (`event.type === "open"`), the marker `<g>` key (interpolates
  `event.type`, now `"open"`/`"close"` instead of `"buy"`/`"sell"`), the
  marker's own label text (now `eventLabelVerb(event)`, "Buy"/"Short" or
  "Sell"/"Cover"), the hover tooltip's verb (`eventTooltipVerb(event)`,
  "bought"/"shorted" or "sold"/"covered"), and the accessible data
  table's row text (`eventLabelVerb` again). Any future audit of this
  component's own direction-aware branches should expect five sites, not
  four.
- **OG share card (`/api/og/[range]`, issue #33) deliberately stays
  long-only-only** -- `og-card.ts`/`OgCard.tsx` needed zero changes for
  this issue (neither file touches `Trade`'s renamed fields or
  `longShort` at all, only `endingBalance`/`startingCapital`/`dataAsOf`,
  none of which changed meaning). A `mode`-aware share card would double
  its own cached-variant matrix (6 ranges -> 12 range x mode combos) for
  a feature this issue's own scope never asked for -- left as a possible
  follow-up issue, not silently bundled in here.
- **Live-verified** (real S&P 500 data, full 503-ticker universe, no S3
  write): both the window path's 5 ranges and the intraday path's 251
  real trading days produced 0 invariant violations, and real short
  trades appeared in every one of the 5 window ranges' `longShort`
  fields and in 218 of the 251 intraday days -- see
  `packages/core/CLAUDE.md`'s "Short-selling mode" section for the full
  numbers (this file's own consumers were verified via the full
  `apps/web` test suite plus a manual read of the rendered fixtures in
  `ResultsPanel.test.tsx`'s "mode" describe block, not a live pipeline
  write -- the schema-5 rollout itself is a real-AWS action gated on the
  user's go-ahead, same as every prior schema bump, and not yet
  performed as of this issue's implementation).

## Custom start-date anchor picker (issue #11, day-precision calendar since issue #75)

`GET /api/results?anchor=YYYY-MM-DD` is the same route as `?range=...`
(`app/api/results/route.ts` branches on which query param is present),
not a second route file -- see `docs/plans/issue-11-plan.md`'s section
1.5 for why this differs from the (deferred) live-compute design's own
recommendation of a genuinely separate route: once a custom anchor is
_also_ just a precomputed S3 read (the coarsened design this issue
actually shipped), there's no backing-logic/cache-semantics difference
left to justify a second route.

**Issue #75 shipped the day-precision calendar picker
`docs/plans/issue-75-plan.md` designed, replacing the month-granularity
scheme (`?anchor=YYYY-MM`, a 252-option `<select>`) end to end.** The
single biggest architectural change: `CustomRangeSelector.tsx` used to
compute its own anchor list client-side for free
(`customRangeAnchors(asOf)` needed no real data) -- day-granularity
anchors can't be computed that way (real trading days aren't derivable
from calendar math alone), so the picker now depends on a real server
fetch it never needed before: `GET /api/custom-anchors`
(`app/api/custom-anchors/route.ts`, backed by
`getCustomAnchorsResponse` in `results-api.ts`), which serves the
published `CustomAnchorsManifest` (`packages/core`, written by
`apps/pipeline` alongside every individual `CustomWindowResult` --
see `apps/pipeline/CLAUDE.md`'s "Day-precision extension" section).
`lib/use-custom-anchors.ts`'s `useCustomAnchors()` hook is a thin
`useFetchResultsState<CustomAnchorsManifest>("/api/custom-anchors")`
instantiation (fetches once per mount, unlike
`useResults`/`useCustomResults`, whose URLs change per selector) that
`CustomRangeSelector.tsx` is the sole consumer of.

`CustomRangeSelector.tsx` is now a hand-rolled calendar-grid picker
behind a native `<details>`/`<summary>` disclosure (matching this app's
own established disclosure pattern -- `ResultsPage.tsx`'s "More
options," `PortfolioChart.tsx`'s "View chart data as a table"), not a
`<select>`: a day-granularity anchor set (~1,255 entries at the shipped
5-year lookback) is both too many for a flat option list and a genuine
day-precision UI ask, not just a longer list. Month-nav header (`‹`
current month `›`, disabled at the oldest/newest anchor's own month) +
a 7-column Sun-first day grid, leading/trailing blank cells aligning the
1st to its real weekday. A day cell's selectability is one `Set<AnchorDate>`
membership check (`new Set(manifest.anchors)`, `useMemo`'d) -- a real
anchor renders as an enabled `<button>` (click -> `onSelect` + close the
popover), anything else (weekend, holiday, outside the lookback,
future, or just not published yet) renders `disabled`, which alone
gives correct tab-order skipping with no custom ARIA-grid machinery.
**Keyboard navigation is tab-order only, no hand-rolled arrow-key grid
roving** -- a deliberate scoping call the plan flagged explicitly (see
`docs/plans/issue-75-plan.md` section 7's own tradeoff writeup), not an
oversight. New loading/error states this control never needed before
(the old `<select>` was a pure, always-available local computation): a
disabled "Loading start dates…" trigger while `useCustomAnchors()` is
loading, and a plain "Start-date picker unavailable" inline message (no
trigger, no calendar at all) on a fetch error -- matching this app's
established graceful-degradation posture elsewhere (the OG card route's
silent 404, `BenchmarkStat`'s silent `null` render) rather than
inventing a new error-surfacing pattern for just this one control.

- **The trigger/popover wrapper changed from `<label>` to a plain `<div>`
  (found during this issue's own test-writing, not the plan)**: a
  `<label>` wrapping a `<button>` (labelable per the HTML spec, unlike
  the old `<select>` this replaced, for which `<label>` wrapping is the
  textbook-correct association) makes browsers/`dom-accessibility-api`
  compute the _label's_ text ("Starting from") as the button's
  accessible name, silently discarding whatever the button's own content
  says ("Choose a start date…", the formatted selected date, or
  "Loading start dates…") -- a real accessibility regression a plain
  `getByRole("button", { name: "Loading start dates…" })` test query
  caught immediately (it found the button named "Starting from"
  instead), not something spotted by eye. A `<div>` wrapper (no
  label-association semantics) fixes it: the button's own dynamic
  content is its accessible name again, and "Starting from" is still
  visible as an ordinary preceding text node.
- **The popover's positioning is `right`-anchored with a `max-w-[calc(100vw-2rem)]`
  clamp, not `left`-anchored at a fixed `w-64`** (found via a real
  375px-viewport screenshot, not assumed) -- the trigger sits mid-row
  after "Starting from," and a left-anchored, unclamped 256px popover
  overflowed the real viewport's right edge on mobile, inside the nested
  "More options" `<details>` (see below). Right-anchoring plus the
  viewport-relative max-width keeps it fully on-screen at both the
  375px mobile width and the always-visible desktop width, confirmed by
  a real screenshot at both sizes.
- **Live-verified end to end against a real local pipeline run, not just
  fixtures/component tests** -- the acceptance criteria's own explicit
  ask. Same throwaway technique this file's own "Per-day breadth made
  visible" section (issue #80) already established:
  `apps/pipeline/src/local-run.ts` (real `runPipeline`, a 20-real-ticker
  universe, real Yahoo network calls, `computeCustomAnchors: true`,
  writing to local disk) + `apps/web/src/lib/local-file-result-reader.ts`
  (a `ResultReader` reading that directory, swapped in via a
  `LOCAL_RESULTS_DIR` env var in both `app/api/results/route.ts` and the
  new `app/api/custom-anchors/route.ts`) + `next dev` + a headless-
  Chromium Playwright script (installed and reverted for this one
  verification session, per this file's own "Headless-browser
  screenshot verification" convention). Confirmed: the real pipeline run
  produced 1,255 real trading-day custom-anchor results plus the
  manifest; `GET /api/custom-anchors` served the real manifest; opening
  the calendar showed the correct month with real anchor days enabled
  and non-anchor days (weekends) disabled; clicking a real day wrote
  `?anchor=2026-08-12` to the URL and rendered that day's real trade
  data (`Best possible outcome since Aug 12, 2026...`); the calendar's
  own nested `<details>` inside the outer mobile "More options"
  `<details>` rendered and hit-tested correctly at a real 375px
  viewport (the one specific combination the plan flagged as
  not-previously-exercised, see below) -- no repeat of the documented
  closed-`<details>`-forced-visible-via-CSS bug, since this nesting
  never overrides native closed-state behavior with CSS the way that
  bug required. All scaffolding (the two files above, both routes'
  `LOCAL_RESULTS_DIR` branches, the temporary `tsx`/`playwright`
  devDependencies) was reverted before the final commit.

- **`results-api.ts`'s `getCustomResultsResponse`** is a sibling of
  `getResultsResponse`, not a branch merged into it -- deliberately kept
  separate so this addition can't risk the existing, well-tested
  `?range=` path's own logic. **Both are now thin config objects passed
  to one shared `getPrecomputedResultResponse` (code review finding,
  fixed)**: the two functions used to independently re-type the entire
  reader-configured check / `getObject` try-catch / JSON.parse try-catch
  / schemaVersion check / `model` check / `Cache-Control` response
  skeleton, differing only in which identifier they parse, which S3 key
  they build, and which `model` value(s) they accept -- now a single
  generic function parameterized by a `ResultRouteConfig<TParsed>` (plus
  a `TResult` type param on the call, not the config interface itself --
  ESLint's `no-unused-vars` otherwise flags an unused type param on the
  interface, since nothing in its fields actually mentions `TResult`).
  `parseAnchorDate` (renamed from `parseAnchorMonth` for issue #75)
  validates shape only (via `packages/core`'s `anchorDateToDate`) -- it
  does **not** also check the parsed anchor against the live published
  anchors manifest, since this route's own server-side "now" and the
  pipeline's last-run "now" can disagree by up to one anchor right
  around a day boundary, and re-validating against a live-read manifest
  here would mean an extra S3 read on every single `?anchor=` request
  just to duplicate a check the ordinary `not_found` path already gives
  for free; an anchor outside the actually-published set just falls
  through to that path instead, same as any preset range not yet
  computed on a first-ever pipeline run.
- **`getPrecomputedResultResponse`'s JSON.parse try/catch alone wasn't
  enough (second-round code review finding, fixed)**: a successfully-
  parsed value can still be `null` or a non-object primitive (a
  plausible shape for a partially-written S3 object -- see
  `packages/core/CLAUDE.md`'s write-time validation notes), and the next
  line used to read `.schemaVersion` straight off it -- a `null` parse
  result throws an uncaught `TypeError` there, escaping this route as a
  raw, undocumented 500 instead of the same 502 `corrupt_data` every
  other malformed-data path here returns. Fixed with an explicit
  `typeof parsed !== "object" || parsed === null` check folded into the
  existing `corrupt_data` response, between the JSON.parse try/catch and
  the schemaVersion check. Regression-tested for both `null` and a bare
  number in `results-api.test.ts`.
- **`ResultsPanel.tsx`'s `errorCopy()` switch had no case for
  `"invalid_anchor"` (second-round code review finding, fixed)** -- a
  real `ApiErrorCode` `getCustomResultsResponse` (above) returns for a
  malformed `?anchor=` value, but the switch silently fell through to
  the generic "Something went wrong" default instead of a tailored
  message, unlike the symmetric `"invalid_range"` case ("Unsupported
  range"). Added an `"invalid_anchor"` case ("Unsupported start date"),
  with a regression test in `ResultsPanel.test.tsx` -- the original gap
  was untested, which is how it shipped unnoticed.
- **`CustomRangeSelector.tsx`** is a plain `<select>` next to
  `RangeSelector`: up to 252 anchor options is far too many for pill
  buttons. (`DaySelector` used to make this same argument for the
  intraday model's own day picker; issue #80 replaced it with
  `DayOverview`, a scrollable row list rather than a `<select>`, since
  that picker also needs to show each day's trade count/result inline --
  `CustomRangeSelector` has no equivalent per-option content, so a plain
  `<select>` still fits best here.) Its leading, disabled placeholder
  option ("Choose a
  start month...") is deliberate, not decorative -- it's what makes "you
  can only pick from this fixed list, not any date" discoverable just by
  opening the dropdown, rather than a silent limitation a user only
  discovers after picking something that 404s. Calls
  `customRangeAnchors(new Date())` fresh on every render (a cheap,
  252-iteration pure function of calendar time) rather than memoizing --
  the tiny SSR/hydration-mismatch risk (both sides call `new Date()`
  independently, a few hundred ms apart) only matters if a render
  straddles the exact millisecond a month boundary rolls over; accepted,
  not engineered around further, for this low-stakes learning project.
- **Range mode and custom-anchor mode are mutually exclusive URL state**
  (`?range=` xor `?anchor=`, `ResultsPage.tsx`) -- selecting one clears
  the other, mirroring how `?day=` is already cleared on a range switch.
  A new `useCustomResults(anchor: AnchorDate | null)` hook
  (`lib/use-custom-results.ts`) mirrors `useResults`'s own fetch state
  machine as a deliberate sibling, not a merge into it -- both return
  `null` (no fetch at all) when their own selector is `null`, so exactly
  one of the two is ever actually in flight, never both and never
  neither. `useResults` itself grew a `range: PresetRange | null`
  parameter for this (previously required, non-null) -- every _existing_
  caller still passes a real range, so this is purely additive; only
  `ResultsPage`'s own anchor-mode branch ever passes `null`. **The two
  hooks' entire fetch/loading/error machinery is now one shared
  `useFetchResultsState<T>(url: string | null)` in `use-results.ts`
  (code review finding, fixed)** -- they used to be two independent,
  near-line-for-line copies of the same tracked-value/effect/cancellation
  logic; `useResults`/`useCustomResults` are now thin wrappers that just
  build their own URL string and hand it to the shared hook.
- **`ResultsPanel.tsx` gained a third render branch** (`data.model ===
"custom-window"`, alongside the existing `"window"`/`"intraday-daily"`)
  sharing a new extracted `WindowResultBody` component with the
  `"window"` branch, rather than a second copy of that ~50-line JSX
  block -- the two models are the identical underlying computation (same
  `optimizeAllVariants` over a daily-close window, issue #13), differing
  only in which field identifies the result (`range` vs. `anchorDate`),
  so `WindowResultBody` takes a structural `WindowLikeResult` (the fields
  it actually reads -- neither `range` nor `anchorDate`) plus a
  caller-supplied `descriptionPhrase`/`heroKey`/`emptyCopy`, derived
  differently by each of the two call sites (`RANGE_COPY[range]` for
  presets; `` `since ${formatDate(data.startDate)}` `` for a custom
  anchor). **`ResultsPanel`'s own `range` prop is `PresetRange | null`
  (code review finding, fixed -- it used to be required/non-null, forcing
  `ResultsPage` to pass a harmless-but-fake placeholder `PresetRange` in
  custom-anchor mode).** The two places `range` is actually read
  (`RANGE_COPY[range]`, in the `"intraday-daily"` and `"window"`
  branches) each assert it non-null first and `throw` if it somehow
  isn't, rather than silently trusting a comment that it can't happen --
  a real invariant (only `useResults(range)`-sourced data ever reaches
  those two branches, and that hook requires a non-null `range`), now
  enforced in code and caught by this app's own render-crash boundaries
  (`app/error.tsx`/`app/global-error.tsx`, issue #46) if it's ever
  violated, instead of assumed via comments/branch order alone.
  `useDailyGuess` (`lib/use-daily-guess.ts`), called unconditionally
  before these branches (Rules of Hooks), also grew a nullable `range`
  parameter for the same reason -- when `range` is `null` it never reads
  or writes storage and always reports "never guessed," since there's no
  (range, date) pair to key a guess under in custom-anchor mode and the
  guess UI never renders there anyway.
- **`CustomWindowResult.startDate` is always exactly equal to
  `anchorDate`** (issue #75) -- every anchor is already a real trading
  day (see `packages/core/CLAUDE.md`'s "Day-precision extension"
  section), so there's no separate "nominal vs. forward-snapped start"
  distinction to display any more, unlike the old month scheme's
  `startDate` (the literal calendar month boundary, e.g. `"2019-03-01"`,
  which the ordinary window-slicing filter then forward-snapped past to
  find the first real bar). No missing/holiday-date UI work was needed
  for either scheme -- see `packages/core/CLAUDE.md`'s own section for
  why day-granularity anchors need no forward-snapping at all, for a
  different reason than the month scheme's own "it happens for free."

### Merged with issue #13's long-only vs. long+short mode

Issues #11 and #13 were developed in parallel branches and merged after
both had independently landed -- neither `?mode=` (issue #13's URL state)
nor `?anchor=` (issue #11's) was designed with the other in mind. Worked
out at merge time so `?anchor=2020-03&mode=long-short` is a valid,
working URL, not a case one feature's own logic silently overrides:

- **`ResultsPage.tsx`'s `selectRange`/`selectAnchor`/`selectMode` each
  only touch the URL params their own feature owns.** `selectRange` and
  `selectAnchor` stay mutually exclusive with each other (each clears the
  other's param, per issue #11's own design above) but neither touches
  `?mode=` -- a mode choice is an orthogonal axis, not something either
  a range or an anchor selection should reset. `selectMode` only ever
  sets `?mode=`, leaving whichever of `?range=`/`?anchor=` is currently
  active untouched. The header row renders `RangeSelector`, "or",
  `CustomRangeSelector`, then `ModeToggle` -- all three always visible
  together, not conditionally hidden based on which of range/anchor mode
  is active.
- **`WindowResultBody` (issue #11's shared window/custom-window body)
  gained a required `mode: Mode` prop** and now calls `selectVariant`
  itself, once, instead of a caller pre-selecting the variant -- both the
  `"window"` and `"custom-window"` branches in `ResultsPanel.tsx` thread
  their own `mode` prop straight through, and both fold `mode` into their
  own `heroKey` (`` `${data.range}-${data.dataAsOf}-${mode}` `` /
  `` `custom-${data.anchorDate}-${data.dataAsOf}-${mode}` ``) so a mode
  switch remounts `HeroStat` and replays its reveal animation under a
  custom anchor exactly the same way it already did for a preset range.
  This only works because `CustomWindowResult` itself gained the same
  `longShort` sibling field `WindowResult` already had -- see
  `packages/core/CLAUDE.md`'s "Merged with issue #13's short-selling
  mode" section for the schema/pipeline side of this integration.
- **`useDailyGuess` combines both features' own signature changes**:
  issue #11's nullable `range: PresetRange | null` (for custom-anchor
  mode, where there's no `(range, date)` pair to key a guess under) and
  issue #13's required `mode: Mode` parameter (for `(range, date, mode)`
  keying) both apply to the same hook now -- `useDailyGuess(range: PresetRange
| null, date: string, mode: Mode)`. In practice these two axes never
  actually interact: the guessing game only ever renders inside the
  `"intraday-daily"` branch (which requires a non-null `range`), and
  `"custom-window"` results never reach that branch at all (see
  `ResultsPanel.tsx`'s own model switch) -- so a custom anchor's `mode`
  is always `useDailyGuess`'s unused second half of a call whose `range`
  is `null`, the same "called unconditionally per Rules of Hooks but its
  result is never actually consumed" situation issue #11's own `range
=== null` handling already established, just with one more always-ignored
  parameter alongside it.

## Reveal announcement for screen readers (issue #67)

The guess -> reveal swap in `ResultsPanel.tsx`'s intraday-daily branch
(issue #34, see "Daily guessing game" above) had no `aria-live` coverage
at all until this issue -- a screen reader user who submitted the guess
form got no announcement that a large block of new content (`HeroStat`,
`WorstCaseStat`, the methodology paragraph, `BenchmarkStat`, the "You
guessed $X" line, `PortfolioChart`, the trade list) had just appeared.

- **A `role="status"` + `aria-live="polite"` `sr-only` `<div>` sits at
  the very top of the intraday-daily branch's return, always rendered**
  -- not conditionally mounted only once `guess !== null` alongside the
  revealed content. This mirrors `PortfolioChart.tsx`'s own `aria-live`
  tooltip readout (an always-present container whose _text_ changes),
  not `LoadingSkeleton`'s pattern (a container that itself mounts/
  unmounts) -- an aria-live region generally needs to already exist in
  the accessibility tree before the mutation it's meant to announce, so
  conditionally mounting the region at the same instant as the content
  it announces risks the mount itself being what a screen reader has to
  notice, not a guaranteed live-region-mutation announcement.
- Content is a static sentence, `` `Results revealed for ${formatDate(activeDay.date)} (${MODE_LABELS[mode].toLowerCase()}).` ``
  when `guess !== null`, empty string otherwise -- deliberately **not**
  wired to `HeroStat`'s per-frame `useCountUp` tween value. See this
  file's own "Client-side animation" section above, which already
  documents this exact trap (spamming assistive tech with every
  intermediate count-up number) and its established fix for `HeroStat`
  itself (`aria-hidden` + a static `sr-only` twin) -- this issue applies
  the same "announce the fact, not the animating figure" principle one
  level up, at the whole-section swap rather than a single number.
- **Keyed on mode too, not just date (real bug, found in `high` code
  review, fixed)**: `guess` is itself keyed on `(range, date, mode)` (see
  "Long-only vs. long+short mode" below), so a day already guessed under
  _both_ modes stays non-null on both sides of a mode switch -- the
  underlying content still genuinely changes (a different trade
  sequence, the same reasoning `HeroStat`'s own `heroKey` already keys on
  mode for), but with the announcement text built from date alone, that
  swap produced no DOM text mutation at all for assistive tech to notice.
  `MODE_LABELS` (`lib/mode.ts`) is a new export, extracted from
  `ModeToggle.tsx`'s previously-private label map so both surfaces share
  one copy instead of the announcement growing its own second copy of
  the same "long" -> "Long only" mapping.
- Switching to a different, not-yet-guessed day resets the region back
  to empty (the `guess !== null` check re-evaluates against the new
  day's own stored guess, via the same `(range, date, mode)`-keyed
  `useDailyGuess` this branch already calls) -- so the announcement
  never stays stuck announcing a stale day's reveal.
- Tested in `ResultsPanel.test.tsx`'s "guess-then-reveal (issue #34)"
  describe block: `getByRole("status")` is empty before `submitAnyGuess`,
  holds the reveal sentence after; resets to empty on a day switch; and
  a dedicated regression test leaves `requestAnimationFrame` real
  (un-mocked, unlike most of this file's other reveal-animation tests)
  so `useCountUp`'s tween is still genuinely mid-flight when the
  assertion runs, confirming the announcement is the final static
  sentence even then, not an in-progress dollar figure. The mode-keying
  fix itself is regression-tested in the "mode (issue #13)" describe
  block: guess both modes for the same day first, then assert the
  announcement text actually changes on a mode switch alone (date
  unchanged).

## First-visit onboarding intro banner (issue #64)

`OnboardingIntro.tsx` is a one-line, dismissible callout rendered above
`ResultsPage.tsx`'s `<header>`, framing what the page is for a first-time
visitor who otherwise lands directly on a fully-resolved result (default
range is 1Y, see `DEFAULT_RANGE`) with no context beyond the terse
one-line disclaimer already under the `<h1>`. `AboutSection`'s fuller
methodology/disclaimer sits at the very bottom of the page and isn't a
substitute -- unlikely to be the first thing read.

- **Storage is the simplest possible shape in this app so far**:
  `lib/onboarding-storage.ts` is one namespaced key
  (`hikt:onboarding-dismissed`) holding a single sentinel string, no
  keying and no re-prompt logic at all -- unlike `daily-guess-storage.ts`
  (keyed per `(range, date, mode)`) or `use-starting-capital.ts` (a
  numeric value), once dismissed on a browser it never shows again,
  full stop, per the issue's own scope. Still built on
  `lib/local-storage.ts`'s `readLocalStorage`/`writeLocalStorage` rather
  than touching `window.localStorage` directly, per this file's
  "localStorage pattern" section above.
- **Hydration safety follows `use-starting-capital.ts`'s pattern, not
  `use-daily-guess.ts`'s shortcut -- this was the one real trap in this
  issue.** `use-daily-guess.ts` is safe reading storage synchronously in
  a `useState` initializer only because it's exclusively mounted from
  `ResultsPanel`'s client-only `success` branch, which never renders
  during SSR (see that hook's own doc comment). `OnboardingIntro` is
  mounted unconditionally on the root page, which _can_ render during
  SSR, so `use-onboarding-dismissed.ts` instead always starts `false`
  (banner visible) on every render including the first client render
  during hydration, and only corrects to `true` from a `queueMicrotask`
  inside a mount effect if a previous dismissal is actually found in
  storage -- identical shape to `use-starting-capital.ts`, including its
  `userSetRef` guard against the same mount-to-microtask race window (a
  fast `dismiss()` call landing before the deferred hydration read runs
  must not get clobbered back to "not dismissed").
- **Verified live** (this dev environment has no `RESULTS_BUCKET`/AWS
  credentials -- see this file's own "Live verification without a
  headless browser or real S3" note for the general shape of this
  workaround): no throwaway route was actually needed here, since
  `use-results.ts`'s fetch happens in a client-only effect, not during
  SSR -- the page shell (header, `OnboardingIntro`) renders fully
  server-side even with `/api/results` 500ing, confirmed by building
  and starting the real production server (`next build`, `next start`)
  and driving it with a headless-Chromium Playwright script (installed
  and reverted for one verification session only, per the "Headless-
  browser screenshot verification" note above) that loaded the real
  page, asserted no console message matched `/hydration|did not
match|server rendered/i`, clicked dismiss, then did a real
  `page.reload()` and asserted the banner stayed gone. Screenshotted in
  both light and dark.
- **Duplication found in code review, fixed by extracting
  `lib/use-hydrated-local-storage-state.ts`.** `use-onboarding-dismissed.ts`
  originally reimplemented the exact mount-hydration + `userSetRef`
  race-guard shape `use-starting-capital.ts` already had, near-verbatim
  -- a real reuse finding, not just a style nit, since a future fix to
  that logic (like the race-guard fix `use-starting-capital.ts` itself
  needed once, see its own git history) would otherwise have to be
  manually re-applied to both copies. Both hooks are now thin wrappers
  around one generic `useHydratedLocalStorageState<T>(defaultValue,
readStored, writeStored)` -- see that file's own doc comment for the
  full hydration-safety/race-guard reasoning, now told in one place
  instead of two. `use-onboarding-dismissed.ts`'s own race-guard
  behavior is no longer independently tested (see that test file's own
  comment on why: its `readStored` can only ever report `true` or
  `null`, and its setter only ever writes `true`, so there's no pair of
  differing stale/fresh values that could actually exercise a clobber
  for this particular caller) -- the guard itself is covered once,
  generically, in `use-hydrated-local-storage-state.test.ts`.

## Chart point-label collision avoidance (issue #68)

`lib/chart-label-layout.ts`'s `resolveLabelOffsets` is a small, pure,
unit-tested-in-isolation module `PortfolioChart.tsx` calls to pick each
trade marker's label `y` position, replacing the old fixed `p.y - 14` /
`p.y + 24` offsets with per-marker values that never let two labels'
estimated bounding boxes overlap. Kept separate from the component, same
reasoning `chart-scales.ts`'s own header comment already gives for its
own extraction.

- **The actual collision case is _not_ what a first reading of the issue
  suggests.** A trade's close and the _next_ trade's open always land at
  the exact same portfolio value (opening a position doesn't move value
  -- see `portfolio-series.ts`'s own header comment), and open labels
  render above/close labels render below with a large enough built-in
  gap (25px baseline-to-baseline at the original fixed offsets) that
  this specific pairing can _never_ actually overlap, confirmed by hand
  algebra before writing any fixture. **The real collision is a single
  trade's own open+close pair**: its close's value is _compounded_ from
  its open's (`compoundBalance`), so a real, moderate gain moves the
  close point up the log-scaled y-axis just enough that its
  below-the-point label creeps into range of the open's
  above-the-point label -- but only for a _moderate_ gain. A huge gain
  (or a huge loss) pushes the close point's y far enough from the open's
  that they're never close regardless of how many days apart the two
  dates are on the x-axis. Both `chart-label-layout.test.ts` and
  `PortfolioChart.test.tsx`'s own "point-label collision avoidance"
  describe block deliberately use a synthetic ~50% gain for this reason,
  not an extreme one -- an extreme-gain fixture would silently pass even
  on the pre-fix code and prove nothing.
- **Algorithm**: greedy, in x order -- place each label at its normal
  base offset; if its estimated bounding box overlaps any
  already-placed label's box, push it further out **in the same
  direction it already points** (an open's label never flips below its
  point, a close's never flips above) in fixed `STACK_STEP` increments
  until clear. At most 6 markers total (3 trades), so brute-force
  pairwise checking per placement costs nothing.
- **No real DOM measurement is possible for this** -- SVG `<text>`
  reports a zero-size `getBoundingClientRect`/`getBBox` under jsdom (see
  this file's own "Chart pointer interaction" section), and even a real
  browser needs an actually-mounted node to measure. Box width is a
  deliberate **per-character estimate** (`CHAR_WIDTH_PRIMARY`/
  `CHAR_WIDTH_SECONDARY`), calibrated generously against this app's own
  two label font sizes/weights so a real rendered label is never wider
  than predicted (avoiding false-negative "no collision" verdicts) --
  not derived from any live measurement.
- **Live screenshot verification found a second, _out-of-scope_ overlap
  risk, deliberately not fixed here**: a marker sitting very close to
  the plot's vertical domain edge can have its label visually brush the
  always-rendered x-axis start/end date text (a completely different
  pair of elements neither this module nor the issue's own scope covers
  -- see the issue's own "Out of scope: no change to ... gridline
  rendering"). The debug fixture used for live verification was
  deliberately built with values comfortably inside the plotted y-domain
  (not pinned to the window's own min) specifically to avoid this
  unrelated edge case and get a clean, unambiguous screenshot of the
  actual marker-to-marker fix. Worth knowing before filing a future
  "label overlaps the axis" issue: it's a different collision (label vs.
  axis text, not label vs. label) and would need its own fix, not an
  extension of `resolveLabelOffsets`.
- **Unbounded stacking can push a label off the visible canvas entirely
  (`high` code review finding, fixed)**: the first version of the greedy
  loop above had nothing stopping it from stepping a still-colliding
  label further and further out -- fine for two markers, but a small
  cluster (several markers close in both x _and_ y, near the plot's own
  top or bottom edge, where there's the least headroom to begin with)
  can need several stack levels to fully separate, and each level was
  unconditionally another `STACK_STEP` away with no ceiling. Traced by
  hand: two "open" markers a couple px apart near `y = 10`/`y = 12`
  needed stack level 2 (`labelY = -58`) to clear, which -- once
  translated through the `<g>`'s own `MARGIN.top = 56` -- lands at
  absolute SVG `y = -2`, outside the `0..400` viewBox and silently
  clipped by the root `<svg>`'s default overflow -- the exact failure
  mode this issue exists to eliminate, just moved from "overlapping" to
  "invisible". Fixed with an optional `LabelLayoutBounds` (`{ minY,
maxY }`) `resolveLabelOffsets` now accepts: the stacking loop simply
  stops advancing once the _next_ level would cross the bound, accepting
  whatever residual overlap remains at the last in-bounds position --
  crowded-but-visible beats invisible. `PortfolioChart.tsx` passes
  `{ minY: -MARGIN.top, maxY: HEIGHT - MARGIN.top }`, the real local-
  coordinate extent before the outer `<svg>` clips. Regression-tested
  two ways: `chart-label-layout.test.ts` asserts directly against a
  tight bound with the hand-traced near-collision fixture above, and
  `PortfolioChart.test.tsx` renders a genuinely pathological 6-marker
  cluster (the max this chart ever shows) crowded near the plot's top
  edge and asserts every rendered label's box stays within the real
  `MARGIN.top`-based bound -- live-screenshot-verified too (both
  themes): the crowded cluster's labels visibly overlap each other
  (an accepted tradeoff at that many markers packed into one spot) but
  never disappear off the top of the chart.
- **The layout inputs (anchor, verb+ticker text, date+price text) used
  to be computed twice per marker -- once to build
  `resolveLabelOffsets`' input array, again in the render map just below
  (`high` code review finding, fixed)**: not a correctness bug on its
  own, but a real drift risk (`anchorFor`/`eventLabelVerb`/
  `formatDateTime`/`formatHeroCurrency` each called from two independent
  call sites nothing enforced would stay in sync). Fixed by computing a
  single `markerLabels` array once (`{ p, event, isAbove, anchor,
primaryText, secondaryText }` per marker) that both the
  `resolveLabelOffsets` call and the render `.map` now read from --
  matching the exact "compute once, reuse" pattern the "Long-only vs.
  long+short mode" section above already applied to `tradeVerbs`/
  `tradeVerbsPast` for the same class of duplication.

## The trade list always sits immediately below the chart (found while planning issue #85)

Worth knowing before touching `PortfolioChart.tsx`'s on-chart labels or
tooltip: in `ResultsPanel.tsx`, `PortfolioChart` is _immediately_
followed by `TradeList` (window model) or `IntradayTradeList` (intraday
model) in the render tree -- no gate between the two beyond whatever
already gates the chart itself. `TradeList` renders as always-visible
prose (`narrate-trades.ts`'s `NarratableTrade` carries `ticker`,
`buyLabel`/`sellLabel`, and both prices) for the window model; for the
intraday model, `IntradayTradeList`'s `TradeRow`-based rows sit behind
the _same_ `DailyGuessForm` gate the chart itself is behind (issue
#34/#80), never a stricter one. Net effect: whenever a user can see the
chart, the exact ticker/date/price information any on-chart marker label
carries is already rendered, unconditionally, one scroll-length below it
-- a stronger duplication argument than "the hover/tap tooltip and the
collapsed `ChartDataTable` already cover this" (the overlap the chart's
own on-chart labels were originally justified against), since neither of
those needs an extra interaction or an extra click the way the tooltip/
table do. See `docs/plans/issue-85-plan.md` section 2 for the full
reasoning this fact fed into (recommending removing `PortfolioChart`'s
on-chart text labels and deleting `chart-label-layout.ts` entirely).

## Touch discoverability for the chart (issue #66)

Two independent pieces, both scoped by the issue itself as "at minimum"
vs. "optionally, implementer's call": the idle caption fix (required,
the actual accessibility floor) and a one-time visual pulse hint for
touch users specifically (optional, built here). Built both -- the pulse
hint reuses enough of this app's own established patterns
(`local-storage.ts`'s two-layer shape, `should-celebrate.ts`'s
"skip the affordance entirely under reduced motion" precedent) that it
added real, cheap discoverability value without inventing anything new.

- **Caption fix**: `PortfolioChart.tsx`'s idle readout now reads "Tap,
  hover, or focus the chart (use the arrow keys) to inspect a point." --
  unconditional wording rather than branching on touch support, since
  the sentence reads naturally either way and a conditional version
  would need its own hydration-safety story (see below) for zero real
  benefit.
- **Pulse hint**: `lib/use-chart-tap-hint.ts` + `lib/chart-tap-hint-storage.ts`
  gate a one-time pulsing ring (`.chart-tap-hint-pulse`, `globals.css`)
  around the chart's most recent trade marker, shown once per browser
  on a first-ever touch-primary visit. Three independent conditions, all
  checked once at mount, ANDed together: `matchMedia("(pointer: coarse)")`
  matches (a touch-primary device -- a mouse/trackpad user already has
  the discoverable hover interaction), not already shown/dismissed
  (`chart-tap-hint-storage.ts`, same single-sentinel shape as
  `onboarding-storage.ts`, issue #64), and not `prefersReducedMotion()`.
  A tap (`revealNearestPoint`, shared by pointerdown/pointermove since
  issue #44) or the pulse animation completing three cycles on its own
  (`onAnimationEnd`) hides it for the rest of that mount, so a user who
  never taps still only sees it flash briefly once, not forever.
  - **The dismissal itself is persisted immediately on mount (a `useEffect`
    with an empty dependency array), not deferred until the tap/
    animation-end that hides it locally (real bug, found in `high` code
    review, fixed).** The first version only wrote to storage from those
    two dismiss paths -- fine for a chart that stays mounted, but
    `ResultsPanel`'s intraday-daily model unmounts `PortfolioChart`
    entirely on a `DayOverview` day switch (issue #80; `DaySelector`
    before it -- see "Two result models" above), well within the pulse's
    own ~4.2s three-cycle runtime. A
    touch user who switched days mid-pulse, before tapping or waiting it
    out, left `isChartTapHintDismissed()` still reading `false` -- so
    the next `PortfolioChart` mount (any day, including the one just
    left) showed the pulse all over again, repeatably, contradicting
    this hook's own "shown once, ever" contract. The effect fires
    synchronously on commit, strictly before the browser can dispatch
    any user event that could unmount this component (a day-switch click
    included), so persisting there instead closes the gap regardless of
    what happens to that particular mount afterward. Regression-tested
    two ways: `use-chart-tap-hint.test.ts` unmounts a shown-but-untapped
    hook instance and asserts a fresh instance stays dismissed;
    `PortfolioChart.test.tsx`'s own "touch tap hint" describe block does
    the same one level up, rendering and unmounting a whole
    `PortfolioChart` with no tap at all.
- **Deliberately the `use-daily-guess.ts` synchronous-read shortcut, not
  `use-hydrated-local-storage-state.ts`'s deferred-correction hook** --
  `use-chart-tap-hint.ts`'s own doc comment spells out why this is safe:
  `PortfolioChart` is only ever mounted from `ResultsPanel`'s client-only
  `success` branch (`use-results.ts`'s fetch state machine always starts
  `"loading"`, matching both server and initial client render), so the
  branch that actually mounts this hook never renders during SSR and
  there's no hydration-mismatch risk to guard against. This is the same
  reasoning this file's own "localStorage pattern" section already gives
  for `use-daily-guess.ts` -- worth re-checking this precondition still
  holds before reusing this shortcut for a future feature, per that
  section's own warning.
- **Reduced motion skips the affordance entirely, not a static
  substitute** -- the same choice `should-celebrate.ts` already makes
  for `HeroStat`'s celebration burst (see the "Client-side animation"
  section above): a user who prefers reduced motion gets no pulse at
  all rather than e.g. a static ring, since the caption fix above is
  already this issue's real accessibility floor for every user
  regardless of motion preference or pointer type.
- **CSS mechanics worth knowing for the next SVG-element animation in
  this app**: `.chart-tap-hint-pulse`'s keyframe animates `transform:
scale(...)` on an SVG `<circle>`, which needs `transform-box: fill-box`
  -- without it, `scale()` on an SVG shape transforms around the nearest
  SVG viewport's own origin (roughly the chart's top-left corner), not
  the circle's own center, unlike `.confetti-piece`'s identical-looking
  `transform` keyframe (issue #36), which needs no such property since
  it animates plain HTML `<span>`s whose default transform origin is
  already their own box. `animation-fill-mode: forwards` holds the
  animation's final (invisible) state after its three iterations finish,
  rather than snapping back to fully visible between/after runs the way
  an unset fill-mode would.
- **Screenshot-verified via the established headless-Chromium workaround**
  (see "Headless-browser screenshot verification" above) using
  Playwright's own `hasTouch`/`reducedMotion` context options rather than
  hand-rolling a `matchMedia` stub in the browser itself -- confirmed
  live across all four combinations (touch device in light and dark, no
  ring on a non-touch viewport, no ring on a touch device with reduced
  motion requested) on a throwaway debug route
  (`debug-chart-tap-hint/page.tsx`, deleted before committing, per this
  file's own "Screenshotting a component locally" convention).
- **`lib/stub-match-media.test-util.ts`** is a new shared per-query
  `matchMedia` stub (`stubMatchMedia({ "(pointer: coarse)": true, ... })`)
  -- `use-chart-tap-hint.test.ts` and `PortfolioChart.test.tsx` both need
  to control two independent media queries (`(pointer: coarse)`,
  `prefersReducedMotion()`'s own `(prefers-reduced-motion: reduce)`)
  rather than one fixed `matches`, and this issue's own first draft
  hand-copied an identical stub function into both files (`high` code
  review finding, fixed). Named `.test-util.ts`, not `.ts`, specifically
  so Vitest's default `**/*.{test,spec}.*` glob doesn't pick it up as
  its own (empty, assertion-free) test file -- confirmed live, not just
  reasoned about: the full suite's file count didn't change by adding
  it. `use-count-up.test.ts`/`HeroStat.test.tsx`'s own older, narrower
  `stubPrefersReducedMotion` (a single fixed `matches`, no per-query
  control) stayed independently duplicated between those two files --
  out of scope for this issue, not touched here at the time; extracted
  once a third caller (`PortfolioChart.test.tsx`, issue #85) needed the
  identical stub, into `lib/stub-prefers-reduced-motion.test-util.ts` --
  see that issue's own section below.

## Mobile layout pass for the top controls (issue #63)

**The epic issue's own premise ("three stacked rows") was wrong, but the
real risk it was gesturing at was real.** `ResultsPage.tsx`'s controls
row is genuinely one `flex flex-wrap` container, not three separate row
divs -- but at a real ~375px phone width, `RangeSelector`'s six pills
alone already fill nearly the full row, so `CustomRangeSelector` and
`ModeToggle` (and the `"or"` between them) each wrapped onto their own
near-full-width line anyway. Screenshot-verified (the throwaway-debug-
route technique below) that this pushed the actual result -- the chart
and trade list, the whole point of the page -- below the fold on a real
375x812 viewport in both the window and intraday-daily models; the
intraday-daily model's pre-guess `DailyGuessForm` fit fine, but its own
post-reveal content (chart, trade list) had the identical problem once
guessed.

- **Fix**: `CustomRangeSelector` + `ModeToggle` (+ the `"or"` between
  them) collapse behind a `<details>` "More options" disclosure below
  640px (this project's `sm` breakpoint everywhere else), leaving
  `RangeSelector` as the one always-visible control -- matching the
  collapsed-by-default pattern `PortfolioChart.tsx`'s own "View chart
  data as a table" disclosure already establishes. `RangeSelector` was
  kept always-visible (not collapsed) since it's the primary, most-used
  control; the issue's own scope named `CustomRangeSelector`/
  `ModeToggle` specifically as the less-essential candidates.
- **Renders `CustomRangeSelector`/`ModeToggle` twice, not once** -- a
  `hidden sm:flex` div (visible at `sm` and up) and a second copy inside
  the `sm:hidden` `<details>` (visible only below `sm`), both driven by
  the exact same `anchor`/`mode` props and `selectAnchor`/`selectMode`
  handlers, so neither copy's behavior can drift from the other. This
  wasn't the first design tried, and the reason it changed is worth
  knowing before "simplifying" this back to one instance:
  - **A single-instance version was tried first and reverted after a
    real, live-verified browser bug, not a hypothetical one.** The
    original design put `CustomRangeSelector`/`ModeToggle` inside the
    `<details>` only, closed by default, and tried to force it visibly
    "open" at `sm` and up purely via CSS (`display: contents` on the
    `<details>` to promote its children into the outer flex row, plus
    `display: flex !important` overriding the UA stylesheet rule that
    hides a closed `<details>`'s content). Every computed style checked
    out (`getComputedStyle` reported the right `display`, real non-zero
    `getBoundingClientRect` dimensions in the right position) -- but the
    content still didn't paint, and `document.elementFromPoint` at that
    exact position hit the ancestor wrapper, not the actual control:
    this Chromium build (verified via an isolated minimal repro, not
    just in the real component) genuinely does not paint or hit-test a
    closed `<details>`'s content even when an author CSS rule forces its
    `display` back from `none`, at least for this exact "closed +
    CSS-forced-visible" combination -- confirmed the same isolated
    repro paints fine when the `open` attribute is actually present, so
    it's specifically the "closed but CSS says show it" combination that
    silently fails to render, not `display: contents` or `<details>` in
    general. Two real component instances gated by plain `hidden`/`sm:`
    utilities (the ordinary, well-supported responsive-nav duplication
    pattern -- no reliance on overriding a closed `<details>`'s native
    behavior at all) sidesteps this entirely. If a future change wants
    to de-duplicate this back to one instance, re-verify this exact
    failure mode live first, in this same browser/version, before
    assuming a CSS-only approach will work.
- **`ResultsPage.test.tsx` needed real changes, not just new
  assertions**: with two real instances, `getByRole("button", { name:
"Long + short" })`/`getByRole("combobox")` etc. started matching two
  elements and throwing (jsdom loads no stylesheet in this test file at
  all -- see `vitest.config.mts`'s own comment on the `jsdom`
  environment -- so neither copy's `hidden`/`sm:flex` classes actually
  compute to `display: none` there; both report as equally "visible" to
  Testing Library queries, unlike in a real browser). Fixed with a
  `desktopControls()` test helper (`within(screen.getByTestId(
"controls-more-desktop"))`) that every affected query now goes through
  -- an arbitrary but consistent choice of which copy to interact with,
  since both share the same props/handlers and a test's assertion is
  identical either way.
  - **That coverage alone left the mobile copy itself completely
    untested (`high` code review finding, fixed)**: every assertion in
    the file went through `desktopControls()`, so a bug isolated to just
    the `<details>` copy specifically (a typo in its own `onSelect` prop,
    the `<details>`/`<summary>` structure getting mangled) would have
    passed the whole suite untouched. A new `"mobile 'More options'
disclosure (issue #63)"` describe block adds a `mobileControls()`
    sibling helper (`within(screen.getByTestId("controls-more-mobile"))`)
    and two tests -- a mode-toggle click and an anchor `<select>` change,
    both routed through the mobile instance specifically -- confirming
    it writes the same URL params the desktop copy's own tests already
    check.
  - **The desktop div was also missing `flex-wrap` (`high` code review
    finding, fixed)**: unlike its mobile twin inside the `<details>`
    (`className="mt-3 flex flex-wrap items-center gap-3"`), the desktop
    copy was `sm:flex` with no `flex-wrap` -- fine at the 1024px width
    this issue's own screenshot verification checked, but the three
    children (`"or"`, `CustomRangeSelector`, `ModeToggle`) couldn't wrap
    onto their own line if their combined width ever exceeded the row
    (e.g. right at the 640px `sm` boundary itself, or with browser
    zoom/OS text-size scaling enlarging the rendered text) -- they'd
    overflow instead. Now `flex flex-wrap` like the mobile copy, no
    visual change at the widths already screenshotted.
  - **`CustomRangeSelector`'s own `customRangeAnchors(new Date())` call
    effectively doubled in cost per `ResultsPage` render (`high` code
    review finding, fixed)** -- this component's own doc comment already
    called the 252-iteration loop "cheap... not engineered around
    further" for a _single_ instance recomputing it every render, but
    this issue's two-instance design means every `ResultsPage` render
    (e.g. on every `router.replace` from a range/day/mode change) now
    ran that loop twice. Fixed inside `CustomRangeSelector.tsx` itself
    (no prop change, so still within this issue's "wrapper/layout change
    in the two parent components only" scope) with `useMemo(() =>
customRangeAnchors(new Date()), [])` -- computed once per _mount_, not
    once per _render_, which also incidentally fixes the pre-existing
    per-render redundancy for the single-instance case this doc comment
    used to accept. The empty dependency array preserves the exact same
    SSR/hydration-mismatch risk profile as before (still a fresh `new
Date()` per mount, not a module-level constant) -- see that file's
    own updated doc comment.
- **Screenshot verification used the throwaway-debug-route technique**
  (`apps/web/CLAUDE.md`'s own "Screenshotting a component locally" note)
  at a real 375x812 viewport: a debug page rendered `ResultsPage.tsx`'s
  real header JSX plus `ResultsPanel` with hardcoded `WindowResult`/
  `IntradayResult` fixtures (no `RESULTS_BUCKET`/AWS creds needed), with
  small buttons to switch between the window and intraday-daily models
  without a second page load. Verified before and after, both models,
  both light and dark, plus a 1024px desktop screenshot each time to
  confirm no regression there (the issue's own out-of-scope constraint).
  A separate live check against the real (unmodified-except-for-this-fix)
  `ResultsPage` component -- not just the fixture-fed debug route --
  confirmed the "More options" disclosure actually expands and a mode
  selection still writes `?mode=` to the URL exactly as before, ruling
  out the debug harness itself masking an interaction regression.

## Range/anchor switch fade-in transition (issue #65)

The only genuine "just swaps content" gap left in this app (mode/day
switching already had `HeroStat`'s own keyed-remount reveal, see "Two
result models" above and `HeroStat`'s `heroKey` doc comment) was
`ResultsPanel.tsx`'s `LoadingSkeleton` -> success-tree handoff on a range
or custom-anchor switch, since `useFetchResultsState` resets state to
`{status: "loading"}` synchronously the instant its `url` changes
(`lib/use-results.ts`), unmounting the whole success tree and mounting a
fresh one once the new fetch resolves.

- **Mechanism: a plain CSS `@keyframes` opacity fade (`globals.css`'s
  `results-fade-in`, 300ms ease-out), applied via a shared
  `FadeInWrapper` component (`ResultsPanel.tsx`) that wraps each of the
  three success-branch outer `<div>`s** -- `WindowResultBody`'s own
  wrapper (shared by the `"window"` and `"custom-window"` branches) and
  the `"intraday-daily"` branch's own wrapper. No library, same
  convention `.confetti-piece`/`.chart-tap-hint-pulse` already establish.
- **No JS toggle is needed to keep mode/day switching from replaying
  this** -- both are plain prop/local-state changes within an
  already-mounted success tree (no new fetch, see "Two result models"
  above), so neither ever unmounts/remounts these wrapper divs in the
  first place; a CSS mount-animation on a static className simply never
  re-triggers without a fresh DOM node. Verified live (below) alongside
  confirming the animation _does_ play on an actual loading -> success
  transition.
- **`FadeInWrapper` reads `prefersReducedMotion()` via a `useState` lazy
  initializer, not a plain expression recomputed on every render (real
  bug, found in `high` code review, fixed).** The first version computed
  `prefersReducedMotion() ? "" : " results-fade-in"` once per
  `ResultsPanel` render and threaded the resulting string down as a
  `fadeInClassName` prop -- which re-evaluated `prefersReducedMotion()`
  on _every_ render, including the mode/day/starting-capital re-renders
  that leave an already-mounted wrapper's own DOM node in place the
  whole time (per the point above). If the OS-level reduced-motion
  preference actually changed value _between_ two such re-renders (e.g.
  toggled mid-session, then the user clicks `ModeToggle`), the computed
  className string would flip on an element already on screen -- and
  per the CSS Animations spec, `animation-name` newly entering an
  element's computed style (even via a plain class-attribute change on
  an existing node) starts that animation fresh, so an "instant, always"
  mode/day switch could suddenly flash opacity 0 -> 1 on already-visible
  content. `useState`'s lazy initializer runs exactly once, at the
  moment React actually creates a new `FadeInWrapper` instance -- which,
  given where it's used, only happens on a genuine `"loading"` ->
  `"success"` transition (a real range/custom-anchor switch, or first
  load), never a mode/day/starting-capital change; no extra key or
  memoization bookkeeping is needed to replicate that "was this a
  genuine mount?" check by hand, since it falls straight out of React's
  own reconciliation rules for this component's two call sites.
  Regression-tested in `ResultsPanel.test.tsx`: render a success state,
  flip the stubbed `matchMedia` preference, then `rerender` the _same_
  mounted tree with an unrelated prop change (`mode`) and assert the
  wrapper's fade-in class doesn't move.
  **Update (issue #77):** this exact "latch `prefersReducedMotion()` once
  via a `useState` lazy initializer" shape got reimplemented independently
  in `HeroStat.tsx`'s reveal accent, hitting the identical bug a second
  time before being caught in `/code-review`. Both call sites now share
  `lib/use-reduced-motion-at-mount.ts`'s `useReducedMotionAtMount` hook
  instead of each holding its own copy -- see that file's own doc comment
  for the full argument (unchanged from what's written here) and its
  precondition for safe reuse. `FadeInWrapper` itself is now `const
shouldFadeIn = !useReducedMotionAtMount();`, no local `useState` of its
  own.
- Still reuses `lib/prefers-reduced-motion.ts` rather than a second
  `matchMedia` check, and `FadeInWrapper` is only ever rendered once
  `state.status === "success"` (both early returns for `"loading"`/
  `"error"` already ran before either call site), so -- like
  `use-daily-guess.ts`/`use-chart-tap-hint.ts` (see their own doc
  comments) -- it's client-only by construction and needs no separate
  hydration-safety story. Mirrors `should-celebrate.ts`'s own
  primary-gate pattern (skip the class outright under reduced motion,
  don't rely on the CSS `@media` guard alone); `results-fade-in`'s own
  `@media (prefers-reduced-motion: reduce)` block in `globals.css` is
  defense-in-depth on top, the same two-layer approach that keyframe's
  own doc comment already documents for `.confetti-piece`/
  `.chart-tap-hint-pulse`.
- **Verified live** via the established throwaway-debug-route + headless-
  Chromium technique (`apps/web/CLAUDE.md`'s own notes above): a debug
  page toggled `ResultsPanel`'s `state` between `"loading"` and a real
  `"success"` fixture (the actual transition this issue targets, not
  just a static before/after screenshot) and sampled the wrapper's
  `getComputedStyle(...).opacity` at several points after the switch.
  With no reduced-motion preference, opacity climbed from `0` shortly
  after the switch up to `~0.98` by 350ms later -- a real, visible fade
  over roughly the animation's own 300ms duration, not an instant snap.
  With `reducedMotion: "reduce"` (Playwright's own context option, not a
  hand-rolled `matchMedia` stub): opacity was `1` at every sampled point,
  confirming the transition is fully skipped, not just slowed down.
  **Caveat (found in `high` code review):** the intermediate samples
  (`0.09` at 100ms, `0.56` at 200ms after the triggering click) don't
  cleanly match a textbook `ease-out` curve's own shape -- they're
  backloaded relative to what `cubic-bezier(0, 0, 0.58, 1)` predicts for
  those elapsed fractions. That's expected and not a sign the CSS itself
  is wrong: the samples are timestamped from the _click_ that flips
  `state`, not from the animation's own actual start (the React
  re-render, commit, and paint that create the fresh wrapper node all
  happen somewhere in between, an unmeasured lag this script never
  isolated) -- so don't read these specific numbers as characterizing
  the curve's shape, only as confirming a real, gradual fade happens
  under normal motion and none happens under reduced motion. Playwright
  itself was temporarily added (`pnpm add -D -w playwright`) and reverted
  afterward, per this file's own "Headless-browser screenshot
  verification" convention above.

## Dark mode only (issue #76)

`globals.css`'s `:root` used to hold light values with a
`@media (prefers-color-scheme: dark)` block redefining them; that block
is gone, and `:root` now holds the old dark values directly, unconditionally
-- dark is this app's only theme, no in-app toggle, no OS-preference
branching anywhere. `global-error.tsx`'s independent hand-copied
`<style>` block (see "Render-crash boundaries" above) lost its own
`prefers-color-scheme` swap the same way, for the same reason (it can't
import `globals.css`, so it always needed its own copy of whichever
values were live).

- **The CSS custom-property swap alone wasn't the whole fix (found in
  `high` code review, fixed): `color-scheme` also needed setting
  explicitly.** Before this issue, this app's own painted colors and the
  browser's _native_ UA-widget theming (a `<select>`'s dropdown popup --
  `CustomRangeSelector.tsx` (`DaySelector.tsx` too, before issue #80
  replaced it with `DayOverview.tsx`, a `<button>` list with no native
  popup of its own); `StartingCapitalInput.tsx`'s
  `type="number"` spin-button chrome; scrollbars) both happened to track
  the same `prefers-color-scheme` signal independently, so they always
  agreed by coincidence, not by any explicit link between them. Once the
  page's own colors stopped following that signal but nothing told the
  browser to stop _its_ native-widget theming from following it too, an
  OS-light visitor would get this app's dark page with a light-themed
  native dropdown/spinner popping up on top of it -- a real, visible
  mismatch a plain screenshot pass didn't catch (a transient native
  popup, not part of the page's own paint). Fixed with `color-scheme:
dark` on `globals.css`'s `:root` (a real CSS property, not a custom
  token) and an equivalent `style={{ colorScheme: "dark" }}` on
  `global-error.tsx`'s own `<html>` tag, its usual React-inline-style
  spelling. **Any future non-`prefers-color-scheme` theme mechanism in
  this app (a toggle, a per-user override) needs to keep setting this
  too** -- it's a separate lever from the custom-property values, not
  implied by them.
- Verified live: `getComputedStyle(document.documentElement).colorScheme`
  read back `"dark"` from a real `next build`/`next start` page loaded
  under Playwright's `colorScheme: "light"` context emulation, confirming
  the property actually takes effect regardless of the emulated OS
  preference, not just that the CSS was written.
- Screenshot-verified (same throwaway-debug-route + headless-Chromium
  technique this file's other sections already establish, `colorScheme:
"light"` emulation) across all 6 preset ranges, one custom anchor, a
  guess-then-revealed intraday day (confetti burst included), and a
  375px mobile width -- every view renders fully dark regardless of the
  emulated OS preference, with a matching dark-scheme screenshot of the
  same page confirming no visual regression from removing the media
  query. `global-error.tsx` was verified by temporarily throwing inside
  `layout.tsx` (reverted before committing, never worth keeping as a
  permanent debug affordance) and loading the page under `next dev`
  (not `next build`, which fails outright on a throw during static
  prerendering of `/` -- the runtime boundary this file exists for
  never gets a chance to run in that mode) with Next's own dev error
  overlay dismissed via <kbd>Escape</kbd> to see the real fallback
  underneath.
- **`OgCard.tsx`'s share-card palette is deliberately untouched and
  stays hardcoded light** -- it never read `prefers-color-scheme` (Satori
  renders server-side with no viewer/OS context at all) and a share
  image needs to look right embedded on arbitrary third-party
  pages/platforms regardless of this app's own in-page theme, so "dark
  mode only" doesn't apply to it. Its own doc comment used to say these
  values were copied from `globals.css`'s _light_ `:root` palette;
  updated to note that palette no longer exists there at all post-#76,
  so these are now standalone literal values with no live source of
  truth to stay in sync with (join `global-error.tsx`'s own values in
  that same boat).

## Visual polish pass: surface elevation, chart fill, hero accent (issue #77)

Three small, additive CSS/SVG changes against the dark-only palette #76
left in place, each scoped to the "implementer's call" cosmetic values
the issue itself left open:

- **Surface elevation**: `globals.css`'s new `--shadow-surface` token
  (a tight contact shadow + a softer ambient one + a faint inset top
  highlight) and its `.surface-card` class are applied only to the
  app's genuine "card" surfaces -- `TradeRow.tsx`'s rows, `TradeList.tsx`'s
  prose box and empty-state fallback, `ResultsPanel.tsx`'s three
  "no trades"/"no days" empty-state boxes, and `OnboardingIntro.tsx`'s
  banner -- **not** every `--surface-1`/`--surface-2` background in the
  app. Deliberately left off `RangeSelector`/`ModeToggle`'s pill-toggle
  housings (control chrome, not a content card), the various form
  controls that use `--surface-1` as their own background
  (`DailyGuessForm`, `StartingCapitalInput`, `CustomRangeSelector`,
  `DaySelector` at the time -- superseded by `DayOverview`, issue #80,
  which kept the same no-elevation treatment, see that section above),
  and `ResultsPanel`'s `LoadingSkeleton` placeholders (a
  transient loading state, not worth its own elevation) -- a shadow on a
  small pill or an input field read as visual noise, not polish, in a
  quick live check. If a future surface-toned element genuinely reads as
  a "card," add `.surface-card` to it explicitly rather than reaching
  for one blanket selector matching every element that sets its
  background from either surface custom property -- that would also
  catch the pill/input/skeleton cases above, unintentionally. **Don't
  spell that selector out literally in this file, even in prose**: tried
  once while writing this very note, not just reasoned about --
  Tailwind v4's content scanner reads this CLAUDE.md file too, and
  writing the bracketed arbitrary-value class name with a wildcard
  stand-in for "either surface number" was enough to make `next build`
  emit a real "Unexpected token" CSS-optimizer warning at build time
  (the scanner tried to treat the prose string as a candidate utility
  class and choked on the wildcard character). Describe such patterns
  structurally instead, the way the sentence above this note does.
- **Chart area-fill gradient**: `PortfolioChart.tsx` already had an
  area-fill gradient under the line (`<linearGradient>` fading
  `--series-1` to transparent, present since issue #25's original
  frontend PR) -- the issue's own background section describing "no
  area fill" was working from a live screenshot where the fill was
  simply too faint to read (a flat 10% opacity at the top, fading to
  0%). Fixed by raising the top stop to 32% and adding a 55%-offset
  8%-opacity middle stop (a curved, not linear, taper) rather than
  adding a second gradient element -- confirmed live via the
  throwaway-debug-route technique below that the wash is now clearly
  visible against the dark background without competing with the
  gridlines or the line itself.
- **Hero stat reveal accent**: `HeroStat.tsx`'s visible (aria-hidden)
  ending-balance span gets `globals.css`'s new `.hero-figure-accent`
  class (a soft `text-shadow` glow) once `settled` goes true -- colored
  via the same `isMultiplierGain` (`>= 1`) threshold the adjacent
  multiplier badge already uses, deliberately _not_ the stricter
  `isGain` that gates `CelebrationBurst`, so the glow (unlike confetti)
  renders on both a gain and a loss reveal. Under reduced motion,
  `.hero-figure-accent` alone still applies its own resting glow
  instantly, satisfying the issue's "skipped/instant" wording literally:
  the _animation_ (`.hero-figure-accent-animate`, a brief CSS
  `@keyframes` entrance) is skipped, the glow itself isn't. Never
  touches the `sr-only` twin span or the `aria-hidden` attribute on the
  visible one, so neither the accessibility pairing nor `useCountUp`'s
  tween is affected -- only a `className`/inline custom-property
  (`--hero-accent-glow`) added to an already-existing span.
  `HeroStat.test.tsx`'s "reveal accent (issue #77)" describe block
  covers: no class pre-settle, gain coloring + animate class with motion
  allowed, loss coloring, and the animate-class omission under reduced
  motion (mirroring `CelebrationBurst.test.tsx`/`should-celebrate.test.ts`'s
  own gating coverage per the issue's acceptance criteria).
  - **Two real bugs found in `/code-review`, both fixed, in how
    `animateAccentReveal` originally decided whether to add
    `.hero-figure-accent-animate`.** The first draft computed it as
    `settled && !prefersReducedMotion()`, claiming (wrongly) to reuse
    `should-celebrate.ts`'s own `isGain && settled` short-circuit safety.
    That claim doesn't hold here: `isGain` (`endingBalance >
startingCapital`, strict) stays `false` at mount even for a flat result,
    which is what makes `shouldCelebrate`'s `&&` provably never reach
    `prefersReducedMotion()` on the SSR-matching first render -- but
    `settled` (this accent's own gate, `animatedEndingBalance ===
endingBalance`) is trivially `true` at mount whenever `startingCapital
=== endingBalance` (a flat/no-trade result), so `prefersReducedMotion()`
    genuinely _could_ run during that first render for that case,
    reintroducing the exact hydration-mismatch risk those hooks exist to
    avoid. Second, reading `prefersReducedMotion()` live on every render
    (rather than latched once) meant the animate class could add/remove
    itself on an already-mounted, already-settled figure if the OS
    preference changed mid-session and an unrelated prop re-rendered
    `HeroStat` (e.g. a `displayStartingCapital` edit) -- the identical bug
    class `FadeInWrapper` (issue #65, below) already found and fixed
    independently, reimplemented here before being caught a second time.
    Both fixed the same way: `lib/use-reduced-motion-at-mount.ts`'s
    `useReducedMotionAtMount` hook, shared with `FadeInWrapper`, latches
    the read once via a `useState` lazy initializer at mount -- see that
    hook's own doc comment for the full argument and its precondition
    for safe reuse (only ever mounted from a client-only success branch).
    Regression tests for both live in `HeroStat.test.tsx`'s own "reveal
    accent" describe block (a flat-result case, and a re-render-with-
    flipped-preference case) and generically in
    `use-reduced-motion-at-mount.test.ts`.
  - **A third finding in the same pass, also fixed**: `.hero-figure-accent-animate`'s
    keyframe had no `animation-fill-mode: forwards`, unlike every other
    animation in this file (`.confetti-piece`, `.chart-tap-hint-pulse`) --
    its post-animation state relied on the keyframe's own `to` values
    happening to exactly match `.hero-figure-accent`'s separately-declared
    resting rule rather than being explicitly held. Added, matching
    convention.
- **Verified live** via the established throwaway-debug-route +
  headless-Chromium technique (this file's own "Headless-browser
  screenshot verification" section) -- a debug page rendered `HeroStat`
  - `PortfolioChart` + `TradeList` for both a gain and a loss fixture,
    screenshotted with and without `reducedMotion: "reduce"` context
    emulation. Confirmed: both figures show a colored glow (green/red)
    matching their multiplier badge; the chart's area fill reads clearly
    under both a rising and a falling line; the trade-narration card shows
    a visible soft shadow lifting it off the near-black background; no
    confetti and no animate class under reduced motion, but the glow is
    still present and instant. Playwright itself was temporarily added
    (`pnpm add -D -w playwright`) and reverted afterward (confirmed via
    `git diff package.json`/`pnpm install` afterward), per this file's own
    convention.

## Portfolio chart redesign (issue #85)

Per `docs/plans/issue-85-plan.md` (plan-only pass, no re-litigation
needed at implementation time -- both open design forks it flagged
already had an explicit answer): on-chart text labels removed entirely,
`chart-label-layout.ts`/`chart-label-layout.test.ts` deleted outright,
gain/loss-aware coloring added (`--status-good`/`--status-critical`, the
same `>= is good` convention `TradeRow`/`HeroStat` already use), a hollow-
ring-vs-filled-dot marker shape distinction (open vs. close) added, and a
CSS-only reveal-on-mount animation added, gated the same two-layer
reduced-motion way `HeroStat`'s own reveal accent already is (see
"Client-side animation" above).

- **A marker's `<circle>` must render as a _sibling_ `<g>` after the
  crosshair `<line>`, not nested inside the same `<g>` as the area
  fill/line (real z-order regression, found in `/code-review`, fixed).**
  Grouping "area fill + line + markers" into one `<g>` for the reveal
  animation (as this issue's own plan literally describes it) paints
  that whole group, markers included, _before_ the crosshair line right
  below it in the render -- but this chart's pre-#85 stacking always had
  markers on top of the crosshair (they rendered last, after both the
  crosshair and the tap-hint pulse). With markers folded into the
  earlier group, the 1px dashed crosshair would render on top of a
  marker instead of under it whenever a hovered point snapped near one,
  visually cutting through the marker's ring/dot. Fixed by keeping two
  sibling `<g>`s -- one wrapping just the area fill + line (rendered
  first), a second wrapping just the markers (rendered after the
  crosshair, restoring the original stacking) -- both carrying the same
  `animateReveal`-gated `.portfolio-chart-reveal` class so they still
  animate in together despite not being one DOM node. Worth remembering
  for any future addition to this render tree: matching the plan's
  prose literally ("group X, Y, and Z into one wrapper") doesn't by
  itself preserve paint order against elements _outside_ that wrapper --
  check the full render order, not just which elements end up animated
  together.
- **`lib/stub-prefers-reduced-motion.test-util.ts`** is a new shared
  single-query `matchMedia` stub, extracted once this issue's own
  `PortfolioChart.test.tsx` reveal-animation tests became the third
  independent copy of the identical `stubPrefersReducedMotion` helper
  (`use-count-up.test.ts` and `HeroStat.test.tsx` each already had their
  own -- see "Touch discoverability for the chart" above, which flagged
  exactly this as worth doing once a third caller showed up; found
  un-done in `/code-review`, fixed). All three files now import the one
  shared helper; `lib/stub-match-media.test-util.ts` (the per-query
  sibling, for a caller that needs to control more than one media
  feature independently) is unchanged.
- **`<PortfolioChart>` needed real `key={heroKey}` plumbing added at
  both its render sites in `ResultsPanel.tsx`** (window model, custom-
  window model via the shared `WindowResultBody`; intraday-daily model)
  -- it was never keyed before this issue, so a day/mode switch used to
  just update its `points` prop in place rather than remounting it,
  meaning the reveal animation would only ever have fired once per
  range/custom-anchor fetch, out of sync with `HeroStat`'s own count-up/
  glow replaying on every day/mode switch right next to it. Both call
  sites now key on the exact same string already passed to the adjacent
  `HeroAndWorstCase`'s own `heroKey` prop, so the two stay in sync as
  one paired reveal moment.
- Marker `<circle>` rendering now iterates the `eventMarkers` array
  directly (already computed above, for the hover/tap-hint logic) rather
  than the deleted `markerLabels` array the old label system built --
  the old render map destructured `{ p, event, anchor, primaryText,
secondaryText }` per entry; the new one only needs `p`/`event`.
- Live-verified (this file's own "Screenshotting a component locally"
  throwaway-debug-route technique, no local `RESULTS_BUCKET`/AWS creds)
  across a typical gain, a loss, a Max-range astronomical-scale result
  (log-scale ticks spanning $1K-$10M+), and a zero-trade window (a flat
  line, rendered "good" per the `>= is good` convention) -- confirmed
  the hollow-ring/filled-dot marker distinction is visually legible at
  actual chart scale (not just in a unit test's DOM assertions) and that
  the hover tooltip/crosshair still render correctly against the new
  gain/loss-colored line.

## Chained per-day starting capital (issue #84)

Implements `docs/plans/issue-84-plan.md` on top of the per-track
`startingCapital` schema fields `apps/pipeline`'s chaining pass now
writes (see `packages/core/CLAUDE.md`/`apps/pipeline/CLAUDE.md`'s own
"Chained per-day starting capital" sections). The two real `ResultsPanel.tsx`
call-site fixes are covered above (this file's "rescaleFromStartingCapital's
per-day pattern..." section) -- this section covers the new UI surfaces
and one real accessibility gotcha found along the way.

- **`WholeRangeBalance.tsx`** is the whole-range running-balance
  headline (issue #84's own spoiler-fix design, section 4.2) -- rendered
  above `DayOverview` in the intraday-daily branch. **Gating superseded
  by issue #91**: originally count-gated (not order-gated) on
  `revealedCount === data.days.length`, masked with a neutral progress
  placeholder ("Reveal all N days below... -- X of N
  revealed so far") until every day in the currently-viewed range has
  been individually guessed/revealed via `DailyGuessForm`, in any order
  -- **issue #91 replaced this whole mechanism**: `WholeRangeBalance`
  now owns its own independent guess-then-reveal form (backed by
  `range-guess-storage.ts`/`use-range-guess.ts`, keyed `(range, mode)`
  with no date dimension), unrelated to any per-day state -- see
  "Whole-range-only guessing (issue #91)" below for the current design.
  Computes its own `finalBalance` via a
  _single_ rescale from the range's own root `data.startingCapital` to
  the final chained day's own selected-track `endingBalance` -- see the
  section above for why this must NOT reuse the per-day rescale pattern
  every other dollar figure on this page uses.
- **`DailyGuessForm` gained an honest, non-numeric `previousDate` clause**
  ("This day's real starting balance actually carried over from {date}'s
  result -- but for this guess, picture it starting fresh:") for every
  day but a range's own first (`previousDate: null` there) -- communicates
  that chaining happened without changing what's actually being guessed
  (still the existing per-day, ratio-based question) or leaking any
  dollar amount (the previous day's own _date_ is already fully visible,
  ungated information via `DayOverview`'s own rows regardless of guess
  status).
- **`DayOverview`'s own intro copy and per-row "carried over from {date}"
  note communicate the same thing structurally** -- a purely non-numeric
  affordance, since every row's own date is already ungated/visible
  regardless of guess status.
- **Real accessible-name collision, found live (not by a unit test that
  happened to already exist) -- worth knowing before adding any visible
  text inside an interactive row/button element in this app**: the first
  version of `DayOverview`'s per-row "carried over from {date}" note put
  that text directly inside the row's own `<button>`, which folds it into
  the button's own computed accessible name (the browser/testing-library's
  accessible-name algorithm concatenates all non-`aria-hidden` descendant
  text). Since the note names the _previous_ row's date, this made a
  later row's own accessible name contain an _earlier_ row's date too
  (e.g. "Aug 21, 2026 carried over from Aug 20, 2026, 1 trade..."),
  breaking every existing `getByRole("button", { name: /Aug 20,
2026.*1 trade/ })`-style exact-ish query in `DayOverview.test.tsx`/
  `ResultsPanel.test.tsx` -- the regex meant to uniquely match the
  "Aug 20" row instead matched _both_ rows, since "Aug 20, 2026" now
  legitimately appeared inside "Aug 21"'s own accessible name too. Fixed
  with `aria-hidden="true"` on the note span: it stays a purely visual
  affordance (sighted users see it; a screen reader user tabbing through
  rows already hears the full sequence of consecutive dates in DOM order
  regardless, so nothing is actually lost). Not a hypothetical concern
  either way -- this genuinely broke 5 existing tests before the fix, not
  just a theoretical risk flagged in review.
- **Live-verified against real Yahoo data** (20 real tickers, no S3
  write, real `LOCAL_RESULTS_DIR`/`next dev`/headless-Chromium screenshot
  pass, same throwaway technique this file's own "Per-day breadth made
  visible" section documents): the whole-range headline's masked
  placeholder ("Reveal all 21 days below... -- 0 of 21 revealed so far")
  and every `DayOverview` row's own "carried over from {date}" note
  rendered correctly on a real 1M result; fully revealing a real 1W
  range's 5 days unlocked the headline showing "$20.00 -> $32.80" --
  hand-verified against that same real result's own 5 per-day ratios
  (1.0675 x 1.0815 x 1.163 x 1.0945 x 1.116 ~= 1.640, `$20 * 1.640 ~=
$32.81`, matching modulo rounding) -- confirming the headline's
  root-based rescale produces the real compounded figure, not a
  per-day-cancelled one.

## Whole-range-only guessing (issue #91)

Replaced per-day guessing (issue #34) and count-gated whole-range
unlocking (issue #84) with a single guess-then-reveal control scoped to
the whole range -- guessing every individual day before seeing one
summary figure was tedious, and the point of the game is "what did the
whole range turn into," not any one day along the way. Window-model
ranges (5Y/MAX) are untouched -- they never had guessing at all.

- **Every individual day is now unconditionally visible.** In
  `ResultsPanel.tsx`'s intraday-daily branch, `HeroAndWorstCase` and
  `IntradayTradeList` render immediately for whichever day is selected
  -- no `DailyGuessForm`, no gate. `DayOverview`'s own rows show real
  `endingBalance` figures unconditionally too (`DayOverviewRow.endingBalance`
  is now a plain `number`, not `number | null` -- no more "Guess to
  reveal" placeholder).

  **A known, accepted trade-off, not an oversight** (raised in this
  issue's own `high` code review, and explicitly decided by the user
  rather than fixed unilaterally): every row's real dollar figure lets a
  sufficiently motivated user multiply each day's own implied ratio
  together and back out `WholeRangeBalance`'s exact "protected" final
  answer without ever submitting a guess -- precisely the reconstruction
  risk this file's own "Chained per-day starting capital" section
  documents as the reason the pre-#91 design was count-gated in the
  first place. Decided to ship anyway: the point of this issue was
  removing per-day guessing _interaction_ tedium, not information-hiding
  rigor, and multiplying out 5-20+ per-day ratios by hand is real
  friction essentially no one will bother with. If this ever needs
  revisiting, the fix would be obscuring `DayOverview`'s own dollar
  figures (e.g. a gain/loss direction indicator instead of the exact
  amount) rather than re-gating the rows behind a guess again.

- **`WholeRangeBalance.tsx` is the page's one remaining guess-then-reveal control**, independent of any per-day state. It shows a guess form ("Before you look: starting from $X, riding {range} start to finish... what do you think it became?") until the user submits a guess, then shows the real dollar figures plus their own guessed amount.

  The storage backing it is two new modules, both keyed by the pair (range, mode): `range-guess-storage.ts` for the plain read/write functions, `use-range-guess.ts` for the React hook wrapping them. That's a simpler key than the deleted per-day `daily-guess-storage.ts` needed -- no date at all, since there's exactly one guess per range now, not one per (range, date, mode) triple.

  Revealing this headline is also what unlocks `BenchmarkStat` and the whole-range chart below it -- both would otherwise spoil the same answer, and both used to be gated by the _selected day's_ own per-day guess despite being whole-range figures, a scoping mismatch this issue also fixed.

- **The whole-range chart replaces the old per-day intraday chart
  entirely** -- there is exactly one chart in the intraday-daily branch
  now, not one per selected day. `portfolio-series.ts`'s new
  `deriveWholeRangeIntradaySeries` chains every day in the range into one
  continuous `PortfolioPoint[]`: each day keeps real intraday spacing
  (reusing the module's shared `appendTradeSteps` helper), and each
  day's starting value carries forward from the _previous day's real
  ending value_ -- the same chaining `wholeRangeFinalBalance` already
  relied on (issue #84), now expressed as a full series instead of just
  a start/end pair. A zero-trade day renders as a single flat point at
  the running value (mirroring `deriveIntradayPortfolioSeries`'s own
  zero-trade handling), not a gap.
- **`PortfolioChart`/`formatDateTime` needed a real fix, found by
  actually looking at a screenshot, not assumed from the data alone**:
  `formatDateTime` used to format every datetime-labeled point as
  time-only ("9:30 AM"), correct for a single day's own chart (the day
  is shown elsewhere on the page) but silently wrong for a chart
  spanning many days -- a bare time is ambiguous about _which_ day it's
  on, and the whole-range chart's axis/tooltip/data-table all rendered
  this way until caught live. Fixed by giving `formatDateTime` a
  required second `includeDate: boolean` param (no default -- forces
  every call site to decide deliberately) and a new
  `portfolio-series.ts` export, `spansMultipleDays(points)`, that
  `PortfolioChart` computes once from its own `points` prop and threads
  into all four `formatDateTime` call sites (axis start/end labels,
  hover tooltip, the data-table fallback). `ChartDataTable` is a
  separately memoized child component (see its own doc comment on why),
  so it recomputes `spansMultipleDays` from its own `points` prop rather
  than receiving it as a prop threaded down -- cheap, and one fewer
  thing for a caller to keep in sync with the same array.
- **Live-verified via the "Screenshotting a component locally" throwaway
  debug-route technique** (issue #45's own pattern, no real
  `LOCAL_RESULTS_DIR`/AWS creds needed) -- a 6-day hand-built
  intraday-daily fixture with a mix of gains/losses/a flat day. Confirmed:
  every day's `HeroAndWorstCase`/trades render immediately with no guess
  prompt anywhere per-day; `DayOverview` rows show real dollar figures
  immediately; `WholeRangeBalance`'s guess form gates only itself,
  `BenchmarkStat`, and the chart; switching the selected day after
  revealing leaves the whole-range reveal untouched (confirming the two
  are genuinely independent, not accidentally coupled); the revealed
  chart's line visibly spans the entire 6-day range with the axis
  reading "Aug 14, 9:30 AM" -> "Aug 21, 1:30 PM" (confirming the
  `formatDateTime` fix above); and the mobile (390px) layout reflows
  cleanly with no horizontal overflow.

## Trade replay: "Watch it happen" (issue #96)

Opt-in, on-click playback of a window-model result's trades (5Y/MAX, and
custom-window anchors -- any result rendered via `WindowResultBody`,
`derivePortfolioSeries`'s points). Deliberately scoped to the window
model only -- the intraday-daily whole-range chart (up to ~250 chained
days) is a materially different scale/pacing problem, left to its own
future issue per #96's own Out of scope. `lib/use-trade-replay.ts` is a
small `idle -> playing -> done` state machine (mirroring `use-results.ts`'s
own `ResultsState` shape) driven by one RAF loop, walking
`portfolio-series.ts`'s already-existing `PortfolioPoint[]` --
`TradeReplay.tsx` is the orchestrating component that swaps between the
real hero row/chart and a truncated/interpolated view depending on phase.

- **`HeroAndWorstCase` (previously private to `ResultsPanel.tsx`) is now
  its own file, `components/HeroAndWorstCase.tsx`** -- `TradeReplay.tsx`
  needed to render the exact same HeroStat + WorstCaseStat pairing for
  its own "live" (idle/done) state, and duplicating that ~30-line wrapper
  a second time would've been exactly the class of drift this codebase's
  own `selectVariant`/`trade-math.ts` doc comments already warn against.
  `ResultsPanel.tsx` now imports it instead of defining it locally; no
  behavior change at either of its two existing call sites.
- **The chart never interpolates a position between two points during
  playback -- only the balance figure tweens, and that distinction is
  deliberate, not an oversight.** `revealedCount` (how much of `points`
  `PortfolioChart` is fed) always jumps in whole steps, straight from one
  real precomputed point to the next; `currentValue` (the plain "$X ->
  $Y" figure shown in place of `HeroStat` during playback) tweens between
  a segment's two real endpoint values via the same ease-out-cubic curve
  `useCountUp` uses (now `lib/easing.ts`, extracted from `use-count-up.ts`
  once this became the second caller -- see that file's own note). Fixing
  the chart at real points and only tweening the _display_ number is what
  keeps this honest against `portfolio-series.ts`'s own "flat until
  realized" model (no fabricated interim mark-to-market price) while
  still giving the balance figure continuous motion -- the same "tween is
  a display stylization of a real instantaneous value change, not a claim
  about how the money literally moved" reasoning `useCountUp` already
  relies on for `HeroStat`'s own reveal.
- **A close event's own return is derived by scanning backward through
  `points` for the nearest prior "open" event** (`findMatchingOpenPrice`),
  not by threading the raw `Trade[]` array into the hook at all --
  `derivePortfolioSeries`'s own `appendTradeSteps` never interleaves
  trades (each trade's open/flat/close points always land strictly in
  sequence before the next trade's own points begin), so this is safe
  and keeps the hook working purely off the `PortfolioPoint[]` shape the
  issue's own Background section calls out as "already the exact data
  this feature needs," with no second data source to keep in sync.
- **Reduced motion: the button doesn't render at all, not an instant
  step-through equivalent** -- the same "skip the affordance entirely"
  choice `should-celebrate.ts` (the celebration burst) and
  `use-chart-tap-hint.ts` (the touch pulse hint) already make elsewhere
  in this app, chosen over the acceptance criteria's other allowed option
  for simplicity and consistency. Zero information loss either way: every
  trade is already reachable via the always-present `TradeList`/
  `ChartDataTable`, unaffected by this feature.
- **A single `role="status" aria-live="polite"` region announces each
  trade event once (mirroring its exact wording) and a final "Replay
  finished. Ending balance $X." sentence** -- never a per-frame value,
  the same trap this app's own "Client-side animation" section already
  documents and avoids for `HeroStat`'s count-up. This falls out
  naturally rather than needing special-casing: `frame.activeEvent` only
  changes value at the discrete moments a real event is reached (it
  holds steady for the whole `EVENT_PAUSE_MS` pause), so wiring the
  region's text straight to it doesn't spam per-tick updates the way a
  naive `aria-live` binding to `currentValue` would.
- **Testing the multi-segment RAF loop needed a different mock shape than
  `useCountUp`'s own single-tween tests use** -- `use-count-up.test.ts`'s
  `mockImplementation((cb) => { cb(now); return 1; })` fires the callback
  _immediately_ with one fixed `now`, which works for a lone tween (only
  ever needs one resolved frame) but hangs a multi-segment machine: each
  arrival resets its own internal `phaseStart` to whatever `now` the mock
  just supplied, so an always-fires-immediately mock handing back the
  same fixed `now` computes `elapsed = now - phaseStart = 0` for every
  segment after the first, looping in the "not there yet" branch forever
  (an infinite synchronous `requestAnimationFrame` recursion, not just a
  slow test -- caught by actually running it, not reasoned about in
  advance). Fixed with a small shared `lib/raf-pump.test-util.ts`
  (`createRafPump()`, used by both `use-trade-replay.test.ts` and
  `TradeReplay.test.tsx`): it only _queues_ the latest scheduled
  callback, leaving it unfired until the test calls `tick(now)` with its
  own chosen elapsed-time value -- same "pin `performance.now()`, control
  `now` directly" approach as `use-count-up.test.ts`'s own tests,
  generalized to more than one frame.
- **Live-verified via the "Screenshotting a component locally" throwaway
  debug-route technique** (a hardcoded 3-trade `WindowResult` fixture, no
  `RESULTS_BUCKET`/AWS creds needed) plus the documented no-root headless-
  Chromium workaround: confirmed the idle state (hero row + chart +
  "Watch it happen" button, unchanged from before this issue), a
  mid-playback pause on an open event (truncated chart, the interpolated
  "$20.00 -> $20.00" figure, the "Bought SNDK on Aug 21, 2025 at
  $45.50." callout, a "Skip to end" button), Skip to end landing on the
  real final state with a fresh `HeroStat` count-up/glow replaying and a
  "Replay" button, a full un-skipped playback reaching the same end
  state on its own, and `prefers-reduced-motion` rendering zero buttons
  with the real chart/hero shown instantly (no animation at all). No
  console hydration warning appeared for any of these under normal
  (non-reduced-motion) emulation.
  - **One hydration warning did appear, but it's a debug-harness
    artifact, not a real bug** -- found by combining Playwright's
    `reducedMotion: "reduce"` context option with this debug route's
    hardcoded `state={{status:"success", ...}}` prop (bypassing
    `useResults`'s fetch state machine entirely, which in the _real_ app
    always starts `"loading"` on both server and initial client render --
    see this file's own "localStorage pattern" section for the general
    shape of this precondition). That combination server-renders
    `WindowResultBody`/`TradeReplay` at all -- a state real production
    SSR never reaches, since the genuine app never has a `"success"`
    state before the client-only fetch resolves -- with the server
    computing `useReducedMotionAtMount()` as `false` (no `matchMedia`
    during SSR) while the client's very first render already sees the
    emulated `true`, mismatching `TradeReplay`'s own conditionally-
    rendered button row. Confirmed this isn't new to issue #96: the
    _same_ hardcoded-success-state harness already mismatches one level
    up, on the pre-existing `FadeInWrapper`'s `results-fade-in` class
    (visible earlier in the same error's diff), for the identical
    reason. Worth remembering for the next debug-route verification that
    combines a hardcoded `"success"` state with `reducedMotion: "reduce"`
    context emulation -- expect this diff to show up and know it's not
    an actual regression.

### Code-review follow-up, seven findings (all fixed before merge)

A `high` review of the PR above caught seven real issues, none of them
hypothetical -- worth internalizing before extending this feature again:

- **A component returning more than one logical "block" for a parent's
  flex-gap layout must return a Fragment of siblings, not one wrapping
  div, or the parent's own gap collapses to whatever gap the new wrapper
  happens to use instead.** `TradeReplay`'s first version put the hero
  row _and_ the chart inside one shared `flex flex-col gap-2` div --
  which silently shrank the pre-existing spacing between the methodology
  paragraph/`BenchmarkStat` (rendered as `children`, just above the
  chart) and the chart itself from `FadeInWrapper`'s own `gap-8` (2rem)
  down to `gap-2` (0.5rem), on _every_ window-model page load, not just
  during replay -- exactly the kind of regression a component test can
  miss entirely if it only asserts on text content, never layout.
  `TradeReplay` now returns `<>{heroBlock}{chart}</>`, splicing both as
  direct siblings into `FadeInWrapper`'s own flex column alongside the
  "Trades" block below, restoring the original three-sibling `gap-8`
  spacing exactly. Verified live (not just reasoned about): a `document
.querySelector(".results-fade-in").children` walk measured the real
  gap between each pair of top-level siblings at exactly `32px` (2rem)
  both before the chart and after it, matching pre-#96 spacing
  bit-for-bit. A cheap regression test for the shape of this bug
  (without needing a real browser layout engine): assert the rendered
  `container.children.length` is `2` for a component meant to return
  a same-level Fragment -- jsdom doesn't compute real CSS gaps, but it
  does faithfully report DOM structure, which is the actual thing that
  determines which flex container's `gap` value applies.
- **A "swap the animated version in for the static one" component must
  scope the swap to only the pieces the issue actually names, not to
  everything living in the same JSX region.** The first version of
  `TradeReplay` used the existing `HeroAndWorstCase` wrapper (bundling
  `HeroStat` + `WorstCaseStat`) as its "live" state and a bespoke
  replacement for its "playing" state -- which meant `WorstCaseStat`
  vanished for the whole ~3-6s playback run alongside `HeroStat`, even
  though the issue's own Scope names "the chart and hero figure"
  specifically. Fixed by composing `HeroStat`/`WorstCaseStat` directly
  in `TradeReplay` (not via the shared wrapper) so only `HeroStat`'s own
  slot swaps between live and animated -- `WorstCaseStat` renders with
  the exact same wrapper markup in every phase. Worth checking for any
  future feature that reaches for an existing multi-component wrapper as
  a shortcut for "the whole row this component sits in": a wrapper
  bundling N things is the wrong unit to swap out if the feature only
  actually means to touch a strict subset of those N things.
- **A live prop that can change reference while a multi-step RAF state
  machine is mid-flight, without the owning component unmounting, needs
  its own explicit "is this still the walk I started?" check -- the
  effect's own dependency array restarting internal loop variables
  isn't enough on its own, because the _exposed_ state (what the caller
  actually renders) doesn't get folded back in until the next tick.**
  `use-trade-replay.ts`'s `points` argument can change identity mid-
  playback from two real, always-available live controls that don't
  unmount `TradeReplay` -- `StartingCapitalInput` and the app's
  always-interactive `ModeToggle` (a mode switch to a zero-trade variant
  is the sharpest case, see the next finding) -- and the RAF effect's
  own `[phase, points]` dependency array already rebuilds `segments`
  from scratch in that case, but `frame` (the state actually rendered)
  kept whatever mid-playback value it last held from the _old_ points
  until the next tick fired, and even then resumed walking through data
  that no longer matched what was on screen -- visibly snapping the
  chart/hero backward and re-narrating an already-shown trade with no
  indication anything had reset. Fixed with the exact same "adjust
  state during render when a prop changes" idiom `use-results.ts`'s own
  `trackedUrl` check and `use-range-guess.ts`'s `tracked` check already
  use elsewhere in this app: a `trackedPoints` companion state compared
  against the live `points` prop during render, resetting `phase` to
  `"idle"` and `frame` to a fresh initial frame the instant they diverge
  -- treating a mid-flight `points` identity change as a fresh mount
  rather than a silent rebuild. **The first draft of this fix also
  bumped `runIdRef.current` inside that same render-time branch "for
  extra safety" -- `react-hooks/refs` immediately flagged this
  (`Cannot access ref value during render` / `Cannot update ref during
render`), and it turned out to be genuinely unnecessary, not just
  lint-noisy**: the effect's own cleanup (`cancelAnimationFrame`) already
  runs before the new effect body does whenever `[phase, points]`
  actually changes, which this render-time reset guarantees happens on
  the very next commit -- there's no window where the stale RAF loop
  could still fire after the reset without the ref bump. Worth the
  general lesson: reaching for a ref "just to be extra sure" during a
  render-phase state adjustment is exactly the shape this lint rule
  exists to catch, and the fix is usually to trust the mechanism you
  already have (here, the effect's own dependency-driven cleanup)
  rather than adding a second one.
- **A control that's the _only_ way to act during one phase of a state
  machine must never be gated by a condition that can flip based on a
  prop the _same_ live interaction can change out from under it.**
  `TradeReplay`'s "Skip to end" button (the only control visible while
  `phase === "playing"`, `TradeList`/`ChartDataTable`'s own always-
  present static fallback aside) used to share the same `canReplay =
tradeCount > 0 && !reducedMotionAtMount` gate the idle/done "Watch it
  happen"/"Replay" button uses -- so a `ModeToggle` switch to a
  zero-trade variant mid-playback flipped `canReplay` to `false`
  _before_ the RAF loop's own phase-to-`"done"` transition could
  happen, hiding the one clickable control with nothing left to
  advance playback (the finding above's points-reference reset happens
  to also resolve this specific scenario as a side effect, since a mode
  switch always changes `points` too -- but that's an emergent property
  of _two_ independent fixes interacting, not something to rely on
  without its own direct fix, since a future edit to either one in
  isolation could silently reopen this gap). Fixed by decoupling "Skip
  to end"'s visibility from `canReplay` entirely: it renders whenever
  `phase === "playing"`, full stop, and the idle/done button is the only
  one `canReplay` actually gates.
- **A `computeTradeReturn`/`compoundBalance`-style helper that
  deliberately throws on corrupted input (see `trade-math.ts`'s own
  `InvalidTradePriceError` doc comment) is only "contained, not silent"
  at the call sites that already run inside a React render, where
  `app/error.tsx`/`app/global-error.tsx` catch it. A RAF callback is not
  a render** -- `use-trade-replay.ts`'s own call into this same helper
  (via `replayEventFor`, for a close event's return) would throw
  uncaught from inside `requestAnimationFrame`'s callback if it ever hit
  a corrupted stored price, silently freezing the whole replay with
  `cancelAnimationFrame`'s cleanup left referencing a now-permanently-
  stale `frameId` and no error surfaced anywhere a user or an error-
  tracking tool would ever see it. Fixed with a `try`/`catch` around
  just that call, logging via `console.error` and failing into the same
  `finalFrame`-shaped final state `skipToEnd` already produces --
  contained (playback still resolves to something coherent on screen)
  but not silent (logged), and if the underlying price really is
  corrupted, the page's own real static render (`TradeList`/
  `narrate-trades.ts`, once this hands off to the "done" state) still
  throws its own render-time error there, caught by the existing
  boundaries exactly as it always would have been. Worth remembering as
  a general pattern for this app: any shared helper that's designed to
  throw specifically because render-time boundaries exist to catch it
  needs a second look at every non-render call site (an event handler,
  a timer callback, a RAF loop) -- the throw's own safety story doesn't
  automatically travel with the function.
- **Two small, easy-to-miss efficiency/duplication findings, both purely
  mechanical fixes**: the sr-only announced string and the visible
  callout `<p>` were computing the identical `calloutText(...)` call
  independently (a drift risk if one call site's wording ever changed
  without the other, and wasted work every frame) -- now computed once
  into an `activeCallout` local, used by both. `points.slice(0,
frame.revealedCount)` was reallocating a new array on every render,
  including the many mid-tween frames where `revealedCount` itself
  hasn't advanced (only `currentValue` has) -- defeating `PortfolioChart`'s
  own `useMemo`s, which are keyed on `points` by reference. Wrapped in
  `useMemo(() => points.slice(0, frame.revealedCount), [points,
frame.revealedCount])` so a fresh array only appears when `revealedCount`
  actually changes.
- **Live-verified again after all seven fixes**, same throwaway-debug-
  route + no-root-Chromium technique as the original pass, this time
  with two interactive controls (a mode toggle, a starting-capital
  bump) added to the debug page specifically to exercise the
  points-reference-change fix live, not just in a unit test: clicking
  "Toggle mode" mid-playback (mid-pause on a real trade callout)
  cleanly dropped back to the idle view with a fresh "Watch it happen"
  button and no visible freeze/snap, and clicking it again started a
  genuinely fresh playback through the new mode's own trade sequence
  (a real short trade, "Shorted SNDK... Skip to end") -- confirming the
  reset is a full functional recovery, not just a visual one. The same
  check with a starting-capital bump mid-playback (the other live
  control that changes `points`) showed the identical clean reset with
  correctly rescaled figures ($20 -> $25, `WorstCaseStat`'s own $4.20 ->
  $5.25). The `.results-fade-in` child-gap measurement mentioned in the
  first finding above was taken in this same session.

### Code-review follow-up, round two -- nine more findings (all fixed before merge)

A second `high` review of the PR above, after the seven-finding round
already documented, caught nine more real issues -- several of them
only reachable because the first round's own fixes changed the shape of
what there was left to review. Also worth noting up front: this round's
reviewer flagged a tenth "finding" (the PR supposedly bundling unrelated
changes from a different issue) that turned out to be a stale-`main`
artifact on the reviewer's own end, the same class of false positive the
first round's own process already anticipated -- confirmed via `gh pr
diff --name-only` that the PR's file scope never changed, and ignored.

- **`aria-hidden` must never wrap a focusable element -- and `inert`,
  not a `PortfolioChart` API change, turned out to be the right fix,
  closing a second focusable-descendant instance the original finding
  didn't even name.** The truncated chart's wrapping div carried
  `aria-hidden="true"` while playing, but `PortfolioChart`'s own root
  `<svg>` is focusable (`tabIndex={0}`, with an arrow-key point-
  inspection handler) -- a real ARIA-spec violation, since browsers
  disagree on whether focus/keydown still reach a focusable descendant
  of an `aria-hidden` ancestor. Fixed by adding a real `inert` attribute
  to that same wrapping div (`inert={!showLive}`, kept alongside
  `aria-hidden` as defense-in-depth) instead of threading a new
  `interactive` prop through `PortfolioChart` to conditionally strip its
  own `tabIndex`/handlers -- `inert` is a DOM/HTML property, not an ARIA
  attribute, and removes an entire subtree from both the tab order and
  the accessibility tree together, so there's no "hidden from AT but
  still focusable" combination possible at all. **This also caught a
  second instance of the identical violation class the original finding
  never named**: `PortfolioChart`'s own `ChartDataTable` child renders a
  native `<details>`/`<summary>` disclosure, whose `<summary>` is _also_
  natively focusable -- a prop-based `PortfolioChart` fix would have had
  to remember to guard that too; `inert` on the wrapper catches both for
  free, with zero `PortfolioChart` changes. React 19's DOM renderer
  treats `inert` as a genuine boolean HTML attribute (confirmed by
  reading `react-dom-client.development.js`'s own property-config table,
  not assumed) -- `true` sets it, `false`/`null`/`undefined` remove it,
  same handling as `disabled`/`hidden`. **Live-verified as real browser
  behavior, not just an attribute-presence check**: a real
  `svg.focus()` call from Playwright's own `page.evaluate` succeeds
  while idle (`document.activeElement === svg`) and genuinely fails once
  playing (`document.activeElement` stays whatever was focused before
  the call, confirmed alongside `svgHasInertAncestor: true` read from
  the live DOM) -- and a real `Tab` keypress from the focused "Skip to
  end" button skips straight past the inert chart to the next real
  focusable element in the document, never landing on the `<svg>`
  itself. jsdom doesn't implement `inert`'s own behavioral enforcement
  (focus prevention) at all, only attribute presence/absence -- the unit
  test (`TradeReplay.test.tsx`) only asserts `hasAttribute("inert")`
  for this reason; the _actual_ browser-enforced guarantee this fix
  depends on was only ever confirmed live.
- **Natural playback completion must land on exactly the same `frame`
  shape `skipToEnd` and the corrupted-price catch already produce, and
  didn't.** The "advance past the last segment" branch in
  `use-trade-replay.ts`'s `tick()` used to only call `setPhase("done")`,
  leaving `frame.activeEvent` still set to whatever the _last_ segment
  paused on -- correct as long as `derivePortfolioSeries` appends a
  trailing flat point after the final trade's close (the common case),
  but that function appends no such point whenever a trade's own
  `closeDate` already equals the window's `endDate` (see its own
  `if (!last || last.date !== endDate)` guard) -- a realistic shape, not
  a hypothetical one (the best trade in a 5Y/MAX window closing on the
  most recent trading day is exactly this). In that case the close event
  _is_ the array's last point, and natural completion landed "done" with
  a stale `activeEvent` still populated, contradicting this hook's own
  documented contract that every "reached the end" path agrees on the
  same shape. Fixed by calling `setFrame(finalFrame(points))` on that
  branch too (and, for the same consistency reasoning, on the
  `segments.length === 0` defensive branch, even though `play()`
  already guards against ever reaching "playing" with zero segments in
  practice). Regression-tested in `use-trade-replay.test.ts` with a
  fixture built with no trailing point at all -- deliberately walking
  the exact same sequence the pre-existing "walks every point" test
  uses, just truncated at the close event, so the only variable is
  whether that missing trailing point actually matters.
- **`PortfolioChart`'s own `key` used to toggle between a real string
  and `undefined` at exactly the two moments playback starts and
  stops, forcing an unwanted remount (and reveal-CSS-animation replay)
  right then.** `HeroStat`'s slot genuinely needs _no_ explicit key
  suffix to remount correctly at those same two moments (see the next
  finding) because it's swapped between two different _element types_
  at that JSX position (`<HeroStat>` vs. a plain `<div>`) -- any type
  change at a position is _already_ an unconditional fresh mount by
  React's own reconciliation rules, with or without a matching key.
  `PortfolioChart`, by contrast, is the _same_ element type in every
  phase (only its `points`/`key` props differed) -- so toggling its own
  `key` between `liveKey` and `undefined` was the _only_ thing causing
  it to remount at those transitions, discarding the gradual per-point
  reveal the user just watched with an unwanted flash/re-fade right as
  playback starts, and again right as it finishes. Fixed by giving it a
  single, always-stable `key={heroKey}` (never toggled, matching this
  chart's own pre-#96 keying exactly) -- it now only remounts on a
  genuine new result (a fetch, or a `heroKey`-changing mode switch),
  never merely because playback started or stopped. **Live-verified as
  a real absence of motion, not just DOM node identity**: sampled
  `getComputedStyle(...).opacity` on the chart's own
  `.portfolio-chart-reveal` group at five points ~30ms apart
  immediately after both the "Watch it happen" click and the "Skip to
  end" click -- `1` at every single sample, both times, confirming no
  fresh 550ms fade-from-zero ever started. The jsdom-level regression
  test (`container.querySelector("svg")` reference equality across a
  full idle -> playing -> done -> replay cycle) can only confirm the DOM
  node itself didn't change identity, not that no animation replayed on
  it -- worth remembering that distinction for any future "did this
  remount" fix: a stable node reference is necessary but not sufficient
  proof that a CSS mount-triggered animation didn't also replay (it
  happens to be sufficient _here_ specifically because this app's own
  reveal animations are keyed to a genuine DOM mount, not to a class
  toggle on an already-mounted node -- a future animation gated some
  other way could remount-free but still visibly replay).
- **`play()` wasn't actually safe to call while `phase` was already
  `"playing"` -- not reachable via the shipped UI (the button that
  calls `play()` is hidden while playing, replaced by "Skip to end"),
  but a real latent bug in this hook's own public API.** Bumping `phase`
  from `"playing"` to `"playing"` again is a no-op by React's own
  `Object.is` bail-out, so the effect's dependency array never noticed
  anything changed and never restarted -- meaning `frame` reset to its
  initial value (via `play()`'s own direct `setFrame` call) but no RAF
  loop was left running to ever advance it again. Fixed by replacing the
  previous `runIdRef` (a plain ref, mutated but never read by React's
  own reconciliation) with real `runId` state, included in the effect's
  own dependency array (`[phase, points, runId]`) and bumped by every
  `play()`/`skipToEnd()` call -- a state bump _always_ differs from its
  previous value, so it forces the effect to tear down (via
  `cancelAnimationFrame` in cleanup) and restart every single time,
  independent of whether `phase`'s own value happened to change too.
  **This also let the old "is this tick stale?" check inside `tick()`
  itself (`if (runIdRef.current !== runId) return;`) be deleted
  outright, not just left in place defensively** -- it existed
  specifically to catch a same-value `phase` update that _couldn't_
  force a restart on its own; once every restart trigger genuinely
  forces one via the dependency array, a stale tick can no longer fire
  in the first place (the effect's own cleanup always cancels it first),
  so the check became tautological dead code once the actual mechanism
  it was working around no longer existed. Regression-tested by playing,
  advancing partway, calling `play()` again mid-flight, and asserting
  both the immediate reset _and_ that a fresh RAF loop genuinely
  resumes advancing afterward (not just that `frame` reset once and then
  froze).
- **Two per-render rescale computations recomputed on every one of the
  dozens of RAF-driven frames during playback, for constant-for-the-
  whole-run inputs -- both purely mechanical `useMemo` fixes.**
  `TradeReplay.tsx`'s own `endingBalanceDisplayValue` (feeding the
  "Replay finished..." announcement) is now memoized on
  `[endingBalance, startingCapital, displayStartingCapital]`. The
  worst-case figure's own rescale moved location entirely as a side
  effect of the `HeroAndWorstCase` restructuring below, and is now
  memoized _there_ instead, on its own three real inputs.
- **A one-off `capitalize()` helper in `TradeReplay.tsx` reinvented
  exactly the class of verb-pair fragmentation `trade-math.ts`'s own
  header comment already documents happening three times independently
  before centralization.** Added a third verb-pair function there,
  `tradeVerbsPastCapitalized` ("Bought"/"Sold" for a long,
  "Shorted"/"Covered" for a short -- the one register neither the
  existing `tradeVerbs` (capitalized present) nor `tradeVerbsPast`
  (lowercase past) already covers), and `TradeReplay.tsx`'s own
  `calloutText` now calls it instead of hand-capitalizing
  `tradeVerbsPast`'s own output. Not independently unit-tested in
  `trade-math.test.ts` -- consistent with how its two siblings are
  tested today (only indirectly, via `TradeRow.test.tsx`/
  `PortfolioChart.test.tsx`/`TradeReplay.test.tsx`'s own callout
  assertions), not a gap specific to this addition.
- **The very fix for the first round's "WorstCaseStat disappears during
  playback" finding reintroduced the exact duplication
  `HeroAndWorstCase` was extracted (that same round) to avoid.** That
  fix stopped using `HeroAndWorstCase` entirely and hand-composed
  `HeroStat`/`WorstCaseStat` directly in `TradeReplay.tsx` instead --
  which solved the disappearing-`WorstCaseStat` bug, but meant
  `TradeReplay.tsx` now carried its own hand-copied version of
  `HeroAndWorstCase`'s own wrapper `className` and worst-case rescale
  call, exactly the two-copies-to-keep-in-sync risk that component's own
  doc comment already argues against. Fixed with a `heroSlot?: ReactNode`
  prop on `HeroAndWorstCase` itself: when provided, it overrides only
  the `HeroStat` half of the pairing; `WorstCaseStat` always renders
  through the same unconditional code path regardless, with the same
  wrapper markup, in every phase. `TradeReplay.tsx` now composes through
  `HeroAndWorstCase` again, passing its own animated figure as
  `heroSlot` only while playing (`undefined`, the default, otherwise) --
  one wrapper implementation again, not two hand-kept-in-sync copies.
  Worth the general lesson for this codebase specifically: a fix for one
  finding can reintroduce a _different_, earlier-fixed finding as a side
  effect if it isn't checked against the reasoning behind nearby existing
  code, not just against its own acceptance criteria.
- **Once the `heroSlot` restructuring above was in place, the
  `replayRun` state and the `liveKey` string it fed turned out to be
  dead code -- confirmed by reasoning through _why_, not just by
  deleting them and seeing tests still pass.** `HeroStat`'s own slot
  swaps between two different element types (`<HeroStat>` vs. a plain
  `<div>`) depending on phase -- and _any_ element-type change at a JSX
  position is already an unconditional fresh mount by React's own
  reconciliation rules, independent of whether a `key` prop is present
  or matches a prior value. That means every idle/done <-> playing
  transition already forces `HeroStat` to fully unmount and remount for
  free, with no explicit key needed at all -- including "Replay"
  re-triggering a _second_ "done" landing after an intervening
  "playing" (a `<div>`) render already tore down the first `HeroStat`
  instance completely, so React has no "previous same-type instance"
  left to reconcile against regardless of key value. The one case worth
  double-checking before deleting the key entirely: a `points`-
  reference-change reset (the first round's own fix, above) can take
  `phase` directly from `"done"` to `"idle"` _without_ passing through
  `"playing"` -- both of which render the _same_ element type
  (`HeroAndWorstCase`'s own real `HeroStat`), so no type-swap remount
  happens there. Whether that's actually a bug turns out to depend on
  _why_ `points` changed: a starting-capital edit deliberately should
  _not_ remount `HeroStat` (this app's own established "rescale
  instantly, don't replay the reveal" convention, see the "Configurable
  starting capital" section above) -- and doesn't need to, since
  `displayStartingCapital`'s live rescale math already updates the
  already-settled figure correctly in place; a mode switch genuinely
  should remount it (a different trade sequence deserves a fresh
  reveal) -- and does, because `heroKey` itself includes `mode` and
  therefore already changes value on exactly that transition, forcing a
  real key-mismatch remount with no `replayRun` counter needed. Both
  cases land correctly with a bare, unsuffixed `key={heroKey}` -- so
  `replayRun`/`liveKey` were never actually load-bearing for any
  reachable case once this was traced through properly. Removed, along
  with the doc-comment paragraph that described the mechanism as real.
- **`findMatchingOpenPrice` did a fresh `O(n)` backward scan through
  `points` from inside the RAF callback every time playback landed on a
  close segment, instead of being resolved once during `buildSegments`'s
  own existing single forward pass.** Folded into that forward pass: a
  `lastOpenPrice` running variable, updated whenever an "open" event is
  seen and stashed onto each close segment's own new `openPrice` field,
  removing the separate backward-scan function entirely.
  `replayEventFor` now takes only a `Segment` (no `points` parameter at
  all), reading `segment.openPrice`/`segment.point` directly instead of
  re-deriving either from the raw array -- a narrower, more clearly
  test-shaped function than an unrelated `points` array pointer, even
  though `points` itself remains genuinely necessary elsewhere in the
  hook (`initialFrame`/`finalFrame` both still need it directly). Given
  `points.length` here never exceeds roughly a dozen (3 trades, worst
  case), this was never a _real_ performance problem -- worth doing
  anyway for the interface-narrowing reason above, not because the old
  O(n) rescan was actually slow in practice.
- **A false positive, confirmed and dismissed rather than investigated
  from scratch**: this round's own reviewer flagged the PR as bundling
  unrelated changes (issue #14's closure, a `daysBeforeUtc` dedup) that
  actually belong to a _different_, already-merged PR (#95, see the root
  `CLAUDE.md`'s own commit history) -- a stale-`main` artifact on the
  reviewer's own end (its local checkout predated #95's merge, so a diff
  against that stale base spuriously included #95's already-landed
  changes as if this PR introduced them). Confirmed via `gh pr diff 98
--name-only` that this PR's own file scope was, and remained, exactly
  its own ten files throughout both review rounds -- no root `CLAUDE.md`,
  no `pipeline.ts`, no `packages/core/CLAUDE.md` ever touched here.
  Worth the general process lesson: a review finding that claims a PR's
  diff includes files nowhere in its own file list is itself the thing
  to verify first (a quick `gh pr diff --name-only` check), not the
  code -- cheap to rule out, and the actual root cause (a stale local
  base, not a real scope problem) has nothing to do with the PR's own
  changes at all.

### Code-review follow-up, round three -- ten more findings (all fixed before merge)

A third `high` review of the PR above, after the seven- and nine-finding
rounds already documented, caught ten more -- three real bugs, seven
perf/reuse cleanups consistent with rounds one and two's own standard.

- **`PortfolioChart`'s x/y axis domain used to be keyed on whatever
  `points` array it was currently handed -- fine as long as every caller
  always passed the full series, which stopped being true the moment
  `TradeReplay.tsx` started passing an already-truncated
  `points.slice(0, revealedCount)` during playback.** The chart's own
  scale-building `useMemo` computed the y-domain (`Math.min`/`Math.max`
  over `points`) and the x-positions from whatever array it received, so
  the axis rescaled to fit exactly what was currently revealed at _every
  single reveal step_ -- the gridlines, their labels, and the two
  start/end axis-text labels all moved, defeating the entire point of a
  playback animation (a fixed frame the real trajectory grows into) and
  instead rendering as the whole chart visibly reflowing every
  ~300-600ms. Fixed by decoupling "what defines the axis domain" from
  "what's actually drawn": `PortfolioChart` now always takes the FULL,
  final `points` series (a new optional `revealedCount` prop says how
  much of it to actually draw -- the line, its area fill, event markers,
  and the accessible data table; defaults to `points.length`, so every
  other caller is unaffected). The scale-building `useMemo` stays keyed
  purely on the full `points`/`isChainedIntradaySeries`, never on
  `revealedCount`; a separate `drawn = plotted.slice(0, revealed)` feeds
  only the rendering/interaction logic. `TradeReplay.tsx` no longer
  pre-slices `points` itself at all -- it passes the real `points` prop
  straight through, plus `revealedCount={frame.revealedCount}` while
  playing (the `truncatedPoints` `useMemo` round two's own fix added is
  gone entirely, superseded by this). **Live-verified specifically for
  axis stability, not just remount/opacity behavior (the earlier live
  verification checked the latter but never the former, which is how
  this got through two rounds)**: a Playwright script sampled the
  y-axis gridlines' own `y1` coordinates and the two axis text labels at
  three points -- idle (before playback), ~150ms into playback (one
  point revealed), ~1050ms in (several more revealed) -- and after
  landing on "done": all four snapshots were byte-identical. A
  deliberately extreme fixture (a flat `$20` point followed by a jump to
  `$4000`) was also added as a `PortfolioChart.test.tsx` regression test
  comparing a `revealedCount={2}` render's gridlines/marker positions
  directly against the full render's own -- a partial-domain regression
  on a fixture this extreme would be obviously wrong, not just off by a
  rounding hair.
- **A starting-capital edit mid-playback replayed `HeroStat`'s
  count-up/confetti reveal, directly contradicting that component's own
  documented "rescale instantly, don't re-trigger" contract -- and the
  actual mechanism was more subtle than "the reset logic is wrong."**
  Editing starting capital while `phase === "playing"` correctly aborts
  playback (`use-trade-replay.ts`'s own `trackedPoints` render-time
  reset, round one's fix, still fires as designed -- `points` genuinely
  changes identity on a capital edit, since `ResultsPanel.tsx`'s own
  `points` memo is already display-rescaled). The bug was one level up:
  aborting sets `phase` to `"idle"`, which flips `showLive` true and
  swaps the hero slot's JSX at that position from a plain `<div>`
  (the playing-phase tween figure) back to `<HeroStat>` -- and _any_
  element-type change at a JSX position is an unconditional fresh mount
  by React's own reconciliation rules, independent of `key`. That's
  exactly the mechanism round two's own `PortfolioChart` key-stability
  fix and its `replayRun`/`liveKey` removal already reasoned about
  correctly for the _chart_ -- but for the _hero slot_, the type-swap is
  actually load-bearing: it's what gives "Skip to end" its own fresh
  reveal/confetti as a deliberate reward (verified and celebrated in
  rounds one and two). The type-swap can't tell "landed on done, a real
  completion" apart from "aborted back to idle, a live prop change" --
  it fires identically for both, which is wrong for the second case.
  Fixed with two changes together: (1) `HeroAndWorstCase.tsx`'s own
  `heroSlot` prop now _overlays_ `HeroStat` (a CSS `invisible` wrapper
  plus an `absolute inset-0` sibling) instead of replacing it via a
  ternary -- `HeroStat` genuinely never unmounts just because `heroSlot`
  toggles on or off any more. (2) `TradeReplay.tsx` now owns a small
  `revealRun` counter, bumped only when `phase` _lands on_ `"done"`
  (tracked via the same render-time "adjust state when a value changes"
  idiom this file already uses elsewhere), suffixed onto `heroKey`
  before it reaches `HeroAndWorstCase` -- so a `key` change (the only
  remaining remount trigger, now that the type-swap is gone) happens
  exactly when playback genuinely finishes, and never merely because it
  was aborted. A mode switch mid-playback still gets its own fresh
  reveal correctly, with no special-casing needed: `heroKey` itself
  already folds in `mode` upstream, so that case remounts via its own
  ordinary key change regardless of `revealRun`. **Live-verified with a
  real starting-capital edit mid-playback, and it needed two tries to
  verify correctly**: the first pass compared confetti-element presence
  before/after the edit and got a false positive (confetti appeared ~2s
  after the edit) -- turned out to be `HeroStat`'s own ordinary,
  unrelated page-load count-up (which starts on mount, independent of
  replay) simply finishing its normal 1.2s reveal on its own schedule,
  coincidentally inside the observation window, not a re-trigger. Fixed
  the verification by waiting out that initial reveal fully (tagging its
  confetti container with a probe attribute) _before_ ever starting
  playback, then confirming after a mid-playback capital edit: the
  pre-playback `HeroStat` DOM node (and its confetti container) were
  still the _exact same_ nodes 1.5s later (no second burst added,
  `document.querySelectorAll` still returned only the tagged original),
  while the figures correctly rescaled ($20 -> $50 shown as `$50.00 ->
$17.2K`, `WorstCaseStat`'s own $4.20 -> $10.50). The contrast case
  (Skip to end, a genuine completion) was verified in the same session:
  the pre-playback-tagged confetti node was confirmed _gone_ afterward
  and a fresh, untagged one present instead -- proof `HeroStat` really
  did remount there, unlike the abort case.
- **A stale `hoverIndex` could pop the crosshair/tooltip back into view
  mid-replay, a regression introduced by round two's own fix for a
  different problem.** `PortfolioChart`'s `hoverIndex` state only ever
  cleared on `onPointerLeave`/`onPointerCancel`/`onBlur`/`Escape` --
  safe as long as a `points` change always came with a fresh `key`
  (a remount resets all state for free), which stopped being true once
  round two gave the chart a single always-stable `key={heroKey}` across
  the live/truncated swap. A user who hovered or tapped a point, then
  clicked "Watch it happen" without the pointer ever leaving the SVG's
  bounds, never fired any of those four clearing handlers -- `hoverIndex`
  stayed pinned to the pre-playback index and popped the tooltip back
  into view the instant `revealedCount` grew past it mid-replay. Fixed
  by clearing `hoverIndex` whenever `points` changes identity _or_
  `interactive` flips (the same render-time-adjustment idiom used
  throughout this hook/component family) -- `interactive` had to be
  tracked too, not just `points`, because the redesign for the axis-domain
  fix above means `TradeReplay.tsx`'s own `points` prop no longer changes
  identity at all across the live/playing swap; only `revealedCount` and
  `interactive` do. **Live-verified (not just unit-tested)**: hovering the
  chart's last point showed a real tooltip (`"Aug 19, 2026 - $2.1K"`),
  clicking "Watch it happen" from inside the SVG's own bounds immediately
  reverted the readout to the placeholder text, and it stayed the
  placeholder a further ~1.2s into playback as `revealedCount` grew well
  past the stale index -- confirming it never popped back.
- **`PortfolioChart` now owns its own `interactive` prop instead of every
  caller re-deriving the `aria-hidden`+`inert` wrapper idiom itself** --
  this exact concern (the root `<svg>`'s own `tabIndex`, `ChartDataTable`'s
  `<summary>`) had already needed rediscovering twice in this PR's own
  history (round two's `inert` finding, and the second focusable-descendant
  instance it caught along the way) before becoming a documented prop.
  `interactive` (default `true`) sets `inert`/`aria-hidden` on this
  component's own root div, which already wraps every focusable
  descendant -- `TradeReplay.tsx` no longer wraps `PortfolioChart` in a
  second div of its own for this at all; it just passes
  `interactive={showLive}`.
- `spansMultipleDays(points)` in `TradeReplay.tsx` -- constant for the
  whole run, but this component re-renders on every one of the dozens of
  RAF-driven frames while playing -- is now wrapped in a `useMemo`,
  matching the sibling fixes round two already applied to
  `endingBalanceDisplayValue`/`worstCaseDisplayValue`/`truncatedPoints`
  (the last of which no longer exists at all, superseded by the axis-domain
  fix above).
- `use-trade-replay.ts`'s `tick()` used to open with a defensive
  `if (segments.length === 0)` branch "just in case" -- confirmed
  genuinely unreachable (not just defensively guarded): `play()` already
  guards `points.length < 2` before ever setting `phase` to `"playing"`,
  the only way this effect ever runs, so `buildSegments` always produces
  at least one segment by the time `tick` fires. Deleted outright.
- The play/skip-to-end button row's ternary used to duplicate the
  identical wrapping `<div className="flex items-center gap-3">` in both
  branches. Hoisted once; only the inner button varies with phase now.
- `tradeVerbsPastCapitalized` (`trade-math.ts`) used to re-encode the
  long/short branching a third time instead of deriving from the
  existing `tradeVerbsPast` -- ironic, given this function's own doc
  comment already argues against exactly that class of duplication. Now
  calls `tradeVerbsPast(direction)` and capitalizes both fields via a
  small private `capitalize()` helper local to that module.
- The tween interpolation formula (`from + (to - from) * easeOutCubic(t)`)
  was duplicated between `use-count-up.ts` and `use-trade-replay.ts` --
  only the `easeOutCubic` curve itself had been extracted to
  `lib/easing.ts` (round one's own extraction, prompted by issue #96's
  Background section), not the linear-interpolation wrapper around it.
  `use-count-up.ts` carried a deliberate float-precision snap-to-exact-
  value guard at `t >= 1` that `use-trade-replay.ts`'s independent copy
  of the same formula lacked (harmless there in practice, since it's only
  ever reached inside an `if (t < 1)` branch, but still a real
  duplication of the underlying arithmetic). Extracted a shared
  `tweenValue(from, to, t)` into `lib/easing.ts`, including the snap
  guard -- both call sites now share one implementation, with a new
  `easing.test.ts` covering `tweenValue`'s own boundary/monotonicity
  behavior directly (the two curves it composes were previously only
  exercised indirectly, via each hook's own tests).
- `formatHeroCurrency(displayStartingCapital)` inside `TradeReplay.tsx`'s
  playing-phase hero slot recomputed on every RAF-driven re-render even
  though `displayStartingCapital` is constant for the whole run -- hoisted
  into a `useMemo`, the same pattern as `endingBalanceDisplayValue` above
  it in the same file.
- **Live-verified end to end** via the same throwaway-debug-route
  (a hardcoded 3-trade `WindowResult` fixture, `ResultsPanel` driven
  directly with a `startingCapital` `useState` standing in for
  `StartingCapitalInput`'s real wiring) plus the documented no-root
  headless-Chromium workaround as every prior round: confirmed all three
  bugs above with real pointer/click interaction and DOM-identity
  checks (not just code reading or unit tests), screenshotted the
  mid-playback and post-capital-edit states, and confirmed zero console
  errors/warnings and zero `pageerror` events across the entire
  verification run. The debug route and the temporary `playwright`
  devDependency (added the same way issue #36's own note documents,
  `pnpm add -D -w playwright` for one verification session) were both
  reverted before committing -- `git status`/`git diff --stat` on
  `package.json`/`pnpm-lock.yaml` show no trace of either afterward.

### Code-review follow-up, round four -- eight more findings (two real bugs, six cleanups)

A fourth `high` review of the PR above, after the seven-, nine-, and
ten-finding rounds already documented, caught eight more, tagged by
confidence (3 CONFIRMED, 5 PLAUSIBLE) -- two real bugs, six
duplication/perf/simplification cleanups. Two other candidates the
reviewer flagged were checked and refuted before this list was even
handed off, so they're not discussed here.

- **A touch-only regression from round 3's own `revealedCount`/
  `interactive` redesign: the one-time tap-hint pulse could relocate
  between successive trade markers mid-playback, animating on content
  that's simultaneously `inert`.** `PortfolioChart.tsx`'s pulse targets
  `eventMarkers[eventMarkers.length - 1]`, and round 3 changed
  `eventMarkers` to derive from `drawn` -- the `revealedCount`-truncated
  prefix TradeReplay.tsx's playback grows one marker at a time -- without
  updating the pulse's own gating to match. A touch-primary first-time
  visitor who saw the pulse on the chart's final marker, then clicked
  "Watch it happen" before the pulse's own multi-second animation
  finished, would see the hint circle jump backward to whatever's
  currently the last _revealed_ marker and keep relocating forward as
  `revealedCount` grew -- an animated "tap here" invitation moving around
  on content the same render also marks `inert` (pointer events
  disabled) and `aria-hidden`. Fixed two ways together, the same "belt
  and suspenders" posture this component's `aria-hidden`+`inert` pairing
  already uses: (1) the pulse's own render condition now also checks
  `interactive`, so it can never paint at all while non-interactive; (2)
  the existing `useResetWhenChanged` reset that already clears a stale
  `hoverIndex` on an `interactive` flip (round 3) now also calls
  `dismissTapHint()` whenever `interactive` goes `false` -- `dismissTapHint`
  is idempotent (a no-op if the hint was never shown, or already
  dismissed), and playback starting is itself a real interaction with
  the chart, the same class of event `revealNearestPoint` already treats
  as "the hint did its job." **Live-verified**, not just unit-tested: a
  Playwright script emulating a touch-primary device (`(pointer: coarse)`
  stubbed via `matchMedia`) against a throwaway debug route confirmed the
  pulse present before playback, confirmed absent across ten ~150ms
  samples spanning the whole playback run, and confirmed still absent
  once playback finished -- the debug route and the temporary
  `playwright` devDependency were both reverted before committing (same
  pattern as every prior round). A jsdom regression test was also added
  (`PortfolioChart.test.tsx`) covering both the "never renders while
  `interactive` is false, even as `revealedCount` grows" case and the
  "stays dismissed once `interactive` flips back to `true`" case, since
  jsdom can assert the DOM-presence half of this bug (the pulse element
  existing or not) even though it can't assert the CSS animation motion
  itself -- the same distinction round 2's own `inert` live-verification
  note already drew between what jsdom can and can't confirm.
- **`drawn = plotted.slice(0, revealedCount)` had no lower bound, and
  `revealedCount` is a public, unvalidated prop.** A `revealedCount` of
  `0` (or negative) produced an empty `drawn` array, and the non-null
  assertions built on top of it (`drawn[drawn.length - 1]!.x`,
  `drawn[0]!.x`, the gain/loss color's own `drawn[drawn.length - 1]!
.value`) would then crash on `undefined!.x` instead of rendering
  anything -- today prevented only by an emergent combination of
  independently-maintained checks elsewhere (`use-trade-replay.ts`'s
  `play()` length guard, `buildSegments`'s 1-indexed loop, `TradeReplay`'s
  `showLive` gating), not one explicit invariant at this component's own
  boundary. Fixed with an explicit clamp,
  `Math.min(Math.max(revealedCount ?? points.length, 1), plotted.length)`
  -- `PortfolioChart` is now safe regardless of what a future caller
  passes, matching this codebase's established defense-in-depth posture.
  Regression-tested (`revealedCount={0}`, a negative value, and a value
  larger than the series) in `PortfolioChart.test.tsx`.
- **The "track a value during render, react the instant it changes"
  idiom was hand-duplicated six times** (three pre-existing:
  `use-results.ts`'s `trackedUrl`, `use-range-guess.ts`'s `tracked`,
  `StartingCapitalInput.tsx`'s `trackedValue`; three new from this PR:
  `use-trade-replay.ts`'s `trackedPoints`, `PortfolioChart.tsx`'s
  `trackedPoints`/`trackedInteractive`, `TradeReplay.tsx`'s
  `trackedPhase`) -- despite several of those sites' own comments
  explicitly cross-referencing the others by name as precedent for the
  same pattern, with no shared helper. Extracted `useResetWhenChanged`
  (`lib/use-reset-when-changed.ts`): pass an array of values to track
  (`useEffect`-style, compared element-by-element via `Object.is`, so it
  handles `PortfolioChart`'s own two-value `[points, interactive]` case
  the same way single-value callers use `[value]`) and a callback to run
  synchronously during render the instant any of them changes. All five
  remaining sites (see the next bullet for why `TradeReplay.tsx`'s own
  instance disappeared entirely rather than becoming a sixth caller) now
  share this one implementation, with a dedicated
  `use-reset-when-changed.test.ts` covering the multi-value and
  `Object.is`-not-deep-equality behavior directly.
- **`TradeReplay.tsx`'s own `revealRun`/`trackedPhase` pair (a
  lower-priority "consider simplifying" candidate, item 8 below) turned
  out foldable into `useTradeReplay` itself rather than needing the
  shared helper above at all.** `trackedPhase` existed purely to detect
  "the hook's own `phase` just became `\"done\"`" -- but the hook already
  owns that exact transition at its own three `setPhase("done")` call
  sites (natural completion, `skipToEnd`, and the corrupted-price
  defensive catch), so it's the more natural owner of counting them.
  `useTradeReplay` now returns a `completedRuns` counter, bumped at all
  three sites; `TradeReplay.tsx` suffixes `heroKey` with it directly and
  no longer tracks `phase` itself at all. Net effect: one fewer
  duplicate-idiom site than the finding originally counted (five
  `useResetWhenChanged` callers, not six), and a simpler
  `TradeReplay.tsx` besides.
- **`PortfolioChart` was not wrapped in `React.memo`, even though its own
  child `ChartDataTable` already was, for the identical reason.** During
  RAF-driven replay playback most tween frames leave
  `points`/`revealedCount`/`interactive` completely unchanged (only the
  hero figure's own `currentValue`, owned entirely by `TradeReplay.tsx`,
  moves), yet `linePath`/`areaPath`/`eventMarkers` still recomputed and
  the full SVG still re-diffed every frame for no visible difference.
  Wrapped in `React.memo` -- safe under the default shallow comparison
  since `points` is a stable reference for the whole run (only
  `revealedCount` grows) and `revealedCount`/`interactive` are
  primitives. Deliberately **not** applied to `HeroAndWorstCase`, whose
  `heroSlot` content changes nearly every tick during playback -- memo
  would buy nothing there and was correctly left alone.
- **`use-trade-replay.ts`'s `runId` state (added in round 2 solely to
  force `play()`'s RAF effect to restart even when `phase`'s own value
  repeated) was simplified to a plain guard.** Round 2's fix made
  `play()` safe to call while already `"playing"` -- not reachable via
  the shipped UI, but a real hook-level API gap -- by bumping a `runId`
  state variable on every `play()`/`skipToEnd()` call and including it in
  the effect's own dependency array, so a same-value `phase` update could
  still force a teardown/restart. Round 4 simplified this to
  `if (points.length < 2 || phase === "playing") return;` at the top of
  `play()` itself: every reachable caller only ever invokes `play()` from
  `"idle"`/`"done"`, never `"playing"`, so a guard that simply declines to
  act while already playing is behaviorally identical for every real call
  site -- and is arguably the more literal reading of "idempotent," which
  is what round 2's fix was actually named for (repeating the call has no
  additional effect, vs. round 2's chosen behavior of restarting the
  walk). `runId` state, and its dependency-array entry, were removed
  entirely. The one existing regression test that asserted the old
  "restarts from the beginning" behavior was updated to assert the new
  "no-op, original walk keeps advancing undisturbed" behavior instead --
  a deliberate behavior change to the hook's own unreachable-in-practice
  edge case, not an oversight; the reasoning is recorded in both the
  hook's own doc comment and the test's own name.
- **The RAF scheduling scaffold in `use-trade-replay.ts` (start-time
  capture, `tick(now)`/elapsed computation, `requestAnimationFrame`
  reschedule, `cancelAnimationFrame` cleanup) structurally mirrors
  `use-count-up.ts`'s own RAF loop -- considered for extraction, not
  extracted.** Only `tweenValue`'s own curve math (round 3, `lib/
easing.ts`) was ever actually shared between the two; the scheduling
  boilerplate itself was not, because the two loops' substance genuinely
  diverges: `use-count-up.ts`'s tick closes over a single fixed
  `startTime` captured once and runs unconditionally on a mount-only `[]`
  effect, while `use-trade-replay.ts`'s tick restarts a multi-segment
  tween/pause state machine (`segmentIndex`/`subPhase`/`phaseStart`, all
  _reassigned_ mid-loop as segments advance, not just read) on every
  `[phase, points]` change. A shared primitive would need the caller to
  hand it a memoized "build my own `tick(now)`" callback and thread that
  through its own dependency array -- a genuine dependency-array-of-a-
  dependency-array layer of indirection for what's otherwise ~5 lines of
  schedule/cleanup boilerplate, likely making both hooks harder to read
  rather than easier. Left un-extracted, with the reasoning recorded as a
  comment directly above `use-trade-replay.ts`'s own effect, per the
  review's own explicit "if it doesn't compose cleanly, leave a comment
  explaining why rather than forcing a bad abstraction" guidance.
- **`HeroAndWorstCase.tsx`'s generic `heroSlot?: ReactNode` prop has
  exactly one real caller (`TradeReplay.tsx`), which used to hand-copy
  `HeroStat`'s own "Starting from" label and big-number-row `className`
  strings byte-for-byte instead of reusing them.** Considered narrowing
  `heroSlot` itself to something more purpose-built, but that would mean
  splitting `HeroStat`'s own label+wrapper markup out from its
  count-up/celebration-burst/accessibility machinery -- a real
  restructuring of a component whose mount/reveal timing and
  accessibility behavior have already needed careful, hard-won fixes
  across rounds 1-3, for a prop with a single caller. Took the cheaper,
  equally-effective fix instead: `HeroStat.tsx` now exports
  `heroLabelClassName`/`heroValueRowClassName` as named constants, and
  `TradeReplay.tsx`'s `heroSlot` content imports and reuses them rather
  than hand-copying the literal strings -- the actual duplication risk
  (drift if `HeroStat`'s own typography ever changes) is eliminated with
  zero behavior change and no risk to `HeroStat`'s own careful reveal
  machinery. `heroSlot` itself stays a generic `ReactNode` prop.
- **Two other candidates the round-four reviewer flagged were checked
  and refuted before this list was finalized**, per the same "verify a
  suspicious finding before trusting it" discipline round 2's own false
  positive (a stale-`main` diff artifact) already established --
  specifics not repeated here since they were dropped before reaching
  this file, the same treatment round 2's refuted finding got.
- **Verified all five routine checks green** (lint, `next typegen &&
tsc --noEmit`, `pnpm build`, `pnpm test`, `pnpm format:check`) after
  every fix in this round, plus a full `.next` cache clear once the
  throwaway debug route was deleted -- `next typegen`'s generated route
  validator otherwise keeps a stale reference to a route file that no
  longer exists on disk, failing typecheck for a reason unrelated to any
  real code change (worth remembering for the next debug-route cleanup:
  delete `.next` too, not just the route file itself, before trusting a
  typecheck run).

### Code-review follow-up, round five -- one real bug, the rest left alone

A fifth `high` review of the PR above, after the seven-, nine-, ten-, and
eight-finding rounds already documented, found exactly one thing worth
fixing -- everything else it raised was explicitly assessed by the
reviewer itself as minor cleanup, not a correctness bug, and was
deliberately left alone (four rounds is already more scrutiny than this
feature needs).

- **`TradeReplay.tsx`'s playing-phase hero overlay omitted the "(Nx)"
  multiplier badge `HeroStat.tsx` always renders in the same row.** The
  overlay only ever showed the tweening "$X -> $Y" dollar figures, so a
  user viewing e.g. a big-multiplier result who clicked "Watch it happen"
  saw the badge disappear for the whole ~3-6s playback, then pop back in
  once phase returned to idle/done -- visually jarring for exactly the
  results where the badge matters most. Fixed by computing the multiplier
  the same way `HeroStat.tsx` does (`endingBalance / startingCapital`,
  the real final figures -- deliberately _not_ tied to
  `frame.currentValue`'s tween, matching `HeroStat`'s own badge, which
  isn't tied to its count-up tween either) and rendering it with that
  component's own formatting/threshold logic, following the same
  extraction pattern round four already used for
  `heroLabelClassName`/`heroValueRowClassName`: `HeroStat.tsx` now also
  exports `heroMultiplierClassName` (the static text classes) and
  `heroMultiplierColor(multiplier)` (the `>= 1` gain/loss threshold,
  colored the same as `TradeRow.tsx`'s own per-trade return badge) --
  `HeroStat` itself now calls these rather than hand-inlining the same
  logic, so there's exactly one implementation instead of two kept in
  sync by hand. `formatMultiplier` (`lib/format-currency.ts`) was already
  exported and reused as-is; only the className/color piece needed a new
  export. The multiplier is memoized (`useMemo` on
  `[endingBalance, startingCapital]`) for the same reason the other
  constant-per-run values in this file already are -- it re-renders on
  every RAF-driven frame while playing, but the value itself never
  changes across those frames.
- **Regression-tested** in `TradeReplay.test.tsx`: a `$20 -> $40` (2x)
  fixture asserts `(2x)` is present at idle, still present (two matches --
  the real, visually-hidden `HeroStat`'s own badge plus the overlay's,
  see `HeroAndWorstCase.tsx`'s own `heroSlot` doc comment for why
  `HeroStat` stays mounted underneath the overlay) once playing, and
  still present after landing on done.
- **Live-verified** via the same throwaway-debug-route (a hardcoded
  $20 -> $250, 12.5x/"13x"-displayed `WindowResult`-shaped fixture) plus
  the documented no-root headless-Chromium workaround as every prior
  round: a Playwright script sampled the badge's own text continuously
  across the entire playback run (idle, ~15 samples ~300ms apart spanning
  the full ~2.4s playback, and done) and confirmed `(13x)` present at
  every single sample, never missing -- plus zero console/`pageerror`
  events across the whole run. The debug route and the temporary
  `playwright` devDependency were both reverted before committing, same
  as every prior round; confirmed via `git status`/`git diff --stat`
  showing no trace of either afterward. Re-ran all five routine checks
  (lint, `next typegen && tsc --noEmit`, `pnpm build`, `pnpm test`,
  `pnpm format:check`) green on the clean tree after cleanup, including
  the `.next` cache clear round four's own note already flags as
  necessary post-debug-route-deletion.
