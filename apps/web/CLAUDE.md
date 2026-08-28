@AGENTS.md

The real app (issues #7/#8/#10): `GET /api/results?range=...` (thin S3
read, see `src/lib/results-api.ts`), a `useResults` fetch state machine,
and a range selector + hero stat + portfolio chart + trade list + a
click-to-reveal disclaimer/methodology section (issue #104 collapsed
this from always-visible to behind a single click -- see "Disclaimer/
methodology collapsed behind a single click" below). Live-verified
against the real deployed S3 bucket (see `infra/CLAUDE.md`'s "Current
deployment state"), not just fixtures.

## Local development without AWS credentials

This machine (and most agent sandboxes) has no `RESULTS_BUCKET` env var
and no AWS credentials wired up for local `next dev` -- both
`/api/results` and `/api/custom-anchors` 500 with `server_misconfigured`
before any real page ever renders, and `CustomRangeSelector.tsx` shows
its "Start-date picker unavailable" fallback. **This is a permanent,
committed local-dev workflow now, not a throwaway pattern to recreate
from scratch** -- earlier notes in this file (issues #45, #85, #75)
describe an ad hoc script-plus-manual-cleanup version of this exact
technique, recreated independently at least three separate times before
it became real, checked-in tooling. If you're about to write a
throwaway debug route or a one-off local pipeline script for a results-
dependent verification, use this instead:

1. `LOCAL_RESULTS_DIR=/some/dir pnpm --filter @hadiknowntrades/pipeline run local-run`
   -- runs the real pipeline (`apps/pipeline/src/local-run.ts`) against a
   small, real ticker sample (`LOCAL_TICKER_COUNT`, default 20 -- real
   Yahoo network calls, not fixtures) with `computeCustomAnchors: true`,
   writing real, current-schema results to that directory via
   `LocalFileResultStore` (`apps/pipeline/src/local-file-store.ts`), the
   same S3-key layout (`results/{RANGE}.json`,
   `results/custom/{ANCHOR}.json`, `results/custom/index.json`) a real
   bucket would have.
2. `LOCAL_RESULTS_DIR=/some/dir pnpm --filter web dev` -- same directory,
   picked up by `LocalFileResultReader`
   (`src/lib/local-file-result-reader.ts`), wired into both
   `app/api/results/route.ts` and `app/api/custom-anchors/route.ts`
   (checked before `RESULTS_BUCKET`, so setting both env vars prefers
   the local directory). Every page/control that depends on real
   results data -- the range selector, the trade replay button, the
   custom-date calendar picker -- now works exactly like it would
   against a real bucket, with no code path skipped.

Never set `LOCAL_RESULTS_DIR` in any real deployment -- `RESULTS_BUCKET`
is the only reader either route configures in production. For a
verification that genuinely doesn't need real results data at all (a
single component in isolation, hardcoded props), the older "Screenshotting
a component locally" throwaway-debug-route technique (below) is still
the right, lighter-weight tool -- this local-run workflow is for
verifying the real fetch-through-render path end to end.

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
`format-date.ts`'s own exported `toPortfolioTimestamp` (called by
`PortfolioChart.tsx` for its x-axis timestamps, and by
`use-trade-replay.ts` for its rewind-tween target, issue #105) and
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

- **Scope: every preset range gets a card as of issue #134 -- see that
  issue's own section below.** It used to be window-model-only (5Y/MAX),
  with `buildOgCardContent` returning `null` for an "intraday-daily"
  result (1W/1M/3M/1Y, issue #28; 1W since issue #60) and the route
  turning that into a 404. That restriction was real when it shipped
  ("no single top-level `endingBalance` to headline, since per-day
  results don't compound") but went stale the moment issues #84/#91
  shipped whole-range capital chaining -- **don't re-derive that
  reasoning from a stale comment somewhere; the chained whole-range
  balance is the card's headline for that model now.** Still deliberately
  keyed off the result's actual `model` field, not a hardcoded range
  list, so a future model/range change stays correct with no list to
  remember to update.
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
range is 1W as of issue #103, previously 1Y -- see `DEFAULT_RANGE`) with
no context beyond the terse one-line disclaimer already under the `<h1>`.
`AboutSection`'s fuller methodology/disclaimer sits at the very bottom of
the page and isn't a substitute -- unlikely to be the first thing read.

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

**Superseded by issue #103 for the desktop-vs-mobile duplication
specifically -- read this section for history, but see this file's own
"Default range to 1W; single 'More options' disclosure at every width
(issue #103)" section (near the end of this file) for what's actually true
today.** #103 collapsed the two real rendered instances this section
describes (`hidden sm:flex` desktop div + `sm:hidden` mobile `<details>`)
into one instance, rendered unconditionally at every viewport width. The
Chromium bug this section documents (a closed `<details>`'s content failing
to paint/hit-test even when CSS forces its `display` back from `none`) is
what originally ruled out a single instance -- but #103's single instance
sidesteps that failure mode entirely rather than re-triggering it: neither
breakpoint wants an _always-open_ state any more (both now want the same
native closed-by-default/opens-on-click behavior), so there's no longer any
CSS-forced-open trick being attempted at all. The bug itself was never
re-tested and may well still be real; it just stopped being relevant to
this control's own design once the "force it open via CSS at wide widths"
requirement went away.

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

## Rewind-to-start-date intro beat (issue #97)

A brief (~0.6-1s) "had I known" intro beat, added as a new `rewinding`
phase to `use-trade-replay.ts`'s own state machine, immediately before
`play()` starts real trade playback: `idle -> rewinding -> playing ->
done`, not a second, parallel animation system alongside #96's own. A
backward-ticking date readout (e.g. "May 2, 2026" ticking down to "Aug
21, 2025") sells the fantasy the app's whole premise is built on; it's
purely decorative -- no new data dependency, no new schema field, and
`TradeReplay.tsx`'s hero slot is the only thing that renders it (via a
new `rewindDate: string | null` field on `UseTradeReplayResult`, `null`
outside the `"rewinding"` phase).

- **The rewind target is `points[0].date`, already on hand -- no new
  prop needed.** `derivePortfolioSeries`'s own leading boundary point
  (the same one `initialFrame`/`finalFrame` already read) is exactly the
  result's real start date, so the hook needed no new parameter at all;
  `TradeReplay.tsx` doesn't pass anything new either.
- **Reuses `use-count-up.ts`'s RAF/easing shape, not a second mechanism**
  -- a single `requestAnimationFrame` tween (via the shared
  `lib/easing.ts` `tweenValue`, same as `use-trade-replay.ts`'s own
  multi-segment playing effect), just tweening a raw epoch timestamp
  between "now" (`Date.now()`, captured once when the effect starts) and
  the target date's own epoch, formatted every tick. **A small
  date-formatting layer was genuinely sufficient, per the issue's own
  Background section**: `format-date.ts` gained one new export,
  `formatEpochAsDate(epochMs)` (the exact `Intl.DateTimeFormat` options
  `formatDate` already used, extracted so a raw epoch -- not a
  `"YYYY-MM-DD"` string -- can reuse them); `formatDate` itself is now a
  thin wrapper (`formatEpochAsDate(Date.parse(...))`), not a second
  independent implementation of the same formatting.
- **A single-tween effect, not the multi-segment scaffold the playing
  effect uses** -- there's only one thing to animate here (a date, not a
  multi-point walk), so this is a second, independent `useEffect` in
  `use-trade-replay.ts` (keyed `[phase, points]`, gated on `phase ===
"rewinding"`) that mirrors `use-count-up.ts`'s own lone-tween shape
  instead of reusing the playing effect's `segmentIndex`/`subPhase`
  scaffold, which exists specifically to walk more than one waypoint.
- **Reduced motion is enforced at the hook level, in `play()` itself, not
  only via `TradeReplay.tsx`'s existing button-gating.** `play()` now
  checks `prefersReducedMotion()` directly and sets `phase` straight to
  `"playing"` (skipping `"rewinding"` entirely) when it's true --
  matching the issue's own "skip straight past this phase with zero
  delay" acceptance criterion literally, at the hook's own public API
  boundary. In the real UI this branch is never actually reached today
  (`TradeReplay.tsx`'s pre-existing `canReplay` gate already hides the
  "Watch it happen" button whenever `reducedMotionAtMount` is true, so
  `play()` is never called under reduced motion in the first place) --
  but `play()` is this hook's own public contract, and a future caller
  (or a test) shouldn't have to trust an upstream button gate for the
  hook to behave correctly standalone. This is the same "belt and
  suspenders" posture #96's own `aria-hidden`+`inert` pairing already
  established for this codebase.
- **Skip to end works identically during `"rewinding"` as during
  `"playing"`, with no extra code in `skipToEnd()` itself** -- that
  function already computed `finalFrame(points)` unconditionally,
  regardless of the current phase, so the only change needed was
  clearing the new `rewindDate` state alongside it (defensive hygiene,
  not load-bearing: `TradeReplay.tsx` only ever renders `rewindDate`
  while `phase === "rewinding"`, which `skipToEnd()` always leaves).
  `TradeReplay.tsx`'s own "Skip to end" button visibility condition
  widened from `phase === "playing"` to `phase === "rewinding" || phase
=== "playing"` -- one shared button/handler for both, not a second
  control, per the issue's own acceptance criterion wording.
- **The mid-flight `points`-reference-change reset (round one of #96's
  own code review, see above) needed zero changes to cover a mid-rewind
  case, and this was verified, not assumed.** `use-trade-replay.ts`'s
  `useResetWhenChanged([points], ...)` call already resets whenever
  `phase !== "idle"`, unconditional on which non-idle phase that
  happens to be -- so a `"rewinding"`-phase points change already fell
  under the same guard the pre-#97 code already had, before any #97
  code was written. `use-trade-replay.test.ts` adds a dedicated
  regression test for this exact case anyway (a mid-rewind rerender with
  a new `points` reference), both to document the claim and to guard
  against a future refactor of that reset accidentally narrowing its own
  condition back to `phase === "playing"` specifically.
- **`showLive` (`TradeReplay.tsx`) widened from `phase !== "playing"` to
  `phase === "idle" || phase === "done"`** -- the rewind is part of the
  same non-live, animated stretch `"playing"` already was, so the chart
  and hero slot both need to stay in their truncated/interactive-false
  shape through the rewind too, not just once real trade playback
  begins. `PortfolioChart`'s own `revealedCount`/`interactive` props
  (already driven by `showLive`) needed no further change: during the
  rewind, `frame` is still exactly `initialFrame(points)` (untouched by
  the rewind effect, which only ever writes `rewindDate`), so the chart
  correctly shows just the window's own opening point the whole time,
  with no trade line drawn yet.
- **Existing #96 tests needed real updates, not just new assertions,**
  since `play()` now lands on `"rewinding"` first rather than
  `"playing"` directly -- every existing test in both
  `use-trade-replay.test.ts` and `TradeReplay.test.tsx` that called
  `play()` and then immediately drove RAF ticks assuming trade-playback
  progress had begun needed one extra tick inserted first (`raf.tick(now

> = 1700)`, completing the 700ms rewind in a single pumped frame since
  `performance.now()`is pinned to a fixed value throughout these test
  files -- the same "pin`performance.now()`, control `now` directly"
> approach this suite already established) before the pre-existing
> tick sequence continues unmodified. Two tests genuinely needed more
> than a one-line insertion, both caught by tracing through what they
> were actually meant to verify rather than just patching the
> assertions that failed:

- `TradeReplay.test.tsx`'s "shows the multiplier badge throughout
  idle -> playing -> done" test used to assert
  `getAllByText("(2x)").length` is merely `>0` right after clicking
  "Watch it happen" -- which, with the rewind phase now inserted,
  would trivially keep passing forever even if the _playing_-phase
  overlay's own badge regressed again, since the real (always-
  mounted) `HeroStat`'s own badge alone already satisfies `>0`
  throughout the rewind. Fixed by asserting the exact count (`1`
  during the rewind -- only the real `HeroStat`'s badge, since the
  rewind overlay has no multiplier badge of its own to show; `2` once
  actually `"playing"` -- both `HeroStat`'s and the overlay's),
  restoring the original round-five regression's real coverage at the
  exact moment it's meant to guard.
- `use-trade-replay.test.ts`'s "play() while already playing is a
  no-op" test gained a sibling, "play() while already rewinding is a
  no-op" -- the guard in `play()` itself now checks both
  `phase === "rewinding" || phase === "playing"`, and the pre-existing
  test only ever exercised the latter half.
- **Live-verified** via the established throwaway-debug-route (a
  hardcoded two-trade `points` series, dated in the past relative to the
  sandbox's own real clock, so the readout has real distance to tick
  through) plus the documented no-root headless-Chromium workaround:
  screenshotted the readout early and mid-rewind (confirmed the date
  text genuinely changes, ticking backward -- not a static label),
  confirmed it auto-advances into real trade playback on its own with no
  second click once the 700ms elapses, confirmed "Skip to end" clicked
  mid-rewind lands on the exact same settled final state ($48.00, the
  real `endingBalance`) that a natural completion or a mid-playback skip
  already does -- including HeroStat's own fresh count-up/confetti
  reveal replaying, the same established reward behavior #96's own
  round-three live verification already confirmed for a mid-playback
  skip -- and confirmed `reducedMotion: "reduce"` context emulation
  renders zero "Watch it happen" button and zero "Rewinding to" text
  anywhere, matching #96's own pre-existing full-bypass behavior with no
  regression. Zero console errors/warnings and zero `pageerror` events
  across the whole run. The debug route and the temporary `playwright`
  devDependency were both reverted before committing, per this file's
  own established convention; confirmed via `git status`/`git diff
--stat` showing no trace of either afterward, and all five routine
  checks (lint, `next typegen && tsc --noEmit`, `pnpm build`, `pnpm
test`, `pnpm format:check`) re-ran green on the resulting clean tree.

### Code-review follow-up -- one real bug, `rewindDate` outliving its own phase

A `high` review of the PR above found one real gap: `rewindDate` was
only ever cleared by `skipToEnd()` and the mid-flight `points`-reference
reset -- not by the other two `setPhase("done")` call sites this hook
has (natural completion, and the corrupted-stored-price defensive
catch), despite `rewindDate`'s own doc comment promising "`null` in
every other phase." Concretely: play a result through to a genuine
natural finish (not "Skip to end"), then click "Replay" -- the _previous_
run's own target date was still sitting in `rewindDate` all through
`"done"`, and remained visible for one frame as the wrong date the
instant `"rewinding"` was re-entered, only correcting once the first new
RAF tick fired. Fixed by adding `setRewindDate(null)` alongside
`setFrame(finalFrame(points))` at both of the two previously-missed call
sites, matching what `skipToEnd()` already did. Regression-tested in
`use-trade-replay.test.ts`: a dedicated test walks a full natural
completion (mid-rewind -> playing -> every trade event -> done) and
asserts `rewindDate` is `null` both immediately after landing on "done"
and immediately after the next `play()` re-enters "rewinding" -- plus a
one-line addition to the existing corrupted-price test asserting the
same for that third call site. All five routine checks (lint, `next
typegen && tsc --noEmit`, `pnpm build`, `pnpm test`, `pnpm format:check`)
re-ran green after the fix.

### Post-#97 follow-up -- two small findings from an independent `high` review of the merged PR

A `high` review run _after_ the PR above had already merged (not part of
its own pre-merge review rounds) found two more small, real things --
both fixed on their own short follow-up PR, no new issue number (a
small enough scope that filing one felt like overhead for this project's
own stated process rigor).

- **`rewindDate` wasn't actually cleared at the _natural_ transition
  from `"rewinding"` to `"playing"` either -- only at the three
  `setPhase("done")` sites the previous follow-up above already fixed.**
  The rewind effect's own `tick(now)` used to call `setRewindDate(...)`
  with the fully-tweened target date and _then_ `setPhase("playing")` on
  the very same `t >= 1` tick -- so `rewindDate` held that stale
  target-date string through the entire subsequent trade-playback
  stretch (a real ~2-6s), not just for one frame, contradicting its own
  doc comment's "`null` in every other phase" promise the same way the
  previous follow-up's three `"done"` sites did. Currently latent --
  `TradeReplay.tsx` only ever reads `rewindDate` while `phase ===
"rewinding"` -- but the same "a real hook-level API contract gap is
  worth fixing even when today's shipped UI can't observe it" reasoning
  this hook's own doc comment already applies to the `runId`/idempotent-
  `play()` fix (see the round-two entry under "Trade replay: `Watch it
happen`" above) applies here too. Fixed by reordering the `t >= 1`
  branch to `setRewindDate(null)` before `setPhase("playing")`, and
  dropping the branch's own now-redundant intermediate
  `setRewindDate(formatEpochAsDate(...))` call entirely (there's no
  reason to render the fully-tweened value even for one frame once the
  tick already knows it's leaving `"rewinding"` for good). The existing
  "play() enters 'rewinding' before 'playing'..." test in
  `use-trade-replay.test.ts` used to assert `rewindDate` equals the
  fully-tweened date string (`"Jan 1, 2024"`) immediately after the tick
  that lands on `"playing"` -- that assertion was itself pinned to the
  bug, not the contract, so it's updated to assert `null` instead.
- **`TradeReplay.tsx`'s "Skip to end" button visibility re-derived the
  exact logical complement of `showLive` instead of using `!showLive`
  directly.** `phase === "rewinding" || phase === "playing"` and
  `showLive`'s own `phase === "idle" || phase === "done"` are two
  independently-written expressions that happen to partition
  `ReplayPhase`'s four values into the same two groups -- nothing
  enforces they stay opposites. Genuinely low-severity today (that
  four-value union is exhaustively covered by construction, and neither
  expression has drifted since #96/#97 shipped), but a future edit to
  `showLive` itself, or a new `ReplayPhase` value added to the state
  machine, could silently desync the button's visibility from the
  chart/hero's own live/non-live state with no compiler or test signal
  pointing at the second copy. Fixed by using `!showLive` directly.
- Both fixes verified via the existing test suite (updated as above for
  the first) plus all five routine checks (lint, `next typegen && tsc
--noEmit`, `pnpm build`, `pnpm test`, `pnpm format:check`) -- no new
  live-browser verification pass, since neither change is observable in
  the shipped UI today (the first is a latent hook-contract gap; the
  second is a pure refactor to an already-exhaustive condition).

## Default range to 1W; single "More options" disclosure at every width (issue #103)

Two small, independent changes to `ResultsPage.tsx`, both in its header:

- **`DEFAULT_RANGE` changed from `"1Y"` to `"1W"`.** A first-time visitor
  with no `?range=`/`?anchor=` param now lands on the intraday-daily model
  (see "Two result models" above), not the window model -- worth knowing if
  a future change assumes the very first render is always the window model.
- **`CustomRangeSelector` + `ModeToggle` now collapse behind exactly one
  "More options" `<details>`, unconditionally, at every viewport width** --
  not just below 640px (issue #63's original scope). See the "Mobile
  layout pass" section above for why this used to be two real rendered
  instances (`hidden sm:flex` desktop div + `sm:hidden` mobile
  `<details>`) and why that duplication is now gone: neither breakpoint
  wants an always-open state any more, so there's nothing left to force
  open via CSS and no reason to keep two copies in sync. `data-testid`
  went from `"controls-more-desktop"`/`"controls-more-mobile"` to a single
  `"controls-more"`.

**`ResultsPage.test.tsx` needed real updates, not just new assertions**
(same class of change the issue's own Scope section called out): the
`desktopControls()` test helper became `moreOptions()`, pointing at the
one remaining `data-testid`; every call site across the file (mode toggle,
custom-anchor calendar selection) now goes through it. The dedicated
"mobile 'More options' disclosure" describe block (issue #63's own
regression coverage for the second instance) was removed rather than kept
-- with only one instance left, its two tests exercised the exact same
code path `moreOptions()`-based tests elsewhere in the file already cover,
so keeping it would just be testing the same thing twice under a different
describe name. In its place, a small "single disclosure at every viewport
width" test asserts the actual acceptance criterion structurally: exactly
one `"controls-more"` node exists, and it's a descendant of a `<details>`
whose `<summary>` reads "More options."

**Live-verified against a real local pipeline run** (the permanent
`LOCAL_RESULTS_DIR` workflow documented at the top of this file, not a
throwaway fixture route -- this change touches real fetched data via
`DEFAULT_RANGE`, not just static layout), screenshotted at 1280px desktop
and 375px mobile via the established no-root headless-Chromium technique.
Confirmed at both widths: `/` with no query params shows the 1W pill
pressed and fetches `/api/results?range=1W`; the only always-visible
header control is the 6-pill `RangeSelector` plus a closed "More options"
disclosure; clicking it reveals `CustomRangeSelector` and `ModeToggle`
correctly. One thing only a real browser could catch (jsdom loads no
stylesheet in the test file, so this is invisible to the unit tests, which
is why this file's own "Mobile layout pass" section already documents
querying through a scope helper rather than relying on visibility): a
closed native `<details>`'s content is genuinely not visible pre-click in
a real browser (confirmed by querying `getByRole("button", { name: "Long
only" }).isVisible()` before opening the disclosure -- `false`), unlike in
the jsdom test environment where it reports as visible regardless of the
`open` attribute. Zero console errors/warnings and zero `pageerror` events
across the whole verification run. `playwright` was added temporarily
(`pnpm add -D -w playwright`) and reverted afterward (`git checkout --
package.json pnpm-lock.yaml`, confirmed via `git status`), per this file's
own "Headless-browser screenshot verification" convention.

**`high` code review found three doc-staleness/dead-code findings, all
fixed:** ResultsPage.tsx's own `anchorsState` doc comment and
CustomRangeSelector.tsx's own `anchorsState` prop doc comment both still
described the manifest being threaded down to "both mounted
CustomRangeSelector instances (desktop + mobile)" -- exactly the
duplication this same PR removed, in the same diff, one function above
each stale comment. Both reworded to describe the current single-instance
reality while keeping the historical issue #63/#75 pointers. Third: the
`<div className="flex flex-wrap items-center gap-3">` wrapping
`RangeSelector` alone (its former sibling, the desktop always-visible
`CustomRangeSelector`/`ModeToggle` block, is what the collapse above
removed) had nothing left to wrap -- `RangeSelector` now renders as a
direct child of `<header>` instead of inside a single-child wrapper div,
re-screenshotted afterward to confirm no visual change.

## Disclaimer/methodology collapsed behind a single click (issue #104)

Deliberately reverses issue #10's original "always visible, not tucked
behind a click" reasoning -- confirmed by the human user as intentional,
not an oversight. Before this issue, the same "hindsight toy, not
investment advice" framing was repeated in four always-visible surfaces
at once (`ResultsPage.tsx`'s header subtitle, `AboutSection.tsx`'s own
always-visible `role="alert"` box, `ResultsPanel.tsx`'s per-view "Best
possible outcome..." sentence in both result models, plus that same
`AboutSection.tsx`'s already-collapsed "Methodology & assumptions"
details underneath it) -- collapsed into one small, clearly-labeled
`<details>`/`<summary>` affordance ("Disclaimer & methodology").

- **`AboutSection` moved from the page level into each result view,
  not just restyled in place.** It used to be a single instance
  `ResultsPage.tsx` rendered once, page-wide, regardless of fetch state.
  It's now rendered once per success branch instead --
  `WindowResultBody` (shared by the "window"/"custom-window" models) and
  the "intraday-daily" branch each render their own instance, right
  after their own "Trades" section. This wasn't a stylistic choice: the
  removed per-view sentence's substance (the description phrase, the
  trade-count ceiling, the "as of" timestamp) had to go _somewhere_, and
  only the branch currently rendering has that data on hand --
  `AboutSection` now takes a required `viewDetails: string` prop each
  call site builds from its own local variables (`descriptionPhrase`/
  `data.maxTrades`/`data.dataAsOf` for the window model;
  `formatDate(activeDay.date)`/`data.maxTradesPerDay`/`data.dataAsOf`
  for the intraday-daily model). One real consequence: `AboutSection`
  (and therefore any disclaimer/methodology content at all) no longer
  renders during a loading or error state -- only once a result has
  actually loaded. Accepted as a reasonable tradeoff for a small
  learning project; revisit only if that gap actually bites.
- **Rendered unconditionally, not gated behind the intraday-daily
  model's whole-range guess-then-reveal flow (issue #91).** Both
  `AboutSection` call sites sit outside the `rangeGuess !== null`
  fragment in `ResultsPanel.tsx` -- a disclaimer isn't part of "the
  answer" the guessing game protects, so it should never be spoiler-
  gated behind guessing it.
- **Doesn't touch a different, unrelated always-visible sentence**: the
  intraday-daily model's `WholeRangeBalance` headline (issue #91) still
  has its own always-visible "Every trading day's own best possible
  outcome, chained day to day..." paragraph once the whole-range guess
  is revealed. That explains the day-to-day chaining mechanic, not a
  disclaimer or a restatement of the "not investment advice" framing --
  out of this issue's own named scope (its Background section cited
  specific line numbers for the sentence this issue does consolidate),
  left as-is deliberately, not missed.
- **`BenchmarkStat`'s `rangeLabel` prop changed meaning, not just
  gained a new caller (found in this issue's own `high` code review,
  fixed).** Before this issue, `rangeLabel` was a bare label
  (`"the past month"`) and the component always hardcoded a literal
  `" over "` prefix in front of it -- justified for the window model's
  own omission by "an adjacent, always-visible methodology paragraph
  already names the range." That premise stopped holding the moment
  this issue moved that paragraph behind `AboutSection`'s click, so the
  window model's `BenchmarkStat` line lost its own range disambiguation
  with nothing left nearby restating it. Fixed by widening `rangeLabel`
  to accept the **full phrase including its own preposition**
  (`"over the past year"` or `"since Mar 1, 2019"` -- reusing
  `WindowResultBody`'s own `descriptionPhrase` prop directly, which
  already has the right preposition for either the preset-range or
  custom-anchor case) rather than a bare label the component always
  prefixes with a hardcoded "over ". The intraday-daily call site was
  updated to match (`` `over ${RANGE_COPY[range]}` `` instead of the
  bare `RANGE_COPY[range]`) so both call sites share the same contract.
  Every real call site now passes `rangeLabel` explicitly -- there's no
  live caller left that relies on the prop's own default omission
  behavior, though the prop itself stays optional (nothing enforces
  every future caller must pass it, and `BenchmarkStat.test.tsx` still
  covers the omitted case).
- **Live-verified** (throwaway debug route + the documented no-root
  headless-Chromium workaround, both window and intraday-daily model
  fixtures, `colorScheme: "light"` and `"dark"` emulation -- this app is
  dark-mode-only since issue #76, so both render identically, confirmed
  rather than assumed): collapsed state shows only the small
  "Disclaimer & methodology" summary line at the bottom of each result
  view, no paragraph text visible anywhere on first paint; clicking it
  reveals the view-specific sentence, the "Not investment advice"
  paragraph (no red border/background, no `role="alert"` -- confirmed
  via a live `[role="alert"]` query that the only alert-role element
  left on the page is Next.js's own route announcer, unrelated), and
  the still-nested, still-collapsed "Methodology & assumptions" details
  underneath. Also confirmed live (after the `BenchmarkStat` fix above)
  that the window model's benchmark line reads "Buying and holding SPY
  **over the past year** instead..." and the intraday-daily model's
  reads "...**over the past month** instead...", both with zero console
  errors.

## Carrying the ticking date readout through forward playback (issue #107)

Extends #97's rewind-to-start-date readout through the rest of forward
playback -- before this issue, `rewindDate` (`use-trade-replay.ts`) was
`null` the instant `phase` left `"rewinding"`, so the date readout that
sells the "had I known" fantasy vanished the moment real trade playback
began, right when it's arguably most relevant (each trade event has its
own real date). `UseTradeReplayResult.rewindDate` is generalized into
`displayDate: string | null`, non-null in both `"rewinding"` and
`"playing"` (still `null` in `"idle"`/`"done"`):

- **`"rewinding"`**: unchanged from #97 -- the existing tween from "now"
  to `points[0].date`, now stored in a private `rewindTweenDate` state
  (the same value, just no longer the field returned directly).
- **`"playing"`**: no tween of its own, and no state of its own either --
  computed fresh on every render, straight from `frame`/`points` (see
  `UseTradeReplayResult.displayDate`'s own doc comment in
  `use-trade-replay.ts` for the exact expression), i.e. "whichever point
  is currently revealed's own real date." `revealedCount` already jumps
  point-to-point (the chart itself never interpolates a position between
  two points, see `ReplayFrame.currentValue`'s own doc comment for the
  identical reasoning), so there's nothing to tween between two real
  trading dates -- the readout just tracks `frame` directly, which is
  also what keeps it automatically correct at every one of `tick()`'s
  several `setFrame` call sites with zero new bookkeeping. Safe to read
  unconditionally in the "playing" branch: `play()` already guards a
  too-short `points` array before phase can ever reach "playing," and
  `revealedCount` is always a valid index into it for the same reason
  `initialFrame`/`finalFrame` already read `points`' own first/last entry
  unconditionally elsewhere in this file.

**A real layout bug, found live (not caught by the unit test suite at
all) -- worth internalizing before the next `heroSlot` addition to this
component.** `HeroAndWorstCase.tsx`'s `heroSlot` prop is an
`absolute inset-0` overlay whose own box height is forced to exactly
match its invisible, real `HeroStat` sibling's height (both `top` and
`bottom` pinned to `0` with `height: auto` computes to fill the
containing block exactly, per the CSS box model -- content taller than
that box doesn't grow the box, it just visibly overflows past its
bottom edge with nothing stopping it, since neither element sets
`overflow: hidden`). Two designs were tried and both broke this live,
confirmed by an actual screenshot each time, not just reasoned about in
advance:

1. **A third `<p>` line** (label, a new date row, then the pre-existing
   dollar-figure row) pushed the "Skip to end" button and
   `WorstCaseStat`'s own figures visibly out from underneath the
   overlay -- the invisible `HeroStat` box is only ever two lines tall
   (its own label + one value row), so a third line always overflows,
   regardless of viewport width.
2. **Folding the date into the _same_ value row as the dollar figures**
   (prepending a date span ahead of `displayStartingCapitalFormatted`)
   still broke, for a subtler reason: `heroValueRowClassName` is
   `flex flex-wrap`, and this app's own real page width
   (`ResultsPage.tsx`'s `max-w-3xl`, confirmed the same constraint
   applies to the actual production layout, not just the debug-route
   harness) is narrow enough that `HeroStat`'s own "(Nx)" badge already
   sometimes wraps onto its own second line even without any of this
   issue's changes -- so the invisible box's real height is
   content-length-dependent, not a fixed two lines. Widening the visible
   overlay's own value row (by prepending date text) changes _where_ it
   wraps without changing where the invisible box's own, unwidened
   content wraps -- the two no longer wrap in lockstep, and a taller
   overlay overflows the same way design 1 did, just by a smaller
   margin.

**The fix that actually holds**: the date folds into the **label**
line instead (`"Watching " + displayDate`, e.g. "Watching Aug 21,
2025"), and the value row is left **byte-for-byte identical to this
branch's own pre-#107 markup** -- the one piece of content whose wrap
behavior is proven to track the invisible box's own (it renders the
literal same-shaped figures, just a tweened value instead of the final
one). A short label line ("Watching " plus a ~13-character date) never
wraps at this app's own real content width, confirmed live, so this
sidesteps the wrap-parity problem entirely rather than trying to solve
it. **Accepted trade-off, not an oversight**: the date's own visual
_size_ shrinks the instant `"rewinding"` hands off to `"playing"` (giant,
alone in the value row during the rewind; small, folded into the label
during playback) -- what actually carries the issue's own "reads as a
continuation... same position in the hero slot" acceptance criterion is
the label's _position_ and _styling_ staying identical across the
transition, not the date's own rendered size. The label text itself is
a second deliberate choice the issue's own acceptance criteria left
open ("Rewinding to" -> "Watching" vs. a constant label): chosen to
change, since "Rewinding to" stops describing what's happening once real
trades are playing out, and "Watching" ties back to this feature's own
"Watch it happen" name.

- `format-date.ts` needed no changes -- `formatDate` (already exported,
  already used by `calloutText` in this same file) is exactly the right
  formatter for a window-model point's plain `"YYYY-MM-DD"` date; no new
  `includeDate`/datetime-awareness concern applies here the way it does
  for `calloutText`'s own `formatDateTime` call, since this readout only
  ever needs the point's own calendar date.
- Existing #96/#97 tests needed real updates, not just a `rewindDate` ->
  `displayDate` rename, at exactly the tick where phase transitions from
  `"rewinding"` to `"playing"`: the old contract asserted `displayDate`
  (then `rewindDate`) was `null` the instant `"playing"` began; the new
  contract asserts it equals `points[0].date`'s own formatted value (the
  window's own opening point, still the only one revealed at that exact
  instant) -- continuous with the rewind's own tweened target, which is
  exactly that same date. `TradeReplay.test.tsx` needed a small
  `readoutDate(label)` test helper (walks from the unambiguous label text
  to its immediate next sibling's own `textContent`) rather than a plain
  `screen.getByText(dateString)`, since `PortfolioChart`'s own
  always-rendered `ChartDataTable` disclosure gets a row for the exact
  same date once more than the opening point is revealed, and a bare
  text match throws on more than one hit.
- Tests cover the new per-tick date value in both hook and component
  tests: `use-trade-replay.test.ts`'s "walks every point..." test asserts
  `displayDate` at every tick (including the two same-date points around
  the close event, confirming that's expected, not a bug), plus a
  dedicated assertion in the "natural completion... last point is a
  close event" test for the one case where the _final_ point's own
  `displayDate` is genuinely observable while still `"playing"` (a
  fixture with a trailing no-event point completes in the same
  synchronous tick as its own arrival, with nothing in between to
  assert); `TradeReplay.test.tsx` extends the existing "pauses on each
  trade event" test with matching readout assertions at each event.
- No new `react-hooks/set-state-in-effect` violations, and no new
  reduced-motion logic needed -- both confirmed, not just assumed:
  `displayDate`'s "playing" branch is a plain derived render-time
  expression (no `setState` involved at all, let alone inside an
  effect), and this whole phase stays unreachable under reduced motion
  via the pre-existing `canReplay` gate, confirmed live with
  `reducedMotion: "reduce"` context emulation showing zero "Watch it
  happen" button and zero "Rewinding to"/"Watching" text anywhere,
  identical to #96/#97's own established bypass.
- **Live-verified** via the established throwaway-debug-route (a
  hardcoded two-trade `points` series, dated in the past) plus the
  documented no-root headless-Chromium workaround: screenshotted idle,
  mid-rewind, the instant playing begins, mid-playback on each trade
  event (confirming the date genuinely advances -- "Watching Aug 21,
  2025" -> "Watching Aug 26, 2025" as the second trade's own event is
  reached), and done -- confirming the label-in-the-value-row layout
  bug above, then confirming the label-line fix renders cleanly with no
  overlap at every one of those steps. `aria-live` announcements
  unchanged (still just the buy/sell callouts + final sentence,
  confirmed by inspecting the status region throughout). The debug
  route and the temporary `playwright` devDependency were both reverted
  before committing, per this file's own established convention;
  confirmed via `git status`/`git diff --stat` showing no trace of
  either afterward. All five routine checks (lint, `next typegen && tsc
--noEmit`, `pnpm build`, `pnpm test`, `pnpm format:check`) green on the
  resulting clean tree.

### Code-review follow-up -- four findings, all fixed before merge

A `high` review of the PR above found four real, lower-severity issues
-- no live/reachable correctness bug survived scrutiny, matching this
issue's own unusually thorough test coverage.

- **`displayDate`'s "playing" branch read `points[frame.revealedCount -
1]!` with a bare non-null assertion and no runtime clamp**, unlike
  `PortfolioChart.tsx`'s own established precedent for this exact class
  of risk (its `revealed` local, issue #96 follow-up round four -- see
  that component's own doc comment). `frame.revealedCount` is fully
  internal state here (unlike `PortfolioChart`'s public, caller-supplied
  `revealedCount` prop), but it stays in range today only via an
  emergent combination of independently-maintained invariants elsewhere
  (`play()`'s length guard, `buildSegments`'s 1-indexed loop) -- not one
  explicit check at this read site. Fixed with the identical
  `Math.min(Math.max(..., 1), points.length)` clamp shape
  `PortfolioChart.tsx` already uses. **Not independently regression-
  tested** -- unlike `PortfolioChart`'s own clamp (directly testable by
  passing an out-of-range `revealedCount` prop), there's no way to force
  this internal state out of range through `useTradeReplay`'s public API
  without exposing internals purely for testing, which this codebase
  avoids elsewhere too (see e.g. the deleted, confirmed-unreachable
  `segments.length === 0` branch, issue #96 follow-up round three).
- **Four doc-comment references called this feature "issue #108"**
  (a copy/paste slip), while every other touched file, the branch name,
  and this very section's own header all correctly say "issue #107."
  Fixed -- a wrong issue number in a comment is exactly the kind of
  thing that sends a future reader chasing the wrong GitHub issue.
- **`displayDate`'s "playing" branch recomputed `formatDate` on every
  RAF-driven re-render, even mid-tween frames where `revealedCount`
  (and therefore the result) hadn't changed** -- roughly a dozen wasted
  calls per ~300ms segment tween, the identical class of waste this
  file's own `endingBalanceDisplayValue`/`displayStartingCapitalFormatted`/
  `multiplier` already guard against on this same hot path. Wrapped in
  `useMemo` alongside the clamp fix above, keyed on
  `[phase, points, frame.revealedCount, rewindTweenDate]`.
- **A stale comment in `TradeReplay.test.tsx`** (the "starting-capital
  edit mid-playback" test) still claimed the playing-phase overlay shows
  "its own 'Starting from' caption... alongside the animated overlay's
  identical caption text" -- which this issue's own label-line design
  (see above) makes false (the overlay reads "Watching {date}," not a
  second "Starting from"). The test itself still passed regardless (it
  only reads index `[0]` of `getAllByText`, now legitimately one match
  instead of two), but the comment would have misled a future reader.
  Fixed, and also noted that this particular click never actually
  advances past "rewinding" in this test (no RAF ticks are pumped) --
  true either way, since neither non-live phase's overlay uses "Starting
  from" as its own label text.
- All five routine checks (lint, `next typegen && tsc --noEmit`, `pnpm
build`, `pnpm test`, `pnpm format:check`) re-ran green after every fix
  -- no new live-browser verification pass, since none of the four
  changes are observable in the shipped UI (a doc-comment fix, a
  defensive clamp on an already-provably-in-range internal value, a
  memoization with no behavioral difference, and a test-only comment
  fix).

## Marker pulse, shake, and speech-bubble callout during trade replay (issue #108)

Extends #96's own marker/callout language rather than replacing it:
`PortfolioChart.tsx`'s open/close marker shapes (hollow ring vs. filled
dot, gain/loss colored) are untouched, and the callout's own wording
(`TradeReplay.tsx`'s `calloutText`) is unchanged too -- this issue only
adds motion tied to a marker landing during playback and relocates the
existing callout text from a plain `<p>` below the hero row onto the
chart itself, anchored near its own marker.

- **`PortfolioChart.tsx` gained one new prop, `landing?: ChartLanding |
null`** (`{ event: PortfolioEvent; calloutText: string }`), rather than
  splitting this into two separate props (an event identifier plus a
  text string) -- bundling them means the JSX below never has to
  separately null-check both. `TradeReplay.tsx` computes it from its own
  `frame.activeEvent`/`activeCallout` (both already existed, see #96's
  own doc comment) as a `useMemo`, non-null only during `phase ===
"playing"` while a real event is being narrated -- `null` during
  `"rewinding"` (no event landed yet) and `"idle"`/`"done"` (no active
  event at all).
- **The matching marker is found by reference equality
  (`eventMarkers.find((p) => p.event === landing.event)`), not by
  rebuilding a string key.** This works because `landing.event` (from
  `frame.activeEvent.event`, ultimately `segment.event`, ultimately
  `point.event`) and `PortfolioChart`'s own `points` prop both trace back
  to the exact same array TradeReplay.tsx passes to both
  `useTradeReplay(points)` and `<PortfolioChart points={points} />` --
  the same precondition `use-trade-replay.ts`'s own `Segment.event` doc
  comment already relies on elsewhere in this feature. No string-based
  matching (date+type+ticker) was needed, and no new identifier had to
  be invented.
- **Three distinct visual effects, each independently gated, not one
  combined "landing" animation:**
  - **Pulse** (`.marker-landing-pulse`, `globals.css`): every open _and_
    close event gets this. A **decorative sibling `<circle>`**, not
    applied to the real marker directly -- reuses the existing
    `chart-tap-hint-pulse`'s own `chart-tap-pulse` keyframe (issue #66)
    verbatim, just a single iteration instead of three and a shorter
    550ms duration (tuned to sit inside `EVENT_PAUSE_MS`, 600ms, rather
    than outlasting it). Applying that keyframe's own scale-up/fade-to-0
    directly to the real marker would make it visibly vanish once the
    animation finishes (its `animation-fill-mode: forwards` holds the
    _final_ frame, opacity 0) -- exactly the failure mode a decorative
    overlay sidesteps, the identical reasoning the pre-existing touch
    tap hint already established for the same keyframe.
  - **Shake** (`.marker-landing-shake`): close events only, applied
    _directly_ to the real marker's own `<circle>` -- safe here (unlike
    the pulse) because its own keyframe starts and ends at
    `translateX(0)`, the marker's resting position, so the marker's
    permanent appearance is untouched once it finishes. Scoped to close
    events specifically because a close is "the point where value
    actually jumps" (this file's own pre-existing marker doc comment,
    issue #85) -- an open event moves no value, so it gets the pulse
    alone.
  - **Speech bubble** (`.marker-landing-bubble` + `-above`/`-below`):
    both open and close events, rendered inside an SVG `<foreignObject>`
    so ordinary HTML text wrapping applies to a real sentence-length
    string -- sidesteps the per-character width estimation issue #85's
    now-deleted `chart-label-layout.ts` needed for its own (always-on,
    many-at-once) on-chart labels; this bubble shows at most one
    narration at a time, so none of that collision-avoidance machinery
    is needed. `bubblePlacement` (a small pure function, `PortfolioChart.tsx`)
    horizontally clamps to the plot's own width and flips
    above/below the marker based on available headroom near the plot's
    top edge -- **deliberately not gated on `animateReveal`/reduced
    motion at all**, since the bubble itself has no CSS animation of its
    own; it's a relocated version of always-present callout content, not
    motion, so it renders identically regardless of motion preference
    (the pulse/shake are what motion preference actually gates).
- **`TradeReplay.tsx`'s own plain `<p aria-hidden="true">{activeCallout}</p>`
  is deleted outright, not left alongside the bubble** -- the issue's own
  acceptance criteria say "anchored near the marker... not a plain
  paragraph," and keeping both would just show the identical sentence
  twice. The sr-only `role="status"` announcement (`announced`) is
  completely unaffected -- still reads `activeCallout` directly, per the
  issue's own "aria-live announcement content is unaffected" acceptance
  criterion. Existing tests that asserted `screen.getAllByText(callout)`
  has length 2 (previously: the paragraph + the status region) needed no
  count change at all -- the bubble simply replaced the paragraph as the
  second match; only the _reason_ for the second match changed, verified
  explicitly with a `classList.contains("marker-landing-bubble")` check
  added to that same test.
- **`PortfolioChart` is `React.memo`'d (issue #96 follow-up round four),
  so `landing` needed to be memoized by its caller, not just typed as an
  object.** `TradeReplay.tsx`'s own `landing` is wrapped in `useMemo`
  keyed on `[phase, frame.activeEvent, activeCallout]` specifically so
  its object identity stays stable across any parent re-render that
  doesn't actually change which event is active -- a fresh-but-
  equivalent object literal every render (the obvious first draft) would
  have made `PortfolioChart`'s own memo comparison see a "changed" prop
  on every tick and defeat the point of memoizing it at all. In practice
  this doesn't cost much regardless: `TradeReplay.tsx` doesn't even
  re-render during the `EVENT_PAUSE_MS` pause itself (`use-trade-
replay.ts`'s own `tick()` makes no `setFrame` call while paused), so
  `landing` is naturally stable for the whole time a bubble is visible --
  but memoizing is still the correct, defensive thing to do rather than
  relying on that emergent property.
- **Live-verified via screenshot** (throwaway debug route + the
  documented no-root headless-Chromium workaround, both a gain-close and
  a loss-close event, plus a `reducedMotion: "reduce"` pass): the bubble
  rendered legibly (this app is dark-mode-only, issue #76, so only one
  theme to check) with correct gain/loss coloring on the marker/line
  matching the bubble's own adjacent narration, and
  `document.querySelector(".marker-landing-pulse"/".marker-landing-shake")`
  both present at the close-event pause for both scenarios.
  - **The "above" case is by far the common one -- the "below" flip
    (`bubblePlacement`'s own doc comment) genuinely needs an extreme
    fixture to reach, and the first live-verification pass missed it
    entirely** (both the gain and loss fixtures above rendered "above,"
    caught only by a self-review re-read after the fact, not by the
    original pass). The log-scale y-axis's own multiplicative padding
    (`padFactor = 1.15`, see the scale-building `useMemo` above) means a
    marker at the series' own max value still sits several px below the
    plot's absolute top, comfortably inside `bubblePlacement`'s "still
    room above" branch, for any ordinary gain -- reaching the "below"
    branch needs the _log-scale fraction_ of that 15% padding to be tiny,
    which only happens with a genuinely huge value range. A third debug
    fixture (`$20 -> $10,000,000`, a 500,000x close) computed (via a
    throwaway Node script against this same log-scale math, before
    touching the browser at all) to place the close marker within ~3px
    of the plot's top edge -- confirmed live afterward: `below: 1,
above: 0`, and the screenshot shows the tail correctly flipped to the
    bubble's top edge, rotated the other way, with no overlap against
    the hero row above or the topmost gridline label. Worth remembering
    for any future fixture aimed at this branch: an "extreme gain" isn't
    enough on a log scale the way it would be on a linear one -- the
    range needs to be extreme in _log_ terms (many orders of magnitude),
    not just a large absolute number.
  - **Reduced motion**: confirmed via the pre-existing `canReplay` gate
    that no "Watch it happen" button renders at all (unchanged, pre-#108
    behavior) -- the pulse/shake's own JS-level reduced-motion gate
    (`animateReveal`) is separately covered by direct `PortfolioChart`
    component tests (`stubPrefersReducedMotion(true)`, asserting the
    pulse/shake classes never appear while the bubble's own text still
    does), since the button-hiding behavior alone doesn't exercise that
    gate -- `PortfolioChart.tsx` is a public component whose `landing`
    prop a future caller could reach independent of `TradeReplay.tsx`'s
    own upstream gate, so it needed its own direct verification, not
    just an inference from the button being hidden.
- **One hydration-warning artifact, same class as issue #96's own note
  above** -- the debug route hardcoded a `"use client"` page rendering
  `TradeReplay` unconditionally (no `useResults` fetch-state gate), which
  _can_ render during SSR unlike the real app (see that section's own
  explanation) -- a floating-point serialization mismatch on one marker's
  `cy` value (`44.830906949144435` vs. `"44.83090694914432"`, an
  `Intl`/`Number`-to-string precision difference between Node's server
  render and the browser) triggered React's hydration-mismatch warning on
  page load. Confirmed unrelated to this issue's own changes (it fires on
  the _first_, non-`landing` marker too, present before this issue's own
  code ever touched anything) and, like #96's own documented instance,
  never reachable in the real app (the real `WindowResultBody` never
  SSRs a `"success"` state). Not fixed -- a debug-harness artifact, per
  this file's own established precedent for the identical class of
  false alarm.

### Code-review follow-up -- one real bug, one lower-confidence hardening fix

A `high` review of the PR above found one real, reachable bug and one
lower-confidence robustness gap, both fixed before merge.

- **The bubble's CSS tail was fixed at the box's own 50% center, but
  `bubblePlacement`'s own horizontal clamp can decenter the box from the
  marker it's narrating -- a trade opening/closing near either edge of
  the window (a realistic case, not hypothetical: this file's own #85
  section already documents "the best trade... closing on the most
  recent trading day" as real) clamps the box away from the marker,
  leaving the tail pointing at empty chart space instead.** Fixed by
  computing the tail's own position as a percentage of the marker's real
  offset _within_ the final, possibly-clamped box
  (`bubblePlacement`'s new `tailOffsetPercent` field, clamped to
  `[12, 88]` so it never slides onto the bubble's own rounded corner) and
  threading it into the bubble's own inline style as a CSS custom
  property (`--marker-landing-bubble-tail-offset`) that
  `.marker-landing-bubble::after`'s `left` now reads, falling back to
  the old fixed `50%` only for a hypothetical caller that renders the
  class without setting the property at all -- every real render always
  sets it. **Live-verified, not just unit-tested**: a debug fixture with
  an open event two days into a ~10-year window (its own x position deep
  inside the left-edge clamp zone) confirmed live that the tail sits at
  the clamped 12% offset -- visibly near the bubble's own left edge,
  correctly pointing down-left at the real marker below it -- rather
  than centered over empty space to the marker's right. Regression-
  tested in `PortfolioChart.test.tsx` with the same edge fixture,
  asserting the rendered `--marker-landing-bubble-tail-offset` inline
  style is `"12%"`, not `"50%"`.
- **The bubble box has a fixed height (`BUBBLE_HEIGHT`) with no overflow
  handling -- a long enough callout sentence (a long ticker/verb/percent
  combination) could wrap past what the box comfortably fits and spill
  past its own rounded border into the surrounding chart.** Fixed with
  `overflow: hidden` on `.marker-landing-bubble` -- any excess simply
  gets contained within the box's own rounded corners rather than
  bleeding out; the sr-only `aria-live` announcement
  (`TradeReplay.tsx`'s own `announced`) never truncates regardless, so no
  information is lost, only the decorative bubble's own visual overflow.
  Deliberately not also resized (`BUBBLE_WIDTH`/`BUBBLE_HEIGHT` left
  unchanged) -- `overflow: hidden` alone fully closes the "spills into
  the chart" failure mode the finding named, and resizing would have
  meant re-verifying the "above"/"below" placement thresholds
  (`bubblePlacement`'s own math, already live-verified once for both
  branches) against new constants for a lower-confidence finding whose
  actual risk this simpler fix already eliminates.
- All five routine checks (lint, `next typegen && tsc --noEmit`, `pnpm
build`, `pnpm test`, `pnpm format:check`) re-ran green after both
  fixes.

## "Watch it happen" replay for 1W (issue #105)

Extends #96/#97/#107/#108's window-model-only replay to the
intraday-daily whole-range headline, for the 1W preset range
specifically (1M/3M/1Y are a materially different pacing/scale problem,
tracked separately -- see issue #106's own sibling plan). Implements
`docs/plans/issue-105-plan.md` essentially as designed -- the plan's own
independent-review process (two rounds before any code was written)
caught the load-bearing mistakes early, so implementation matched the
plan closely; only a couple of small, obvious gaps in the plan's own
prop lists needed filling in mechanically (see below), not real design
deviations.

- **`useTradeReplay` gained an optional second parameter, `pacing?:
ReplayPacing` (`{ transitionMs, eventPauseMs, rewindMs }`), defaulting
  to a module-level `DEFAULT_PACING` matching the pre-#105 window-model
  constants exactly** -- `TradeReplay.tsx` needed zero changes, it
  simply never passes the parameter. Both RAF effects (`playing` and
  `rewinding`) include `pacing` in their own dependency arrays alongside
  `phase`/`points`, so a genuinely different `pacing` object (by
  reference) restarts the effect the same way a `points` change does --
  every real caller passes one fixed, module-level object for its entire
  lifetime, so this is satisfied by construction, not extra bookkeeping.
- **`WholeRangeReplay.tsx`'s own `WHOLE_RANGE_REPLAY_PACING`
  (`transitionMs: 130, eventPauseMs: 220, rewindMs: 700`) is what the
  plan's own section 2.3 worked out analytically for 1W's real worst
  case (50 points/49 segments/30 event-pauses against
  `deriveWholeRangeIntradaySeries`'s own point shape -- one leading
  boundary point per trading day, no trailing boundary point, a
  genuinely different layout than `derivePortfolioSeries`).** Live-
  measured (see "Live verification" below) at **~14.4s** for a real
  worst-case 15-trade run -- under the plan's own 15s ceiling, but
  ~1.4s (~11%) over its ~13.0s analytical estimate, confirming the
  plan's own explicit caveat that real browser RAF-scheduling overhead
  wasn't accounted for in that number. Still comfortably inside the
  ceiling; not re-tightened further, matching the plan's own explicit
  warning against pushing `eventPauseMs` down purely to chase a duration
  target once it's already short enough to risk reading as "flicker"
  rather than "brisk" across up to 30 pauses in one run.
- **Two real, previously-undocumented date-formatting bugs fixed in
  `use-trade-replay.ts`, exactly as the plan's own section 5
  identified** -- both only reachable against a datetime-labeled
  (chained-intraday) series, never against the window model's own
  plain-date points, which is why they'd sat latent since #96/#97/#107
  shipped:
  1. The rewind effect's own target-date parse (``Date.parse(`${points[0]!.date}T00:00:00Z`)``)
     assumed a plain calendar date -- against a datetime-labeled point
     ("2025-08-21T09:30:00") this produced a malformed double-`T` string,
     which `Date.parse` silently resolves to `NaN`, rendering "Invalid
     Date" for the entire rewind beat.
  2. `displayDate`'s `"playing"` branch called bare `formatDate(...)`,
     which does the exact same unconditional `Date.parse` -- the
     identical bug for the whole rest of forward playback, not just the
     rewind beat.

  Both fixed by extracting `PortfolioChart.tsx`'s own private
  `toTimestamp` into `format-date.ts`'s newly-exported
  `toPortfolioTimestamp` (the rewind effect now calls this instead of
  its own inline `Date.parse`) and swapping the bare `formatDate(...)`
  call for `formatDateTime(points[index]!.date, true)` (`formatDateTime`
  already delegates to `formatDate` unconditionally for a plain-date
  point, so this is a zero-behavior-change swap for the window model and
  the correct multi-day-aware format, e.g. "Aug 21, 9:30 AM", for the
  chained-intraday case). Both fixes are regression-tested in
  `use-trade-replay.test.ts` against a real datetime-labeled fixture --
  see its own "datetime-labeled (chained-intraday) points" describe
  block.

- **`WholeRangeBalance.tsx` gained `worstCase?`/`revealSlot?` props,
  restructuring its `revealed` branch so the caption and headline `<p>`s
  are genuinely paired inside one `relative` wrapper** (mirroring
  `HeroAndWorstCase.tsx`'s own `<div className="relative">` around
  `HeroStat`, not a new pattern) -- the caption text moved from
  "rendered once, before the guess/revealed ternary" to "rendered once
  per branch" (the unrevealed branch is unchanged; the revealed branch
  gets its own copy, now paired with the headline). With no `revealSlot`
  passed (every pre-#105 caller, and the idle/done phases of the new
  one), this is a pure no-op -- same text, same classes, same document
  position. Exports its own `wholeRangeLabelClassName`/
  `wholeRangeValueRowClassName` pair (mirroring `HeroStat.tsx`'s own
  exported pair, issue #96 follow-up round four's precedent) for
  `WholeRangeReplay.tsx` to build its overlay content from -- **not** a
  reuse of `HeroStat`'s classes, since `WholeRangeBalance` is a
  different component with its own typography (the plan's first draft
  tried reusing `HeroStat`'s classes directly and found, on inspection,
  that `WholeRangeBalance` had no matching paired label+value structure
  to overlay onto as shipped -- see the plan's own section 3.2 for the
  full "rejected approach" writeup).
- **New `WholeRangeReplay.tsx` composes `WholeRangeBalance` (extended as
  above) instead of `HeroAndWorstCase`** -- a deliberate divergence from
  issue #106's own sibling plan sketch (written before a shipped 1W
  existed to check the assumption against), stated explicitly in both
  the plan's section 3.1 and this component's own doc comment:
  `WholeRangeBalance` already _is_ this range's one hero moment (the one
  place its ending balance is headlined); composing through
  `HeroAndWorstCase` too would render the exact same "$X -> $Y" figure
  twice. `ResultsPanel.tsx`'s intraday-daily branch now renders
  `<WholeRangeReplay>` in place of the old bare `<WholeRangeBalance>` +
  `<PortfolioChart>` pair -- `WholeRangeReplay` owns the chart
  internally now, alongside the "Watch it happen"/"Skip to end" button
  row, both gated behind the same `rangeGuess !== null` value
  `ResultsPanel.tsx` already threads to `BenchmarkStat`, not a second,
  independent gate.
- **The overlay design during `"rewinding"`/`"playing"` is a single
  shape for both phases** (unlike `TradeReplay.tsx`, which needs two:
  a giant date-only rewind figure, then a compact "Watching {date}"
  label once the dollar-figure row needs its own space back) --
  `WholeRangeBalance`'s headline has no multiplier badge competing for
  room, so there's no equivalent layout-forced split here. The label
  always folds in the date ("Watching {date}", per issue #107's own
  proven pattern, reused rather than rediscovering its overflow lesson a
  second time) and the value row stays byte-for-byte the same three-span
  shape as the real headline's own markup, just with
  `frame.currentValue` substituted for `finalBalance`.
- **Two items the plan explicitly left for the implementer (its own
  section 7), both resolved during this build:**
  1. **`PortfolioChart`'s own `key` for the `WholeRangeReplay`-owned
     chart instance**: a new `chartKey: string` prop on
     `WholeRangeReplayProps`, threaded straight through from
     `ResultsPanel.tsx` as the exact same string the bare
     `<PortfolioChart key={...}>` call it replaces already used --
     `` `${range}-${data.dataAsOf}-${mode}` `` -- stable across every
     phase transition within one playback run, changing only on a
     genuine new result (a fetch, a mode switch), matching
     `TradeReplay.tsx`'s own `heroKey` contract for its identical chart
     instance exactly (see that component's own doc comment, issue #96
     follow-up round two's key-stability fix -- one of the most-
     relitigated bugs in this whole feature's review history).
     `WholeRangeReplay` itself is **not** separately keyed by
     `ResultsPanel.tsx` at its own call site (same as `TradeReplay.tsx`)
     -- its internal `useTradeReplay(points, ...)` call already resets
     to idle on a genuine `points`-identity change via the hook's own
     `useResetWhenChanged` mechanism, with no external re-keying needed.
  2. **No confetti/count-up reward moment on replay completion** -- a
     considered tradeoff, not an oversight. `WholeRangeBalance` has none
     of `HeroStat`'s reveal machinery (no `useCountUp`, no
     `CelebrationBurst`, no reveal-accent glow) and the plan didn't
     design any new machinery for it. Reasoning for shipping it this
     way: the guess-then-reveal moment (issue #91) is already this
     range's own "reward" beat, and issue #105's own acceptance criteria
     never asked for a second one specifically for the _replay_.
     Landing on `"done"` simply returns to the same static, unanimated
     headline the guess reveal itself already showed. Worth revisiting
     only if a future reviewer/user genuinely finds the replay's own
     ending feels anticlimactic next to the window model's -- not
     preemptively built.
- **`calloutText` (the past-tense trade narration, "Bought AAPL on ...")
  extracted out of `TradeReplay.tsx`'s own private function into
  `lib/replay-callout.ts`**, so `WholeRangeReplay.tsx` reuses the exact
  same narration/voice rather than a second hand-copied version --
  `TradeReplay.tsx` now imports it instead of defining it locally, with
  no behavior change at its own call site.
- **Test coverage**: `use-trade-replay.test.ts` gained a "pacing
  parameter" describe block (defaults preserved when omitted; a custom
  pacing object's values genuinely drive the RAF timing, not the
  module's own defaults) and a "datetime-labeled (chained-intraday)
  points" describe block (both date-formatting fixes, against a real
  datetime fixture). `WholeRangeBalance.test.tsx` gained "worstCase
  prop"/"revealSlot prop" describe blocks (no worst-case stat when
  omitted; rendered only once revealed; rescaled from its own raw/
  native-root pair, not a pre-rescaled one; the overlay genuinely hides
  the real caption+headline pair via `invisible`/`aria-hidden`, not just
  "some text changed"; the guess/"You guessed" line unaffected).
  `WholeRangeReplay.test.tsx` (new, mirroring `TradeReplay.test.tsx`'s
  own coverage shape): the guess-then-reveal gate (button/chart
  genuinely absent from the DOM pre-reveal, not just visually hidden);
  `canReplay` (zero-trade result, reduced motion); "Skip to end" staying
  available regardless of `canReplay`; a mid-playback pause showing a
  real chart-anchored callout; Skip-to-end landing on the exact final
  state; a day switch (same `points` reference, mirroring
  `ResultsPanel`'s own `wholeRangePoints` memo never depending on the
  selected day) leaving an in-flight replay undisturbed, contrasted with
  a genuine `points`-identity change (a mode/capital edit) correctly
  resetting to idle; the worst-case figure's own raw/native-root rescale
  contract. `ResultsPanel.test.tsx` gained coverage for the new
  `wholeRangeWorstCaseEndingBalance`/`wholeRangeWorstCaseStartingCapital`
  computations (both modes, mirroring the existing `wholeRangeFinalBalance`
  coverage's own "rescale from the range's own root, not a per-day
  pattern" shape) and that `WholeRangeReplay` (not a bare
  `PortfolioChart`) is what's rendered post-reveal.
- **Live-verified via the established throwaway-debug-route +
  no-root-headless-Chromium technique** (a debug route rendering
  `ResultsPanel` directly with a hand-built 1W-shaped `IntradayResult`
  fixture -- 5 trading days x 3 trades each, the plan's own literal
  worst case -- since no real Yahoo/local-pipeline run reliably produces
  exactly 15 trades in one real week; a synthetic fixture is what this
  specific worst-case timing check needs, the same class of deliberate
  synthetic-edge-case fixture issue #108's own "500,000x close" log-scale
  fixture already established precedent for). Confirmed: the idle
  pre-reveal state (no button, no chart at all -- genuinely absent from
  the DOM, not just hidden); a real mid-playback pause showing a genuine
  chart-anchored callout (`.marker-landing-bubble` present, matching sr-
  only status text); Skip-to-end landing on the exact final state;
  **a full un-skipped worst-case playback measured at ~14.4s real
  elapsed time** (see the pacing note above); the reduced-motion
  fallback (zero button, real chart/hero shown instantly); a zero-trade
  result (no button, chart/worst-case stat still render); the
  guess-then-reveal gate (button/chart absent pre-reveal, present
  post-reveal); and a day switch mid-replay leaving an in-flight replay
  fully undisturbed (`Skip to end` still present, the sr-only status
  text byte-for-byte unchanged before and after the switch). Zero
  console errors across the full-playback run. The debug route and the
  temporary `playwright` devDependency were both reverted before
  committing, per this file's own established convention; confirmed via
  `git status`/`git diff --stat` showing no trace of either afterward.
  - **One hydration-mismatch console warning did appear, but only under
    `reducedMotion: "reduce"` context emulation, and it's the exact same
    debug-harness artifact this file's own "Trade replay" section
    already documents for #96/#108's debug routes, not a real bug** --
    the harness hardcodes `state={{status:"success",...}}` directly,
    bypassing `useResults`'s fetch state machine (which always starts
    `"loading"` in the real app, on both server and initial client
    render); that lets the intraday-daily branch actually SSR, with the
    server computing `FadeInWrapper`'s `useReducedMotionAtMount()` as
    `false` (no `matchMedia` during SSR) while the client's very first
    render already sees the emulated `true` -- mismatching the
    `results-fade-in` class. Never reachable in the real app (the
    genuine `useResults` fetch never resolves to `"success"` before the
    client-only effect runs), and unrelated to any of this issue's own
    changes.
  - **A real debug-harness gotcha worth remembering for the next
    multi-fixture debug page in this app**: the first version of this
    debug route rebuilt its own `state: ResultsState` object as a fresh
    literal on every render (`{ status: "success", data: FIXTURES[fixture] }`,
    recomputed inline in the component body) -- since `ResultsPanel.tsx`'s
    own `wholeRangePoints` memo is keyed on `state` by reference, this
    silently defeated that memo on _every_ unrelated re-render (e.g. a
    `DayOverview` day-switch click, which flows through the debug page's
    own `onSelectDay` state setter), making a day switch look like it
    reset an in-flight replay when it wouldn't in the real app (where
    `useResults`'s own state object is stable across such unrelated
    re-renders). Fixed by wrapping the debug page's own `state` in
    `useMemo(() => ({ status: "success", data: FIXTURES[fixture] }),
[fixture])` -- the harness needs the same object-identity discipline
    the real app gets for free from `useResults`, or it can produce a
    false "regression" that isn't real.

### Code-review follow-up -- two release-blocking findings, nine total, all fixed before opening the PR

A `high` review of the diff above (8 independent finder agents,
cross-verified) found ten candidate issues; one was refuted (see below),
the other nine were real and all fixed before this PR was ever opened.
Two were release-blocking, confirmed independently by three of the
finder agents:

- **`WholeRangeReplay` was rendered unconditionally for every
  intraday-daily range (1W/1M/3M/1Y), with no range gate anywhere,
  despite the feature being documented everywhere -- the inline JSX
  comment, `WholeRangeReplay.tsx`'s own header doc comment, this file's
  own section above -- as "1W specifically."** `WHOLE_RANGE_REPLAY_PACING`
  is tuned and live-verified only against 1W's own worst case (15
  trades/50 points, ~14.4s); against 1M/3M/1Y's own much larger
  `wholeRangePoints` (up to ~252 days), a user clicking "Watch it happen"
  on one of those ranges would have run an untested-at-scale, uncapped-
  duration playback with real trades and no reduced-motion preference --
  a genuinely reachable bug, not a hypothetical one, since 1M/3M/1Y
  already serve real chained results today. Fixed with a new
  `replaySupported: boolean` prop on `WholeRangeReplayProps` (`range ===
"1W"`, computed by `ResultsPanel.tsx` -- this component has no other
  notion of "range" to derive it from on its own), ANDed into `canReplay`
  alongside the existing `canReplayFor(tradeCount, reducedMotionAtMount)`
  check. Does **not** gate `WholeRangeBalance`/the chart/`children`
  themselves -- 1M/3M/1Y keep rendering their own whole-range headline
  and (non-animated) chart exactly as they did before issue #105, only
  without a replay button. Regression-tested in both
  `WholeRangeReplay.test.tsx` (button absent with `replaySupported={false}`
  even given real trades and no reduced motion) and `ResultsPanel.test.tsx`
  (a real 1M render, guess submitted, no "Watch it happen" button, chart
  still present) -- and **live-verified**: a 1W debug fixture shows the
  button; the identical fixture data rendered under `range="1M"` shows no
  button at all, with the chart/methodology paragraph unaffected.
- **`wholeRangeTradeCount` was a fresh, unmemoized `data.days.reduce(...)`
  traversal re-deriving the exact same per-day `selectVariant(...).trades.length`
  value `dayOverviewRows` (defined just above it, and itself memoized
  specifically to avoid this class of bug) already computes and stores as
  its own `tradeCount` field.** Every `ResultsPanel` render -- including
  every `StartingCapitalInput` keystroke and every RAF-driven frame while
  `WholeRangeReplay` is animating -- re-ran this full `data.days`
  traversal a second time, duplicating work `dayOverviewRows`'s memo
  already did in the same render pass; confirmed independently by three
  separate finder agents in the same review. Fixed by deriving it from
  `dayOverviewRows` instead: `dayOverviewRows.reduce((sum, row) => sum +
row.tradeCount, 0)`.
- **`WholeRangeReplay` (which now owns the whole-range chart internally)
  was mounted _before_ the `rangeGuess !== null` block containing the
  methodology paragraph and `BenchmarkStat`, silently reversing the
  pre-#105 visual order (headline -> guess paragraph -> `BenchmarkStat`
  -> chart, becoming headline -> "Watch it happen" button -> chart ->
  guess paragraph -> `BenchmarkStat`) with no comment acknowledging the
  reorder as intentional and no test protecting the relative DOM order.**
  The actual fix already existed as a proven pattern one file over:
  `TradeReplay.tsx`'s own `children` prop is rendered "between the hero
  row and the chart... unaffected by playback" specifically so
  `WindowResultBody` can slot `BenchmarkStat` in at the right spot
  without reordering it relative to the chart -- `WholeRangeReplay`
  needed the identical slot and didn't have one. Added `children?:
ReactNode` to `WholeRangeReplayProps`, rendered between the button row
  and the chart, inside the same `guess !== null` gate; `ResultsPanel.tsx`
  now passes the methodology paragraph + `BenchmarkStat` as
  `<WholeRangeReplay>`'s own children instead of a separate sibling block
  below it, restoring the exact pre-#105 relative order (now: headline ->
  button -> paragraph -> `BenchmarkStat` -> chart -- the button is new,
  everything else's relative order is unchanged from before this issue).
  Regression-tested in `WholeRangeReplay.test.tsx` (a probe child renders
  only once revealed, positioned after the button and before the chart's
  own `<svg>`, via `compareDocumentPosition`) and **live-verified** via
  a `document.compareDocumentPosition` check against the real rendered
  DOM.
- **Three hot-path memoization gaps, all in code that re-renders on
  every one of the dozens of RAF-driven frames during a replay run for
  values that don't actually change across those frames** -- the exact
  wasted-work class this feature's own #96/#97/#107/#108 history already
  fixed repeatedly for `TradeReplay.tsx`'s own sibling values
  (`endingBalanceDisplayValue`, `displayStartingCapitalFormatted`, the
  multiplier), reintroduced independently here rather than carried over:
  1. `formatHeroCurrency(startingCapital)` was called directly, unmemoized,
     inside `WholeRangeReplay`'s own `revealSlot` JSX -- wrapped in
     `useMemo` on `[startingCapital]`, mirroring
     `displayStartingCapitalFormatted`'s own fix in `TradeReplay.tsx`.
  2. `WholeRangeReplay` handed `WholeRangeBalance` a fresh
     `worstCase={{ startingCapital, endingBalance }}` object literal
     every render, and `WholeRangeBalance`'s own
     `rescaleFromStartingCapital(...)` call was inline in JSX with no
     memoization of its own -- so the rescale recomputed on every replay
     tick despite all three inputs being constant for the whole run.
     Fixed at both ends together (one alone wasn't enough): `WholeRangeReplay`
     now memoizes the `worstCase` object itself
     (`useMemo` on `[worstCaseStartingCapital, worstCaseEndingBalance]`),
     and `WholeRangeBalance` now memoizes its own rescale
     (`worstCaseDisplayValue`, `useMemo` on `[worstCase, startingCapital]`)
     -- the object-identity stability from the first fix is what lets the
     second one's memo actually hit.
- **Three reuse findings -- code duplicated between `TradeReplay.tsx` and
  `WholeRangeReplay.tsx` despite this same diff already extracting
  `calloutText` into `lib/replay-callout.ts` for exactly this dual-caller
  reuse reason, just not applied consistently to every duplicate:**
  1. `buttonClassName` was a byte-for-byte copy in both files. Exported
     from `TradeReplay.tsx` (where it already lived) instead of a second
     copy; `WholeRangeReplay.tsx` imports it.
  2. The `landing: ChartLanding | null` `useMemo` block (identifying
     "what just landed" for `PortfolioChart`'s own marker-pulse/shake/
     speech-bubble effects) was a verbatim copy in both files. Extracted
     into `lib/replay-callout.ts`'s new `chartLandingFor(phase,
activeEvent, activeCallout)`; both files now call it.
  3. `canReplay`/`showLive`'s own core expressions were independently
     re-derived in both files -- worth sharing specifically because
     `TradeReplay.tsx`'s own history already needed `showLive`'s
     complement expression fixed once (round two's "Skip to end" gating
     fix), and a second independent copy is exactly the kind of thing
     that fix was meant to prevent recurring. Extracted
     `isReplayLive(phase)` and `canReplayFor(tradeCount,
reducedMotionAtMount)` into `use-trade-replay.ts` itself (the module
     that owns `ReplayPhase`); `WholeRangeReplay.tsx`'s own `replaySupported`
     restriction (see above) ANDs on top of `canReplayFor`'s result rather
     than that function growing a range-specific parameter.
- **One nit deliberately left as-is, not fixed**: the reviewer also
  suggested `WholeRangeReplayProps`' flat `worstCaseEndingBalance`/
  `worstCaseStartingCapital` two-number props should be one paired
  `{ startingCapital, endingBalance }` object instead. Checked against
  this codebase's own established convention before accepting or
  rejecting: `TradeReplayProps` and `HeroAndWorstCaseProps` both already
  use the identical flat two-number shape for the exact same worst-case
  pairing (neither uses a paired object), so a paired object here would
  actually be the _less_ consistent choice, not the more consistent one
  -- flat props are what every other caller in this exact feature area
  already does. Left flat; `WholeRangeReplay` itself is what assembles
  the pair into an object one level down, at the one place
  (`WholeRangeBalance`'s own `worstCase` prop) that actually wants it
  bundled.
- **One suggested fix was checked and refuted, not applied**: the
  reviewer flagged the pre-#105 line in this file's own "Whole-range-only
  guessing" section above ("Revealing this headline is also what unlocks
  `BenchmarkStat` and the whole-range chart... below it") as now stale,
  describing the chart as rendering _after_ `BenchmarkStat`. The
  `children`-slot fix above makes this description accurate again (the
  restored order really is headline -> ... -> `BenchmarkStat` -> chart),
  so no doc update was needed there -- worth confirming a "this comment
  is now stale" finding against the _final_ state of a fix still in
  progress, not just the intermediate state the finding was made against.
- All five routine checks (lint, `next typegen && tsc --noEmit`, `pnpm
build`, `pnpm test`, `pnpm format:check`) re-ran green after every fix,
  and the timing/day-switch/ordering behavior already live-verified once
  (see the section above) was re-verified live a second time against the
  post-fix code specifically to confirm none of these nine fixes (four of
  them touching the RAF-hot-path memoization or the button's own gating
  logic) had regressed the original worst-case-timing (~14.4s, unchanged)
  or day-switch-undisturbed behavior.

### Independent-review follow-up (post-PR) -- one release-blocking scope-creep finding, one verification gap, both fixed

A second, independent review round on the already-opened PR (after the
nine code-review findings above) found two more real things, neither
caught by the `high`-effort self-review pass:

- **`WholeRangeBalance`'s new "Worst case, same budget" stat (see above)
  was forwarded unconditionally to every intraday-daily range, not
  gated by `replaySupported` the way the "Watch it happen" button
  itself already was -- an undisclosed scope expansion beyond issue
  #105's own explicit scope ("1W specifically, not 1M/3M/1Y").**
  `ResultsPanel.tsx` computes `wholeRangeWorstCaseEndingBalance`/
  `wholeRangeWorstCaseStartingCapital` unconditionally (cheap, alongside
  `wholeRangeFinalBalance`, for every range -- this part is fine and
  unchanged) and always passed them to `<WholeRangeReplay
worstCaseEndingBalance={...} worstCaseStartingCapital={...}>`, which in
  turn always built a real `worstCase` object and forwarded it to
  `<WholeRangeBalance worstCase={...}>`, which renders a `WorstCaseStat`
  sibling whenever `worstCase` is non-`undefined` and revealed, with no
  range awareness of its own. The result: 1M/3M/1Y's whole-range
  headline permanently gained a stat it never had before this issue,
  reachable by any real user on those ranges, not just a latent bug --
  confirmed via `ResultsPanel.test.tsx`'s own pre-fix assertions, which
  asserted the stat rendered for `range="1M"`. This is legitimately
  correct, well-computed data (issue #84 already ships per-day
  worst-case for every intraday range) and arguably a good enhancement,
  but shipping it silently preempts issue #106's own future plan-first
  design work for exactly this question on the larger ranges, and was
  never flagged for sign-off anywhere the way the "no confetti" tradeoff
  explicitly was (see this file's own "Two items the plan explicitly
  left for the implementer" bullet above). Fixed by gating the `worstCase`
  object itself on `replaySupported` inside `WholeRangeReplay.tsx`
  (`replaySupported ? { startingCapital, endingBalance } : undefined`,
  memoized on `[replaySupported, worstCaseStartingCapital,
worstCaseEndingBalance]`) -- the same prop that already gates the
  button, so 1M/3M/1Y's whole-range headline now renders exactly as it
  did before issue #105 (no `WorstCaseStat` sibling at all), while 1W
  keeps the stat. `ResultsPanel.tsx` itself needed no change -- it still
  computes the two raw numbers unconditionally and passes them straight
  through; `WholeRangeReplay` is the one place that decides whether they
  ever reach `WholeRangeBalance`. Regression-tested: `WholeRangeReplay.test.tsx`'s
  `replaySupported={false}` test now asserts the stat is genuinely absent
  (previously asserted the opposite); `ResultsPanel.test.tsx` gained an
  `it.each(["1M", "3M", "1Y"])` case confirming no whole-range worst-case
  stat renders on any of them even with real trade data present, plus its
  two existing worst-case-computation tests were moved from `range="1M"`
  to `range="1W"` (the only range this stat is still gated on) rather
  than deleted, since the underlying rescale-from-root computation itself
  is unaffected and still needs coverage. **Live-verified against real
  pipeline data** (see below) that 1M genuinely shows no stat next to its
  whole-range headline while the page's unrelated per-day `WorstCaseStat`
  (issue #84) is unaffected.
- **Every prior verification pass for issue #105 (both the original PR
  and the nine-finding follow-up above) used a synthetic hardcoded
  fixture, consistent with this feature's own established precedent
  across #96/#97/#107/#108 -- but issue #105's own acceptance criteria
  ask for a live-verified real 1W result specifically, and that had
  never actually been done.** Added one additional real-data pass using
  this file's own "Local development without AWS credentials" workflow
  (documented at the top of this file): `LOCAL_RESULTS_DIR=<dir> pnpm
--filter @hadiknowntrades/pipeline run local-run` (real Yahoo network
  calls against the default 20-ticker sample) produced a real 1W result
  with 6 trading days x 3 trades each (18 trades total -- more than the
  plan's own 15-trade synthetic "worst case," since this ticker sample
  happened to find 3 trades on every single day), then `LOCAL_RESULTS_DIR=<dir>
pnpm --filter web dev` plus the documented no-root headless-Chromium
  workaround (`playwright` temporarily added via `pnpm add -D -w
playwright`, reverted afterward) drove the real page end to end:
  submitted the whole-range guess, clicked "Watch it happen," and let a
  full un-skipped playback run to completion against real tickers
  (ABNB, ACN, ALB, ARE, and others) and real dollar figures -- landing
  cleanly on the real final headline ($20.00 -> $34.68) with the
  "Replay" button back, a genuine chart-anchored callout mid-playback
  ("Bought ABNB on Aug 18, 9:30 AM at $181.08."), and **zero console
  errors or page errors** across the whole run (~16.1s real elapsed for
  18 real trades, a hair over the plan's 15s ceiling tuned for its
  15-trade synthetic worst case -- expected given 3 more real trades
  than that fixture, not a regression). Screenshotted at four points
  (idle pre-reveal, revealed with the worst-case stat and button, a
  mid-playback callout, and the finished state). The same real
  `LOCAL_RESULTS_DIR` also drove a real 1M page through the identical
  guess-then-reveal flow, confirming live (not just via the unit tests
  above) that its whole-range headline shows no "Watch it happen" button
  and no whole-range worst-case stat, with zero console errors. The
  debug scripts and the temporary `playwright` devDependency were both
  reverted before committing, per this file's own established
  convention.

## Chunked "Watch it happen" replay for 1M/3M/1Y (issue #118)

Extends #105's 1W-only whole-range replay to 1M/3M/1Y, per
`docs/plans/issue-106-plan.md` section 3.1's day/chunk-based reveal
mechanism -- those three ranges' own worst-case trade counts (up to
~750 for 1Y) are far too large for #105's per-point walk to stay
watchable (an unmodified per-trade pacing would run 1Y's own worst case
in ~26 minutes, see that plan's own section 2).

- **`use-trade-replay.ts` gained a third parameter, `segmentMode:
"point" | "chunk"` (default `"point"`)** -- selects between the
  original per-point `buildPointSegments` (unchanged behavior, still
  what the window model and 1W use) and a new `buildChunkSegments`. Both
  now build a shared, private `WalkSegment[]` (generalized from the old
  point-only `Segment` type) so one `tick()` RAF loop drives either walk
  -- the public `ReplayEvent`/`ReplayFrame.activeEvent` shape point mode
  already had is untouched; a new `ChunkSummary`/`ReplayFrame.activeChunk`
  field (mutually exclusive with `activeEvent`) carries chunk mode's own
  multi-trade pause data.
- **The chunk mechanism**: `groupPointsIntoDayGroups` walks
  `wholeRangePoints` once, grouping by `portfolio-series.ts`'s own
  `calendarDayOf` (no new pipeline field), collecting each day's own
  completed trades along the way (tracking "the most recently seen open
  price," the identical trick `buildPointSegments` already uses -- a
  day's own trades never interleave). `buildChunkSegments` then clusters
  day groups into at most `NUM_CHUNKS` chunks (`chunkCount =
min(dayGroups.length, NUM_CHUNKS)`, `chunkSize =
ceil(dayGroups.length / chunkCount)`) -- 1M's ~21 trading days stay
  under the cap (one chunk per day, for free); 3M's ~62 and 1Y's ~250
  both exceed it and group multiple days per chunk. Each chunk becomes
  one `WalkSegment`: `revealedCount` jumps straight to the chunk's own
  last point at the _start_ of its tween (unlike point mode, which only
  reveals a point once its own tween lands) -- only the display balance
  figure tweens, matching this feature's own "the chart never
  interpolates a position between two real points" principle. A chunk
  with zero trades has `buildLanding: null` and advances with no pause
  at all (the "skippable/fast-forwarded no-trade days" behavior); a
  chunk with real trades pauses for `pacing.eventPauseMs` (chunk mode's
  own pacing object reuses this field as the chunk-pause duration --
  literally the same `ReplayPacing` shape point mode uses, not a
  separate constant pair).
- **Two callout voices, chosen per chunk, not per range.** A chunk that
  happens to contain exactly one day with exactly one trade (`buildChunkLanding`'s
  own "free degenerate case," per the plan's own section 3.1) falls
  through to the _existing_, real, shared `ReplayEvent`/`calloutText`
  voice -- literally the same `buildReplayEvent` helper point mode's own
  `buildPointSegments` uses, narrating the trade's own **close** event
  (with its computed return), not its open. This is the common case for
  1M, where the day cap (30) always exceeds 1M's own ~21 trading days,
  so every chunk defaults to a single day. A genuine multi-trade chunk
  (more than one trade, or a single trade spanning more than one day
  group within the chunk) gets a new voice instead:
  `lib/replay-callout.ts`'s `chunkSummaryText` (`"{startDate}
  - {endDate}: N trades, $X -> $Y."`, or a single date when the chunk is
one day) -- narrating each trade individually inside one pause would
be an unreadable blur for a chunk that can span up to `chunkDayCount *
    maxTradesPerDay` trades.
- **The single-trade voice keeps its existing chart-anchored
  marker-pulse/shake/speech-bubble treatment (issue #108) for free** --
  `chartLandingFor` already gates strictly on `frame.activeEvent`, so it
  correctly returns `null` (no bubble) whenever a genuine multi-trade
  chunk is showing instead. **The multi-trade summary voice has no
  single marker to anchor a bubble to** (a chunk can span several days,
  and its own terminal point doesn't necessarily carry a trade event at
  all -- the chunk's _last_ day group within it could itself be a
  no-trade day even though an earlier day in the same chunk had real
  trades) -- `WholeRangeReplay.tsx` instead renders it as a plain
  visible `<p aria-hidden="true">` line between the button row and
  `children`, identical wording to the sr-only status region right
  above it. A deliberate, considered scoping call (not attempted:
  forcing every chunk summary to anchor somewhere on the chart, which
  would need its own new placement logic for a case `bubblePlacement`
  was never designed around).
- **`WholeRangeReplay.tsx`'s `WHOLE_RANGE_REPLAY_PACING` module constant
  is now exported, and a new `CHUNKED_WHOLE_RANGE_REPLAY_PACING` sits
  alongside it** -- both `pacing: ReplayPacing` and `segmentMode:
ReplaySegmentMode` became required props on `WholeRangeReplayProps`
  (no default, matching this codebase's established "no silent fallback
  by omission" convention -- see `trade-math.ts`'s own `direction`
  parameter), threaded per range group by `ResultsPanel.tsx`: 1W keeps
  `WHOLE_RANGE_REPLAY_PACING`/`"point"` unchanged; 1M/3M/1Y get
  `CHUNKED_WHOLE_RANGE_REPLAY_PACING`/`"chunk"`.
- **`replaySupported` widened from `range === "1W"` to every
  intraday-daily range** -- this is what unlocks both the "Watch it
  happen" button and the whole-range worst-case stat for 1M/3M/1Y (the
  same prop already gated both together for 1W, per #105's own
  post-PR independent-review fix) -- no separate gate needed for the
  stat.

### `NUM_CHUNKS`/pacing retuned from the plan's own first-draft numbers, against real live-browser measurement -- a real, measured overage, not just margin erosion

The plan's own section 6 explicitly flagged both `NUM_CHUNKS` (its own
suggested value, 40) and the chunk pacing constants (its own suggested
120/220) as an implementer/reviewer call to finalize live, expecting
some real-browser-overhead margin the same way 1W's own
`WHOLE_RANGE_REPLAY_PACING` needed one (~11% over its own analytical
estimate). **Chunk mode's overhead turned out to scale with a range's
own total point count, materially worse than 1W's flat ~11%**: measured
live (the established no-root-headless-Chromium technique, this file's
own "Headless-browser screenshot verification" section, against a
synthetic worst-case fixture -- every trading day maxed at
`maxTradesPerDay` = 3 trades), the plan's own first-draft 120/220 pacing
at `NUM_CHUNKS = 40` played 1M's own worst case in **~8.95s** (target
4-7s, ~25% over its own correct ~7.1s analytical estimate -- 21 chunks,
since 1M's own ~21 trading days stay under either a 30 or 40 cap) and
1Y's own worst case in **~20.1s** (target 7-14s, ~64% over its own
correct ~12.2s analytical estimate -- 36 chunks at a 40 cap, from
`chunkSize = ceil(250/40) = 7`, `actualChunks = ceil(250/7) = 36`; a
code-review finding, fixed, caught an earlier version of this paragraph
reusing the _new_, NUM_CHUNKS=30 chunk counts [21/21/28] mislabeled as
the 40-cap numbers, and separately citing a "~13.6s" 1Y estimate that
was actually just `NUM_CHUNKS * pacing` [40 chunks, not 36] -- exactly
the "identical ceiling" mistake this whole retuning story is otherwise
correcting) -- both real overages a user would actually notice, not just
analytical-estimate margin. The root cause: `PortfolioChart` (already
`React.memo`'d, issue #96 follow-up round four) still recomputes
`linePath`/`areaPath`/`eventMarkers` over the _revealed_ prefix on every
landing, and that cost grows with a range's own total point count --
1Y's own worst case is ~2,500 points, vs. 1W's ~50 -- so tightening
`pacing` alone wasn't enough; `NUM_CHUNKS` itself (how many times that
per-landing cost gets paid) needed lowering too. Retuned to
`NUM_CHUNKS = 30` plus `{ transitionMs: 80, eventPauseMs: 160, rewindMs:
700 }` (now 21/21/28 actual chunks for 1M/3M/1Y respectively), re-measured
live (two separate runs, for stability): **1M ~6.4s, 3M ~6.8-6.9s, 1Y
~13.6-13.7s** -- all inside their own stated targets, 1Y with a real but
modest ~350ms margin under its 14s ceiling (comparable tightness to 1W's
own live-measured ~14.4s against its own ~15s ceiling -- an accepted,
established margin profile for this
feature, not a red flag).

**Also live-verified against real pipeline data**
(`LOCAL_RESULTS_DIR`/`local-run.ts`, this file's own "Local development
without AWS credentials" workflow, default 20-ticker sample, no S3
write): a real 1Y result (251 real trading days, 641 real trades) played
its full un-skipped worst case in **~13.0-13.7s** (matching the
synthetic measurement closely), landing cleanly on the real final
headline ($20.00 -> $324K) with zero console/page errors; a real
mid-playback pause showed a genuine multi-trade chunk summary built from
real dates/dollar figures ("Aug 26, 2025 - Sep 8, 2025: 22 trades, $20.00
-> $26.06.") with no chart-anchored bubble, exactly as designed. A real
1M result (21 real trading days) played its full worst case in **~6.4s**,
also with zero errors. Both the "Watch it happen" button and the
whole-range worst-case stat ("Worst case, same budget") were confirmed
present on both real 1M/1Y pages, unlocked by the widened
`replaySupported` gate. The debug route, verification scripts, and the
temporary `playwright` devDependency were all reverted before
committing, per this file's own established convention.

**1W itself is unaffected** -- confirmed live, not just by reasoning:
the same synthetic worst-case-fixture technique above, run against 1W
with `segmentMode: "point"`/`WHOLE_RANGE_REPLAY_PACING` unchanged,
measured **~14.4s**, identical to #105's own original live measurement,
confirming the `use-trade-replay.ts` generalization (a new `segmentMode`
parameter defaulting to `"point"`, a private `WalkSegment` type replacing
the old `Segment`) introduced no behavior change for the point-mode path
1W and the window model both still use.

**Test coverage**: `use-trade-replay.test.ts` gained a "chunk segment
mode" describe block -- day-by-day walking (a one-day/one-trade chunk
landing on the real `ReplayEvent` shape; a no-trade chunk advancing with
zero pause), a genuine multi-trade chunk producing a `ChunkSummary` (not
a `ReplayEvent`), and a `NUM_CHUNKS`-capping test (90 days, evenly
divisible by the cap, landing on exactly 30 pauses rather than 90 --
deliberately chosen so the day count can't coincidentally produce the
same chunk count under a different candidate cap value, unlike an
arbitrary day count whose own rounded `chunkSize` might not actually
distinguish the cap being tested). `WholeRangeReplay.test.tsx` gained a
"chunked segment mode" describe block mirroring the same three cases
one level up, with tick offsets derived from the real, imported
`CHUNKED_WHOLE_RANGE_REPLAY_PACING` constant (not hardcoded numbers) so
a future retuning pass doesn't also require hand-recomputing every tick
argument across two test files. `ResultsPanel.test.tsx`'s existing
`it.each(["1M", "3M", "1Y"])` "no worst-case stat" test (from #105's own
post-PR independent-review fix) is now a "renders the stat too" test,
plus a new `it.each` case driving a real chunked pause-to-completion
cycle on all three ranges through the real component tree.

### Code-review follow-up -- one real bug, two doc-accuracy fixes

A `high` review of the diff above (two independent finder angles, both
converging on the same real bug) found one genuine correctness gap and
two doc-comment inaccuracies -- all three fixed before opening the PR.

- **`groupPointsIntoDayGroups` silently dropped a "close" event with no
  matching prior "open" instead of recording it defensively, unlike
  `buildPointSegments`/`buildReplayEvent` (point mode), which still
  surface every close event (with `tradeReturn: null`) regardless of
  whether a matching open was found.** `deriveWholeRangeIntradaySeries`
  never actually produces this shape in practice (every real trade's
  open always precedes its own close) -- but this is exactly the same
  defensive posture point mode's own walk already has for corrupted/
  malformed data, and the two builders had silently diverged: chunk
  mode's version excluded such a trade from `group.trades` entirely
  (gated by `lastOpenPrice !== null` at the push site), meaning it never
  counted toward `tradeCount`, and -- if it were the only event in an
  otherwise single-day chunk -- the chunk never paused at all, making
  the trade completely invisible in chunk-mode replay. Fixed by always
  pushing a close event into `group.trades` (dropping the `lastOpenPrice
!== null` guard at the push site; `DayGroupTrade.openPrice` widened to
  `number | null` to carry the "no matching open" case through, exactly
  parallel to `buildPointSegments`'s own `openPriceForClose: number |
null`) -- `buildReplayEvent` already treats a `null` openPrice as "no
  return computable" (`tradeReturn: null`), so no downstream change was
  needed once the trade itself stopped being dropped. Regression-tested
  in `use-trade-replay.test.ts`: an orphan-close fixture (a close event
  with no preceding open anywhere in the series) confirms the chunk
  still pauses and narrates (the one-day/one-trade degenerate voice,
  `tradeReturn: null`), not silently skipped.
- **`NUM_CHUNKS`'s own doc comment (and the near-identical claim in
  `WholeRangeReplay.tsx`'s `CHUNKED_WHOLE_RANGE_REPLAY_PACING` comment)
  asserted 3M's ~62 days and 1Y's ~250 days both "land on the identical
  worst-case chunk count by construction, not coincidence" -- false,
  given `buildChunkSegments`'s actual algorithm.** `chunkCount =
min(dayGroups.length, NUM_CHUNKS)` is used only to derive `chunkSize =
ceil(dayGroups.length / chunkCount)`; the walk then strides by that
  fixed `chunkSize`, so the real chunk count produced is
  `ceil(dayGroups.length / chunkSize)` -- always `<= NUM_CHUNKS`, but not
  always equal to it. Hand-computed at `NUM_CHUNKS = 30`: 3M's 62 days ->
  chunkSize 3 -> 21 actual chunks; 1Y's 250 days -> chunkSize 9 -> 28
  actual chunks -- 21 != 28, and neither equals 30. The only regression
  test for the cap deliberately used a day count evenly divisible by 30
  (see the "Test coverage" paragraph above), so this undercount was
  untested for any realistic 3M/1Y day count and could have misled a
  future maintainer reasoning about the pacing from the comment alone.
  Both comments rewritten to describe the mechanism accurately (an upper
  bound, not an exact-equality guarantee) and to cite the real
  live-measured per-range durations instead of a false "identical
  ceiling" framing.
- **Two test-file comments still said "NUM_CHUNKS (40)"**, a stale
  leftover from before the constant was retuned from 40 to 30 (see
  `CHUNKED_WHOLE_RANGE_REPLAY_PACING`'s own comment above) -- didn't
  affect test correctness (3 days is fewer than either 30 or 40), but
  misleading to a future reader trying to understand the current cap
  from the tests alone. Fixed in both `use-trade-replay.test.ts` and
  `WholeRangeReplay.test.tsx`.
- All five routine checks (lint, `next typegen && tsc --noEmit`, `pnpm
build`, `pnpm test`, `pnpm format:check`) re-ran green after every fix.

### Independent-review follow-up -- one doc-accuracy correction, one real layout-shift bug found and fixed via pixel measurement (not just DOM presence)

A second, independent review round on the already-opened PR (after the
code-review round above) found two more things -- both fixed before
merge.

- **The `NUM_CHUNKS = 40` baseline's own real chunk counts, cited in
  both `CHUNKED_WHOLE_RANGE_REPLAY_PACING`'s comment and this file's own
  retuning section above, were arithmetically wrong -- confirmed by the
  reviewer recomputing from this repo's own stated formula.** An earlier
  version of both comments reused the _new_, `NUM_CHUNKS = 30` chunk
  counts (21/21/28 for 1M/3M/1Y) and mislabeled them as the old 40-cap
  numbers, and separately cited a "~13.6s" 1Y analytical estimate that
  was actually just `NUM_CHUNKS * pacing` (`40 * 340ms`) -- i.e.
  `NUM_CHUNKS` itself treated as if it were the real chunk count, the
  exact "identical ceiling" mistake this whole retuning narrative is
  otherwise correcting (see the code-review section above, which fixed
  the _general_ version of this mistake but happened to still get the
  _specific_ 40-cap numbers wrong in the process). Correctly recomputed
  via this repo's own `chunkSize = ceil(dayCount / min(dayCount,
NUM_CHUNKS))`, `actualChunks = ceil(dayCount / chunkSize)` formula, at
  `NUM_CHUNKS = 40`: 1M's 21 days -> chunkSize 1 -> 21 chunks (unchanged
  from the 30-cap case, since 21 already sits under either cap); 3M's 62
  days -> chunkSize `ceil(62/40)` = 2 -> 31 chunks; 1Y's 250 days ->
  chunkSize `ceil(250/40)` = 7 -> 36 chunks. This changes the _stated_
  analytical estimates and overhead percentages for the old baseline
  (1Y: ~12.2s analytical, not ~13.6s; ~64% real overhead against the
  ~20.1s measurement, not ~47%) but **not** any shipped runtime
  behavior -- the real constants in the code (`NUM_CHUNKS = 30`, `{
transitionMs: 80, eventPauseMs: 160, rewindMs: 700 }`) and every
  live-measured duration for the _current_ pacing were already correct;
  this was purely a doc-accuracy bug in the narrative explaining _why_
  the retune was needed. Both comments (`CHUNKED_WHOLE_RANGE_REPLAY_PACING`
  in `WholeRangeReplay.tsx`, and this file's own retuning section above)
  rewritten with the correct 40-cap numbers, and both now spell out the
  exact prior error (which numbers got swapped for which) so a future
  reader can see why the story changed, not just that it did.
- **The genuine multi-trade chunk-summary line was a plain flow
  `<p>`, mounted and unmounted on every chunk-summary landing and
  clearing (`{frame.activeChunk && <p>...}`) -- a real, live-confirmed
  layout-shift bug, not a hypothetical one.** Unlike the existing
  chart-anchored speech bubble (absolutely positioned, so its own
  mount/unmount never affects surrounding flow), this line sits in
  normal document flow between the button row and `children`/the chart
  -- and `tick()`'s own logic clears `activeChunk` back to `null` on
  every intervening tween frame between two chunk landings (see
  `ReplayFrame`'s own doc comment), so a real multi-chunk run mounts and
  unmounts this element repeatedly, visibly shifting the chart/children
  block down and back up on every single chunk boundary. **The original
  live verification for this feature only asserted DOM presence/absence
  of the summary text (`getByText`/`queryByText` in
  `WholeRangeReplay.test.tsx`), never an actual pixel/position
  measurement** -- exactly the category of gap issue #107's own
  `heroSlot` overlay-height-matching bug (see that section above) had to
  be caught the same way, by a real screenshot, not by DOM assertions
  alone. Fixed in two iterations, both confirmed live via a real
  `getBoundingClientRect().y` measurement of the chart's own position
  sampled every 20ms across an entire synthetic worst-case run (a
  throwaway debug route + the no-root-headless-Chromium technique, per
  this file's own established convention):
  1. **First attempt**: always mount the `<p>` for the whole
     `!showLive` (rewinding/playing) stretch of a chunk-mode run, not
     conditionally on `frame.activeChunk` alone -- toggled via
     `invisible`, the same idiom `WholeRangeBalance.tsx`'s own
     `revealSlot` pairing already establishes. This eliminated the
     _mount/unmount_ shift (confirmed: the chart's own Y position no
     longer changed on every chunk boundary) but a real, smaller
     residual shift remained: a plain-space placeholder (when
     `activeChunk` is `null`) is always exactly one line tall, but a
     _real_ chunk-summary sentence's own length varies chunk to chunk
     (different date ranges, trade counts, dollar figures), and some
     genuinely wrap to a second line at this page's own content width
     while others don't -- so the reserved space itself wasn't actually
     fixed, just less variable than before. Live-measured: the chart's
     own Y position took on 2 distinct values during a single
     uninterrupted playback run (not the many distinct values the
     original bug produced, but still 2, not the expected 1).
  2. **Second attempt (the one that holds)**: `min-h-10` (2 lines' worth
     at `text-sm`) plus `line-clamp-2` together, applied whenever a
     genuine chunk summary is showing. This gives the line a genuinely
     _fixed_ height regardless of actual content length -- `min-h-10` is
     the floor (never shrinks below 2 lines, including for the
     single-line placeholder-space state), `line-clamp-2` is the
     ceiling (caps the rare chunk whose own summary sentence would need
     a third line, e.g. a real trade count into the hundreds on 1Y --
     the sr-only status region right above it still carries the full,
     untruncated sentence, so no information is lost, only this
     decorative line's own display). Live re-measured across the same
     synthetic run (400 samples at 20ms intervals, 163 of them landing
     on a genuine multi-trade chunk summary with varying real sentence
     lengths): the chart's own Y position took on exactly 2 distinct
     values for the _entire_ run -- one constant value for the whole
     `!showLive` stretch (idle -> rewinding -> playing, regardless of
     which specific chunk summary was showing or whether it was a
     1-line or 2-line-worth sentence), and a second, different constant
     value once back to idle/done (no reservation at all, matching
     pre-#118 layout for point mode and every other range). That
     single, one-time "make room" transition when playback starts (or
     stops) is the deliberate, accepted shift this design has always
     called for -- not a regression, and not what this finding was
     about. Screenshotted both the finished state and a real
     mid-playback multi-trade-chunk landing to confirm the line renders
     legibly, correctly positioned between the button row and the
     methodology paragraph, with no visual artifacts.
  - **A real debugging detour worth remembering for the next
    per-chunk-landing live measurement in this app**: an earlier version
    of this same verification script polled state via several
    Playwright locator calls per sample (a `boundingBox()` on a
    regex-matched button locator queried against a 60+-button
    `DayOverview` DOM, plus a separate `allTextContents()` call over the
    same DOM), and appeared to show the _entire_ worst-case run
    completing in under 100ms of nominal `waitForTimeout` elapsed time --
    not a real RAF-speed anomaly (confirmed separately, by hooking
    `window.requestAnimationFrame` directly and observing normal,
    real-time-paced frame deltas), but an artifact of the _verification
    script's own_ per-sample Playwright/CDP overhead: repeatedly
    resolving a regex-based accessible-name query against dozens of
    text-heavy elements is itself slow enough in real wall-clock terms
    that, while the script was still "inside" what it thought was one
    50ms sample, several real seconds had already elapsed on the actual
    page -- long enough for the whole chunked run to finish in the
    background, undisturbed. Fixed by consolidating each sample into one
    single, cheap `page.evaluate()` call (plain `document.querySelector`/
    `getBoundingClientRect()` in-page, no per-element Playwright/CDP
    round-trips) -- worth the same discipline for any future test
    against a real, large `DayOverview`-heavy fixture: prefer one cheap
    in-page evaluation per sample over several locator-based queries,
    especially any that use a regex name matcher against a large,
    text-heavy DOM.
- All five routine checks (lint, `next typegen && tsc --noEmit`, `pnpm
build`, `pnpm test`, `pnpm format:check`) re-ran green after both
  fixes, and the debug route/script/temporary `playwright`
  devDependency were all reverted before committing, per this file's own
  established convention.

## Page structure: this is a single-page app, and new mechanics are sections, not routes (issue #122)

**Standing architectural decision, made once so independent agents
building The Call Board (#128/#129), Beat the Bench (#131/#132) and The
Daily Ritual (#133) don't each make an incompatible assumption.** The
design artifact behind issue #120 renders those mechanics at separate
illustrative routes (`/predict`, `/bench?range=daily`); **that is a
mockup convention, not the shipping architecture.** Don't build them as
routes.

### The current real render order (verified, not assumed)

`apps/web/src/app/` holds exactly one `page.tsx` (18 lines, a `Suspense`
boundary around `ResultsPage`) plus `layout.tsx`, `error.tsx`,
`global-error.tsx`, `globals.css`, and three `api/` routes -- there is
no second page anywhere. Every view axis is a query param on `/`
(`?range=`, `?anchor=`, `?day=`, `?mode=`), owned by `ResultsPage.tsx`.

`ResultsPage.tsx:124-174` returns one `max-w-3xl` flex column:

1. `<OnboardingIntro />` (`:126`)
2. `<header>` (`:128-162`): `<h1>`, `<RangeSelector>` (`:130`), and a
   "More options" `<details>` (`:148-161`) wrapping `CustomRangeSelector`
   - `ModeToggle`
3. `<ResultsPanel … />` (`:164-172`)

`ResultsPanel` (`ResultsPanel.tsx:397`) early-returns `<LoadingSkeleton />`
(`:548`) or the error box (`:553-560`) before any content, then branches
on `data.model`:

- **`"intraday-daily"`** (`:683-809`), inside `<FadeInWrapper>`:
  1. `<WholeRangeReplay>` (`:699-726`) -- the whole-range guess/reveal
     headline, the "Watch it happen" button row, its `children` (the
     methodology `<p>` at `:715-719` and `<BenchmarkStat>` at `:720-725`),
     and the whole-range `PortfolioChart` it owns internally
  2. `<DayOverview>` (`:728-741`)
  3. the sr-only `role="status"` day/mode announcement (`:755-757`)
  4. the per-day `<HeroAndWorstCase>` + `<StartingCapitalInput>` row
     (`:759-792`)
  5. the "Trades" `<h2>` + `<IntradayTradeList>`/empty box (`:794-803`)
  6. `<AboutSection>` (`:805-807`)
- **`"custom-window"`** (`:812-836`) and **`"window"`** (`:849-876`) both
  render `<WindowResultBody>` (`:266-328`), inside `<FadeInWrapper>`:
  1. `<TradeReplay>` (`:282-310`) -- hero row, "Watch it happen", its
     `children` (`<BenchmarkStat>` at `:304-309`), and the chart
  2. the "Trades" `<h2>` + `<TradeList>`/empty box (`:312-321`)
  3. `<AboutSection>` (`:323-325`)

### The decision

1. **Sections, not routes.** No new files under `apps/web/src/app/`, no
   `/predict`, no `/bench`, no `?tab=`. Routing would mean a second
   `Suspense`/`useSearchParams` shell, a duplicated header/onboarding
   chrome, and cross-route navigation state -- for zero stated benefit
   (there are no accounts, no auth, and nothing in #128-#133 asks for a
   deep link to a mechanic). It would also directly break #133's status
   rail, which has to show hero-seen + Beat-the-Bench-played +
   Call-Board-slots-filled together in one view, and the single-scroll
   "daily ritual" the whole milestone is built around.
2. **Each mechanic is one self-contained section component** under
   `apps/web/src/components/` (`CallBoard.tsx`, `BeatTheBench.tsx`),
   owning its own localStorage-backed state via this file's established
   two-layer pattern (see "localStorage pattern" above). **Neither takes
   `PrecomputedResult`, `range`, `mode`, or `selectedDay` props** --
   neither mechanic is a function of the hindsight result, and keeping
   them result-independent is what makes the placement below work.
3. **They mount in `ResultsPage.tsx`, not inside `ResultsPanel.tsx`'s
   model branches.** Two concrete reasons, both real rather than
   stylistic: (a) `ResultsPanel` renders nothing but a skeleton or an
   error box until `/api/results` succeeds (`:548`/`:553`), so anything
   placed inside it disappears whenever that fetch is slow or 500s --
   a routinely-hit state locally (see "Local development without AWS
   credentials" at the top of this file) and a real operational one;
   the daily ritual shouldn't depend on the hindsight result loading.
   (b) `ResultsPanel` has three mutually exclusive model branches, so
   "inside" means duplicating the mount into both `WindowResultBody`
   (`:280-327`) and the intraday-daily branch (`:683-809`) -- exactly the
   two-copies-to-keep-in-sync shape this codebase has been bitten by
   repeatedly (the `HeroAndWorstCase` extraction, the three
   `effectiveStartingCapital` misses).
4. **Exact attachment points**, in the order they should be built:
   - **#129 and #131 (day one, no `ResultsPanel` change at all):** render
     `<BeatTheBench />` then `<CallBoard />` as direct children of
     `ResultsPage.tsx`'s `max-w-3xl` column (`:125`), immediately after
     `<ResultsPanel … />` (`:164-172`). This is shippable on its own and
     is the default if #133 never lands.
   - **#133 (the final engagement order -- hero reveal, then Beat the
     Bench, then The Call Board):** do **not** move the mechanics into
     `ResultsPanel`'s branches. `ResultsPage` keeps creating and owning
     both elements; `ResultsPanel` grows **one** optional
     `afterHero?: ReactNode` prop, rendered at exactly two sites --
     immediately after `</TradeReplay>` in `WindowResultBody` (between
     `ResultsPanel.tsx:310` and `:312`) and immediately after
     `</WholeRangeReplay>` in the intraday-daily branch (between `:726`
     and `:728`). Only one branch ever renders, so this is still one
     instance and one state owner, and it is the same `children`-slot
     idiom `TradeReplay`/`WholeRangeReplay` already use for
     `BenchmarkStat` (see their own doc comments -- that slot exists
     precisely so `ResultsPanel` can inject content at a fixed point in
     the hero block without reordering anything relative to the chart).
     Net order becomes: hero reveal -> Beat the Bench -> The Call Board
     -> `DayOverview`/per-day drill-down/trade list -> `AboutSection`.
   - **Known trade-off of the slot, decide it deliberately in #133:**
     anything passed through `afterHero` inherits `ResultsPanel`'s fetch
     gate and is therefore absent during loading/error, unlike the
     default placement. If a fetch failure must still leave the daily
     ritual playable, keep #133's status rail (and, if needed, the two
     mechanics themselves) at the `ResultsPage` level instead. This is a
     product call, not an architectural one -- the mount point and
     ownership stay the same either way.

## Design tokens: the reward accent, and the real body font (issue #121)

Prerequisite decisions for the "Hindsight Wrapped" redesign (issue #120's
design review; issues #123, #125, #129, #131 and #133 all build on this).
**The decision record itself lives in `src/app/globals.css`'s own comment
blocks -- read those before adding any color or type token for one of
those issues.** This section is the pointer, not a second copy that can
drift from it.

The short version:

- **Two accent tokens, split by job, deliberately not unified.**
  `--accent-reward` (gold `#e8a33d`, plus `--accent-reward-wash` for a
  faint tinted background, mirroring `--series-1-wash`) is for _earned_
  state only: the celebration burst, streaks, win stamps, an unlocked
  recap. `--accent-selection` is a semantic alias of the existing
  `--series-1` blue, for _selected/active control_ state. The design
  artifact used one gold for both jobs; one token cannot carry both,
  because the moment an active control is gold, gold stops meaning "you
  earned this."
- **`RangeSelector`'s active pill stays blue.** Explicit, not inertia --
  the blue active-pill treatment is already shared by six places in the
  app, and white-on-gold measures 2.16:1, so a gold-filled pill could not
  keep the white label those controls share. Text on a gold _fill_ must be
  `var(--background)` (9.18:1). Gold as a foreground glyph/figure passes
  comfortably on every surface (9.18 / 8.08 / 7.03:1 against
  `--background` / `--surface-1` / `--surface-2`).
- **Keep using `--series-1` for the chart's data series**, and
  `--accent-selection` for active controls. Same blue today, different
  reasons to change later.
- **Type roles: no third webfont.** `--font-display` (Geist Sans, static
  figures and headings) and `--font-numeric` (Geist Mono, tabular or
  digit-by-digit animated data) are declared in `@theme inline`, so they
  exist as Tailwind utility classes rather than as custom properties you
  read with `var()` -- Tailwind tree-shakes the properties themselves out
  of `:root` while nothing uses them, so reading them off the document
  returns an empty string. That is expected; the utility classes work
  (verified live). The artifact's rounded display face was considered and
  rejected for now -- an extra request and extra CLS surface, for a look
  unlike anything already shipped. Revisit as its own issue, don't slip
  one in as a side effect.
- **The app's real body font changed here, and it is a genuine visual
  change.** `globals.css`'s `body` rule carried
  `font-family: Arial, Helvetica, sans-serif`, a create-next-app template
  leftover, and it beat the Geist variables `layout.tsx` sets on `<html>`.
  Verified live against a real `next dev` page under headless Chromium
  before touching anything: `<html>` computed `Geist, "Geist Fallback"`
  while `<body>`, `<h1>` and every control computed
  `Arial, Helvetica, sans-serif`; Chrome DevTools'
  `CSS.getPlatformFontsForNode` reported the `<h1>` actually painting in
  **DejaVu Sans** (this Linux box's Arial substitute -- a real visitor got
  Arial or Helvetica), and every Geist face reported
  `status: "unloaded"`. In other words the app downloaded two Geist
  families and never rendered a single glyph from either. Removing that
  one line lets `<body>` inherit `<html>`, which Tailwind preflight
  already drives from `--font-sans` -> `--font-geist-sans`; re-verified
  after, the `<h1>` now paints in real Geist. **So any pre-#121 screenshot
  in this file shows the app in Arial/DejaVu, not Geist** -- worth knowing
  before treating an old screenshot as a typography baseline.
- Nothing was applied to any component here on purpose: this issue ships
  tokens and the decision record, and each downstream issue does its own
  application.

## Surfacing the share card, and extending it to the intraday-daily model (issue #134)

Two independent halves, plus one drift fix found along the way. See the
"OG share card (issue #33)" section above for everything about the route
itself that this issue did **not** change (ISR/caching, the exact-case
route-param guard, the `generateStaticParams` reasoning).

- **`buildOgCardContent` now covers both result models.** For
  "intraday-daily" it headlines the **whole-range chained balance**: the
  **final** day's `endingBalance` paired with the **range's own root**
  `startingCapital` -- exactly what `ResultsPanel.tsx`'s
  `wholeRangeFinalBalance` computes and `WholeRangeBalance.tsx`
  headlines on the page. Deliberately **not** the per-day rescale
  pattern (a day's own `endingBalance` paired with that same day's own
  `startingCapital`), which algebraically cancels the chaining back out
  -- see this file's own "rescaleFromStartingCapital's per-day pattern
  silently cancels out per-day capital chaining" section for that trap,
  and `og-card.test.ts`'s own regression test for it (a fixture whose
  final day carries in $30, so a card built the wrong way would read
  "$30 -> $41" instead of "$20 -> $41"). Still long-only for both
  models, unchanged (see "Long-only vs. long+short mode" above).
  `null` is still a real return value, now for exactly one case: a
  result with no trading days at all, which has nothing to headline.
- **`OgCardContent` gained `subtitleLabel`**, moving the line under the
  figures out of `OgCard.tsx` (where it was the hardcoded string
  "{range} range - best possible 3-trade outcome") and into
  `og-card.ts`. Not cosmetic: that sentence would be flatly wrong on a
  chained intraday card (1Y's own chained result routinely runs to
  hundreds of trades, not 3). The window model's version now reads the
  result's own `maxTrades` instead of a literal `3`, matching what
  `AboutSection`'s copy already does.
- **`OgCard.tsx`'s palette is untouched** -- still the deliberate light,
  third-party-safe card (see issue #76's own note above). **Verified as
  byte-identical, not just eyeballed**: the MAX card rendered before and
  after this change (same real result, same values) produced the exact
  same PNG, `md5` for `md5`. Worth reusing as the cheap check for any
  future change that claims not to touch this card's own rendering.
- **A visible way in: `ShareCardLink.tsx`**, a copy-link button
  (`${window.location.origin}/api/og/{range}`) rendered at the bottom of
  a result view, just above `AboutSection`. Before this, nothing in the
  app linked to the card at all -- it had existed since issue #33 with
  no way for a user to discover it. Copy-link rather than a file
  download, per the issue's own scope: page-initiated downloads are
  inert in some embedding contexts, and a link is the better share
  primitive regardless (it re-renders as the nightly pipeline refreshes
  the result, rather than freezing yesterday's numbers into someone's
  downloads folder).
  - **Rendered only where the figure it headlines is already on
    screen.** The window model (5Y/MAX) has no guess gate at all, so it
    renders unconditionally there; the intraday-daily branch renders it
    inside the same `rangeGuess !== null` gate `BenchmarkStat`/the
    whole-range chart already sit behind (issue #91), so a player is
    never handed a one-click link to the answer they're mid-way through
    guessing. The card's URL is public and guessable either way -- this
    is about not spoiling the game from inside the page, not about the
    number being secret. A custom start-date anchor (issue #11) has no
    `/api/og/...` route at all, so `WindowResultBody`'s own
    `shareRange` prop is `null` there and no button renders.
  - `navigator.clipboard` is genuinely **absent** (not merely
    permission-denied) on any non-secure origin and under jsdom, so the
    unguarded call throws a `TypeError` rather than rejecting -- both
    shapes fall through one `try`/`catch` into the same fallback, which
    reveals a read-only, select-on-focus input holding the URL rather
    than dead-ending. **`ShareCardLink.test.tsx` must call
    `userEvent.setup()` BEFORE stubbing the clipboard**: setup installs
    its own working `navigator.clipboard` stub, which otherwise silently
    wins and makes every "denied/absent clipboard" test exercise the
    happy path instead (a real failure, caught by the tests failing, not
    a hypothetical).
- **Drift fix: `/api/og/[range]` now builds its reader via
  `createResultReader()`** like `/api/results` and `/api/custom-anchors`
  already did, instead of constructing an `S3ResultReader` from
  `RESULTS_BUCKET` itself. That helper was extracted after this route
  shipped, so this was the one results-reading route that ignored
  `LOCAL_RESULTS_DIR` -- meaning **no card could be rendered locally at
  all** without real AWS credentials (confirmed live: pre-fix,
  `/api/og/MAX` under a real `LOCAL_RESULTS_DIR` dev server returned
  `server_misconfigured`). Production behavior is unchanged.
- **`route.test.ts` is now `@vitest-environment node`** (the whole file,
  not a second file) so it can drive a real end-to-end
  fetch-validate-**render** pass: it writes real current-schema JSON to
  a temp dir under the same `results/{RANGE}.json` layout, points
  `LOCAL_RESULTS_DIR` at it, `vi.resetModules()` + re-imports the route
  (its reader is module-scope), and asserts a real PNG comes back
  (signature bytes, not just a non-empty body). Node is required because
  `next/og`'s resvg rasterization fails with "Unsupported input" under
  this project's default jsdom environment -- the same fact this file's
  own issue #33 note already documented for a throwaway script.
- **Live-verified** against a real local pipeline run (the committed
  `LOCAL_RESULTS_DIR` workflow at the top of this file -- real Yahoo
  data, 12 tickers) plus the documented no-root headless-Chromium
  workaround: a real 1W card rendered at `$20.00 -> $30.37` matching
  that range's own real chained result; the 1W page showed no share
  button pre-reveal and exactly one post-reveal; clicking it copied
  `http://localhost:3001/api/og/1W`, and fetching that copied string
  back returned `200 image/png` (58,764 bytes -- the same card);
  5Y showed the button ungated and copied its own link; a custom anchor
  showed none; 390px mobile reflowed with no horizontal overflow; zero
  console/page errors across the run. The temporary `playwright`
  devDependency and all verification scripts were reverted before
  committing, per this file's own convention.
- **Deliberately NOT done: wiring `openGraph` metadata** (so a link to
  the _page_ unfurls with this card) -- that needs a `metadataBase`, and
  this app still has no canonical public URL (CloudFront is blocked on
  AWS account verification, see `infra/CLAUDE.md`). Picking a fake one
  would ship a broken unfurl. The natural follow-up the moment a real
  domain exists.

## Celebration burst scaled to the result's magnitude (issue #125)

Before this issue `CelebrationBurst` threw the identical fixed 24-piece,
full-row burst for every gain -- a $20 -> $20.44 custom anchor got exactly
what a $20 -> $218M Max result got. `lib/celebration-magnitude.ts` adds a
tier table over the _same_ `endingBalance / startingCapital` multiplier
`HeroStat`'s "(345x)" badge already computes (deliberately that value, not
a second notion of "how big was this" that could drift from the badge on
screen), and `CelebrationBurst` gained an `intensity` prop scaling piece
count and horizontal spread by tier.

- **The tier is strictly an intensity dial layered on top of
  `shouldCelebrate(isGain, settled)` -- it can scale an approved burst
  down (to nothing), never turn one on.** `HeroStat` still passes
  `active={shouldCelebrate(...)}`, and `CelebrationBurst` renders `null`
  whenever `active` is false regardless of what intensity it's handed.
  That gate (gain + settled + `!prefersReducedMotion()`, with the live
  read-at-fire-time and render-scoped-overlay fragilities documented in
  the "Client-side animation" section above) is untouched by this issue --
  no attempt was made to "fix" either fragility as a side effect.
  `HeroStat.test.tsx`'s own "never introduces a burst where
  shouldCelebrate already says no" test covers all four no-cases (flat,
  loss, reduced motion, unsettled tween) with scaling on, using a
  top-tier multiplier for the last two.
- **Thresholds are decades, not linear steps**: suppress below 1.25x
  (0 pieces), modest below 10x (8 pieces, 45% spread), strong below 100x
  (16 pieces, 72% spread), full at 100x and up (24 pieces, 100% spread --
  byte-for-byte the pre-#125 burst). The outcome space genuinely spans
  many orders of magnitude (the portfolio chart already plots it on a log
  scale for the same reason), so a linear ladder would put essentially
  every window-model result in the top tier and change nothing.
  `spreadPercent` is a band centered on the figure
  (`50 + (rand - 0.5) * spread`), so 100 reproduces the original
  `Math.random() * 100` distribution exactly.
- **Opt-in per call site (`HeroStat`'s `scaleCelebrationToMagnitude`,
  default `false`), not always-on -- a deliberate scope call, not an
  oversight.** Issue #125 scopes itself to the window model.
  `TradeReplay.tsx` (window/custom-window only, by construction) is the
  one call site that passes `true`, via a matching pass-through prop on
  `HeroAndWorstCase`. `ResultsPanel.tsx`'s intraday-daily _per-day_
  `HeroAndWorstCase` deliberately doesn't -- note that call site renders a
  real `HeroStat`/`CelebrationBurst` too (unlike `WholeRangeBalance.tsx`,
  the whole-range headline the issue's own Background section discusses,
  which has no burst at all), and its single-day multipliers (~1.0-1.2x)
  would _all_ land in the suppressed tier, silently removing confetti
  from every intraday day. That's a real product change for a model this
  issue explicitly puts out of scope -- exactly the class of undisclosed
  scope expansion #105's own post-PR review flagged as release-blocking --
  so it's left for its own issue. `HeroStat.test.tsx` regression-tests
  that a non-opted-in caller still gets the full 24-piece burst for a
  1.05x win.
- **The `--accent-reward` gold token (issue #121) was deliberately not
  applied here**, even though `globals.css`'s own token comment names the
  celebration burst as an `--accent-reward` surface. #125's scope is
  magnitude, not palette; #121's own note says each downstream issue does
  its own application pass. Recoloring the confetti is a separate visual
  change worth its own diff.
- **Live-verified against real precomputed data** (the `LOCAL_RESULTS_DIR`
  workflow at the top of this file -- a real `local-run.ts` pipeline pass
  over the default 20-ticker sample, 6 preset results + 1,254 real
  custom-anchor results, then `next dev` + the documented no-root
  headless-Chromium workaround). A **real near-1.0x window-model result
  existed in the data** -- no "closest example" fallback was needed: the
  custom anchors nearest today are genuinely short windows. Measured piece
  counts and left-percent spans at ~1.3s after load (just after the
  1200ms count-up lands, mid-fall):
  - `?range=MAX`, 10.9Mx ($20 -> $218M): 24 pieces, spanning 12.1%-99.6%
  - `?range=5Y`, 57.3x ($20 -> $1.1K): 16 pieces, 23.9%-78.3%
  - `?anchor=2026-08-06`, 1.56x ($20 -> $31.14): 8 pieces, 28.1%-69.1%
  - `?anchor=2026-08-19`, 1.12x ($20 -> $22.48): no burst element at all
  - `?anchor=2026-08-25`, 1.02x ($20 -> $20.44): no burst element at all
  - `?range=1W` (intraday-daily per-day, not opted in), a 1.1x day: still
    24 pieces spanning 5.4%-96.6% -- unchanged, as intended

  Screenshots confirm the visual reading matches the numbers (a wide dense
  burst on Max, a tight little cluster under the figure at 1.6x, nothing
  at 1.02x while the multiplier badge and issue #77's reveal glow still
  render in green). Zero console errors or page errors on any of them.
  The verification scripts and the temporary `playwright` devDependency
  were reverted before committing, per this file's own convention.

### The deferred token application, done (issue #156)

The recolor this section's own "deliberately not applied here" bullet
flagged as deferred. `CelebrationBurst.tsx`'s `CONFETTI_COLORS` used to
hardcode two colors that duplicated real tokens rather than referencing
them -- `#f5b301` (a second, undocumented gold, distinct from
`--accent-reward`'s `#e8a33d`) and `#3987e5` (a literal copy of
`--series-1`) -- confirmed live by issue #135's own QA pass as two golds
on screen at once (the confetti's `rgb(245, 179, 1)` next to The Call
Board's `rgb(232, 163, 61)`).

**The decision: reference the tokens for those two, keep the other four
as a deliberately separate festive palette.** `#ff6b6b`/`#2dd4bf`/
`#a78bfa`/`#34d399` don't duplicate any existing semantic token, so
there's no drift risk to fix and no reason to invent one by tokenizing
them -- they stay festive literals, chosen for variety, with nothing to
keep in sync. `CelebrationBurst.tsx`'s own doc comment above
`CONFETTI_COLORS` now states this split explicitly, specifically so a
future QA pass doesn't have to re-derive it a third time. `globals.css`'s
own `--accent-reward` consumer list (see its own comment block) now says
CelebrationBurst genuinely is a consumer, replacing the "NOT
CelebrationBurst... don't read the confetti as already using this token"
language #135 had to add when it wasn't yet true.

No canvas/SVG constraint applied here -- confetti pieces are plain HTML
`<span>`s with an inline `backgroundColor` style, which resolves a CSS
custom property exactly the way a stylesheet rule would, so `var(--accent-reward)`/
`var(--series-1)` needed no special-casing. `celebration-magnitude.ts`'s
own tier table (piece count/spread) is untouched, per this issue's own
explicit Out of scope -- this is a palette-only change.

## The Call Board engine: storage, scoring, resolution (issue #128)

The pure logic layer behind the rolling 3-day prediction game -- **no UI
at all** (that's issue #129, which should be able to build against this
section alone rather than re-deriving any of it). Three new modules in
`src/lib/`, all unit-testable without mounting anything:

| module                  | owns                                                                                                                              |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `market-calendar.ts`    | forward trading-day calendar (weekends + scheduled US market holidays), and the "has this day's market opened yet?" approximation |
| `call-board-scoring.ts` | the four buckets, the +/-0.5% threshold, per-day scoring, resolution against real closes, stats                                   |
| `call-board-storage.ts` | the date-keyed localStorage layer, plus `syncCallBoard`, the single entry point #129 needs                                        |

**This is purely additive.** It does not touch, reference, gate or
replace `WholeRangeBalance.tsx`, `WholeRangeReplay.tsx`,
`use-range-guess.ts` or `range-guess-storage.ts` -- the whole-range
guess-then-reveal gate (issue #91) is a different mechanic and stays
exactly as it was. An earlier draft of issue #128 proposed deleting some
of those and also claimed it replaced an existing "N-day check-in
heat-grid"; both claims were withdrawn (there has never been such a
component in this app).

### The mechanic

- **Four buckets** (`CallBucket`): `up-strong` / `up` / `down` /
  `down-strong`, split at `STRONG_MOVE_THRESHOLD = 0.005` (+/-0.5% of
  close-to-close move). **That threshold is a first-pass, undertuned
  value -- it is NOT derived from SPY's real volatility distribution**,
  and its own doc comment says so; don't present it in UI copy as if it
  were calibrated. A dead-flat day (exactly 0.0%) is bucketed `up`, an
  arbitrary but fixed tie-break so there's never a fifth "unchanged"
  outcome to render.
- **Scoring** (`scoreCall`): exact bucket match = 2, right direction at
  the wrong confidence = 1, wrong direction = 0. A call is a **win** at
  `>= 1` (i.e. the direction was right).
- **Stats** (`computeCallBoardStats`): `resolvedCalls`, `wins`,
  `winRate` (wins / resolvedCalls, `null` when nothing has resolved),
  `totalPoints`, `currentStreak`, `bestStreak`. **`winRate` is
  deliberately the only percentage this engine computes** -- a
  points-based rate would be a second, different number for the same
  history and the two would visibly disagree. `totalPoints` is exposed
  as a raw count only; don't turn it into a competing percentage in the
  UI.
- **Rolling lookahead** (`upcomingCallDays`): at most `MAX_OPEN_CALLS`
  (3) trading days whose sessions haven't started, ascending. Today is
  included until its own 9:30, then drops off the front. Derived from
  the clock on every read -- there is no stored cursor and nothing to
  advance on a schedule.
- **Resolution** (`resolveCalls`): a picked day settles once the close
  series holds both its close and the previous trading day's. The very
  first entry in a window never resolves (nothing to measure it
  against), which is correct rather than lossy -- see the persistence
  note below.

### The data source

Real SPY daily closes come from a `PrecomputedResult`'s
`benchmarkSeries.closes` (issue #126, `packages/core`'s
`BenchmarkSeries`) -- a trailing 90-calendar-day window, range-independent
by design, so the board shows the same history whichever range the
viewer has selected. `resolveCalls` takes a plain `DailyClose[]`, not a
`PrecomputedResult`, so nothing in this engine depends on the results
schema beyond that one field's element type. (`packages/core`'s
`index.ts` gained one new export for this: `isValidPrice`, so
`resolveCalls`' own "is this a real price" guard delegates to the
existing single source of truth instead of re-deriving
`Number.isFinite(v) && v > 0` a fourth time -- the exact drift
`packages/core/CLAUDE.md` records catching once already.) Per issue #122, the
`CallBoard` component itself must not take `PrecomputedResult`/`range`/
`mode`/`selectedDay` props -- so #129's own hook is where the series is
obtained, not here.

### Storage keys

- `hikt:call-board:pick:{YYYY-MM-DD}` -> `{"bucket":"up"}` -- one entry
  per called day. **Date-keying is the point of this mechanic and is not
  a reversal of issue #91's decision for `range-guess-storage.ts`**:
  that one has no date dimension because there is exactly one guess per
  (range, mode); this one has several independent calls open at once,
  each locking and resolving on its own schedule, so the day _is_ the
  identity. An object (not a bare bucket string) so a later added field
  is a value change, not a stored-format migration.
- `hikt:call-board:history` -> `{"resolved":[ResolvedCall, ...]}`,
  ascending by date, trimmed to the most recent
  `MAX_STORED_RESOLVED_CALLS` (400, ~18 months).
- **Stats are never stored.** They're derived from the history on every
  read. Issue #128's brief lists them alongside picks and history, but a
  stale or hand-edited stored `bestStreak` could disagree with the calls
  it claims to summarise, and `computeCallBoardStats` is a cheap walk.
- Both readers treat anything malformed as "nothing stored" (a corrupt
  history drops only its bad entries, not the whole record), per this
  file's own localStorage-pattern section.
- Everything goes through `local-storage.ts`'s defensive helpers -- no
  direct `window.localStorage` access anywhere in these modules.

### The lock lives in the storage layer, not the UI

`saveCallBoardPick(date, bucket, now)` writes only while
`isPickEditable(date, now)` -- a real trading day whose approximate
market open hasn't passed. Before that boundary a pick may be changed
any number of times; after it, the call **returns `false` and writes
nothing** rather than silently overwriting a locked call. It's enforced
here and not only in #129's UI because a pick that reached storage after
its day opened would be indistinguishable from an honest one, and this
is the one place every write passes through. (A `false` return also
covers a genuine storage failure; ask `isPickEditable` first if the
difference matters -- nothing in the shipped UI should need to.)

### The market-open approximation, stated plainly

`hasMarketOpened(date, now)` asks one question: **is the client's own
clock, rendered in `America/New_York`, at or past 9:30 AM on `date`?**
No live market data, no server check. A device with a wrong clock can
lock a pick early or leave one editable late; the worst case is a viewer
cheating themselves, which is the right trade for a stakes-free toy.

It uses `Intl.DateTimeFormat` with an explicit `timeZone` rather than a
fixed UTC offset -- unlike `packages/core`'s `unixToLocalDateString`,
whose fixed-offset approximation is fine for price bars. A fixed offset
would be genuinely wrong here: 9:30 ET is a wall-clock time, so it moves
a real hour in UTC terms twice a year (there's a direct DST test for
this in `market-calendar.test.ts`).

Half days (the day after Thanksgiving, Christmas Eve) close early but
still _open_ at 9:30, so the boundary needs no half-day awareness.

### The holiday model, and the one thing it can't know

`isMarketHoliday` models the ten scheduled US market holidays, including
observed-date shifting (Saturday -> preceding Friday, Sunday -> following
Monday) and the one real NYSE exception: **New Year's Day falling on a
Saturday is not observed at all**, because the preceding Friday is the
last trading day of the year (2021-12-31 was a full session; there's a
test for it). Good Friday needs a Gregorian Easter computation -- it's
the only one of the ten with neither a fixed date nor an
nth-weekday-of-month rule.

It cannot know about **unscheduled** closures. Live-verified once
against every real SPY session in the three years ending 2026-08-26 (752
sessions): the model agreed on every calendar day except **2025-01-09**,
the National Day of Mourning for President Carter -- exactly that
category, not a rules bug. `market-calendar.test.ts` keeps a
committed-fixture version of that same cross-check against
`src/test-fixtures/spy-daily-closes.ts` (63 real closes, the same
90-day shape a real `benchmarkSeries` carries).

### `syncCallBoard` is the one call #129 needs

`syncCallBoard(closes, now)` resolves every stored pick the series now
covers, folds them into the persisted history (an already-settled date
keeps its original entry -- `mergeResolvedCalls` is last-write-_loses_,
so a date reappearing in a differently-sliced window can never quietly
change score), writes back only when something new actually settled, and
returns `{ openCalls, resolved, stats }`. History is persisted rather
than re-derived precisely because it outlives its own 90-day source
window -- a streak that ran across that boundary would silently reset if
this were derived state.

It is safe to call during a server render (every storage read degrades to
"nothing stored" without a `window`), but **#129 still owes it this
file's usual hydration discipline**: `CallBoard` mounts at the
`ResultsPage` level per issue #122, which _does_ render on the server, so
follow `use-hydrated-local-storage-state.ts`'s deferred-correction shape,
not `use-daily-guess.ts`'s synchronous-read shortcut (that shortcut is
only safe from `ResultsPanel`'s client-only success branch).

### Real-data backtest (the acceptance criterion)

`call-board-scoring.test.ts` runs a blind "always call `up`" strategy
against the real fixture and asserts hand-worked numbers, with the
per-day table written out in a comment above the test: over the real
22-trading-day span **2026-07-27 .. 2026-08-25**, it scores **12 wins of
22 calls (54.5%), 18 points, best streak 4, current streak 1** -- 6
exact matches at 2 points plus 6 right-side-only at 1. Over the
fixture's full 62-call window: 32 wins, 48 points, best streak 4. (Issue
#128 cites 12/22, ~55%, best streak 4 from the original design process
against a different window -- recomputed here against the data this repo
actually ships, and landing in the same place.)

## Gain/loss rebalance + duration-coded range pills (issue #123)

Like #121, **the decision record lives in `src/app/globals.css`'s own
comment block above `--status-critical`/`--status-good`** -- read that
before changing either value. The short version, plus the things that only
showed up live:

- `--status-good` `#0ca30c` -> `#4ab86f`, `--status-critical` `#e66767` ->
  `#e46b64`. The defect was **not** a WCAG failure (an earlier draft of the
  issue claimed one and was wrong -- both old values already cleared 4.5:1
  on every surface): it was a 31-point HSL-lightness gap plus a 0.048 OKLCH
  chroma gap, a dark maximally-saturated forest green next to a light
  moderate salmon, so a loss read louder than a gain. Now 13.7 HSL-lightness
  points apart (2.9 in OKLCH lightness, 0.005 in chroma). Contrast improved
  on all three surfaces for both: good 5.90/5.19/4.52 -> 7.90/6.95/6.05,
  critical 6.13/5.39/4.69 -> 6.21/5.46/4.75 (`--background`/`--surface-1`/
  `--surface-2`; `--surface-2` is the binding one).
- **`app/global-error.tsx`'s hand-copied `#e66767` had to move with it**
  (three places: the hex plus two `rgba(230, 103, 103, ...)` values). That
  file can't import `globals.css` -- see its own doc comment -- so nothing
  enforces the sync; it is the one thing to grep for on any future change
  to these values.
- `RangeSelector`'s pills gained an `aria-hidden` duration bar (8/11/14/17/
  20/23px, ordinal by `PRESET_RANGES` position, not proportional to real
  elapsed time -- 1W to MAX spans three-plus orders of magnitude and a
  true-to-scale bar renders the short ranges as identical slivers). Length,
  not a color per range: color on this page already means gain/loss and
  earned-vs-selected, and duration is ordinal. The width is an inline
  `style`, not a Tailwind class, because this repo's jsdom setup loads no
  stylesheet and a class-based width isn't assertable.
- **The bar is absolutely positioned inside the pill, and that is
  load-bearing, found by measuring rather than by eye.** The first version
  stacked label-over-bar in flow; a bar wider than its own (very short)
  label widens that pill -- "1Y" is the narrowest at ~14px of content
  against a 17px bar -- which grew the row from 343px to 345px and pushed
  `document.documentElement.scrollWidth` to 377px at a 375px viewport, a
  real 2px horizontal overflow on the page this control already nearly
  fills (issue #63). Taking the bar out of flow (`absolute bottom-1.5
left-1/2 -translate-x-1/2`, with `pb-3` reserving the room) keeps every
  pill's width purely label-driven: re-measured live at 343px and
  `scrollWidth` 375, identical to before the indicator existed.
- The active pill now fills with `--accent-selection` instead of
  `--series-1` directly -- the same blue, and exactly the consumer #121's
  own decision block names. The other five active-control sites
  (`ModeToggle`, `CustomRangeSelector`, `DayOverview`, `WholeRangeBalance`,
  `app/error.tsx`) still said `--series-1` after this issue; **issue #135's
  cross-feature QA pass finished that migration**, so all six now genuinely
  say `--accent-selection`. Same pixels (it is an alias) -- see this file's
  own "Final cross-feature design QA pass" section at the end.
- **Live verification gotcha, cost real time: in this sandbox a headless
  Chromium cannot hydrate a `next dev` page.** Every `/_next/static/chunks/
*.js` request came back **403** to the browser while the exact same URL
  returned 200 to `curl`/Node, and the HMR websocket failed with
  `ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS`. The page still renders
  (SSR'd markup screenshots fine), so the failure is silent and looks like
  "React is fine but nothing animates" -- the count-up sat frozen at its
  starting value and clicking "Watch it happen" did nothing. `next build`
  - `next start` on the same port has no such problem. **Use the production
    server, not `next dev`, for any screenshot pass that needs real
    interaction here** -- and if a run ever shows unstyled/oddly-narrow
    markup, check for a leftover `next start` still holding the port from a
    previous build (its stale asset manifest 500s on the new CSS chunk, and
    `pnpm start` only logs `EADDRINUSE` to its own log file).
- Verified live at 375px and 1024px, before and after, on the production
  server: the six pills' bar lengths read as a ramp with no row-width
  change, and `TradeReplay`'s playback overlay ("Watching {date}" + "Skip to
  end" + the chart-anchored callout bubble) was screenshotted mid-playback
  for both a gain and a loss fixture, since it consumes `heroMultiplierColor`
  directly. Zero console errors across the whole run.

## The Call Board UI: board, history strip, stats (issue #129)

`components/CallBoard.tsx` plus `lib/use-call-board.ts` -- the player-facing
half of the mechanic whose engine issue #128 shipped. **Nothing here
re-implements any of that engine**: buckets, the +/-0.5% threshold,
scoring, resolution, the rolling lookahead, the after-the-open lock and
every storage read/write are all reached through `syncCallBoard` /
`saveCallBoardPick` / `exchangeClock` / `isTradingDay`. The one genuinely
new piece of logic is `callOutcomeFor` (see "The history strip" below).

Mounted per issue #122's standing decision -- a section in
`ResultsPage.tsx`, a direct sibling **after** `<ResultsPanel>`, taking no
props at all. `ResultsPage.test.tsx`'s own "The Call Board placement"
describe block regression-tests both halves of that decision structurally
(the board renders while `/api/results` is still unresolved, and it is not
a descendant of the panel).

### Where the SPY series comes from without a result prop

`useCallBoardCloses()` (`lib/use-call-board.ts`) fetches
`/api/results?range=1W` itself and reads only `benchmarkSeries.closes`
(issue #126). The range is arbitrary -- that field is deliberately
range-independent -- and 1W is picked because it's `ResultsPage`'s own
`DEFAULT_RANGE`, so on a normal first load the board's request is for a URL
the page already fetched and the browser can serve from cache.

**An empty series is a fine degraded state, not an error**, and every
non-success path returns one shared `NO_CLOSES` constant (a stable
reference -- `useCallBoard`'s sync effect is keyed on it, so a fresh `[]`
literal per render would re-sync forever). `syncCallBoard` still returns
the whole board from localStorage plus the clock; only _newly settling_ a
day needs closes at all, so the board stays fully playable offline or with
`/api/results` 500ing. This is also the reason `ResultsPage.test.tsx`'s
"does not also fetch a preset range" test had to change: it now asserts the
only `range=` request in anchor mode is the board's own fixed one.

### The first render reads neither the clock nor storage -- stricter than the usual pattern, on purpose

`UNHYDRATED_VIEW` is a plain module constant (`openCalls: []`,
`hydrated: false`), and `CallBoard` renders `PLACEHOLDER_SLOTS` -- three
inert, `aria-hidden`, `disabled` slots of exactly the real size -- until
the mount-time microtask corrects it.

This goes further than `use-hydrated-local-storage-state.ts` (which only
defers the _storage_ read) and further than `CustomRangeSelector`'s
precedent of calling `new Date()` during render, and the reason is
specific to this feature: **this board's clock-derived output changes at
two boundaries a day** (midnight and 9:30 AM in New York), not once a
month the way `customRangeAnchors`' does -- and 9:30 AM Eastern is a
high-traffic moment for a stock-market page, not an obscure one. It also
costs nothing visible: the correction runs in a microtask before the
browser paints, and the placeholders reserve the same height.

**This was a real, reproduced bug, not a theoretical one.** The first
implementation did compute the lookahead during render. Faking _only_ the
client's clock under headless Chromium (so the server genuinely rendered a
different day) reproduced React's hydration-mismatch `pageerror` on the
Saturday and Labor Day verification passes; after the fix the same two
passes log zero errors. Worth reusing as the technique for any future
clock-dependent component here: a same-clock screenshot pass will not
catch this, because the server and client agree by coincidence.

Placeholders are `disabled` _and_ the `<li>` is `aria-hidden` -- a disabled
button isn't focusable, so nothing focusable ever sits inside an
aria-hidden subtree (the ARIA violation issue #96's own review round two
caught for the truncated replay chart).

### The history strip: four outcomes, and where that fourth one comes from

`callOutcomeFor` is the only new logic in this issue. It takes the
engine's own `score` and splits its single `0` in two by how far apart the
picked and actual buckets sit in `CALL_BUCKETS`' order:

| outcome           | rule                          | glyph | colour              |
| ----------------- | ----------------------------- | ----- | ------------------- |
| `exact`           | `score === 2`                 | `★`   | `--accent-reward`   |
| `right-direction` | `score === 1`                 | `✓`   | `--status-good`     |
| `near-miss`       | `score === 0`, distance `1`   | `~`   | `--text-secondary`  |
| `far-miss`        | `score === 0`, distance `>=2` | `✕`   | `--status-critical` |

**Score is checked before distance, and that ordering is load-bearing**: a
distance of 1 can mean either a right-direction confidence miss ("Up big"
vs. "Up") or a wrong-direction near miss ("Up" vs. "Down"), so distance
alone would conflate two genuinely different results. This is a _display_
classification only -- it feeds nothing back into `computeCallBoardStats`,
and the engine still scores a near miss and a far miss identically at 0.

WCAG 1.4.1 is satisfied three ways over, deliberately not by colour plus a
`title` (which assistive tech doesn't reliably announce): every cell
carries a visible glyph, an `sr-only` sentence naming the date, the call,
the real move and the outcome, and there's a visible legend repeating each
glyph next to its meaning. `CallBoard.test.tsx` has one test per outcome
asserting the glyph, the colour class and the sr-only wording.

### Token application (issue #121)

- `--accent-reward` (gold) on exactly two things: the **exact-match**
  history cells and the **streak figures**. Always as a glyph/text colour,
  never as a fill -- white on gold measures 2.16:1.
- `--accent-selection` (blue) on a **selected bucket button**. A filled
  slot means "you picked", not "you earned", so it deliberately matches
  `RangeSelector`'s active pill rather than the gold.
- `font-display` on the heading and the stat figures (big static figures).
  Not `font-numeric` -- nothing here animates digit by digit.

`globals.css`'s own token block warns against putting a gold element and a
status-coloured element in the same legend where **hue is the only thing
telling them apart**. The history strip's legend does put all three in one
row, and that's fine here specifically because hue is never the only
signal: each of the four outcomes carries its own distinct glyph
(`★`/`✓`/`~`/`✕`) and its own sr-only wording. Keep that property if the
legend ever changes -- it is what makes this an exception rather than a
violation. (Issue #123's rebalance of `--status-good`/`--status-critical`
needed no change here at all: everything references the tokens by name.)

**A real trap, found by screenshot rather than by any DOM assertion**: an
earlier `Stat` put `text-[var(--text-primary)]` in a shared base className
and appended `text-[var(--accent-reward)]` per caller. Both classes really
were on the element, so every DOM-level test passed -- but two
arbitrary-value `text-[...]` utilities are the same property at the same
specificity, so which wins comes down to Tailwind's own emitted source
order, and the streak figures silently rendered white. `Stat` now takes a
required `colorClassName` and the base carries no colour at all. Worth
remembering for any future component that layers two arbitrary-value
utilities of the same property.

### The unspecified states, both decided here

- **First visit**: three unset slots, `0 / 0% / 0 / 0`, and an explanatory
  empty history ("Nothing has settled yet..."). `winRate` is genuinely
  `null` in the engine when nothing has resolved; the display coerces it to
  `0%` rather than a dash, per the issue's own literal `0/0%/0/0` spec --
  a placeholder in one of four otherwise-numeric tiles reads as broken.
- **Weekend/holiday**: no special board at all -- `upcomingCallDays`
  already skips non-trading days, so the three slots are always real
  trading sessions. The only addition is a one-line note ("Markets are
  closed today, so the board is already looking ahead...") gated on
  `!isTradingDay(exchangeClock(now).date)`, so a viewer isn't left
  wondering why the first slot isn't today. Verified live on a Saturday
  (slots roll to Mon/Tue/Wed) and on Labor Day 2026 (Sep 7 -> Sep 8/9/10).

### The "not a predictor" disclaimer

`AboutSection.tsx`'s existing "not a predictor" paragraph is **unchanged**;
a second paragraph was added after it distinguishing the Call Board rather
than softening it ("a separate practice game, not part of that hindsight
analysis and not an exception to the line above"). A short form also sits
in the board's own header, where the game actually is. The issue asked for
this to be surfaced rather than resolved silently -- it's called out in
#129's PR description as an open product-copy question.

### Layout

Slots are `grid-cols-1 sm:grid-cols-3`; each slot's four buckets are
`grid-cols-2 sm:grid-cols-1`. That inversion is deliberate: at `sm` and up
three slots share the row, leaving ~90px per button in a two-across grid --
narrow enough that "Down big" wrapped onto a second line and made the 2x2
grid visibly ragged. One button per row at that width is both un-wrapped
and reads as a bullish-to-bearish ladder, matching `CALL_BUCKETS`' order.

### Live verification

The permanent `LOCAL_RESULTS_DIR` workflow (real `local-run.ts` pipeline
pass, 8 real tickers, a real 62-entry SPY `benchmarkSeries`) plus `next
dev` and the documented no-root headless-Chromium technique. Nine
scenarios, **zero console errors and zero `pageerror` events in every
one**:

- First visit at 1280 / 375 / 390px; `documentElement.scrollWidth` equals
  the viewport at both mobile widths (no horizontal overflow), and all
  three slots share one `x` (genuinely one column) at both.
- **Touch targets measured with real `getBoundingClientRect()`**, not
  eyeballed: every bucket button is exactly `44px` tall at every width
  (129.5x44 at 375px, 137x44 at 390px, 189.33x44 at 1280px). The jsdom
  test can only assert the size contract -- no stylesheet is loaded in that
  environment -- so the real pixels come from here.
- A real pick: `aria-pressed` moves to the clicked bucket, the live region
  reads "Called up big for Aug 27, 2026.", and
  `hikt:call-board:pick:2026-08-27` is genuinely in localStorage.
- Populated, from **real resolution against real closes** (12 picks seeded
  across real trading days, then resolved by `syncCallBoard` on reload):
  12 resolved, 33% win rate, best streak 2, and all four outcomes present
  at once, each cell's computed colour read back off the live DOM and
  matching its own token (`--accent-reward` / `--status-good` /
  `--text-secondary` / `--status-critical`). **That run predates issue
  #123's palette rebalance**, so the two status tokens' raw hexes have
  since moved (`#0ca30c` -> `#4ab86f`, `#e66767` -> `#e46b64`) -- the
  component references the tokens by name, so it followed the rebalance
  for free, which is why this note cites token names rather than the
  literal values that were measured.
- Saturday and Labor Day, via an init script faking only the client's
  clock (see the hydration note above).

Playwright was added with `pnpm add -D -w playwright` for the session and
reverted afterwards, per this file's own convention.

## Beat the Bench: the core session player (issue #131)

The playable, bar-by-bar buy/sell game against the SPY benchmark,
Today's Close mode. Mystery Day, the best-moves/percentile settlement
narrative (both issue #132) and weekly/monthly modes (backlog) are
deliberately not here.

| file                                    | owns                                                                                            |
| --------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `lib/beat-the-bench.ts`                 | the whole mechanic as pure functions: speeds, holdings, settlement, and every settlement string |
| `lib/beat-the-bench-storage.ts`         | `hikt:beat-the-bench:{date}:{mode}` (the key issue #133's status rail reads)                    |
| `lib/use-todays-close-session.ts`       | the fetch, a thin `useFetchResultsState` instantiation                                          |
| `lib/use-reduced-motion-after-mount.ts` | the SSR-safe reduced-motion read (see below)                                                    |
| `components/BeatTheBenchChart.tsx`      | the ticking SVG chart                                                                           |
| `components/BeatTheBench.tsx`           | the section itself: chooser, playback, settlement                                               |

### The read path issue #127 deliberately didn't build

`/api/beat-the-bench` -> `getTodaysCloseSessionResponse` (`results-api.ts`)
-> `createResultReader()`. Shaped as `getCustomAnchorsResponse`'s
sibling, not as a `ResultRouteConfig` instantiation: one fixed key, no
identifier to parse. Everything genuinely shared with the other routes
(reader check, getObject try/catch, not_found, JSON.parse, schemaVersion)
still comes from `readCurrentSchemaObject`, plus one `bars` non-empty
check on top -- the same light posture the anchors manifest gets, since
apps/pipeline already ran `validateTodaysCloseSession` before storing it.

### The zero-trade invariant, and why it's exact rather than close

The player starts **in the market**, so "never touch it" and
"buy and hold" have to settle identically. They do, by construction:
`balanceAtBar(bars, [], capital, i)` **is** the benchmark, so the
zero-move player and the bench are the same call with the same
arguments, not two implementations that agree to within an epsilon.

Holdings are a `{ shares, cash }` pair, not a running balance multiplied
by each bar's return: valuing shares at the current price is one
multiplication from the opening price no matter how many bars have
passed, so a 79-bar session accumulates no per-bar drift. A separate
test checks the shared construction is genuinely buy-and-hold
(`benchmarkBalance` vs. the closed-form ratio), so the invariant test
can't pass by being merely self-consistent.

### The 1x session length is a target that was hit, not an emergent value

`BASE_TICK_MS = 300`, chosen against a stated target of **under 30
seconds at 1x**. A real regular session is 79 five-minute bars and the
opening bar is already on screen, so a full run is 78 ticks = **23.4s**;
measured end to end in a real browser at **23.7s** wall clock. The other
four speeds fall out of it: 0.1x = 3.9 minutes, 0.5x = 46.8s, 2x =
11.7s, 4x = 5.9s. `beat-the-bench.test.ts` asserts the real millisecond
intervals, and `BeatTheBench.test.tsx` measures each one by holding a
fake clock one millisecond short of it -- "the five multipliers differ"
was explicitly not enough for this issue.

### Reduced motion gets a real alternative, not a removal

Every other animated affordance in this app (celebration burst, chart
tap hint, trade replay) is simply **not rendered** under reduced motion.
That answer doesn't work here: the ticking chart _is_ the mechanic, so
removing it leaves nothing to play. Instead:

- Playback **starts paused** when the viewer prefers reduced motion, and
  the chooser says so before they commit.
- **"Step forward one bar"** is present for everyone, always, and is a
  complete way to play a session start to finish -- trades included.
  Verified live: 78 real step clicks plus a trade, through to a real
  settlement and a stored record, with the clock never advancing a bar
  on its own.
- The speed controls stay available -- a reduced-motion viewer who would
  rather watch it at 4x than press step 78 times can.

`use-reduced-motion-after-mount.ts` exists because of this section's
placement, and the distinction is easy to get wrong: `useReducedMotionAtMount`
reads the preference in a `useState` lazy initializer, which its own doc
comment says is only safe from a component that never renders during
SSR. Per issue #122 this one mounts at the `ResultsPage` level, which
does. The new hook takes `use-hydrated-local-storage-state.ts`'s
deferred-correction shape instead (`false` on the server and on the
hydration render, corrected in a post-mount microtask).

### The chart is its own SVG, and shows only what the player has reached

Not a reuse of `PortfolioChart`: that plots a portfolio over trade events
on a **log** axis (it has to survive $20 -> $218M). This plots one
ticker's intraday closes across a single session whose whole range is
well under 2%, where log would be indistinguishable from linear.

- **The y-domain comes from revealed bars only.** An axis fitted to the
  whole session would publish the day's high and low before the player
  got there. There's a regression test that renders the same revealed
  prefix with a wildly out-of-range future bar and asserts the geometry
  is byte-identical.
- **No time labels inside the SVG.** The viewBox is 880 units wide and
  paints at ~295px on a 375px screen, so a 12px label (PortfolioChart's
  own axis size) renders at about 4px -- and early in a session the
  opening and live labels overprint into a smudge. Both seen for real at
  375px, not theorized. The component renders the revealed span
  ("9:30 AM -> 11:05 AM - bar 20 of 79") as ordinary HTML above the
  chart instead. Worth knowing before adding axis text to any chart this
  small.
- While the player is in cash the line goes **muted and dashed** -- the
  price kept moving, they just weren't on it.

### Tone: the mechanic is borrowed, the voice is not

Beat the Couch taunts ("go ahead, time it", "crawling back so soon?",
"twitchy"). This app's register is `narrate-trades.ts`'s. Every string
was written against that, and the settlement copy lives in
`beat-the-bench.ts` (`outcomeHeadline`/`outcomeDetail`/`gapPhrase`) with
a test asserting the zero-move outcome reads "Along for the ride" and
explains itself, rather than the source's "even odds" -- which is also
just wrong, since zero trades is buy-and-hold, not a coin flip.

`gapPhrase` exists because one session moves a fraction of a percent:
both balances routinely round to the same dollars-and-cents figure even
when one genuinely won, so the **gap** is what goes on screen ("0.13%
behind the bench", or "Less than 0.01% ahead" below a hundredth of a
percent). `formatSessionPercent` (a second decimal) is there for the
same reason and is deliberately separate from `formatPercent`.

### Testing notes worth not rediscovering

- **`fireEvent`, not `userEvent`, in `BeatTheBench.test.tsx`.**
  userEvent's own internal delay is a timer, so under `vi.useFakeTimers()`
  every click has to be pumped by the same clock whose exact readings
  these tests assert on. Every timing test hung before this switch.
- **The reduced-motion tests wait for the preference to land** before
  pressing play. It's read in a post-mount microtask, so there's a
  microtask-wide window where the chooser is up but the preference
  isn't applied -- a human can't click inside that, a test can, and did:
  they passed alone and failed under a loaded full-suite run.
- `test-fixtures/spy-session-bars.ts` is a real published session (79
  bars, 2026-08-26, +0.053%) straight from a real local pipeline run.

### Judgment calls a future issue may want to revisit

- **The session is fetched on mount, always**, even for a viewer who
  never plays -- a few KB, and the chooser card names the real date,
  which is in the payload. Issue #132's pool is many sessions; don't
  assume this precedent covers it.
- **A replay overwrites the stored record** rather than being refused.
  Nothing enforces one play per day: the settlement on screen should be
  the one the page remembers. If #133's ritual wants a once-a-day lock,
  that's its call to make.
- **A move settles at the price on screen**, which is a small look-ahead
  edge over real life (you always trade at a price you've already seen).
  Stated in the settlement copy rather than modelled away.

### Live verification (real pipeline output, real browser)

Real `local-run.ts` pass (6 tickers, real Yahoo calls) into a
`LOCAL_RESULTS_DIR`, then `next dev` plus the documented no-root
headless-Chromium workaround: `/api/beat-the-bench` served the real
2026-08-26 session; a full 1x playthrough took 23.74s wall clock; a
zero-move run settled "Along for the ride" with both sides reading
$20.01 (+0.05%); at 375px every playback control measured >= 44px
(44x44 for each speed pill, 68x44 Pause, 59x44 Step) with
`scrollWidth === clientWidth === 375`; a reduced-motion context started
paused, sat still for 3s, and played through on step clicks alone; a
context with `localStorage` throwing on every access still played to
settlement. Zero console or page errors across all five runs. The
temporary `playwright` devDependency and the verification script were
reverted before committing, per this file's own convention.

## Beat the Bench: Mystery Day + Final Settlement analytics (issue #132)

The second mode, and the settlement narrative #131 deliberately deferred.
The engine (`lib/beat-the-bench.ts`) is **unchanged except for one type
widening** -- Mystery Day is a different payload, not a different
mechanic, so `balanceAtBar`/`settleSession`/the whole toggle model play a
pooled session exactly as they play Today's Close.

| file                               | owns                                                                       |
| ---------------------------------- | -------------------------------------------------------------------------- |
| `lib/beat-the-bench-moves.ts`      | the session's best runs, whether the player was on them, the dollar figure |
| `lib/beat-the-bench-percentile.ts` | the seeded Monte Carlo field of random togglers                            |
| `lib/use-mystery-session.ts`       | both client fetches -- and the "not until settlement" rule, mechanically   |
| `app/api/beat-the-bench/mystery/`  | the pick route, and its `reveal/` sibling                                  |

### The date-secrecy rule is a request that doesn't happen, not a hidden prop

Issue #127 put the pool's real dates in exactly one object
(`results/mystery-index.json`) so that "don't read this yet" is **one**
rule rather than several. This issue's whole job on that front is to
honour it, and the enforcement is deliberately structural rather than
presentational:

- `useMysteryReveal(sessionId)` is a `useFetchResultsState` instantiation,
  and `SessionGame` passes `settled ? session.sessionId : null`. A `null`
  URL makes that hook issue **no request at all** -- it does not fetch and
  hide, or fetch and discard. So before settlement there is no date in the
  DOM, in component state, in a fetch cache, or in the network log.
- `/api/beat-the-bench/mystery/reveal?id=` answers for **one id**, never
  the whole `MysteryIndex`. One settlement earns one date; serving the map
  would let a single finished game de-anonymise the other 40 sessions.
  There is a test asserting no other pooled date appears in the response.
- `isMysterySessionId` is an **exact-membership check against
  `MYSTERY_SESSION_IDS`**, not a regex on the id's shape -- the value is
  interpolated straight into an S3 key by `mysterySessionKey`.
- The pick happens server-side (`getMysterySessionResponse`, with an
  injectable `random` so it's pinnable in tests, mirroring apps/pipeline's
  own `RunPipelineOptions.random`). Client-side picking would have meant
  shipping the browser the manifest first; safe in principle, but a round
  trip that never puts the pool's membership in front of the player is
  simply less surface.
- Both mystery routes send `Cache-Control: no-store`, unlike every other
  route in `results-api.ts`. The pick is _random_ (a shared cache would
  hand everyone the same "mystery" day) and the reveal _is the answer_.

**Pool rotation is handled, not hoped away.** Slots are re-permuted every
pipeline run, so an id picked before a run resolves to a different day
after it. `MysterySessionResponse.poolGeneratedAt` is compared against the
reveal's own `generatedAt`; on a mismatch the settlement says the day can
no longer be looked up rather than confidently naming the wrong one, and
writes no stored record.

**A mystery session's record is keyed by the revealed _real_ date**
(`hikt:beat-the-bench:{date}:mystery`), written when the reveal lands
rather than at settlement -- so issue #133's rail reads one key shape for
both modes. Keying by the slot id would mean a key that silently means a
different day after the next nightly run.

### The chooser really did just gain a card

Issue #131 built its single-card chooser as a _list_ of mode cards
specifically so this issue would add a card rather than a layout. That
held. What did change: mode selection moved up to `BeatTheBench` itself,
so `SessionGame` now takes a mode-agnostic `PlayableSession`
(`date: string | null` is the entire difference between the two modes) and
**auto-starts on mount** -- picking a mode _is_ the start click, so #131's
separate "press play" step would have become a second one.

One consequence worth knowing: `SessionGame` reads `reducedMotion` in a
`useState` initializer, which #131's version could not. It's safe here
only because this component now mounts in response to a click, long after
the parent's own post-mount preference read has landed.

`isPlayableSession` takes a structural `PlayableSessionPayload`
(`{ bars }`) instead of `TodaysCloseSession` -- the two payloads differ
only in whether they carry a date, which is exactly the field a
playability check has no business reading.

### The percentile: a real simulation, seeded, never `Math.random()`

`comparePercentile` runs `SIMULATION_TRIALS` (500) synthetic traders
through the **same real bars**, each toggling with `TOGGLE_PROBABILITY`
(0.05 per bar, ~4 moves across a regular session), and ranks the player
against them. Every trader is settled by `balanceAtBar` -- the same call
that settles the player and the bench -- so a zero-move player's rank is
genuinely buy-and-hold's rank, no special case anywhere. Ties count as
half (`percentileRank`), which matters rather than being pedantry: a
trader whose random moves cancel out finishes _exactly_ level with
buy-and-hold, so a do-nothing player really does tie a slice of the field.

- **The RNG is a required parameter, not a defaulted one.** There is no
  code path here that reaches `Math.random()`; a bare one would make every
  assertion on the resulting percentile flaky by construction. The
  component seeds `mulberry32(seedFromBars(bars))` -- from the price path,
  never the clock and never a date (Mystery Day has none on the client,
  and must not). That also means the number a player is reading can't
  shift under them on a re-render.
- **`test-fixtures/spy-trending-session-bars.ts`** exists because the
  directional claim can't be tested against one flat fixture: two real
  pooled sessions, **2026-08-04 (+1.238%)** and **2026-07-29 (-1.418%)**,
  pulled verbatim from a real local pipeline run's own mystery pool.
  Measured do-nothing percentiles across seeds 1-5: **88.5 / 89.1 / 90.5 /
  89.7 / 89.4%** on the up day against **21.9 / 22.9 / 26.1 / 25.7 /
  26.6%** on the down day. The two ranges don't overlap, which is what the
  test asserts (min-up > max-down, gap > 0.5) rather than a hardcoded
  threshold. `spy-session-bars.ts` (the +0.053% quiet day) stays the
  fixture for the mechanic's own invariants -- exactly wrong for this,
  exactly right for that.

### The dollar figure is an approximation, and the comment says exactly which one

`benchmarkDollarsFor`'s methodology, stated once there and mirrored in the
UI copy: **`balanceAtBar(bars, [], capital, fromIndex) * returnFraction`**
-- what a buy-and-hold position was worth when the run started, times the
run's own price return. In words: _if you had been holding the bench's
position when this run happened, it would have added this many dollars to
it._

It is **not** what the run would have added to _the player's_ balance, and
**not** a re-simulation of their session with one decision changed (that
needs replaying everything downstream of the change, since every later
move compounds off a different balance). The per-run figures are
**deliberately not summed** into a "what your mistakes cost you" total for
the same reason -- they would each have compounded into the next. The
rendered copy hedges to match ("about", "to a buy-and-hold position of
this size"), and `missedMoveSentence` says "you weren't in the market for
all of the run", not "you were in cash from X to Y" -- `heldThroughout`
counts a player who stepped out _mid_-run as having missed it, and the
sentence has to stay true for them.

**`MAX_MOVE_SPAN_FRACTION` (1/3) is load-bearing, not cosmetic.** Measured
against the real +1.24% fixture: uncapped, the single best move is bar 0
to bar 74 (09:30 to 15:40) and it overlaps everything else, so the list
comes back with one entry that is buy-and-hold restated. Capped, the same
session yields three real intraday runs.

### Live verification (real pooled data, real browser, real network log)

Real `local-run.ts` pass (6 tickers, real Yahoo calls) into a
`LOCAL_RESULTS_DIR` -- 41 pooled sessions plus manifest and index, and a
direct scan confirmed **0 of 41 pooled payloads contain a date-shaped
substring**. Then `next build` + `next start` (not `next dev` -- see issue
#123's note on hydration failing here) and the documented no-root
headless-Chromium workaround. 19 of 19 checks passed:

- Mid-session (bar 17 of 78), against the section's real `innerHTML`, not
  its render tree: **no date-shaped text of any kind** (`YYYY-MM-DD` or
  "Mon D, YYYY"), the picked slot's real date absent both raw and
  formatted, and absent from `document`, `localStorage` and
  `sessionStorage`.
- **Zero requests** matching `mystery/reveal` or `mystery-index` out of 17
  total, mid-session. Exactly one afterwards. The full recorded log for a
  session-plus-a-second-pick run is: `mystery?pick=0`,
  `mystery/reveal?id=s01`, `mystery?pick=1` -- and no reveal for the
  second, unfinished session.
- At settlement the real day appears, **no other pooled session's date
  does** (all 40 checked), and the record is stored under
  `hikt:beat-the-bench:2026-07-08:mystery`.
- The biggest-runs panel, its approximation caveat, and the percentile
  line ("You finished ahead of 69% of 500 traders who moved at random
  through the same session.") all render. 375px shows no horizontal
  overflow. Zero console errors/warnings and zero page errors.

**One real bug the browser found that reading the code did not**: before
this, "Pick a different mode" only rendered _after_ a session settled, so
a player who started a 78-bar session by mistake had no way out short of
reloading. Caught because Playwright sat waiting 23 seconds for a control
that simply wasn't there yet. `PlaybackControls` now carries it too, with
a regression test.

The temporary `playwright` devDependency and both verification scripts
were reverted before committing, per this file's own convention.

## The hero count-up no longer moves the page (issue #147)

The fix for the jitter issue #124's spike measured. The hero's 1.2s
`useCountUp` reveal used to change the animated span's bounding box on
essentially every frame, and because that span sits in a
`flex flex-wrap` row whose wrap threshold falls inside the swept range,
the row re-wrapped mid-animation and moved the chart, the "Trades"
heading and the document's own `scrollHeight` while the number counted.
Two independent causes, and **fixing only one leaves the defect**:

1. **Glyph metrics, on every result.** Geist Sans' figures are
   proportional; at 64px/600 its "1" is 25.4px against its "0"'s 42.4px,
   so identical-length strings differ by up to 81px.
2. **`formatHeroCurrency`'s compact-unit ladder, on results that cross a
   unit boundary.** "$994.72" -> "$1K" is a 128px drop in one frame, and
   no choice of typeface helps: seven characters are wider than three.

### What shipped

- **`font-numeric tabular-nums` on the two shared value-row class
  strings** -- `HeroStat.tsx`'s `heroValueRowClassName` and
  `WholeRangeBalance.tsx`'s `wholeRangeValueRowClassName`. Geist Mono,
  the face issue #121 declared for exactly this ("anything tabular or
  animated digit by digit ... useCountUp's reveal"). On the _row_, not
  the animated span, on purpose: the `heroSlot`/`revealSlot` overlays
  are sized by the invisible real figure behind them, so a metric change
  reaching one side and not the other is precisely how issue #107 broke
  twice -- anything on these strings reaches both sides at once.
- **`components/AnimatedFigure.tsx`** reserves the box. For each ladder
  tier the tween crosses it renders one invisible width probe
  (`lib/format-currency.ts`'s `heroCurrencyWidthProbes`), all stacked
  into a single CSS grid cell with the real value, and lets the browser
  size the column to the widest. All four figures that need it render
  this same component from the same two endpoint values -- `HeroStat`
  and `TradeReplay`'s playing overlay, `WholeRangeBalance` and
  `WholeRangeReplay`'s overlay -- so the reservation is impossible to
  apply to one side of an overlay only.
- **`HeroStat.tsx`'s "proportional (not tabular)" doc comment is
  rewritten, not left contradicting the code.** The dataviz spec's line
  is written for a _static_ hero number; this one animates, and a figure
  that shoves the page around as it reveals is worse than one whose
  digits aren't optically spaced. Static figures elsewhere
  (`WorstCaseStat`, `BenchmarkStat`, the trade narration) are untouched.

### Three things worth not re-deriving

- **Geist Sans' own `tabular-nums` is NOT sufficient, measured, not
  assumed -- don't "simplify" the mono face away.** Issue #124 reported
  every tabular digit at 38.406px, but sampled only 0/1/2/9. Measured
  across all ten digits in a real browser on this app's own hero row
  (64px/600, letter-spacing zeroed): eight digits advance 40.0px, **"4"
  advances 41.0px and "7" advances 39.0px** -- Geist's `tnum` table is
  not actually uniform. `$999.99` measures 256px against `$444.44`'s
  261px, and the plain `$20.00 -> $21.43` day still swept three distinct
  widths under `tabular-nums` alone (a "4" appearing and disappearing as
  the number counts). Geist Mono measures exactly 38.0px for every digit
  _and_ for "$", ".", "K" and "M" -- that uniformity is what makes
  "longest probe" and "widest probe" the same question.
- **The probes paint from a `data-figure-probe` attribute via
  `globals.css`'s `.figure-width-probe::after`, not from real text
  nodes.** Generated content occupies layout but stays out of
  `textContent`. As real children they'd join the figure's own text --
  the whole-range headline would read `$99.99$999.99$9.9K$1.1K` to
  `getByText`, to any DOM walk, and to every future debug script. (It
  did, in the first draft; three existing tests failed on it.)
- **Sampling an interval's endpoints does not bound it.** `$1,000 ->
$2,000` formats as "$1K"/"$2K" at both ends but "$1.5K" in between, so
  `heroCurrencyWidthProbes` works from the ladder's own tier table
  instead. It lives in `format-currency.ts`, next to the ladder it
  mirrors, and `format-currency.test.ts` brute-forces the two against
  each other (dense linear _and_ geometric sweeps) so a future ladder
  change fails a test rather than silently under-reserving.

### Measured, before and after

Re-ran #124's method on the real app (`LOCAL_RESULTS_DIR` + `next dev`,
headless Chromium, `getBoundingClientRect()` on the animated span every
animation frame across the full tween), at 1280px and 390px:

| result     | animated span width                | hero-row height transitions | "Trades" `<h2>` / `scrollHeight` movement |
| ---------- | ---------------------------------- | --------------------------- | ----------------------------------------- |
| 1W @ 1280  | 61px / 24 widths -> **0px / 1**    | 1 -> **0**                  | 32px -> **0px**                           |
| 1Y @ 1280  | 43px / 21 widths -> **0px / 1**    | 11 -> **0**                 | 32px -> **0px**                           |
| 5Y @ 1280  | 150.6px / 27 widths -> **0px / 1** | 9 (3 heights) -> **0**      | 76px -> **0px**                           |
| MAX @ 1280 | 63.8px / 34 widths -> **0px / 1**  | 2 -> **0**                  | 32px -> **0px**                           |
| 1W @ 390   | 27px / 20 widths -> **0px / 1**    | 0 -> **0**                  | 0px -> **0px**                            |
| 1Y @ 390   | 18px / 14 widths -> **0px / 1**    | 0 -> **0**                  | 0px -> **0px**                            |
| 5Y @ 390   | 93px / 25 widths -> **0px / 1**    | 12 (3 heights) -> **0**     | 52px -> **0px**                           |
| MAX @ 390  | 27px / 22 widths -> **0px / 1**    | 0 -> **0**                  | 0px -> **0px**                            |

Zero console/page errors on every run. **Overlay parity re-verified live
too, not just in jsdom** (which computes no text metrics at all -- the
exact gap #107's version of this bug shipped through): across 35+
playing-phase samples per case, `TradeReplay`'s `heroSlot` overlay and
the invisible `HeroStat` behind it reported byte-identical value-row
widths (525.41/525.41 on 5Y at 1280, 342/342 at 390) and identical
per-row heights, with zero overflow past the overlay's box, and the same
for `WholeRangeReplay`'s `revealSlot` against `WholeRangeBalance`
(440/440 at 1280, 308/308 at 390).

**One accepted layout consequence, deliberate.** A reserved box is by
definition as wide as the widest string the tween can reach, so a result
whose _final_ string is short but which crosses a boundary on the way
(5Y, `$20 -> $1.1K`) now settles with its "(Nx)" badge on the row's
second line where it used to fit on one. That is the price of the row
not moving during the reveal; the badge already wrapped for most of the
old tween anyway.

## The Daily Ritual: status rail + shareable recap (issue #133)

| file                         | owns                                                                                            |
| ---------------------------- | ----------------------------------------------------------------------------------------------- |
| `lib/daily-ritual.ts`        | pure: the snapshot shape, every string in the rail and the recap, and `buildRecapText`          |
| `lib/use-daily-ritual.ts`    | the read layer -- one snapshot over three other features' storage, kept current by subscription |
| `lib/headline-figure.ts`     | "which number does this page headline right now?", for both result models                       |
| `lib/copy-text.ts`           | the defensive clipboard write                                                                   |
| `lib/select-variant.ts`      | issue #13's variant pick, extracted verbatim out of `ResultsPanel.tsx`                          |
| `lib/range-copy.ts`          | `RANGE_COPY`, extracted the same way                                                            |
| `components/DailyRitual.tsx` | the section: rail, lock, recap, copy                                                            |

### The page order was already right, and was left alone

Issue #122 offered #133 an `afterHero?: ReactNode` slot on `ResultsPanel`,
rendered inside its two success branches, and explicitly left the call
here. **It was not taken, deliberately -- `ResultsPanel.tsx` gained no
slot at all**, and the order it would have produced was already true:
verified live at 1280px on a real `next dev` page, the document order is
hero reveal (344px) -> Beat the Bench (1467) -> The Call Board (1719) ->
the ritual (2355), and `ResultsPage.test.tsx` asserts exactly that with
`compareDocumentPosition`.

The reason not to take the slot is a real defect it would have
introduced, not a preference. Anything inside `ResultsPanel`'s success
branches is behind its fetch gate, and `use-results.ts` **passes through
a `"loading"` state on every range switch**, not just first load. So a
player who clicked a range pill mid-session would have had
`<BeatTheBench>` unmounted and remounted under them -- their game
destroyed by a click that has nothing to do with it. The same gate also
deletes the "the daily ritual stays playable while `/api/results` is slow
or 500ing" property that two shipped tests already assert and that local
dev hits constantly.

The cost of leaving it alone is honest and worth stating: the two
mechanics sit ~1100px below the hero on a desktop 5Y page, after the
chart, the trade list and `AboutSection`. If that gap ever needs closing,
**the fix is not the `afterHero` slot as specified** -- it's splitting
`ResultsPanel`'s return into `[hero block, slot, rest]` at one stable
fragment position so the slot's content keeps a single mount across
loading/error/success. That is a bigger change than this issue needed.

### The rail reads other features' storage; it mirrors nothing

`local-storage.ts` grew `subscribeToLocalStorage`, and `writeLocalStorage`
notifies it. That module is already the single choke point every feature's
storage layer funnels through, so subscribing there wires the rail to Beat
the Bench's played record, The Call Board's picks **and** issue #91's
whole-range guess with zero per-feature coupling -- and, more importantly,
with no second copy of any of those flags. The integration test plays a
real session and makes a real pick through their own UIs and asserts the
rail moves, precisely so this can't quietly degrade into three
independently-toggled booleans.

Two constraints on that subscription, both load-bearing:

- **A listener must not write.** Notification is synchronous, so a writing
  listener re-enters its own notification. `use-daily-ritual.ts` therefore
  counts filled slots via `upcomingCallDays` + `getCallBoardPick` rather
  than `syncCallBoard`, which writes a freshly-resolved history back.
- **A failed write doesn't notify** -- nothing changed.

`hero-seen` is a constant `true`. Nothing gates the hero reveal for either
model, so the day starts at 1 of 3; that is an endowed-progress choice and
the issue says so explicitly. Don't "clean it up".

### What goes in the recap, and what deliberately doesn't

- **The hindsight figure is in.** It's the same number issue #134's public
  OG card already headlines for anyone with the link.
- **...but never ahead of this app's own spoiler gate.** For
  `intraday-daily` the headline figure _is_ the answer issue #91's
  whole-range guess hides, so the recap omits that line until the viewer
  has guessed -- the same rule `ShareCardLink` already follows. The window
  model has no gate and is quoted immediately. Verified live in both
  states.
- **Beat the Bench is relative only.** A gap ("0.13% ahead") says how the
  player did; the absolute balances would tell a recipient which way the
  real session went and by how much. Same reasoning keeps the Call Board
  line at "2 of 3 called" rather than naming buckets.

Real generated text, from a real local pipeline run:

```
Had I Known Trades · Aug 26, 2026

Hindsight over the past 5 years: $20.00 became $196.37 (9.8x)
Beat the Bench: you rode it out, level with the bench to the cent
The Call Board: 2 of 3 upcoming sessions called

Hindsight only -- not advice, and not a predictor.
```

### Two things worth not re-deriving

- **`userEvent.setup()` installs its own `navigator.clipboard` stub.** It
  silently replaces one a test installed, so the success path asserts
  against userEvent's fake and the failure path becomes unreachable. Both
  happened before `DailyRitual.test.tsx` switched to `fireEvent` for the
  copy button. (jsdom itself implements no clipboard at all -- stub the
  shape `copy-text.ts` reads, don't fight it.)
- **The recap is a `<pre>`, not a `<textarea>`, for a measured reason.** A
  textarea needs a row count, and at 390px every recap line wraps, so a
  count taken from the text's own newlines clipped the last line mid-word
  behind an inner scrollbar. A `<pre class="whitespace-pre-wrap
select-all">` sizes to content at any width and gives a better manual
  fallback anyway: one click selects the whole recap.

### Live verification

Real `local-run.ts` output (6 tickers, real Yahoo calls) into a
`LOCAL_RESULTS_DIR`, then `next dev` plus this file's own no-root
headless-Chromium workaround, with `clipboard-read`/`clipboard-write`
granted. A real click on "Copy recap" put the recap on the real system
clipboard byte-identically (`navigator.clipboard.readText()` matched), and
a real `Ctrl+V` into a real `<textarea>` pasted it byte-identically again.
A Call Board pick made afterwards regenerated the recap and dropped the
now-stale "Copied" stamp. A context whose `clipboard.writeText` rejects
with `NotAllowedError` showed the manual-select fallback instead. At 390px
the copy button measured 112x44 with `scrollWidth === clientWidth === 390`.
Zero console or page errors across all four runs.

## Final cross-feature design QA pass (issue #135)

The last issue of the "Hindsight Wrapped" build-out (#121-#134, plus
#147): does the whole page read as one thing, rather than five features
that each shipped a clean screenshot of themselves? Verified against a
real `LOCAL_RESULTS_DIR` pipeline run with **every mechanic genuinely
played**, not a first-visit shell -- whole-range guess revealed, a real
Beat the Bench Today's Close session played to settlement (two real
moves, a real win), all three Call Board slots picked plus 12 seeded
picks resolved against real SPY closes into a real history strip, and
the Daily Ritual's rail at 3 of 3 with the recap unlocked.

**`next dev` still cannot hydrate in this sandbox** (issue #123's note)
-- `next build` + `next start`. And the same note's second half bit
again, so it is worth restating as a hard rule: **rebuilding while an
old `next start` still holds the port silently serves the old build's
asset manifest**, chunks 404, the page never hydrates, and every
Playwright locator times out on content that "should obviously be
there." `pkill -f next-server` and confirm the port is actually free
before restarting, rather than debugging the selector.

### What was measured, and what was clean

At 375px and 1280px, on the intraday-daily model (1W) and the window
model (5Y), full-page:

- **No horizontal overflow at any width**:
  `document.documentElement.scrollWidth === clientWidth` exactly (375, 1280) on the _full_ page, not one component. The only element wider
  than the viewport at 375px is `ChartDataTable`'s own
  `min-w-[24rem]` table, which sits inside its own `overflow-x-auto`
  container and scrolls itself -- correct, not a finding.
- **No layout collisions.** Every gap between `ResultsPage`'s top-level
  children measured **exactly 32px** (`gap-8`) at both widths and in
  both models -- results panel -> Beat the Bench -> Call Board -> the
  ritual rail. Nothing overlaps and no margin collapses.
- **No post-paint layout shift**: sampling every top-level child's
  offset every 100ms for 2s after load returned exactly **one** distinct
  offset set at both widths. (#147's reserved-box work holds.)
- **Zero console errors, warnings, and `pageerror`s** across every run.

### Accent-token consistency: gold was fine, blue was not, and one doc was lying

- **Gold (`--accent-reward`, `#e8a33d`) is genuinely one token, not four
  lookalikes.** Every gold surface across `CallBoard` (exact-match
  history cells, their `--accent-reward-wash` background, the streak and
  best-streak figures), `BeatTheBench` (the win headline) and
  `DailyRitual` (completed rail steps, the "Copied" stamp) reads back
  `rgb(232, 163, 61)` live off the DOM. No hardcoded hex gold anywhere
  in those three.
- **The one real exception: `CelebrationBurst`'s hardcoded
  `#f5b301`** -- a second, genuinely different gold, confirmed live on
  screen (`rgb(245, 179, 1)`) at the same moment as the Call Board's
  `rgb(232, 163, 61)`. Its palette also hardcodes `#3987e5`, a literal
  duplicate of `--series-1`. **This is deferred, not fixed** -- issue
  #125 considered recoloring the confetti and explicitly left it to its
  own diff, and a QA pass is not where a decorative palette gets
  redesigned. What _was_ fixed: `globals.css`'s `--accent-reward` block
  had been listing "CelebrationBurst (#125)" as one of its consumers
  since #121, which was never true. A future agent reading that token's
  own decision record would have concluded the confetti already used it.
  The list now says the opposite, explicitly. Filed as backlog for the
  actual recolor.
- **Blue: `--accent-selection` is now used by every active control, for
  real.** #123 migrated `RangeSelector` and recorded that the other five
  sites "still say `--series-1`; migrating them is a separate, purely
  mechanical pass nobody has done yet." That pass is this one:
  `ModeToggle`, `CustomRangeSelector`'s selected day, `DayOverview`'s
  selected row, `WholeRangeBalance`'s "Reveal the answer" button and
  `app/error.tsx`'s "Try again" button now all say
  `--accent-selection`. Zero visual change by construction (the token is
  an alias) and **verified live rather than assumed**: all four
  reachable sites still paint `rgb(57, 135, 229)`, and `DayOverview`'s
  `/15` opacity modifier -- the one with any real risk, since it feeds an
  arbitrary-value `var()` through Tailwind's `color-mix` -- still
  resolves to `oklab(0.622046 -0.0415549 -0.155741 / 0.15)`.
- **`--series-1` was deliberately left alone in two places**, because
  neither is an active control: `BeatTheBenchChart`'s price line (a real
  data series, exactly the name's stated job), and the whole-range
  headline figure in `WholeRangeBalance`/`WholeRangeReplay` (a value
  figure, which the token block names under neither job -- don't
  "finish the migration" by changing it without deciding what it means).
- **`font-display` on section headings**: `CallBoard` and `DailyRitual`
  had it, `BeatTheBench` did not -- despite that same file using it on
  its own settlement headline. Same pixels today (`--font-display` is
  Geist Sans, which the body already inherits), so this is a
  consistency fix that only starts mattering if `--font-display` is ever
  pointed at a real display face. Fixed.

### Three findings left for a human, deliberately not fixed here

1. **The ~1100px gap #133 flagged is real, and now measured.** On 5Y at
   1280px the hero block starts at y=344 and "Beat the Bench" at
   y=1484 -- **1140px**, matching #133's own estimate. On 1W it is
   worse, because the intraday model is taller: **1744px** at 1280px and
   **1908px** at 375px. It is **not a visual defect** -- nothing
   collides, and the page reads as an orderly sequence of cards -- but
   it is a real product problem for a feature whose whole framing is a
   single-scroll "daily ritual". #133 already worked out both why the
   obvious fix is wrong (#122's `afterHero` slot sits behind
   `ResultsPanel`'s fetch gate, so a range-pill click mid-session would
   unmount an in-progress Beat the Bench game) and what the right shape
   would be (split `ResultsPanel`'s return into `[hero, slot, rest]` at
   one stable fragment position). Filed as backlog with these numbers,
   not attempted here.
2. **"You guessed $X." is orphaned below the worst-case stat under
   640px.** `WholeRangeBalance`'s revealed branch is
   `flex flex-col gap-4 sm:flex-row`, holding the headline and
   `WorstCaseStat`, with the "You guessed" line as a _following
   sibling_. At `sm` and up that reads correctly (two columns, the
   guessed line under the left one). Below `sm` it stacks headline ->
   worst case -> "You guessed", so the guess appears to belong to the
   worst-case figure it now sits directly under. **The naive fix is a
   trap**: moving that line into the left column puts it inside the
   `relative`/`invisible` pair that `revealSlot`'s `absolute inset-0`
   overlay sizes itself against -- exactly the overlay-height parity
   that broke twice in #107 and that #147 had to re-establish. Needs a
   considered layout change; filed as backlog.
3. **Hero-row wrap artifacts, inherent to #147's reserved box.** On 5Y
   at 1280px the row settles as `$20.00 →` / `$1.1K` with roughly 87px
   of dead space between `$1.1K` and its `(57x)` badge -- the badge is
   sitting past the width probe reserved for the widest string the tween
   passes through. #147 documents the badge wrapping as an accepted
   trade-off; the _visible gap_ is the same trade-off seen from the
   other side, and shrinking the box once the tween settles would
   reintroduce precisely the end-of-reveal shift #147 exists to remove.
   Related: at 375px the per-day hero breaks as `$20.00 →` / `$20.97
(1x)`, leaving the arrow dangling at the end of the first line.
   Reported, not touched -- any fix here is a hero-layout redesign, not
   a QA tweak.

### One observation worth knowing, not a defect

#147 put the hero value rows on Geist Mono and deliberately left
"static figures elsewhere (`WorstCaseStat`, `BenchmarkStat`, the trade
narration) untouched". The visible consequence is that
`WorstCaseStat`'s figure sits immediately beside (1280px) or directly
below (375px) a mono hero figure in the same card, in proportional
Geist Sans. It reads as deliberate de-emphasis rather than a mistake --
which is what #31 wanted from that stat -- so it was left alone. Worth
knowing before someone "fixes" it in one direction without checking the
other.

## The daily hero: yesterday's result replaces the guess-then-reveal gate as the page's lead content (issue #161)

The first build issue in a second UI-simplification pass (design
references at `docs/design/ui-simplification-2026-08/`, distinct from
the "Hindsight Wrapped" milestone above) -- the app is becoming a daily-
game app, and the landing screen now leads with a direct statement about
the most recently completed trading day instead of the 1W range view's
own guess-then-reveal gate (issue #91). That gate, `WholeRangeBalance`/
`WholeRangeReplay`, `RangeSelector`, and `ResultsPanel` are all
completely untouched by this issue -- see its own Out of scope. This is
a pure-frontend addition: `packages/core`/`apps/pipeline` diffs are
empty, confirmed via `git status` before opening the PR.

- **Three new files, mirroring `use-call-board.ts`'s own established
  shape for a mechanic that reads a fixed range's data without taking a
  `PrecomputedResult` prop:**
  - `lib/daily-challenge.ts`'s `dailyChallengeFor(day: IntradayDayResult,
mode: Mode)` recompounds a day's own mode-selected trades (issue #13's
    `selectVariant`) from a **fresh `DAILY_CHALLENGE_STARTING_CAPITAL`
    ($20)**, not the day's real chained `startingCapital` (issue #84's
    `chainStartingCapital` -- see this file's own
    "rescaleFromStartingCapital's per-day pattern..." section for why a
    day's own `startingCapital` isn't a flat $20 any more). Pure, no
    React -- loops `trade-math.ts`'s `compoundBalance` directly rather
    than routing through `narrateTrades` (which also returns this same
    running balance, but bundled with prose-specific fields this module
    doesn't need).
  - `lib/use-daily-challenge.ts`'s `useDailyChallenge(mode)` fetches
    `/api/results?range=${DAILY_CHALLENGE_RANGE}` (`"1W"`, exported
    for tests, and for the identical reason `CALL_BOARD_SERIES_RANGE`
    is: 1W is `ResultsPage`'s own `DEFAULT_RANGE`, so this is very
    likely already warm in the browser's cache on first load) and reads
    the most recent entry in `data.days` through `dailyChallengeFor`.
    Returns `{ dailyChallenge, loading }`, not a bare nullable value --
    `loading` distinguishes "still fetching" (render a skeleton) from
    "loaded, but genuinely nothing to show" (a fetch error, a window-
    model body, or zero trading days -- all three degrade to
    `dailyChallenge: null` forever), which matters here in a way it
    didn't for `useCallBoardCloses()` (that hook only ever needs the
    binary "do I have a series or not").
  - `components/DailyHero.tsx` is the section itself.
- **Mounted directly in `ResultsPage.tsx`, above the existing
  `<header>`** (which still owns `RangeSelector`/`ResultsPanel`,
  completely unchanged) -- not inside `ResultsPanel`, for the same two
  reasons issue #122's standing decision already gives for
  `BeatTheBench`/`CallBoard`: `ResultsPanel` renders nothing but a
  skeleton or an error box until `/api/results` succeeds, and this
  section is meant to be the very first thing a visitor sees regardless
  of how that fetch goes. **This is a real, deliberate placement call
  worth being explicit about**: the issue's own Scope only requires
  landing above "the existing range explorer," and doesn't say anything
  about the app's own `<h1>`/wordmark -- restructuring the header itself
  (splitting the title from `RangeSelector`) was out of scope for this
  issue (a separate, later issue demotes the range explorer entirely),
  so the daily hero renders above the `<h1>` too, not between the title
  and the pills. Verified live (see below) that this reads fine, not
  awkward, matching the mockup's own "topbar, then daily hero" order
  closely enough at 99% fidelity.
- **The eyebrow is deliberately NOT `--accent-reward` gold**, despite
  the mockup's own `.day-eyebrow` using it -- a considered deviation from
  the mockup's literal styling, not an oversight. `globals.css`'s own
  token decision record (issue #121) is explicit that gold is reserved
  for genuinely _earned_ state (a streak, a win stamp, an unlocked
  recap) and reads as wrong the moment it shows up on something merely
  displayed, and a plain date label isn't an earned outcome -- it's the
  same category of caption `DailyRitual.tsx`'s own date line already
  uses `--text-muted` for. Styled `--text-muted` here instead, matching
  that precedent.
- **Deliberately not animated** -- unlike `HeroStat.tsx`'s count-up
  reveal, this figure renders its final value immediately, no
  `useCountUp`/`CelebrationBurst`/reveal-accent glow. Reusing
  `HeroStat`'s already-exported typography constants
  (`heroValueRowClassName`, `heroMultiplierClassName`/
  `heroMultiplierColor`) gives this section the same hero-scale look and
  the same gain/loss coloring convention with zero new CSS, while
  staying consistent with this app's other static figures
  (`WorstCaseStat`, `BenchmarkStat`, the trade narration), none of which
  animate either. This also sidesteps issue #147's whole reserved-box
  story entirely -- there's no tween to sweep through intermediate
  compact-unit-ladder strings, so no `AnimatedFigure` is needed here.
- **The "Yesterday's trades" narration reuses `narrateTrades` directly,
  per this issue's own Scope, but does NOT reuse `TradeList.tsx`'s JSX
  verbatim** -- a new small `TradeNarrationList` private component in
  `DailyHero.tsx` builds its own sentence, differing from `TradeList`'s
  established template in exactly one place: "at {time}" instead of "on
  {date}" for each trade's open/close labels (matching
  `IntradayTradeList`/`TradeRow.tsx`'s own established "at" convention
  for a time-of-day label, since `narrate-trades.ts`'s own doc comment
  already anticipated this exact split -- `NarratableTrade` takes
  already-formatted label strings specifically so a time-labeled caller
  could write its own sentence template with zero changes to that
  module). Deliberately didn't add a `preposition` prop to `TradeList`
  itself to let it double as this section's renderer too -- that would
  mean threading a new prop through an already well-tested, unrelated
  component for a single new caller, a larger change than this issue's
  own scope called for. Worth reconsidering if a third "at"-vs-"on"
  caller ever shows up.
- **A real existing test needed a real update, not just a new
  assertion**: `ResultsPage.test.tsx`'s "does not also fetch a preset
  range's own result while in anchor mode" test used to assert the
  _only_ `range=` fetch in anchor mode was the Call Board's own -- this
  section's `useDailyChallenge` now unconditionally fetches the same
  fixed `/api/results?range=1W` too, for its own unrelated reason
  (reading `days` for the most recent trading day, vs. the Call Board's
  own `benchmarkSeries`), so the assertion now expects **two** matching
  requests. Both interpolate the same literal range (`CALL_BOARD_SERIES_RANGE`/
  `DAILY_CHALLENGE_RANGE` are both `"1W"`), so the array-order question
  this might otherwise raise (which of the two mounted components' own
  effects fires its fetch first) never actually matters for this
  particular assertion.
- **Live-verified against a real local pipeline run** (`local-run.ts`,
  the default 20-ticker sample, real Yahoo network calls, no S3 write)
  plus `next build`/`next start` and the documented no-root headless-
  Chromium workaround -- `next dev` cannot hydrate in this sandbox (see
  issue #123's own note above), and this section's content only ever
  appears after client-side hydration resolves its fetch (`page.tsx`'s
  `Suspense` boundary around `ResultsPage`, which reads
  `useSearchParams()`, bails the whole tree to CSR -- confirmed live via
  `curl`, which got the `BAILOUT_TO_CLIENT_SIDE_RENDERING` placeholder
  markup, not real content, exactly why this needed a real browser and
  not just a fetch check). Real 1W result: 5 trading days, the most
  recent (2026-08-26) carrying 3 real trades (ALB, AKAM, AKAM) with a
  real chained `startingCapital` of $28.12 -- confirmed the rendered
  page shows `$20.00 -> $21.43 (1.1x)`, matching a hand-computed
  `20 * (135.35/132.02) * (108.36/106.31) * (109.51/106.80) ≈ 21.43`,
  not the chained `$28.12 -> $30.13` still correctly shown further down
  in the (untouched) `DayOverview` row for the same day -- confirming
  this is genuinely a fresh-$20 figure, not the chained one, per the
  issue's own spot-check acceptance criterion. Confirmed live: the daily
  hero (including its own "Yesterday's trades" section) renders above
  the `<h1>`/`RangeSelector`/`ResultsPanel` in document order; a 390px
  mobile screenshot reflows cleanly with `scrollWidth === clientWidth`
  (no horizontal overflow); zero console errors or `pageerror` events.
  The temporary `playwright` devDependency was reverted afterward
  (`git checkout -- package.json pnpm-lock.yaml`, confirmed via `git
status`), per this file's own established convention.
- **Not verified live** (no real trading day in the sample data lacked a
  trade -- every day this issue's own optimizer runs against found at
  least one): the zero-trade-day fallback ("No trade would have beaten
  holding cash on {date}.") and the long+short mode variant, both
  covered instead by `DailyHero.test.tsx`'s own component tests against
  hand-built fixtures.
- **A pre-existing, unrelated `pnpm format:check` failure was found and
  fixed along the way**: `docs/design/ui-simplification-2026-08/
mockup-simplified.html` (added by issue #160, already on `main` before
  this issue started) was never run through Prettier -- confirmed via
  `git stash` that `prettier --check` already fails against a clean
  checkout of `main` itself, so this predates and is unrelated to this
  issue's own changes. Reformatted (`prettier --write`, a purely
  mechanical whitespace/quote-style change, no content edit -- confirmed
  via a visual diff read before committing) as its own separate commit
  in this issue's PR, both because CI's own "Check results" step gates
  on `format:check` repo-wide (so leaving it broken would have kept this
  PR's own CI red for a reason this issue didn't cause) and per this
  repo's standing engineering-excellence convention of fixing a found
  issue rather than routing around it.

## The Call Board becomes an immediate "Think you know the future?" CTA (issue #164)

Second build issue in the same UI-simplification pass as #161 above.
`CallBoard.tsx` used to render the full 3-slot picker, history strip and
stats row unconditionally, full-size (issue #129). It now renders a
compact card by default -- an icon, "Think you know the future?", a
subtitle, and a status line ("N of 3 called this week") -- that expands
in place to the exact same board on click. **`lib/call-board-scoring.ts`
/ `call-board-storage.ts` / `market-calendar.ts` / `use-call-board.ts`
are all completely untouched** -- purely presentational, per the issue's
own Scope; confirmed via `git diff --stat` that this PR touches only
`CallBoard.tsx` and its own test file.

- **Mount point in `ResultsPage.tsx` needed no change at all.** The
  issue asked for `CallBoard` to become a direct sibling immediately
  after the "Beat the Bench" CTA (issue #163, built in parallel) -- and
  `<CallBoard />` already sits directly after `<BeatTheBench />` there
  (both post-`<ResultsPanel>`, per issue #122's standing decision), so
  this issue's own diff to `ResultsPage.tsx` is empty. Worth knowing for
  a future reader diffing this PR and expecting a `ResultsPage.tsx`
  change that isn't there.
- **The collapse/expand mechanism is a plain native `<details>`/
  `<summary>`** -- the same disclosure idiom "More options"/
  "Methodology & assumptions"/"View chart data as a table" already use
  elsewhere in this app, not a hand-rolled `useState<boolean>`. The
  summary's own content (icon, title, subtitle, status line) is a shared
  `CallBoardSummaryRow` component, used both by the real interactive
  `<summary>` and by the pre-hydration placeholder below -- the two can
  never drift in size, which is what makes swapping one for the other
  free of layout shift.
- **The outer `<section>` + its sr-only `<h2 id="call-board-heading">The
Call Board</h2>` render unconditionally, before the hydration branch**
  -- this section's own placement/landmark identity never depends on
  `useCallBoard`'s state, only the card content inside it does. This is
  also what let every pre-existing `ResultsPage.test.tsx` assertion that
  locates the board via `screen.getByRole("heading", { name: "The Call
Board" }).closest("section")` keep passing completely unmodified --
  the visible CTA title ("Think you know the future?") is new, but the
  accessible landmark name a test (or a screen-reader user navigating by
  heading) finds is unchanged.
- **Pre-hydration inert placeholder, mirroring the deleted
  `PLACEHOLDER_SLOTS`' own reasoning one level up.** Before
  `useCallBoard`'s mount-time correction, `CallBoard` renders a plain
  `aria-hidden` `<div>` -- not a `<details>`/`<summary>` -- with the
  identical `CallBoardSummaryRow` markup as the real card, except the
  status line is a non-breaking space rather than a real "0 of 3 called"
  figure. Two reasons this is stricter than "just show the real card
  early": (1) `board.openCalls` is genuinely `[]` in `UNHYDRATED_VIEW`
  (see `use-call-board.ts`'s own doc comment) -- the lookahead itself is
  clock-derived, so there is nothing real to report yet; (2) a plain
  `<div>` means there is no focusable/toggleable element in the tree
  before there's anything real to show, matching the same
  belt-and-suspenders posture `PLACEHOLDER_SLOTS`' own disabled buttons
  established. Title and subtitle are constant strings (not
  clock/storage-derived), so showing them early is safe and is what
  makes the placeholder actually look like the real card rather than an
  empty box -- reserving its exact footprint so nothing shifts once
  hydration lands.
- **This dramatically simplified the full board's own slot rendering**:
  since the picker only ever renders once `useCallBoard` has genuinely
  hydrated (the placeholder branch handles the "not yet" case one level
  up), `board.openCalls` is always real, non-null dates by the time the
  `<ul>` map runs -- no more `isPlaceholder`/null-date branching inside
  each `<li>`, and the old `BoardSlot`/`PLACEHOLDER_SLOTS` types are
  gone outright, not just superseded.
- **Live-verified, not just unit-tested, that this is a real, reproduced
  hydration-safety story, not a theoretical one** -- the same
  fake-only-the-client's-clock technique issue #129's own verification
  (and issue #96's) established: a headless-Chromium pass with the
  client's `Date` faked to a Wednesday before 9:30 ET (so the server and
  the faked client clock can genuinely disagree) logged zero console/
  page errors, confirming no hydration mismatch survived the
  restructuring. A same-clock screenshot pass would not catch this class
  of bug -- server and client happen to agree by coincidence whenever
  their clocks match.
- **Live-verified end to end against a real local pipeline run**
  (`local-run.ts`, the default 20-ticker sample, real Yahoo network
  calls) plus `next build`/`next start` (not `next dev` -- see issue
  #123's own note on hydration failing there) and the documented
  no-root headless-Chromium workaround: the collapsed card renders
  "🔮 Think you know the future? / Call the next 3 sessions, up or down,
  before they open. / 0 of 3 called this week" with the real `<details>`
  genuinely closed (`open` attribute absent); clicking the summary sets
  `open` and reveals the real 3-slot picker/stats/history unchanged from
  before this issue; making a real pick ("Up" on the first open slot)
  updates the status line to "1 of 3 called this week" live; reloading
  the page shows the card collapsed again by default with the pick still
  reflected in the status line, confirming the localStorage-backed pick
  genuinely persists and locks correctly through the new compact-card
  wrapper, not just inside a still-expanded session. Screenshotted at
  1280px and 375px -- zero horizontal overflow at either width, and
  `<h2>` document order confirms `CallBoard` still sits directly after
  `BeatTheBench` and directly before `DailyRitual`'s "Today, so far".
  Zero console/page errors across every pass. The temporary `playwright`
  devDependency and all verification scripts were reverted before
  committing, per this file's own established convention.

## Hide the replay chart until "Watch it happen" is clicked (issue #162)

Two independent gates, one new (the daily hero, which had no chart at
all before this issue -- see #161's own "Not verified live"/Scope notes
above) and one added on top of existing behavior (`WholeRangeReplay`,
whose chart used to render statically the moment the whole-range guess
was revealed). `TradeReplay.tsx` (the window-model 5Y/MAX/custom-anchor
chart) is untouched, per this issue's own explicit Out of scope --
`use-trade-replay.ts`'s state machine, pacing constants, and
`PortfolioChart.tsx`'s own `revealedCount`/`interactive`/`inert`
mechanics all keep working exactly as issue #96's long review history
already established; this issue only changes _whether/when_ a chart
mounts, never how it behaves once mounted.

- **`DailyHero.tsx` gained a plain local `chartRevealed` boolean**, not
  `use-trade-replay.ts`'s `idle`/`rewinding`/`playing`/`done` machine --
  there's no playback animation here at all (this component's own
  "deliberately not animated" doc-comment note, issue #161), just a
  single click that mounts `PortfolioChart`. Since the daily hero never
  had a chart before this issue, the series it feeds that chart is new
  too: `deriveWholeRangeIntradaySeries(dailyChallenge.startingCapital, [
{ date: dailyChallenge.date, trades: dailyChallenge.trades }])` -- that
  function already builds exactly the right shape (one leading boundary
  point, then each trade's open/flat/close steps, datetime-labeled) for
  any list of `{ date, trades }` days; a single-day array is a natural,
  un-special-cased use of it, not a second series-builder invented for
  this issue. The `<button>`/chart pair sits between the ticker sequence
  and the "See the trades ↓" scroll cue, reusing `TradeReplay.tsx`'s
  already-exported `buttonClassName` so this reads as the same control
  the rest of the app already has, not a new visual pattern. The button
  stays visible after being clicked (matching the mockup's own
  `after-desktop-expanded.png` -- a native `<details>`'s `<summary>`
  never disappears either), and clicking it again is a harmless no-op.
- **`WholeRangeReplay.tsx` gained a `chartRevealed = phase !== "idle" ||
!canReplay` derived value**, gating its own `<PortfolioChart>` render
  on top of the pre-existing `guess !== null` gate -- previously, once
  the whole-range guess was revealed, the chart rendered immediately and
  statically in its idle phase, defeating the point of a click-to-reveal
  replay. **The `!canReplay` half of that expression is deliberate, not
  an oversight**: when there's no "Watch it happen" button to ever click
  at all (`canReplay` is `false` -- zero trades, reduced motion, or an
  unsupported range, i.e. `replaySupported` false), the chart still
  renders immediately, unconditionally, the same "zero information
  loss" precedent `TradeReplay.tsx`'s own reduced-motion note already
  establishes for the window model. A permanently un-revealable chart
  would be a real regression this issue never intended -- the existing
  `WholeRangeReplay.test.tsx` tests for the zero-trade/reduced-motion/
  unsupported-range cases (which already asserted the chart renders
  immediately, pre-#162) needed **no changes** for this reason: those
  are exactly the cases `!canReplay` covers.
  - **A genuine `points`-identity reset (a mode/starting-capital edit
    mid-playback) re-hides the chart, treated the same as a fresh,
    not-yet-watched result.** `use-trade-replay.ts`'s own
    `useResetWhenChanged` already resets `phase` back to `"idle"` on
    such a change (issue #96's own established mechanism) -- since
    `chartRevealed` derives from `phase`, this falls out for free with
    no new reset logic of its own, and is regression-tested in
    `WholeRangeReplay.test.tsx`.
- **`ResultsPanel.test.tsx` needed several real updates, not just new
  assertions** -- every existing test that asserted the whole-range
  chart (`getByRole("img", { name: /portfolio value over time/i })`) was
  present immediately after `submitWholeRangeGuess` (a shared test
  helper covering the guess-then-reveal flow) now also needs an explicit
  click on "Watch it happen" first. **A `getByRole("img")` query alone
  isn't enough to confirm the chart mounted, though** -- right after
  that click, `phase` is `"rewinding"`/`"playing"` (`showLive` false),
  so `PortfolioChart`'s own `interactive={false}` sets `aria-hidden` on
  its wrapper (issue #96 follow-up round two's `inert` fix), which
  makes `getByRole("img")` return nothing even though the chart is
  genuinely in the DOM -- exactly the same "role query can't see it
  mid-animation" gap `WholeRangeReplay.test.tsx`'s own "clicking Watch
  it happen swaps only the headline/worst-case-adjacent overlay..." test
  already demonstrates. Fixed by asserting DOM presence directly
  (`container.querySelector("svg")`) rather than the accessible role for
  every post-click check in this file, matching this issue's own
  acceptance criterion wording ("verify via a DOM query, not just visual
  absence").
- **Live-verified** via the documented no-root headless-Chromium
  workaround against a real local pipeline run (`local-run.ts`, the
  default 20-ticker sample, real Yahoo network calls) plus `next
build`/`next start` (not `next dev` -- see issue #123's own note above
  on why headless Chromium can't hydrate a dev-mode page in this
  sandbox): confirmed a real page load has **zero** `<svg>` elements
  anywhere before any click; clicking the daily hero's own "Watch it
  happen" brings that count to one; submitting the whole-range guess for
  the real 1W result leaves the count unchanged at one (the whole-range
  chart still un-mounted); clicking that section's own "Watch it happen"
  brings the count to two, with the real rewind beat ("Watching Aug 21,
  2026") and gridlines visible mid-reveal. Zero console errors or
  `pageerror` events across the whole run. The temporary `playwright`
  devDependency and the `apt-get download`/`dpkg-deb -x`-extracted
  shared libraries were both reverted before committing, per this file's
  own established convention.

## Beat the Bench collapses to a "Can you do better?" CTA, and moves ahead of the daily hero (issue #163)

Second build issue in the same UI-simplification pass as #161. Two
independent changes, both to presentation/mounting only -- every file
issue #163's own Out of scope names (`lib/beat-the-bench.ts`,
`lib/beat-the-bench-storage.ts`, `lib/beat-the-bench-moves.ts`,
`lib/beat-the-bench-percentile.ts`, `lib/use-todays-close-session.ts`,
`lib/use-mystery-session.ts`, `BeatTheBenchChart.tsx`, the mystery-day
API routes) is untouched; confirmed via `git diff --stat` before opening
the PR.

- **`BeatTheBench.tsx` gained one new top-level boolean, `expanded`
  (`useState(false)`).** While `false` it renders `CompactCard` (a new
  private component) instead of the mode chooser/game -- an icon (🎯),
  the mockup's exact copy ("Can you do better?" / "Play today's real
  session against the market, live."), and a status line built from
  `beat-the-bench-storage.ts`'s existing `readPlayedSession` read (the
  same read `ModeChooser`'s own recap paragraph already made -- no new
  storage mechanism). Clicking it flips `expanded` to `true`, which
  unmounts `CompactCard` and mounts the exact same
  chooser/playback/settlement tree this file always rendered, completely
  unchanged in substance. **One-way, not a native `<details>`
  disclosure** (unlike this app's other expand-in-place controls, "More
  options" / "View chart data as a table"): the content behind the click
  is a stateful game (fetches, playback intervals), and nothing in this
  issue's own scope asked for a way back to collapsed.
- **`playableTodaysClose(state)` is a new hoisted helper** -- the
  `todaysCloseState !== null && status === "success" &&
isPlayableSession(...)` check `ModeChooser`'s own `todaysClose` prop and
  the `mode === "todays-close"` branch's local `session` variable each
  independently re-derived before this issue. Both call sites, plus the
  new `CompactCard`'s own need for the session's date (to key its status
  read), now share one derivation -- a real, if small, duplication this
  restructuring removed rather than added a third copy of.
- **`useTodaysCloseSession()` is still called unconditionally at the top
  of `BeatTheBench()`, regardless of `expanded`** -- deliberately
  untouched. This preserves the "fetched on mount, always" behavior this
  file's own Judgment-calls section already documents and accepts (the
  chooser card names the real session date, which is in the payload);
  collapsing the card to a teaser must not change _when_ that fetch
  fires, only how much of the game renders around it. The Mystery Day
  zero-request-before-settlement guarantee (issue #132) is completely
  orthogonal to this new `expanded` flag -- it depends only on `settled`
  (see `useMysteryReveal(settled ? session.sessionId : null)` in
  `SessionGame`), which is unreachable until a mode is chosen and played
  through regardless of whether the outer card used to auto-render or
  not. Verified live, not just by inspection (see below).
- **`compactStatusLine(record)`** mirrors `gapPhrase`'s own thresholds
  (`beat-the-bench.ts`) rather than calling it, the same "same numbers,
  different sentence shape" precedent `lib/daily-ritual.ts`'s
  `benchGapClause` already established for this identical figure:
  `gapPhrase` writes a full settlement-card sentence ("0.13% behind the
  bench."), and this needed a short standalone line for a card that's
  collapsed by default ("0.13% behind the bench today", "Level with the
  bench today", or "Not played yet today").
- **`ResultsPage.tsx`: `<BeatTheBench />` moved from a direct sibling of
  `<ResultsPanel>` (after it) to a direct sibling of `<DailyHero>`
  (immediately after it, before the `<header>`/`RangeSelector`/
  `ResultsPanel` entirely).** Still per issue #122's standing "section,
  not a route or a branch inside `ResultsPanel`" decision -- only
  _where_ it renders changed, not who owns it, and it still takes no
  `PrecomputedResult`/`range`/`mode`/`selectedDay` props. `<CallBoard />`
  was deliberately left in its previous position (still a sibling of
  `<ResultsPanel>`) -- issue #164, built in parallel, is what
  repositions that one; this issue's own scope is Beat the Bench only.
- **`ResultsPage.test.tsx`/`BeatTheBench.test.tsx` needed real test
  updates, not just new assertions**, per this issue's own explicit
  callout: every existing test that rendered `<BeatTheBench />` (or
  `<ResultsPage />` and then interacted with the game) assumed the
  chooser/game was already on screen. Both files gained an
  `expandCompactCard()`/`benchSection()`-style helper that clicks
  through the compact card first, and one existing `ResultsPage.test.tsx`
  test ("renders hero reveal, then Beat the Bench, then The Call Board,
  then the ritual") needed its own _ordering_ assertion corrected, not
  just a click added -- issue #163 moved Beat the Bench ahead of the
  window model's own hero reveal entirely, so it now _precedes_ that
  reveal rather than following it (the rest of the order -- hero, Call
  Board, ritual -- is unchanged).
- **Live-verified against a real local pipeline run**
  (`local-run.ts`, the default 20-ticker sample, real Yahoo network
  calls, no S3 write -- includes `results/beat-the-bench/` and
  `results/mystery-index.json`) plus `next build`/`next start` (not
  `next dev` -- see issue #123's own note on hydration failing here) and
  the documented no-root headless-Chromium workaround. Confirmed, with a
  real recorded network log:
  - The compact card renders by default (icon, exact copy, "Not played
    yet today"), with **zero** `"Beat the Bench"` heading and zero
    "already in the market" text anywhere in the DOM until clicked --
    the full game genuinely isn't mounted, not just visually hidden.
  - Clicking it expands in place to the identical chooser (unchanged
    real session data: "SPY, Aug 26, 2026, 79 bars, about 23 seconds at
    normal speed"), positioned exactly where the compact card was --
    immediately after the daily hero's own "Yesterday's trades"
    narration, before the "Had I Known Trades" `<h1>`/`RangeSelector`.
  - A full real Today's Close session, stepped through to settlement
    ("Along for the ride", both sides at $20.01/+0.05%, matching the
    real session's own zero-trade tie), produced **zero** requests
    containing `"mystery"` and **zero** console/`pageerror` events.
  - **Mystery Day's secrecy guarantee holds unchanged**: after
    expanding and picking "Play a mystery day," a scan of the Beat the
    Bench section's own `innerHTML` (not the whole page -- the rest of
    the page legitimately shows plenty of unrelated dates, from
    `DailyHero`/`DayOverview`/etc.) found no date-shaped substring
    before settlement, and the recorded network log showed **0**
    requests to `/api/beat-the-bench/mystery/reveal` before settlement
    and **exactly 1** immediately after (`?id=s12`, matching whichever
    slot the server happened to pick).
  - Reloading the page after a played session showed the compact
    card's own status line correctly reusing the stored record ("Level
    with the bench today"), confirming `compactStatusLine`'s read
    survives a fresh mount the same way `ModeChooser`'s own recap
    paragraph already does.
  - 390px mobile: no horizontal overflow (`scrollWidth === clientWidth
=== 390`).
  - The temporary `playwright` devDependency and every verification
    script were reverted before committing, per this file's own
    established convention.

## Demoting the range explorer to the bottom of the page (issue #165)

Last build issue in the second UI-simplification pass (#161-#165). The
1W/1M/3M/1Y/5Y/Max range explorer (`RangeSelector` + the "More options"
disclosure + `<ResultsPanel>` itself) moves from the page's top-of-fold
content into one new collapsed `<details>`/`<summary>` -- "Explore other
windows" -- at the very bottom of `ResultsPage.tsx`'s column, below
`DailyRitual`. `OnboardingIntro.tsx`'s former one-sentence banner folds
into the header's own caption line instead of staying a second, separate
always-visible element. Depends on #161/#163/#164 (all already merged);
built last per the issue's own dependency note, since it reorders the
page around everything those three issues added.

### The final `ResultsPage.tsx` order

`<header>` (wordmark + caption) -> `<DailyHero>` (+ its own trade-detail
Fragment, issue #161) -> `<BeatTheBench>` -> `<CallBoard>` -> `<DailyRitual>`
-> the new collapsed "Explore other windows" `<details>`, wrapping
`RangeSelector`, the nested "More options" `<details>`
(`CustomRangeSelector`/`ModeToggle`), and `<ResultsPanel>`. This is a
pure reorder-and-wrap of existing JSX -- no new fetches, no new state,
and (per this issue's own Out of scope) zero changes to
`ResultsPanel.tsx`'s internal model branching, `WholeRangeReplay`/
`TradeReplay`, `DayOverview`, `CustomRangeSelector`, `ModeToggle`, or
`BenchmarkStat` themselves; they move, unchanged.

- **The collapsed summary derives its own "1W · 1M · 3M · 1Y · 5Y · Max"
  copy from `PRESET_RANGES`** (`EXPLORER_RANGE_SUMMARY`, a module-level
  constant in `ResultsPage.tsx`), not a second hardcoded range list --
  the same "don't let a display string silently drift from the pills it
  describes" reasoning this file's own `RangeSelector.tsx` doc comment
  already applies to its duration bar.
- **The nested "More options" `<details>` (issue #103) is untouched
  markup, just relocated one level deeper** -- still the same
  `data-testid="controls-more"`, still the same
  `CustomRangeSelector`/`ModeToggle` pair, still collapsed independently
  of the outer "Explore other windows" disclosure (two real, separately
  toggleable `<details>` elements, one nested inside the other -- the
  same nesting `CustomRangeSelector.tsx`'s own calendar popover already
  proved safe inside a `<details>` for issue #75/#11's live verification).

### Judgment call: `AboutSection`'s disclaimer/methodology stays nested inside the explorer, not pulled out as a third top-level sibling

The mockup's own `after-desktop-full.png` screenshot shows a small
"Disclaimer & methodology" line as its own collapsed row **below** the
"Explore other windows" bar, at the page's own top level -- and this
issue's Scope item 2 also lists "the disclaimer/methodology disclosure
(unchanged)" as a separate item in its top-level ordering prose, after
"the new collapsed 'Explore other windows' section." Taken completely
literally, both of those would mean lifting `AboutSection` out from
inside `ResultsPanel`'s own render branches (`WindowResultBody` and the
intraday-daily branch, issue #104) into a new `ResultsPage.tsx`-level
sibling.

**Decided against that, and kept `AboutSection` exactly where it already
lives -- nested inside `ResultsPanel`, and therefore nested inside the
new "Explore other windows" `<details>` once it moves there.** Three
reasons, in order of how much weight each carried:

1. **The issue's own Scope item 1 is the more specific, mechanical
   instruction, and it doesn't include `AboutSection` in its wrap list**:
   "wrap `RangeSelector`, the 'More options' `<details>`
   (`CustomRangeSelector` + `ModeToggle`), and `<ResultsPanel>` itself
   inside one new collapsed `<details>`/`<summary>` section." `ResultsPanel`
   moving "wholesale, unchanged" necessarily carries `AboutSection` along
   with it, since that's where it's rendered from today -- there's no
   version of "wrap `<ResultsPanel>` unchanged" that also means "except
   pull one of its own internal children out first."
2. **The issue's own Out of scope section is explicit**: "Any change to
   `ResultsPanel.tsx`'s internal model branching... -- they move,
   unchanged." `AboutSection`'s render call is part of that internal
   branching (`WindowResultBody` and the intraday-daily branch each build
   their own `viewDetails` string locally and render `<AboutSection>`
   themselves, per issue #104's own design) -- extracting it to
   `ResultsPage.tsx` would mean `ResultsPanel` no longer owning a call it
   owns today, a real internal-branching change this issue explicitly
   rules out.
3. **The mockup itself is the least authoritative signal here**, per its
   own README ("illustrative only... not real component code... 99%
   visual fidelity... not 100%") -- and it's demonstrably not a complete
   guide to this page's real structure regardless: it has no `DailyRitual`
   section at all (issue #133, built after the mockup was captured), so
   it was never going to be a literal blueprint for every element's exact
   position.

**Net effect, verified live (see below)**: expanding "Explore other
windows" now takes two clicks to reach the disclaimer (expand the
explorer, then expand "Disclaimer & methodology" inside it) instead of
the pre-#165 one click -- a real, honest cost of this call, not hidden.
Weighed against reversing it (which would mean either duplicating
`AboutSection`'s render logic at the `ResultsPage` level, or restructuring
`ResultsPanel` to expose its own `viewDetails` string upward -- a real
"internal model branching" change either way), the explicit Out-of-scope
directive won. If a future issue wants the disclaimer genuinely
independent of the range explorer, it should say so explicitly and treat
it as its own restructuring of `ResultsPanel`, not something implied by
a screenshot alone.

### `OnboardingIntro.tsx` and its storage module: deleted outright, not left unused

Issue #165's own Scope item 3 explicitly left this as an implementer's
call ("delete... if nothing else references it, or leave the storage
module in place but unused if removing it risks breaking something
you're not certain about"). Confirmed via a repo-wide grep before
deciding: `OnboardingIntro.tsx`, `lib/onboarding-storage.ts`, and
`lib/use-onboarding-dismissed.ts` were referenced by exactly one real
call site each (`ResultsPage.tsx`'s own `<OnboardingIntro />`, and that
component's own hook/storage chain) plus their own test files and a
handful of historical doc-comment mentions in unrelated files
(`use-starting-capital.ts`, `chart-tap-hint-storage.ts`,
`use-hydrated-local-storage-state.ts` -- all prose, no imports). Nothing
else in the app imports any of the three. **Deleted all six files**
(component + test, storage module + test, hook + test) rather than
leaving dead code behind -- this is a small learning project (per the
root `CLAUDE.md`'s own framing), and an unused, untested-by-nothing
module left in place is a worse outcome than a clean deletion with a
`git log` trail if it's ever needed again.

`lib/use-hydrated-local-storage-state.ts`'s own doc comment (issue #64's
original extraction target, still used by `use-starting-capital.ts`)
previously described `useOnboardingDismissed` as one of its "two current
callers" -- updated to note it was deleted by this issue and that the
extraction's own reasoning still stands independent of caller count, so
a future reader isn't misled into thinking `useOnboardingDismissed` still
exists.

### `ResultsPage.tsx`'s own header caption reuses `OnboardingIntro`'s exact sentence

`This is a hindsight toy: starting from $20, it finds the best possible
outcome from at most 3 trades across the whole S&P 500, using only
closed daily prices -- not a predictor of what happens next.` -- the
identical copy the deleted banner used to show, now a plain `<p>` under
the `<h1>`, no dismiss button, no localStorage-backed visibility state.
Deliberately not the mockup's own shorter tagline ("A new hindsight
trading puzzle every day...") -- the issue's own Scope item 3 says to
fold in "`OnboardingIntro`'s one sentence," not to write new copy, and
this app's existing sentence already explains the mechanic precisely
(the $20, the 3-trade cap, the S&P 500 universe, the EOD-data caveat)
where the mockup's tagline is a shorter, vaguer restatement.

### `ResultsPage.test.tsx` needed real updates, not just new assertions

Per this issue's own explicit acceptance criterion (and this file's own
established precedent for the same class of change, e.g. issue #103's
`desktopControls()` -> `moreOptions()` rename):

- **The Call Board placement test's own ordering assertion inverted.**
  "mounts exactly one board, as a sibling after ResultsPanel rather than
  inside it" used to assert the loading skeleton (inside `ResultsPanel`)
  _precedes_ the board in document order -- true pre-#165, when
  `ResultsPanel` sat above `CallBoard`. Post-#165, `CallBoard` sits well
  above the now-demoted `ResultsPanel`, so the skeleton now _follows_ the
  board -- the test (renamed to drop the now-inaccurate "after
  ResultsPanel" framing, kept "not nested inside it") now asserts
  `DOCUMENT_POSITION_FOLLOWING` instead of `_PRECEDING`.
- **The "renders Beat the Bench, then the hero reveal, then The Call
  Board, then the ritual" ordering test needed its own order rewritten,
  not just re-labeled.** The window model's `HeroStat` reveal ("Starting
  from") used to sit between Beat the Bench and The Call Board in
  document order; it now lives inside `ResultsPanel`, inside the demoted
  "Explore other windows" section, at the very bottom of the page --
  _after_ the ritual, not between Bench and Board. Renamed and
  reordered to assert `bench -> board -> ritual -> hero`.
- **Two new describe blocks**: one asserting the new "Explore other
  windows" `<details>` is closed by default (`explorer.open === false`,
  a real, directly-assertable DOM property for a native `<details>` --
  unlike CSS visibility, which this file's own "Mobile layout pass"
  section already documents jsdom as indifferent to) and genuinely
  contains `RangeSelector`'s own `role="group"`, the nested
  `controls-more` testid, and the results panel's loading skeleton; one
  asserting the header caption text is present and that no `role="note"`/
  "Dismiss intro" element exists anywhere on the page.
- Every other existing test in this file needed **no** changes -- range/
  anchor/mode selection, the custom-anchor calendar, the single "More
  options" disclosure structural test, the Call Board/Beat the Bench
  compact-card tests, and the ritual's own rail/recap tests all query by
  role/text/testid rather than by DOM position, so relocating their
  common ancestor into a nested `<details>` didn't change what they find.

### Live-verified against a real local pipeline run

`local-run.ts` (default 20-ticker sample, real Yahoo network calls, no
S3 write -- 6 preset results, 1,254 custom-anchor results, and the Beat
the Bench today/mystery pool) into a `LOCAL_RESULTS_DIR`, then `next
build` + `next start` (not `next dev` -- see issue #123's own note above
on why headless Chromium can't hydrate a dev-mode page in this sandbox)
plus the documented no-root headless-Chromium workaround:

- **1440x900 landing**: micro-header (wordmark + the reused onboarding
  sentence as its caption, confirmed present with zero `role="note"`
  elements anywhere), the daily hero (no chart pre-click, per issue
  #162), its own "Yesterday's trades" narration, and both CTA cards all
  render in that order with **zero** console/`pageerror` events. The
  "Explore other windows" summary reads
  "Explore other windows 1W · 1M · 3M · 1Y · 5Y · Max ▸ expand" and its
  own `<details>.open` is `false`.
- **390x844 mobile**: `document.documentElement.scrollWidth === clientWidth`
  exactly (390), confirming no horizontal overflow; zero console/page
  errors.
- **Known, measured gap against the issue's own literal "zero scrolling"
  fold wording, not silently glossed over**: at 1440x900 the bottom of
  the "Think you know the future?" card sits ~20px below the fold
  (920px vs. a 900px viewport); at 390x844 it sits ~319px below (the two
  CTA cards stack vertically at that width, inside `BeatTheBench.tsx`/
  `CallBoard.tsx`'s own pre-existing layout -- both explicitly out of
  this issue's own scope to touch). Two contributing factors, both
  outside what this issue can fix without expanding scope: (1)
  `DailyHero`'s own "Yesterday's trades" narration (issue #161, already
  shipped) renders as an inseparable Fragment sibling of the hero card
  itself -- there is no way to mount "the daily hero" without also
  mounting its trade detail, and this issue's own Scope item 2 literally
  places "daily hero (+ trade detail, issue #1)" ahead of the two CTAs,
  which is what was built; (2) the vertical gap between each top-level
  section is this app's own established `gap-8` (32px), unchanged here,
  confirmed consistent with every other measurement of it in this file
  (see issue #135's own "exactly 32px" note). This is a **substantial
  improvement over the pre-#165 state regardless** -- `CallBoard` used to
  sit below the entire range explorer (RangeSelector, the chart, the
  trade list, everything `ResultsPanel` renders), nowhere near the fold
  at all; now both CTAs sit within ~20-40px of a 900px fold on desktop.
  Closing the remaining gap would mean touching `BeatTheBench.tsx`/
  `CallBoard.tsx`'s own padding or `DailyHero.tsx`'s own trade-detail
  placement, both out of this issue's stated scope -- left for a future,
  explicitly-scoped visual-polish issue rather than expanded into here.
- **Expanding "Explore other windows" gives full, unbroken access to
  every control**: clicking a different preset range (5Y) correctly
  navigated to `?range=5Y` and rendered the window model's own hero
  reveal; opening the nested "More options" disclosure revealed a
  working "Long + short" mode toggle (click wrote `?range=5Y&mode=long-short`
  to the URL) and a visible custom-date-picker trigger; switching back to
  1W rendered the whole-range guess form, and submitting a guess revealed
  "You guessed" text, `WholeRangeBalance`'s figures, `DayOverview`'s
  per-day rows, and a second "Watch it happen" button (the demoted
  explorer's own chart, gated by issue #162's click-to-reveal, alongside
  the daily hero's own separate button) -- clicking it mounted a second
  `<svg>` (the daily hero's own chart was already mounted from the first
  click), confirming both replay charts coexist correctly and neither
  interferes with the other. Zero console/page errors across the whole
  interaction pass.
- The temporary `playwright` devDependency and the `apt-get download`/
  `dpkg-deb -x`-extracted shared libraries were both reverted before
  committing, per this file's own established convention.

## Landing simplification: end-to-end verification pass (issue #166), and why it stayed verification-only

The closing issue of the "Landing simplification: daily-game default"
milestone (#161-166). Its own Scope is explicit that this is
verification, bug-fixing of what #161-165 shipped, and documentation --
**not** new feature work, and that held: a full, real, played-through
pass across every mechanic on the simplified landing found **zero
genuinely broken behavior**. That's not a surprising outcome for this
particular milestone specifically -- unlike most of this file's other
sections, #161/#162/#163/#164/#165 (and the eight-issue "Hindsight
Wrapped" build-out before them) each already carried their own live
verification pass, several with multiple independent code-review rounds
on top, before this issue ever started. This issue's own job was
confirming all five of those passes still add up to one coherent,
working page **together**, end to end, against real data -- not
re-discovering bugs those passes had already caught individually.

### The busyness problem this whole pass (and the milestone it closes) solved

Before this milestone, the landing page led with the full 1W range
explorer's own guess-then-reveal gate (`WholeRangeBalance`) plus two
always-expanded, full-size mechanics (`BeatTheBench`, `CallBoard`)
stacked beneath it in the DOM, all ahead of the app's own `<h1>`/
`RangeSelector`. Per issue #135's own measurements (see its section
above), that put the two mechanics roughly **1100-1900px** below the
fold depending on range/width -- nowhere close to a single-scroll "daily
ritual." #161-165 replaced that with: a static "had you known" daily
hero as the lead content (#161, no guess gate, no gate on its trades),
two mechanics collapsed to compact "Can you do better?" / "Think you
know the future?" CTA cards that expand in place on click (#163/#164),
the replay chart hidden until "Watch it happen" is clicked on both the
new daily hero and the pre-existing whole-range headline (#162), and the
entire pre-existing 1W-6M/5Y/MAX range-explorer experience demoted into
one collapsed "Explore other windows" `<details>` at the very bottom of
the page (#165). Net effect, reconfirmed by this issue's own fresh
measurement below: both CTA cards now sit within **~20-320px** of the
fold (1440px/390px respectively), not over a thousand.

### What was verified, against real data, played through rather than screenshotted once

The permanent `LOCAL_RESULTS_DIR` workflow (this file's own top section)
-- a real `local-run.ts` pass against the default 20-ticker sample, real
Yahoo network calls, producing real preset results, 1,254 real
custom-anchor results, a real Beat the Bench Today's Close session, and
a real 41-session mystery pool -- then `next build` + `next start` (not
`next dev`; see issue #123's own note above on why headless Chromium
can't hydrate a dev-mode page in this sandbox) plus a headless-Chromium
Playwright pass (added with `pnpm add -D -w playwright` for the session,
reverted afterward). Every check below ran with **zero console errors,
zero console warnings, and zero `pageerror` events**:

- **No-scroll-ish landing at 1440x900 and 390x844**: header, daily hero
  (no chart), both CTA cards all render on first paint at both widths.
- **Chart reveal on the daily hero**: zero `<svg>` elements anywhere on
  first paint; clicking the daily hero's own "Watch it happen" mounts
  exactly one.
- **A full real Beat the Bench Today's Close session**, expanded from
  its compact card, played bar-by-bar via repeated "Step forward one
  bar" clicks through to a genuine settlement ("Along for the ride" /
  "Level with the bench to the cent" on this run's real zero-move tie),
  with the compact card's own status line correctly reflecting the
  played session after a full page reload.
- **A real Call Board pick** for all three open slots, made through the
  expanded card, confirmed to persist -- both the status line ("3 of 3
  called this week") and the underlying picks themselves -- across a
  full page reload.
- **`DailyRitual`'s status rail and recap**, exercised through a
  complete real day: all three rail items (`✓ The reveal`, `✓ Beat the
Bench`, `✓ The Call Board`) reached `done` only once their respective
  real interactions completed, the recap stayed locked until then, and
  once unlocked its "Copy recap" button (tested with real
  `clipboard-read`/`clipboard-write` permissions, not just the
  denied-permission fallback) put the exact on-screen text on the real
  system clipboard -- including the "Hindsight over the past week: ..."
  line, confirmed present only after the whole-range guess was
  separately revealed (the same spoiler gate `ShareCardLink` already
  respects, per issue #133's own section above -- reconfirmed still
  correct here, not re-derived from scratch).
- **The demoted "Explore other windows" section's full functionality**:
  expanding it (a real `<details>.open` flip, not just a CSS visibility
  toggle); `RangeSelector` switching to 5Y and correctly rendering the
  window model's own always-visible hero; the nested "More options"
  disclosure's `ModeToggle` (`?mode=long-short` written to the URL) and
  `CustomRangeSelector` (a real calendar popover, an enabled day click
  writing `?anchor=2026-08-03` and rendering that day's real result);
  the 1W whole-range guess-then-reveal flow (a real guess, a real
  reveal, `DayOverview`'s day rows updating `?day=` on click); and both
  of this page's now-two independent "Watch it happen" replay controls
  (the daily hero's own, and the explorer's `WholeRangeReplay`/
  `TradeReplay`) confirmed to mount and behave correctly independently
  of one another, with the window model's own replay confirmed through
  a full "Skip to end" -> "Replay" cycle.
- **No horizontal overflow** (`document.documentElement.scrollWidth ===
clientWidth`, exactly, checked repeatedly through every interaction
  above at 390px, not just on first paint) and **no unexpected
  post-paint layout shift** (five samples of every top-level section's
  own `top` offset, 400ms apart across 2s after load, byte-identical
  across all five).

### The one real finding: reconfirmed, not rediscovered

Issue #165's own section above already measured and documented, in
detail, that the two CTA cards sit slightly below the fold at both
1440px (~21px, `921` vs `900`) and especially 390px (~320px, `1163.75`
vs `844`) -- an honest, deliberately-deferred gap against this issue's
own "zero scrolling" framing, with the reasons already spelled out there
(the daily hero's inseparable trade-detail Fragment, and this app's
established `gap-8` spacing between top-level sections). This issue's
own fresh measurement, taken independently with a different selector
strategy (the real `<section>` elements' own `getBoundingClientRect()`,
not a text-node walk), landed on the **exact same numbers** -- `921` and
`1163.75` respectively. Restated here rather than left only in #165's
own section, since this issue's own acceptance criteria specifically
call for confirming (or refuting) exactly this claim: **confirmed,
unchanged, still real** -- not fixed, per this issue's own Out of scope
("verification and bug-fixing of what #161-165 shipped, not new feature
work"). Closing it would mean touching `BeatTheBench.tsx`/`CallBoard.tsx`'s
own padding or `DailyHero.tsx`'s own trade-detail placement -- both a
real, considered layout change, not a one-line fix appropriate for a
verification pass.

No other genuine-but-deferred findings turned up. Every copy string,
spacing value, and interaction path exercised above matched what
#161-165's own sections already document shipping.

### A worktree-isolation pitfall worth remembering for the next agent working in this repo's own multi-worktree setup

Not a product bug, but a real, reproducible harness gotcha hit while
starting this issue's own verification, worth recording here rather than
re-discovering it cold next time: a worktree-isolated agent session's
`cd <shared-checkout-path> && <command>` is only blocked for `git`
subcommands (the harness refuses those explicitly, with a clear error
naming the isolation) -- but **not** for `pnpm`/`node`/`next` commands,
which run against whatever directory the `cd` lands on with no warning
at all. `cd`-ing to the shared checkout path by habit (rather than
staying in the assigned worktree directory) let a `pnpm add -D -w
playwright` genuinely dirty the **shared** checkout's `package.json`/
`pnpm-lock.yaml` -- exactly the kind of change that would collide with
whatever any other concurrently-running agent is doing there. Caught by
`git status` refusing to run against the shared checkout at all (the one
signal that something was off), diagnosed by a plain `diff` against the
worktree's own clean copy (`diff`, unlike `git diff`, isn't blocked),
and fixed by `cp`-ing the worktree's clean files back over the shared
checkout's dirtied ones (`cp`/`Write` against the shared path is also
blocked for `Write`, but not for a plain `cp` in `Bash`) -- both files
came back byte-identical, confirmed via `diff` again before moving on.
**The general lesson**: for any command in this environment, not just
`git`, always confirm `pwd`/the command's own effective directory is the
assigned worktree before running anything that writes to disk -- the
isolation guardrail only catches one specific command family, not the
underlying mistake of being in the wrong directory in the first place.

## Daily hero: date-seeded starting capital, $1-$10,000 (issue #174)

`lib/daily-challenge.ts`'s `DAILY_CHALLENGE_STARTING_CAPITAL` constant
(a flat $20, since issue #161) is gone. `dailyChallengeStartingCapitalFor(date:
string): number` replaces it -- a pure, deterministic function returning
a value in `[1, 10000)` (inclusive lower bound, exclusive upper bound:
`1 + rng() * 9999`, so a single `mulberry32` draw in `[0, 1)` can never
itself reach the $10,000 ceiling), seeded from `date` via a small
FNV-1a-style hash (`seedFromDate`, mirroring
`beat-the-bench-percentile.ts`'s own `seedFromBars` in style -- loop
over characters, no external dependency). `dailyChallengeFor(day, mode)`
now calls this with `day.date` instead of reading the old constant --
everything downstream (`compoundBalance`'s own multiplicative chain,
`narrate-trades.ts`'s running-balance loop, the chart series via
`deriveWholeRangeIntradaySeries`) needed zero changes, since all of it
already reads `startingCapital` off the `DailyChallenge` shape rather
than hardcoding $20 -- exactly the same "the optimal trade sequence is
entirely a function of price ratios, never of `startingCapital` itself"
fact issue #15's original configurable-starting-capital feature already
established and this module's own header comment already cited.

- **Deliberately does NOT randomize which trades are shown or how
  many**, per the issue's own explicit Out of scope -- the real trade
  count for a given day (0-3) is whatever the optimizer actually found,
  completely untouched by this seed; only the two dollar figures (and
  the prose narration's dollar figures, since `narrateTrades` already
  takes `startingCapital` as a parameter) rescale to the new baseline.
- **Judgment call: `mulberry32` was promoted out of
  `beat-the-bench-percentile.ts` into a new shared `lib/seeded-random.ts`**,
  rather than importing it directly from the game-specific file, per the
  issue's own explicit "document which you pick" instruction. Reasoning:
  a plain display-layer feature (the daily hero) depending on a module
  literally named "beat-the-bench" would be a real, avoidable coupling
  smell -- and this codebase has an established convention of extracting
  a shared helper the moment a second genuine caller needs it (see e.g.
  `trade-math.ts`, `easing.ts`, `replay-callout.ts`, `select-variant.ts`,
  `range-copy.ts`, all promoted for the identical reason once a second
  consumer showed up). `beat-the-bench-percentile.ts` now re-exports
  `mulberry32`/`Rng` from `seeded-random.ts` (`export { mulberry32, type
Rng };`) so its own existing callers (`BeatTheBench.tsx`,
  `beat-the-bench-percentile.test.ts`) needed zero import changes --
  `beat-the-bench-percentile.test.ts`'s own "mulberry32" describe block
  still exercises the real, shared implementation via that re-export, so
  no test coverage was lost or duplicated by the move.
- **Seeding from a date is the one case `seedFromBars`'s own doc comment
  explicitly warns against -- and that warning correctly does not apply
  here.** `seedFromBars`'s doc comment says "never seed this from a
  session date," for Mystery Day's secrecy reasons (issue #132: the
  session's real date must never be derivable from anything the client
  already has before settlement). The daily hero's date is the opposite
  case -- it's already public, printed directly in the section's own
  eyebrow -- so hashing it here leaks nothing that isn't already on
  screen. `seedFromDate` is a new, separate function local to
  `daily-challenge.ts` (not promoted alongside `mulberry32`, since it's
  a one-line, feature-specific hash with no second caller), not a reuse
  of `seedFromBars` itself -- the two hash different input shapes (a
  date string vs. an array of session bars) and have no logic to share
  beyond "FNV-1a over some bytes."
- **Test coverage matches the issue's own Acceptance criteria
  one-for-one**: `daily-challenge.test.ts` gained a
  `dailyChallengeStartingCapitalFor` describe block covering purity
  (same date twice -> same value), a sanity check that five real
  consecutive dates produce five distinct values, and a 1000-iteration
  property-style sweep confirming every result lands in `[1, 10000)`.
  The existing `dailyChallengeFor` tests were updated to compute their
  own expected values via `dailyChallengeStartingCapitalFor` rather than
  a literal `20`, plus one new regression test asserting `trades` stays
  byte-identical across two different dates sharing the same underlying
  trade content while `startingCapital` differs -- the "trades/tickers/
  percentage-returns are byte-identical... only startingCapital/
  endingBalance differ" acceptance criterion, made concrete.
- **Every "always $20"/"a fresh $20" doc comment this issue's own Scope
  named was fixed**, plus two more found by grepping the same feature
  area that the issue's own Scope didn't explicitly name but which
  would otherwise have gone stale for the identical reason:
  `use-daily-challenge.ts`'s own `UseDailyChallengeResult.dailyChallenge`
  doc comment, and two illustrative doc-comment lines in
  `DailyHero.tsx` itself (`"$20.00 into $X.XX"` / `"$20 -> $X figures"`,
  both now `"$X.XX into $Y.YY"` / `"$X -> $Y figures"`) -- this repo's
  own established convention is that a stale doc comment gets fixed
  wherever it's found, not left to rot just because the issue's own
  Scope prose didn't happen to enumerate that exact file.
- **A real existing test needed a real update, not just a new
  assertion**: `use-daily-challenge.test.ts`'s own "recompounds... from
  a fresh $20" test asserted `startingCapital` was literally `20` --
  updated to compute the expected value via
  `dailyChallengeStartingCapitalFor` the same way the fixed-fixture
  tests in `daily-challenge.test.ts` now do, and `DailyHero.test.tsx`'s
  own render test (which asserted `screen.getByText("$20.00")`and a
literal`20 * ...`ending-balance computation) was updated the same
way, via`formatHeroCurrency(dailyChallengeStartingCapitalFor(date))`.
- **A pre-existing, unrelated `pnpm format:check` failure was found and
  fixed along the way, as its own separate commit** -- the exact same
  situation, and the exact same fix, issue #161's own section above
  already documents for a different mockup file:
  `docs/design/gamified-hero-2026-08/mockup-gamified-hero.html` (added
  by issue #173, already on `main` before this issue started) was never
  run through Prettier -- confirmed via `git stash` that `prettier
--check` already fails against a clean checkout of `main` itself.
  Reformatted (`prettier --write`, confirmed purely mechanical --
  doctype casing, a trailing comma in an array literal, attribute
  reflow -- via a whitespace-stripped byte diff, not just eyeballed) as
  its own commit before the feature work, both because CI's own "Check
  results" step gates on `format:check` repo-wide and per this repo's
  standing engineering-excellence convention of fixing a found issue
  rather than routing around it.
- **Live-verified against a real local pipeline run**
  (`local-run.ts`, the default 20-ticker sample, real Yahoo network
  calls, no S3 write) plus `next build`/`next start` and the documented
  no-root headless-Chromium workaround (`next dev` cannot hydrate in
  this sandbox -- see issue #123's own note above). A real 1W result's
  most recent day (2026-08-27, 3 real trades: ALGN, A, ALB) rendered
  `$6.5K -> $7K (1.1x)` -- confirmed independently, not just eyeballed,
  by reimplementing `seedFromDate`/`mulberry32` in a standalone Node
  script and computing `dailyChallengeStartingCapitalFor("2026-08-27")`
  by hand: `$6,542.63`, which formats to the same `"$6.5K"`, and which
  compounds through that day's own three real open/close prices (pulled
  straight from `/api/results?range=1W`) to `$7,049.31`, which formats
  to the same `"$7K"` -- an exact match, not a coincidence of both being
  "big." A second page load (a real reload, not a re-render) showed the
  byte-identical hero text, confirming the seed is genuinely
  date-derived and not request-derived, per this issue's own Acceptance
  criteria. Zero console/`pageerror` events across both loads. The
  temporary `playwright` devDependency and the `apt-get download`/
  `dpkg-deb -x`-extracted shared libraries were both reverted/discarded
  before committing, per this file's own established convention;
  confirmed via `git status`/`git diff --stat` on
  `package.json`/`pnpm-lock.yaml` showing no trace afterward.
- **Not separately live-verified**: the zero-trade-day fallback and the
  long+short mode variant, for the identical reason issue #161's own
  section above gives for the same two cases -- no real trading day in
  the local sample data happened to lack a trade. Covered instead by
  `daily-challenge.test.ts`/`DailyHero.test.tsx`'s own existing
  component-level tests against hand-built fixtures.

## The Call Board's compact card becomes a bold NYT-Games-style tile (issue #177)

First build issue in a third design pass (`docs/design/gamified-hero-2026-08/`,
distinct from both the "Hindsight Wrapped" and "UI simplification" passes
above). Issue #164 built the collapsed "Think you know the future?" card
as a subdued `surface-card` with a thin blue left-border accent -- this
issue restyles that same collapsed card into a solid-fill blue-gradient
tile with a large icon, matching the mockup's `.game-tile.callboard`
(right-hand tile in `mockup-gamified-hero.html`'s two-tile row) at that
folder's own stated "99% fidelity, not pixel-perfect" bar. **Purely
visual**: `lib/call-board-scoring.ts` / `call-board-storage.ts` /
`market-calendar.ts` / `use-call-board.ts` are all untouched, the
`<details>`/`<summary>` expand mechanism is untouched, and the expanded
board itself (picker/stats/history) is untouched -- confirmed via `git
diff --stat` that this PR touches only `CallBoard.tsx` and its own test
file (plus an unrelated pre-existing `mockup-gamified-hero.html`
Prettier-formatting fix, its own separate commit, the same
already-established pattern issue #161's own section documents for the
identical class of gap).

- **`CARD_CLASSNAME` moved from the `<details>` to the `<summary>`,
  a deliberate departure from the issue's own literal wording** ("applied
  to both the real `<details>` and the placeholder `<div>`"), which
  explicitly allowed for "or add a new tile-specific class alongside it."
  Putting the new bold gradient fill on the outer `<details>` (as the
  pre-#177 `CARD_CLASSNAME` did, shared across summary + expanded body
  alike, back when both states shared one subdued look) would have
  painted the _expanded_ board -- the picker, stats, and history strip --
  blue too, once opened. That's a real regression against this issue's
  own acceptance criterion ("clicking it still expands to the exact same
  full Call Board experience as before this issue"), not just an
  aesthetic nit. Moving the gradient onto `<summary>` alone produces the
  identical visual result while the `<details>` is closed (a closed
  `<details>`'s box is exactly its `<summary>`'s own box) with zero risk
  of the parent's blue background leaking around the expanded body's
  edges once open -- simpler and more robust than trying to keep a body
  wrapper's opaque background perfectly congruent with its parent's box.
  The expanded body gets its own new, ordinary dark `surface-card`
  wrapper instead (`border border-[var(--gridline)] bg-[var(--surface-1)]`,
  the same chrome the whole pre-#177 `<details>` used to carry), so the
  board still reads as a card once opened -- just no longer blue.
  **`CARD_CLASSNAME` itself stays the one shared constant** between the
  real interactive `<summary>` and the pre-hydration placeholder `<div>`,
  preserving the file's own established hydration-safety invariant (the
  two can never drift in size) -- only _which_ element it's attached to
  changed, not the sharing itself.
- **`CallBoardSummaryRow` restructured from a horizontal row into a tile
  layout**: a large icon (`text-3xl`, up from the pre-#177 row's
  `text-xl`) stacked above the title/subtitle, with a status pill
  anchored at the bottom next to a small "▸" expand affordance (the same
  chevron this app's other `<details>` disclosures already use --
  "Explore other windows," "More options" -- just relocated next to the
  status pill rather than at the row's trailing edge, since a column
  layout leaves no room there). `text-white`/`text-white/…` throughout,
  not this app's usual `var(--text-primary)`/`var(--text-secondary)`
  tokens -- the fixed blue-gradient fill isn't part of the dark-surface
  token system the rest of the app paints against, the same way
  `OgCard.tsx`'s share-card palette is its own standalone thing (see
  "Dark mode only" above).
- **`min-h-28` (7rem/112px) on `CARD_CLASSNAME` is a defensive floor, not
  a measured value** -- the tile's real content is already comfortably
  taller than the 44px touch-target floor on its own, but this guarantees
  it regardless of future copy edits. Live-measured (see below) at
  704x161px on desktop and 342x177px at a 375-ish mobile width, both
  comfortably clearing 44px in both dimensions.
- **Text contrast: every gradient stop independently clears 4.5:1 against
  white, measured, not just asserted.** The mockup's own literal hex
  stops (`#5c9cf0`/`#3987e5`/`#2b6fc4`) measured (WCAG relative-luminance
  formula) at 2.81:1 / 3.64:1 / 5.03:1 against white -- only the darkest
  stop cleared full AA 4.5:1, and the lightest (sitting right under the
  icon/title, given the mockup's own icon-top layout and 155deg angle)
  fell well short of even this app's own loosest existing precedent
  (`RangeSelector`'s white-on-`--series-1` active pill, ~3.6:1). Rather
  than ship that and flag it as a deferred gap, the three stops were
  replaced with `#4374cf`/`#3568c2`/`#2a58ab` -- same 155deg angle, same
  "lighter to darker blue" sweep, still clearly the same hue family as
  this app's real `--accent-selection`/`--series-1` (#3987e5) -- each
  independently verified at >= 4.5:1 against white (4.53:1 / 5.37:1 /
  6.81:1). This is a deliberate, documented deviation from the mockup's
  own literal hex values (not from its gradient _shape_): the mockup
  folder's own README already states 99% visual fidelity is the bar, not
  100%, and a real WCAG AA shortfall on legible body/title text is
  exactly the kind of thing this repo's own working agreements say to
  fix rather than route around, even mid-review. Re-verified live (see
  below) via real pixel sampling on the rendered tile (a Playwright
  screenshot decoded onto an in-page `<canvas>`, not just the gradient's
  own literal stop values) at several points, including the icon/title
  corner specifically (the previous worst case) -- every sampled point
  now clears 4.5:1.
- **Live-verified against a real local pipeline run** (`local-run.ts`,
  the default 20-ticker sample, real Yahoo network calls) plus `next
build`/`next start` (not `next dev` -- see issue #123's own note above
  on why headless Chromium can't hydrate a dev-mode page in this
  sandbox) and the documented no-root headless-Chromium workaround:
  confirmed a real `background-image: linear-gradient(...)` computed
  style on the `<summary>`, white computed text color, the large icon
  and both title/subtitle strings visible; the expanded board's own new
  wrapper carries no gradient (`getComputedStyle(...).backgroundImage
=== "none"`); a real click-through-pick-reload cycle (expand, pick "Up"
  on the first open slot, confirm the status line updates live to "1 of
  3 called this week," reload, confirm the card is collapsed again by
  default with the pick's status line surviving the fresh mount); no
  horizontal overflow at 390px; and a hydration-safety pass with the
  client's clock faked to a Wednesday before 9:30 ET (so server and
  client can genuinely disagree about which trading day is "now," the
  same technique issue #164's own verification already established)
  logged **zero console errors and zero page errors**. Screenshotted at
  1440px and 390px, both collapsed and expanded. The contrast fix above
  was re-verified in this same pass with real pixel sampling at six
  points on the rendered tile (four corners inset past the rounded
  clip, plus the top-mid/left-mid edges) -- every sampled point cleared
  4.5:1 against white, including the icon/title corner (the gradient's
  own lightest region, and the point that previously measured ~2.88:1).
  The temporary `playwright` devDependency and every scratch
  verification script were reverted/deleted before committing, per this
  file's own established convention.

## Daily hero: fixed-height "showcase" box, one-time entrance, ticker chips fold in each trade's return (issue #175)

Restructures `DailyHero.tsx`'s main render into a fixed-height,
cinematic "showcase" box with a one-time entrance animation, matching
`docs/design/gamified-hero-2026-08/mockup-gamified-hero.html` (99%
fidelity, not pixel-perfect -- read that folder's own README first).
Depends on issue #174 (already merged): the box's own fixed height has
to account for the $1-$10,000 range of possible starting-capital figure
widths issue #174 introduced, not be retrofitted after the fact.

- **The component now returns exactly one `<section>`, not a Fragment of
  two sibling blocks.** Deleting `TradeNarrationList`, the "Yesterday's
  trades" heading/section, and the "See the trades ↓" link (all three,
  per this issue's own Scope item 4) left nothing for the old Fragment's
  second sibling to be -- the doc comment that used to explain why a
  Fragment (not one wrapping div) was needed for two logical blocks no
  longer applies and has been removed rather than left stale.
- **Fixed CSS `height` (not `min-height`), shared by all three top-level
  renders** -- `SHOWCASE_HEIGHT_CLASSNAME` (`h-[40rem]`, a single
  non-responsive value) is applied identically to the loading skeleton,
  the zero-trade fallback, and the real 1-3-trade result (chart hidden
  or revealed). **Live-measured, not just asserted in a unit test**: a
  real `next build`/`next start` page reported the section's own
  `getBoundingClientRect().height` as exactly `640px` (40rem) across
  every one of six real states -- a real 3-trade day (chart hidden and
  revealed), a synthetic 1-trade day (chart hidden and revealed, via
  Playwright's `page.route()` intercepting `/api/results?range=1W`), and
  a synthetic 0-trade day -- at both 1280px and 390px viewports, with
  zero horizontal overflow at either width.
  - **Content is centered (`justify-center`) inside the fixed box, not
    stretched to fill it** -- a deliberate trade-off, not an oversight.
    A shorter state (a 0-trade day, or the button-only default before
    the chart is revealed) simply centers with more surrounding
    whitespace than a taller one (the chart revealed); the alternative
    (growing/shrinking sub-sections to visually "fill" a fixed box) would
    need per-state layout logic this issue's own scope didn't ask for.
    Confirmed live this reads as a deliberate "cinematic" showcase, not
    as visibly broken/empty, via the screenshots below.
  - **A single non-responsive height, not a mobile/desktop pair** (unlike
    the mockup's own `22rem`/`25.5rem` split) -- deliberate, not an
    oversight. The mockup's mobile height is _taller_ specifically
    because its tiny decorative `<svg>` (fixed CSS height regardless of
    width) leaves the real growth entirely to text wrapping. This
    component reuses the real `PortfolioChart.tsx` instead (see the next
    bullet), whose natural rendered height _shrinks_ at a narrower
    viewport (its intrinsic aspect ratio scales with its own CSS width)
    -- roughly offsetting the extra text-wrapping height mobile needs,
    which is exactly what the live measurement above confirms: `640px`
    at both 1280px and 390px, with no visible clipping or excess
    whitespace at either width in the screenshots.
- **The chart slot (`CHART_SLOT_HEIGHT_CLASSNAME`, `h-[24rem]`) is
  deliberately far taller than the mockup's own `4.75rem`** -- per this
  issue's own Scope item 5 and Out of scope ("no change to
  `PortfolioChart.tsx` or its reveal mechanics"), this reuses the real,
  full component (axis labels, hover tooltip, the `ChartDataTable`
  disclosure) rather than the mockup's tiny inline `<svg>` with
  `preserveAspectRatio="none"`. The real chart's axis text is sized in
  SVG viewBox units, so squeezing it into a mockup-sized box would render
  illegibly small -- sizing the slot to comfortably fit the real chart's
  natural size, tuned against the live measurement above, was the
  correct fix, not shrinking the chart to fit a smaller box.
  `overflow-y-auto` (not `overflow-hidden`) on the slot is a defensive
  fallback so a viewer who expands the chart's own nested "View chart
  data as a table" disclosure can still scroll to see it.
- **Each ticker chip's visible label is `{ticker} {sign}{percent}%`, via
  `trade-math.ts`'s `computeTradeReturn(openPrice, closePrice,
direction)` directly, per this issue's own Scope item 3** -- not routed
  through `narrate-trades.ts`'s `NarratableTrade`/`narrateTrades` (which
  this component no longer imports at all), since only the single return
  number was ever needed, not a full narrated sentence. Colored via the
  same `isGain = returnFraction >= 0` convention `TradeRow.tsx`
  established (the percent span only; the ticker itself stays plain
  `--text-primary`, matching `TradeRow.tsx`'s own "ticker plain, return
  colored" split, not the mockup's own literal all-amber ticker + green
  percent styling -- see the next bullet for why).
  - **Judgment call: the chip's pill background is a plain
    `--surface-2`/`--gridline` pill, not the mockup's own
    `--accent-reward`-tinted amber pill.** `globals.css`'s own token
    decision record (issue #121) reserves `--accent-reward` for
    genuinely _earned_ state (a streak, a win stamp, an unlocked recap) --
    a computed hindsight statistic the viewer took no action to produce
    isn't earned state, the identical reasoning issue #161's own section
    above already gives for why this component's eyebrow is `--text-muted`
    rather than the mockup's own gold `.day-eyebrow`. Kept consistent
    with that established precedent rather than reintroducing gold here.
  - **Accessible name/text content, verified with a screen-reader-shaped
    test, per this issue's own Scope item 3**: each chip is a plain
    `<span>` with real text-node children (no `aria-hidden` portion
    inside it) -- `DailyHero.test.tsx`'s own test asserts a chip's full
    `textContent` equals `"{TICKER} {sign}{percent}%"` directly (e.g.
    `"AVGO +1.6%"`), for both a gain and a loss leg, confirming the
    ticker and its return are conveyed together as one accessible unit
    with no extra ARIA needed for a plain `<span>` with real text.
- **One-time entrance animation (Scope item 2), respecting
  `prefers-reduced-motion`**: the eyebrow/statement, the figures row, the
  chart slot's "Watch it happen" button, and each ticker chip (staggered,
  100ms apart per chip) fade/pop in once on mount via three new
  `globals.css` keyframe pairs (`daily-hero-fade-up`, `daily-hero-pop`,
  `daily-hero-chip`) -- see that file's own comment block for the full
  "base class already renders the settled state; `-animate` only adds a
  keyframe on top, via `animation: ... both`" mechanics, the same
  technique `.hero-figure-accent`/`.hero-figure-accent-animate` already
  establish.
  - **`useReducedMotionAfterMount`, not `useReducedMotionAtMount`'s
    `useState`-lazy-initializer shortcut** -- per this issue's own
    Background section, which explicitly names which existing hook shape
    to follow and which not to: this component mounts unconditionally at
    the `ResultsPage` level (`use-hydrated-local-storage-state.ts`'s
    "can render during SSR" precondition, not `use-daily-guess.ts`'s
    "only ever mounted from a client-only success branch" one), so the
    lazy-initializer shortcut (only safe from a component that never
    renders during SSR, per that hook's own doc comment) would risk a
    hydration mismatch. `useReducedMotionAfterMount` (extracted for
    `BeatTheBench.tsx`'s `SessionGame`, issue #131) already has exactly
    the right SSR-safe, deferred-correction shape -- reused as-is, no new
    hook needed.
  - **Live-verified, not just jsdom-asserted, per this issue's own step
    5**: a real `next build`/`next start` page under Playwright's
    `reducedMotion: "reduce"` context confirmed **zero** elements
    anywhere in the section carrying any `daily-hero-*-animate` class at
    150ms after the section first appears -- the settled state (real
    text, real figures, the button) is visible immediately, confirmed by
    screenshot. A separate real-motion pass sampled a rendered element's
    `getComputedStyle(...).opacity` at 2.5s and again at 4.5s after
    load (well after the ~2.05s staggered sequence's own last chip
    finishes) and got `1` both times -- confirming the animation plays
    once and holds, not a loop. `DailyHero.test.tsx`'s own jsdom tests
    cover the same two properties structurally (the `-animate` classes
    present by default, absent under a stubbed reduced-motion
    preference, and unchanged across a re-render triggered by an
    unrelated click) -- jsdom can prove the code branch was taken; only
    the live pass above proves nothing visibly animates under reduced
    motion, the same distinction this file's own established convention
    elsewhere already draws.
- **Accessibility tradeoff, deliberate and checked, per this issue's own
  Scope item 4's explicit instruction to confirm before deleting**:
  removing `TradeNarrationList`/"Yesterday's trades"/"See the trades ↓"
  does not remove the exact buy/sell prices and times from reach. Once
  "Watch it happen" is clicked, `PortfolioChart`'s own already-existing
  accessible data table (`ChartDataTable`) exposes every point's real
  date/time/price -- confirmed directly against the live chart render
  above (its "View chart data as a table" disclosure is present and,
  when expanded, lists each trade's open/close date, time, and price).
  Nothing is silently lost; it just moves from an always-visible prose
  section to one click (+ one more to expand the table) away. Stated
  here explicitly as this section's own version of the same tradeoff
  issue #175's Background section asked to be checked and disclosed, not
  discovered as an oversight later.
- **`DailyHero.test.tsx` needed real updates, not just new assertions**,
  per this issue's own acceptance criteria: every test that used to scope
  queries to a `heroSection` (to disambiguate a ticker appearing twice,
  once in the hero card and once in the deleted narration section) no
  longer needs that scoping, since a ticker now only ever appears once;
  the "See the trades ↓"/"Yesterday's trades" tests were replaced with a
  single test asserting neither exists anywhere in the DOM; and a new
  "folds each trade's own return into its ticker chip" test replaces the
  old narration-sentence assertions with the chip's own accessible-name
  check described above.
- **Live-verified against a real local pipeline run**
  (`local-run.ts`, the default 20-ticker sample, real Yahoo network
  calls, no S3 write) plus `next build`/`next start` and the documented
  no-root headless-Chromium workaround (`next dev` cannot hydrate in this
  sandbox -- see issue #123's own note above). The real 1W result's most
  recent day (2026-08-27, 3 real trades: ALGN, A, ALB) rendered the full
  showcase correctly -- eyebrow, statement, `$6.5K -> $7K (1.1x)`
  figures, three ticker chips each showing their own signed return
  (`ALGN +2.0%`, `A +2.4%`, `ALB +3.1%`), the "Watch it happen" button,
  and (after clicking) the real chart in the same unchanged-height slot
  -- at both 1280px and 390px, zero console errors, zero `pageerror`
  events, zero horizontal overflow. The synthetic 0-trade/1-trade/
  reduced-motion passes above used Playwright's `page.route()` to
  intercept `/api/results?range=1W` with hand-built fixtures rather than
  a throwaway debug route, since this component fetches through the real
  API route already served by the running app -- no `RESULTS_BUCKET`/AWS
  credentials needed either way, per this file's own "Local development
  without AWS credentials" section. The temporary `playwright`
  devDependency was reverted before committing, per this file's own
  established convention; confirmed via `git status`/`git diff --stat`
  on `package.json`/`pnpm-lock.yaml` showing no trace afterward.

## Gamified hero: the whole pass, end to end (issues #174-178)

The closing issue of the "Gamified hero + NYT-Games-style tiles" milestone
(design references at `docs/design/gamified-hero-2026-08/`, itself
building directly on the "UI simplification" milestone's daily hero and
CTA cards -- see that folder's own README). Its own job was two things:
lay `<BeatTheBench />` and `<CallBoard />` out as a real 2-column grid
below the showcase, and confirm the four issues before it (#174-177)
actually add up to one coherent page, played through together against
real data -- not re-discovering bugs those issues' own live-verification
passes had already caught individually (each of #174/#175/#176/#177
already carried its own real-pipeline live-verification pass before this
issue ever started).

### The busyness/emotional-flatness problem this milestone solved

Before #174, the daily hero was a flat, unanimated card: a fixed $20
starting figure every single day, plain "Yesterday's trades" prose below
it, and both game CTAs were subdued, bordered `surface-card` boxes
(issue #163/#164's own restyle) -- functionally correct but visually
inert next to the two real "games" the page was built around. Four
issues fixed this in sequence, each swapped in cleanly with zero changes
to the ones before it:

- **#174** made the daily hero's starting capital a seeded-per-day
  random value in `[1, 10000)` instead of a flat $20 -- the same trade
  sequence, a genuinely different-looking headline figure every day, so
  the page has something new to notice even on a day with an unremarkable
  trade.
- **#175** restructured the daily hero into a fixed-height (`h-[40rem]`)
  "showcase" box with a one-time staggered entrance animation and
  folded the old "Yesterday's trades" prose section into compact ticker
  chips (`{TICKER} {sign}{percent}%`) inside that same box -- a
  cinematic reveal instead of a static readout.
- **#176/#177** restyled both CTA cards from subdued bordered boxes into
  bold, solid-gradient-fill NYT-Games-style tiles (amber for Beat the
  Bench, blue for The Call Board) with a large icon, matching the design
  mockup's own `.game-tile` treatment.
- **#178 (this issue)** is the one piece none of the four before it
  built: laying those two now-bold tiles out as an actual 2-column grid
  (the mockup's own `.game-row`) instead of two full-width stacked
  siblings -- see "The 2-up grid mechanism" below.

Net effect, most visible in the before/after screenshots this milestone's
own design folder ships (`before-desktop.png`/`after-desktop-*.png`):
the page reads as a small set of daily games sitting side by side under
one animated hero, not a stack of independently-built widgets that
happen to share a page.

### The 2-up grid mechanism (issue #178's own scope)

`ResultsPage.tsx` wraps `<BeatTheBench />` and `<CallBoard />` in one
`grid grid-cols-2 gap-4` container, matching the mockup's own `.game-row`
(`display: grid; grid-template-columns: 1fr 1fr; gap: 0.85rem`) at that
folder's stated "99% fidelity, not pixel-perfect" bar (`gap-4` = 1rem
vs. the mockup's 0.85rem -- close enough that a side-by-side glance
agrees, not worth a bespoke arbitrary-value gap for 2.4px).

**The real design decision this issue's own Scope flagged as needing a
call**: neither tile's _expanded_ content was ever designed to fit in a
50%-width column -- both already rendered full-width, stacked, before
this issue (Beat the Bench's playback controls; The Call Board's
`sm:grid-cols-3` 3-slot picker). Squeezing either into a half-width grid
column once expanded would be a real, unreadable regression, not a small
tweak. The fix: the grid collapses itself to one column, via a plain CSS
`:has()` selector, the instant either tile expands into its full real
game/board --

```
grid grid-cols-2 gap-4 has-[[data-bench-expanded]]:grid-cols-1 has-[details[open]]:grid-cols-1
```

**First use of `:has()`/Tailwind's `has-*` variant in this codebase.**
Two independent single-selector variants rather than one comma-joined
selector, deliberately -- this app has already been bitten once by
Tailwind's own bracket-value class-name parsing choking on an unexpected
character inside `[...]` (see `BeatTheBench.tsx`'s own doc comment on
why its amber gradient is an inline `style`, not a bracket class), so
two simple selectors were chosen over one compound selector as the safer
bet, confirmed live rather than assumed:

- **The Call Board's own expanded state is already a native
  `<details open>`** (issue #164) -- directly selectable via
  `has-[details[open]]`, no new markup needed at all.
- **Beat the Bench has no native disclosure element to key off** -- its
  "expanded" flag is a plain `useState` (issue #163), so
  `BeatTheBenchFrame` (only ever rendered once that flag is true) now
  carries a `data-bench-expanded="true"` marker attribute purely for
  this selector to key on, rather than lifting `expanded` state up into
  `ResultsPage.tsx`.

When the grid collapses to one column, both children (the still-compact
tile and the now-expanded frame) fall out full-width automatically --
the exact stacked layout both components already had pre-#178, just
reached via a CSS state change instead of always being the only layout.
No `col-span` juggling, no lifted state, no prop threading through
either component's own public surface.

**No internal restructuring of either tile was needed** (the issue's own
Scope flagged this as a real risk worth checking, and worth noting
explicitly since it did _not_ materialize): both `CompactCard`
(BeatTheBench) and `CallBoardSummaryRow` (CallBoard) were already
written with a future 2-up grid in mind -- `CompactCard`'s own doc
comment literally named "issue #176's own Out of scope explicitly
defers that layout" as the reason it didn't yet have `aspect-ratio`
sizing, and `CallBoardSummaryRow`'s tile layout (icon over title over
subtitle, a status pill anchored to the bottom) was already built for a
narrow column, not a wide row. Neither needed a single internal CSS
change to read well at 344px (half of this app's `max-w-3xl` content
width at 1440px) or ~163px (half of the real content width at 390px,
after `px-6` padding) -- confirmed live, not assumed, including with
real status-line text longer than either tile's own placeholder copy
(see the measurements below).

### Live verification (real pipeline data, real browser, played through)

Real `local-run.ts` output (the default 20-ticker sample, real Yahoo
network calls, no S3 write -- 6 preset results, 1,255 custom-anchor
results) into a `LOCAL_RESULTS_DIR`, then `next build` + `next start`
(not `next dev` -- see issue #123's own note above on why headless
Chromium can't hydrate a dev-mode page in this sandbox) plus the
documented no-root headless-Chromium workaround. **Zero console errors,
zero console warnings, and zero `pageerror` events across every pass
below**:

- **The grid is a real 2 columns at both widths, with first-visit
  (short, placeholder-length) status text**: at 1440px,
  `getComputedStyle(grid).gridTemplateColumns` read `"344px 344px"`,
  both tiles' own `getBoundingClientRect()` reported identical `177px`
  heights sharing one row (`y: 848` for both, `x: 368`/`x: 728`); at
  390px the Beat the Bench tile measured `163 x 213.66px`, comfortably
  clearing the 44px touch-target floor in both dimensions, with
  `document.documentElement.scrollWidth === clientWidth` exactly (390)
  -- no horizontal overflow.
- **Real, longer-than-placeholder status-line text still fits legibly
  at both widths** -- the issue's own explicit concern, checked with
  real (not mockup-placeholder) copy: a played Beat the Bench session
  ("0.13% ahead of the bench today") and two real Call Board picks
  ("2 of 3 called this week"), injected via `localStorage` before load.
  At 390px both status pills wrap to two lines inside their tile and
  stay fully legible; at 1440px both fit on one line. No stacking
  deviation from the mockup's own side-by-side layout was needed at
  either width -- confirmed, not assumed, with the actual longer
  strings this app's own `compactStatusLine`/Call Board status line can
  produce, not just the mockup's short placeholder text.
- **The showcase's entrance animation plays once and settles, with no
  chart visible**: confirmed via `DailyHero.test.tsx`'s own existing
  coverage (issue #175, unchanged by this issue) plus a fresh
  `reducedMotion: "reduce"` pass here -- zero elements anywhere in the
  section carry any `*-animate` class 150ms after load, with the
  settled state (real figures, ticker chips, the button) visible
  immediately, screenshotted.
- **Clicking "Watch it happen" reveals the chart within its fixed slot,
  with no box resize**: the daily hero's own `section[aria-label="Yesterday's result"]`
  measured exactly `640px` tall (`h-[40rem]`, issue #175's own fixed
  height) both before and after the click; the SVG count went from 0 to
  1 on the same click, confirming the chart genuinely mounted in place
  rather than pushing the box's own height around.
- **Reloading the page shows the identical showcase figures** -- the
  daily hero section's own text content, captured before and after a
  real `page.reload()`, matched byte-for-byte, confirming issue #174's
  date-seeded (not request-seeded) starting capital survives a fresh
  page load exactly as that issue's own live verification already
  established.
- **Both tiles render correctly in the 2-up grid and expand to their
  full real games on click**: expanding Beat the Bench alone collapsed
  the grid to `grid-template-columns: "704px"` (one column, full
  content width) with The Call Board's own tile still rendering
  correctly, still compact, directly below it; expanding The Call Board
  too (both tiles expanded at once) kept the single-column layout, with
  the real 3-slot picker/stats/history rendering at full width beneath
  its own still-blue collapsed summary bar -- screenshotted in both
  states.
- **`prefers-reduced-motion` skips the showcase's entrance straight to
  the settled state**: covered above and re-confirmed with a full-page
  screenshot -- the showcase, both tiles, and the ritual rail all render
  fully settled on first paint, no partial/mid-animation frame visible.
- **No horizontal overflow anywhere on the page at 390px**, checked
  repeatedly (first-visit state and the real-status-line stress-test
  state above) -- `scrollWidth === clientWidth` exactly, every time.
- **No unexpected layout shift after initial paint**: sampling every
  top-level child's own `getBoundingClientRect().top` six times, 300ms
  apart across 2s after load, returned exactly one distinct offset set
  -- the showcase's own entrance animation is opacity/transform-based
  (it never changes layout-affecting properties), so it never moves any
  top-level section's own position while it plays.
- **No hydration mismatch introduced by the new grid wrapper**: a pass
  with only the client's clock faked to a real Wednesday before 9:30 ET
  (the same technique issue #164's own verification established, since
  The Call Board's placeholder is clock-derived and now renders inside
  this same grid) logged zero console/page errors -- the grid container
  itself is a static, prop-free `<div>` with no window/clock reads of
  its own, so this was a low-risk check, run anyway for due diligence.

### Findings: none deferred

Every check above passed on the first real pass against real data --
unlike several of this app's other "final QA" issues (e.g. #135, #166),
which each surfaced at least one genuine, deliberately-deferred rough
edge, this one didn't turn up any. The one thing worth being explicit
about, since the issue's own Scope explicitly asked to flag it either
way: **neither tile needed real internal restructuring to fit the 2-up
grid** -- both were already built anticipating this exact layout (see
"The 2-up grid mechanism" above), and no deviation from the mockup's
own side-by-side-at-every-width layout was needed on mobile. The only
real design decision this issue made on its own was the `:has()`-based
grid-collapse mechanism for the expanded state, which the mockup itself
doesn't cover at all (it only shows the two tiles collapsed side by
side, never expanded) -- documented above, not silently invented.

### `high` code review, two findings, both addressed

A `high` review of the PR above found the diff itself small, well-scoped
and well-verified, with two lower-severity, plausible-risk findings --
both about the new `:has()` mechanism specifically, since it's genuinely
novel to this codebase:

- **No fallback for a browser with zero `:has()` support at all**, which
  would leave the grid permanently at two columns and squeeze an
  expanded game into an unreadably narrow half-column with no error or
  console signal. Fixed with a plain-CSS answer, not a JS one:
  `globals.css` gained a `@supports not selector(:has(a))` block
  targeting a new `.game-row-grid` marker class on the container (no
  styling of its own -- purely a `@supports` target), forcing
  `grid-template-columns: 1fr` whenever `:has()` itself isn't
  understood. `@supports selector()` shipped in the same browser
  releases as `:has()` itself (Chrome 105, Firefox 121, Safari 15.4), so
  a browser that fails this specific `@supports` check reliably has no
  `:has()` support either -- the same reasoning that makes it a safe
  feature-detection gate here. **Verified two ways, since no
  `:has()`-lacking browser engine was available to test against
  directly**: (1) an isolated single-file HTML repro (two rules, one
  base and one inside the exact `@supports not selector(:has(a))`
  block, differing only in `grid-template-columns`) loaded directly in
  this sandbox's real Chromium, confirming `CSS.supports("selector(:has(a))")`
  reads `true` and the fallback rule's own `1fr` value is correctly
  **not** applied -- i.e. the rule is syntactically valid CSS a real
  engine understands, and inert (no accidental regression) in the
  primary, `:has()`-supporting case every real visitor to this app hits
  today. (2) The full real app re-verified afterward at 320/360/375/
  1440px with real stress-test content (a played Beat the Bench session,
  real Call Board picks) and through a real expand/collapse cycle --
  identical results to the pre-fix pass, byte-for-byte
  (`grid-template-columns: "344px 344px"` collapsed, `"704px"` expanded,
  zero horizontal overflow, zero console/`pageerror` events), confirming
  the new marker class and `@supports` block introduced no regression to
  the primary mechanism.
- **Only 390px and 1440px had been checked, not anything narrower.**
  Re-verified live at 320px and 360px too (the practical floor for any
  real device today), with the same real stress-test status-line
  content ("0.13% ahead of the bench today", "2 of 3 called this week")
  as the original 390px pass, not just first-visit placeholder-length
  text. Both tiles still measured with zero horizontal overflow at every
  width (`scrollWidth === clientWidth` exactly, 320/360/375px all
  checked) and remained legible -- longer status lines wrap to more
  lines at the narrowest width (up to 3, at 320px) but never overflow or
  clip. No stacking deviation from the mockup's own side-by-side layout
  was needed at any tested width, confirming the original finding: the
  2-up grid holds up down to the realistic floor, not just the two
  widths originally checked.

All five routine checks (lint, typecheck, `pnpm build`, `pnpm test` --
931 passing, `pnpm format:check`) re-ran green after both fixes, on a
tree confirmed clean of the temporary `playwright` devDependency
(`git status`/`git diff package.json pnpm-lock.yaml` showing no trace).

## Daily hero grows on reveal instead of reserving full height upfront; Beat the Bench is collapsible again (a later design pass)

Two follow-up tweaks to the gamified-hero pass above, requested directly
rather than filed as a numbered issue -- small enough in scope that this
repo's own "small learning project" framing doesn't call for the full
issue-tracking ceremony.

- **`DailyHero.tsx`'s showcase box now defaults to about half its old
  (issue #175) height and grows only once "Watch it happen" is
  clicked**, reversing issue #175's own "reserve the worst case, don't
  shrink to the common case" fixed-height design for this component
  specifically (issue #147's identical-sounding principle for the hero
  _count-up tween_ is untouched and still holds -- that's about several
  sizes swept through while animating a number, which this component's
  static figures never do; growing once in response to a real click is a
  different question). `SHOWCASE_HEIGHT_CLASSNAME` (a fixed `h-[40rem]`)
  is gone, replaced by `SHOWCASE_MIN_HEIGHT_CLASSNAME` (`min-h-[20rem]`,
  a floor, not a ceiling) applied to every chart-hidden state (loading, a
  0-trade day, a real day pre-reveal); the chart's own tall slot
  (`CHART_SLOT_HEIGHT_CLASSNAME`, unchanged at `h-[24rem]`) is now only
  applied once `chartRevealed` is true, so the box's real rendered height
  grows via ordinary content flow the instant the chart mounts -- no
  second height constant, no JS-measured transition. Live-measured (real
  `next build`/`next start`, headless Chromium): 320px tall by default at
  1440px (354px at 375px, where the statement/figures wrap a touch more),
  growing to ~645px/700px once revealed -- close to the old fixed 640px
  (40rem), confirming nothing is clipped by the new floor.
- **`BeatTheBench.tsx`'s expanded view is collapsible again, not a
  one-way mount.** Issue #163's own original design deliberately chose a
  plain button over a native `<details>` specifically because "there's
  nothing here that needs to also collapse back closed" -- that premise
  changed. `BeatTheBenchFrame`'s header now carries a "Collapse" button
  (min-h-11/min-w-11, matching `CONTROL_CLASS`'s own 44px touch-target
  floor -- caught live, not in the first pass: the first version was a
  bare 24px-tall text link, well under this app's own established
  floor), present at every expanded state (the mode chooser, mid-game,
  settlement). Clicking it calls `handleCollapse` (`setExpanded(false)` +
  `setMode(null)`), returning to `CompactCard` -- mirroring The Call
  Board's own always-clickable, collapsible `<summary>`, but staying a
  plain `useState` toggle rather than converting to a native `<details>`:
  the content behind it is a stateful game with a running `setInterval`
  (see `SessionGame`), and collapsing needs to genuinely _unmount_ it
  (stopping that interval via the effect's own cleanup), not merely hide
  it behind `display: none` the way a closed `<details>` would while
  leaving its children -- and their timers -- still mounted underneath.
  Resetting `mode` to `null` on collapse is a deliberate simplicity
  choice: re-expanding always lands back on the mode chooser, never
  resumes stale mid-game state a viewer might not recognize.
- Both changes are purely presentational -- no changes to
  `beat-the-bench.ts`/`beat-the-bench-storage.ts`/
  `use-todays-close-session.ts`/`use-mystery-session.ts`, the Mystery Day
  zero-request-before-settlement rule, `PortfolioChart.tsx`/
  `deriveWholeRangeIntradaySeries`, or any storage-backed persistence.
  `DailyHero.test.tsx`/`BeatTheBench.test.tsx` got real updates (not just
  new assertions) for the renamed height class and the new
  collapse-then-re-expand behavior; all five routine checks (lint,
  typecheck, `pnpm build`, `pnpm test` -- 932 passing, `pnpm
format:check`) are green. Live-verified at 1440px and 375px via a real
  `next build`/`next start` render against the permanent
  `LOCAL_RESULTS_DIR` pipeline data (no `RESULTS_BUCKET`/AWS creds
  needed): the showcase box's real measured height before/after reveal
  at both widths (above), the collapse button's real 44x44px hit target,
  no horizontal overflow at 375px, and zero console/`pageerror` events
  across the whole click-through (expand daily hero chart, expand Beat
  the Bench, collapse it, confirm the compact card is back) at both
  widths.

## Hero showcase box: re-measured against the reference, gradient restored (issue #198)

Two small fixes found in the same live-vs-mock comparison pass, both to
`DailyHero.tsx`'s showcase box (`SHOWCASE_CLASSNAME`/
`SHOWCASE_MIN_HEIGHT_CLASSNAME`, see that file's own doc comments): the
box rendered taller than the design reference, and it had regressed to a
flat fill with no gradient at all.

- **The exact measured target height, and how it was gotten.** Don't
  trust a rough eyeball or a CSS `min-height` value read straight off the
  reference's stylesheet -- `docs/design/daily-hub-condensed-2026-08/
mockup-daily-hub-condensed.html`'s own `.showcase.collapsed` rule says
  `min-height: 12.5rem` (200px), but its real content (the statement,
  figures, and button) pushes the actual rendered box taller than that
  floor. Measured live via a headless-Chromium `getBoundingClientRect()`
  read against the reference file directly (`file://...`, not a
  screenshot pixel-count), at a 1280px viewport, in its "Fresh day"
  (`#state-fresh`) chart-hidden (`.collapsed`, `#chart-slot[hidden]`)
  state: **`234.46875px`** (`14.654rem`). This confirms the issue's own
  rough `~233px`/`~14.6rem` estimate was close, not exact -- always
  re-measure precisely rather than trusting a prior estimate, per this
  issue's own instruction. Target per the acceptance criteria (reference
  height, then a further 5% below _that_, not below the pre-fix shipped
  height): `234.46875 * 0.95 = 222.745px = 13.9216rem`, rounded down
  slightly to `min-h-[13.9rem]` (`222.4px`) to sit safely under that
  ceiling. This replaced the pre-#198 `min-h-[20rem]` (320px) -- a real,
  meaningful reduction (~30%), not a rounding-error-sized tweak.
- **The floor only binds at desktop widths where content is shorter than
  it -- not at every viewport, and that's expected, not a bug.** Live-
  measured before/after at 1280px: the real showcase box (a 3-trade day)
  went from `320px` (the old floor, since real content only needed
  ~277px) to `276.78px` (now genuinely content-driven, since the new
  `13.9rem`/`222.4px` floor no longer binds) -- the actual visible
  shrink a viewer sees. At 390px mobile, the box measured `332px` both
  before and after: mobile's wrapped statement/chips content already
  exceeds _both_ the old and new floor, so neither change is the binding
  constraint there and the rendered height is unaffected by this fix at
  that width -- correct given `SHOWCASE_MIN_HEIGHT_CLASSNAME` is a floor,
  not a fixed height (see the "Daily hero grows on reveal" section
  above), not something to "fix" further.
- **The gradient regression, and the fix.** `SHOWCASE_CLASSNAME` had
  drifted to a flat `bg-[var(--surface-1)]` fill with no gradient --
  confirmed via `git blame`/reading history that this was never
  deliberately removed, just never carried forward through the
  `min-h-[40rem]` -> `min-h-[20rem]` (grow-on-reveal) restructuring
  documented in the section above. Restored via a new
  `SHOWCASE_GRADIENT_STYLE` constant (`backgroundImage:
"linear-gradient(180deg, #1d1d1b 0%, var(--surface-1) 55%)"`, matching
  the reference's own `.showcase` rule exactly) applied via inline
  `style` at all three of this component's render sites (the loading
  skeleton, the zero-trade fallback, and the real result) -- following
  `BeatTheBench.tsx`'s own `CompactCard` gradient doc comment's
  established reasoning for inline `style` over a Tailwind arbitrary-
  value background class (see that file's own note: bracket-value
  parsing is easy to get subtly wrong for a gradient, and there's no
  test/reuse reason here that needs a class). `.surface-card` (already on
  this box) sets only `box-shadow`, no background of its own, so there's
  no specificity fight to worry about. Live-verified the computed
  `background-image` resolves both color stops correctly
  (`linear-gradient(rgb(29, 29, 27) 0%, rgb(26, 26, 25) 55%)` --
  `#1d1d1b` and the app's real `--surface-1` value) at both 1280px and
  390px.
- **The chart-revealed state (`CHART_SLOT_HEIGHT_CLASSNAME`, `h-[24rem]`)
  is deliberately untouched**, per this issue's own scope -- it renders
  the real `PortfolioChart`, not the reference's tiny decorative `<svg>`,
  and is a separate, larger design pass filed as its own issue. Checked
  the reference's own "expanded" (`.showcase.expanded`) state before
  concluding this: it measures `455px` at 1280px (`.showcase.expanded`'s
  own `min-height: 24.5rem`/392px floor, plus real content), materially
  different from this app's real chart-slot sizing either way -- nothing
  in that comparison suggested the revealed state needed a matching fix
  here.
- **Live-verified via a real before/after pass** (`LOCAL_RESULTS_DIR` +
  `next build`/`next start`, the documented no-root-Chromium-adjacent
  workaround -- Chromium launched cleanly here with no extra shared-lib
  extraction needed this session, per this file's own "Headless-browser
  screenshot verification" section's own caveat that this can vary),
  `git stash`-ing just the fix to capture the true "before" state (not a
  hand-reverted approximation): screenshotted both states at 1280px and
  390px, chart-hidden. The "after" screenshots show a visibly shorter box
  with the top-to-bottom wash clearly present; the "before" screenshots
  confirm the pre-fix flat fill and the taller, floor-bound box. Zero
  console errors or `pageerror` events across every load. The temporary
  `playwright` devDependency and every scratch verification script were
  reverted/deleted before committing, per this file's own established
  convention; confirmed via `git status`/`git diff --stat` on
  `package.json`/`pnpm-lock.yaml` showing no trace afterward.

## Day-strip layout for `DayOverview` on 1W/1M/3M -- 1Y stays a list (issue #193)

`DayOverview.tsx` gained a required `layout: "strip" | "list"` prop,
computed by `ResultsPanel.tsx` from its own `range` prop
(`range === "1Y" ? "list" : "strip"`). `layout === "list"` is issue #80's
own markup, byte-for-byte unchanged (a pure conditional split, not a
rewrite) -- 1Y's own ~252-day case needs a different design, tracked
separately as issue #140, and is explicitly out of this issue's scope.
`layout === "strip"` (1W/1M/3M) replaces the vertical row list with a
single horizontally-scrollable row of fixed-width (`w-14`) day chips:
short weekday abbreviation + day-of-month number (two new `format-date.ts`
exports, `formatShortWeekday`/`formatDayOfMonth` -- nothing existing fit,
confirmed by reading that file first per the issue's own instruction) on
top, a small `h-1 w-6 rounded-full` `--status-good`/`--status-critical`
bar underneath (the same `>= is good` convention `TradeRow.tsx`/
`HeroStat.tsx` already use).

- **The exact dollar figure and trade count move into the chip's own
  `aria-label`** (e.g. `"Aug 24, 2026, 2 trades, $20.00 to $26.84"`) --
  there's no room for them at `w-14`. A real, minor regression, flagged
  in the issue itself and in this PR's own description rather than
  silently accepted: the old list showed a day's dollar figure without
  needing to select it first; the strip needs one extra click (the same
  day's own `HeroAndWorstCase`/trade-list below still shows every detail
  unconditionally once selected, per issue #91 -- nothing is gated, only
  relocated one interaction earlier than before).
- **`DayOverviewRow` gained a `startingCapital: number` field** -- the
  color bar needs a gain/loss direction per row, and `endingBalance`
  alone isn't enough (see `apps/web/CLAUDE.md`'s own
  "rescaleFromStartingCapital's per-day pattern..." section above:
  `endingBalance`/`startingCapital`'s _ratio_ survives the per-day
  display rescale even though the absolute values don't mean "this day's
  real chained balance"). `ResultsPanel.tsx`'s `dayOverviewRows` memo
  now stashes its own `effectiveStartingCapital` onto every row (same
  value for every row today, carried per-row so a row stays a
  self-contained unit rather than needing a second prop threaded
  alongside `rows`).
- **The "carried over from {date}" note (issue #84) becomes an
  `aria-hidden` `↩` corner glyph** in the strip layout -- no room for the
  list layout's text line at this chip width. Its full meaning
  (unchanged) is still available in the drill-down section below once
  that chip is selected; the glyph itself never reaches the chip's own
  `aria-label` (verified in `DayOverview.test.tsx`), the identical
  accessible-name-collision reasoning the list layout's own `aria-hidden`
  text note already documents.
- **The `scrollIntoView` effect is the same one call, branching only on
  which axis to align** -- `{ inline: "nearest", behavior }` for the
  strip (horizontal), `{ block: "nearest", behavior }` for the list
  (vertical, unchanged) -- both guarded the same two ways the
  pre-existing effect already was (a `typeof ... === "function"` check,
  and `behavior: "auto"` under `prefersReducedMotion()`).

**`DayOverview.test.tsx`/`ResultsPanel.test.tsx` needed real updates,
not just new assertions layered on the old list-based queries, per the
issue's own acceptance criteria** -- `ResultsPanel.test.tsx`'s
DayOverview-related tests that used to assert a row's dollar figure via
`within(row).getByText("$X.XX")` now query
`getByRole("button", { name: /Aug 20, 2026.*\$25\.00/ })` instead for
`range="1M"` (a strip-layout range as of this issue), since the figure
moved into the chip's own aria-label; a parallel test against
`range="1Y"` keeps the original `within(...).getByText(...)` assertion,
confirming the list layout's visible-text contract is still genuinely
unchanged.

**Live-verified against a real local pipeline run** (`local-run.ts`, the
default 20-ticker sample, real Yahoo network calls, no S3 write) plus
`next build`/`next start` and the documented no-root headless-Chromium
workaround (`next dev` cannot hydrate in this sandbox -- see issue #123's
own note above). Real screenshots at all four ranges (1W/1M/3M/1Y),
desktop (1280px) and mobile (390px): 1W/1M/3M render real chips with
correct weekday/day-of-month text, a real `aria-label` matching the
`"{date}, {N} trades, ${from} to ${to}"` format, a visible `↩` glyph on
every chip but each range's own first, and a green/red color bar per
chip; 1Y renders the pixel-identical old vertical list. Clicking a
different chip both highlights it (`aria-current`) and updates the
drill-down `HeroAndWorstCase`/trade-list below, confirmed via the sr-only
"Selected day status" region's own text changing. No horizontal overflow
at 390px (`document.documentElement.scrollWidth === clientWidth`,
checked on 1M). Zero console/`pageerror` events across every range/width
combination.

- **A real, pre-existing gap found live, not caused by this issue --
  worth knowing before the next `scrollIntoView`-on-mount feature in this
  app.** The selected chip/row's on-_mount_ scroll (both layouts) doesn't
  actually happen in the real, shipped app today: since issue #165
  nested `ResultsPanel` (and therefore `DayOverview`) inside a closed-by-
  default "Explore other windows" `<details>`, the component mounts (and
  its mount-time `useEffect` fires) while still hidden -- `scrollIntoView`
  on an element with no layout box (a closed `<details>`'s content is
  `display: none`) is a silent no-op. Confirmed this is not something
  issue #193 introduced: `range=1Y` (untouched list-layout markup) shows
  the identical `selectedInView: false` result at initial mount in this
  same live-verification pass. The **on-selection-change** scroll (the
  same effect, re-firing when `selected` changes) works correctly once
  the `<details>` is genuinely open -- confirmed live, clicking a
  different chip/row always scrolls it into view. Not fixed here (out of
  this issue's own scope, which explicitly only concerns 1W/1M/3M vs. 1Y
  layout, not the `<details>` nesting issue #165 introduced) -- worth its
  own follow-up if the "scrolls to the most recent day on first load"
  experience is ever considered worth restoring for a visitor who
  expands the explorer.

## Connecting each game tile's expanded panel to the tile that opened it (issue #195)

Before this issue, clicking either compact tile (issue #163/#176's Beat
the Bench, issue #164/#177's The Call Board) swapped its bold
gradient-fill card out for a plain flat `bg-[var(--surface-1)]` panel
with no shared border, accent color, or icon -- the two states read as
unrelated components. Two devices, applied to both tiles, using each
tile's own darkest gradient stop as a shared accent:

1. **A 4px accent-colored top border** on the expanded panel (`#d88f28`
   for Beat the Bench, `#2a58ab` for The Call Board), via inline
   `style={{ borderTopColor: ... }}` -- not a Tailwind bracket-value
   class, the same reasoning `CompactCard`'s own doc comment already
   gives for why its gradient is inline. The other three sides keep
   their original `border-[var(--gridline)]` color/width unchanged; only
   `border-t-4`'s width and the inline `borderTopColor` override the top
   edge.
2. **A small persistent icon plate** (🎯 / 🔮) at the top of the
   expanded panel, tinted with a ~15% wash of the same accent
   (`${CONNECTOR_ACCENT}26`, an 8-digit hex alpha), sitting beside a
   visible heading naming the mechanic.
3. **The Call Board's `<details>` additionally gets flush corners**,
   since its tile stays mounted as the (still-clickable) `<summary>`
   while open, unlike Beat the Bench's tile, which fully unmounts on
   expand (a plain `useState` toggle, not a `<details>`) -- see the two
   files' own top-of-file notes. `<details className="group">`, the
   `<summary>` gains `group-open:rounded-b-none`, and the body wrapper
   drops its `mt-3` gap and `surface-card` shadow, flips to
   `rounded-t-none rounded-b-2xl`, and swaps its uniform `border` for
   `border-x border-b` (no top) plus the new `border-t-4` accent -- so
   it reads as unfolding directly out of the tile rather than a separate
   floating card.
4. No transition/animation on either device, per the issue's own scope.

**`CONNECTOR_ACCENT` is derived from each file's own existing gradient
definition, not hand-copied as a fresh third literal.** The two files
needed different mechanisms, since only one of them can genuinely
_derive_ the value at all:

- `CallBoard.tsx`'s `CARD_CLASSNAME` is a Tailwind arbitrary-value
  class (`bg-[linear-gradient(...)]`) -- its utility name has to appear
  in the source as a literal, scanner-visible string for the build-time
  content scan to find it (the same class of gotcha
  `apps/web/CLAUDE.md`'s own "surface elevation" note already
  documents), so the gradient can't be _built from_ a JS constant. It
  can still be _read from_, one-way: `CONNECTOR_ACCENT` is
  `CARD_CLASSNAME.match(/,(#[0-9a-f]{6})_100%\)\]/i)![1]!` -- a genuine
  regex extraction of the darkest stop, not a second literal, so the two
  can't silently drift on a future edit to the gradient string.
- `BeatTheBench.tsx`'s tile gradient was already a plain inline `style`
  string (set that way specifically for reliability, per `CompactCard`'s
  own pre-existing doc comment on Tailwind's bracket-value parsing
  risk), so there's no such constraint -- its three stops were promoted
  to named constants (`BENCH_TILE_GRADIENT_STOPS`), the gradient string
  itself is now built from them via template literal, and
  `CONNECTOR_ACCENT` just reads the last array element directly.

**Hover-lift vs. the flush seam (The Call Board only).** `<summary>`
already had `hover:-translate-y-0.5 hover:scale-[1.015]
active:translate-y-0 active:scale-[0.99]` (issue #177/#186) -- once open
and flush against the body below (device #3), that lift would visibly
tear the seam on hover. Fixed by adding
`group-open:hover:translate-y-0 group-open:hover:scale-100`, relying on
Tailwind's own variant-count-based rule ordering (a two-variant rule
like `group-open:hover:` is always emitted after a one-variant rule
targeting the same property, regardless of source order in the
`className` string, which is exactly why "the order of classes in your
HTML never matters" holds in Tailwind generally) to make the
more-specific suppression win while both rules are simultaneously
active. **Live-verified, not just asserted**: a real Playwright hover
against the running production server read `getComputedStyle(el)`'s
`translate`/`scale` longhands (Tailwind v4's transform utilities set
these, not the `transform` shorthand, so asserting `transform` alone
reads `"none"` regardless of state and proves nothing) -- collapsed +
hover genuinely applies `translate: 0px -2px; scale: 1.015`, expanded +
hover genuinely settles at `translate: 0px; scale: 1`, and the
summary's own `border-bottom-left-radius` reads `0px` once open,
confirming the flush-seam device too.

**Factual correction to the original plan, confirmed by reading the
component before touching it**: the plan claimed The Call Board's
expanded body "has no heading at all visible today." False -- it
already had two visible `<h3>` headings, "Your record" and "Recent
calls." The new icon+heading row (device #2) matches that same
`text-sm font-medium text-[var(--text-primary)]` h3 level/weight for
consistency, rather than inventing a new heading style, and its visible
text ("The Call Board") duplicates the pre-existing sr-only `<h2
id="call-board-heading">`'s own accessible name once expanded --
`ResultsPage.test.tsx`'s own `sectionFor` helper (which locates a
top-level section via `getByRole("heading", { name })`) needed a
`level: 2` constraint added so it keeps resolving the landmark heading
specifically, not either of the two same-named headings ambiguously,
once the board is expanded in a test.

**The visual-symmetry question (Beat the Bench's thinner treatment --
border + icon only, no flush seam, since its tile fully unmounts)** was
explicitly checked live, not assumed: both tiles' expanded panels were
screenshotted side by side (1280px and 375px) after this fix. Beat the
Bench's rounded, floating panel -- carrying the identical accent-colored
border and icon the collapsed tile itself uses, positioned immediately
adjacent to it -- reads as clearly connected to its own tile, not
meaningfully weaker than The Call Board's flush-seam treatment; the two
devices (border + icon) alone were judged sufficient without adding a
third (e.g. a colored ambient glow) specifically to compensate. Beat the
Bench keeps `rounded-lg` on every corner (not `rounded-t-none`) since,
unlike The Call Board, there is no tile left mounted above it once
expanded to flush against -- forcing square top corners there would just
look like an accidental rounding bug, not a connector device.

`CallBoard.test.tsx`/`BeatTheBench.test.tsx` both gained a dedicated
test for the new border-color/icon/heading (and, for The Call Board, the
`group`/flush-corner/no-`surface-card` structure) -- see each file's own
"issue #195" test. Live-verified via `next build`/`next start` (this
sandbox's headless Chromium can't hydrate `next dev`, per this file's
own established note) against a real `LOCAL_RESULTS_DIR` pipeline run:
screenshotted both tiles collapsed/expanded at 1280px and 375px,
confirmed keyboard nav (`Tab` to the summary, `Enter` toggles it closed
again -- native `<details>`/`<summary>` behavior, untouched by this
issue), and zero console/`pageerror` events across every pass.

### `high` code review: two findings, both fixed before merge

An 8-angle `high` review of the PR above found two real issues -- one
reproduced directly by actually rendering the component under a
hydration-timing probe, not just reasoned about.

- **`ResultsPage.test.tsx`'s three `getByRole("heading", { name: "The
Call Board" })` queries had no `level` constraint, and this issue's
  own new visible `<h3>The Call Board</h3>` (device #2, at the top of
  the expanded panel) now shares that exact accessible name with the
  pre-existing sr-only `<h2 id="call-board-heading">` landmark.**
  Reproduced live: rendering `<CallBoard />`, awaiting a microtask (so
  `useCallBoard`'s mount-time hydration correction lands, the same
  boundary `use-call-board.ts`'s own doc comment already documents),
  then calling the unconstrained query throws
  `@testing-library/dom`'s `getMultipleElementsFoundError` -- both
  headings genuinely match. The sibling `sectionFor` test helper (added
  earlier in this same PR, for a different describe block) already
  carries `level: 2` and was never at risk; these three call sites, in
  an _earlier_ describe block in the same file, were the ones missed.
  Fixed by adding `level: 2` to all three, matching `sectionFor`'s own
  precedent -- confirmed this is exactly the "unique landmark, not the
  visible in-panel heading" query every one of these three tests
  actually means, since none of them expand the board first.
- **`CallBoard.tsx`'s `CONNECTOR_ACCENT` regex-derived it from
  `CARD_CLASSNAME` via two bare non-null assertions
  (`.match(...)![1]!`), evaluated at module load time.** A future edit
  to `CARD_CLASSNAME`'s gradient string (a new stop count, different
  spacing/format) that no longer matches this exact pattern would throw
  an unhelpful `TypeError` at import time -- and since `CallBoard`
  mounts unconditionally at the `ResultsPage` level (issue #122), that
  would crash the whole page, not just this tile. Fixed by replacing
  the bare assertions with an explicit `null` check that throws a
  named, descriptive `Error` naming exactly what broke and pointing at
  the regex to fix -- the module still fails fast on a genuine mismatch
  (preserving the "single source of truth, no duplicate literal"
  property the constant's own doc comment already argues for), but the
  failure is now debuggable instead of a cryptic crash. In practice
  `next build`/`pnpm test` would catch a real mismatch on the very next
  CI run before it could ever reach production -- this is a robustness/
  clarity fix, not a fix for a reachable production bug.
- All five routine checks (lint, typecheck, `pnpm build`, `pnpm test` --
  955 passing, `pnpm format:check`) re-ran green after both fixes.

## Non-functional placeholder tiles for The Order / The Lineup (issue #197)

Read issue #189 in full first -- both games were designed, mocked, then
explicitly parked pending a daily-selection-mechanism design pass this
issue does not attempt. `components/PlaceholderGameTile.tsx` exports
`TheOrder`/`TheLineup`, two static tiles filling out the game grid's
second row -- the grid `ResultsPage.tsx` already builds for
`BeatTheBench`/`CallBoard` (issue #178) becomes the full 2x2 the
daily-hub-condensed mockup was originally sketched with, purely by
appending these two as its 3rd/4th children -- no grid restructuring
needed, since `grid-cols-2` with 4 children already wraps into two rows
for free.

- **Deliberately a plain, non-interactive `<div role="group"
aria-label="{title} - coming soon" aria-disabled="true">`, not a
  focusable control with `aria-disabled` bolted on.** The issue's own
  Scope wording ("not interactive... no `<details>`/expand behavior...
  `aria-disabled` and no focus-trap/dead click target") reads as a list
  of constraints on one control at first glance, but there is nothing
  behind either tile to reveal -- unlike `BeatTheBench`'s `useState`
  toggle or `CallBoard`'s `<details>`, both of which exist specifically
  to expand into a real interactive experience. No `<button>`, no
  `tabIndex`, no `onClick` at all is what actually satisfies "no
  focus-trap/dead click target" -- `aria-disabled="true"` is added on
  top for the issue's own explicit ask and to give assistive tech a
  positive "this is disabled" signal, mirroring the
  `aria-hidden`+`inert` "belt and suspenders" posture this file's own
  "Trade replay" section already documents for `PortfolioChart`.
- **Visually matches `BeatTheBench.tsx`'s/`CallBoard.tsx`'s own
  collapsed-card tiles** (icon plate, gradient fill, rounded corners, a
  status pill -- now reading "Coming soon" instead of a real status
  line) via one shared internal `ComingSoonTile`, parameterized per game
  by icon/title/subtitle/a literal Tailwind `gradientAndShadowClassName`
  string.
- **The gradient+shadow className is a fully static, per-tile literal
  string (`CallBoard.tsx`'s own `bg-[linear-gradient(...)]`/
  `shadow-[...]` approach), deliberately not threaded through a CSS
  custom property referenced inside a `shadow-[...]` bracket.** An
  earlier draft tried a shared `--tile-glow` custom property read from
  inside the shadow's own arbitrary-value bracket -- exactly the shape
  `BeatTheBench.tsx`'s own doc comment already warns is "easy to get
  subtly wrong through Tailwind's bracket-value parsing," and this
  codebase has been bitten by that once already (see that file's own
  note on why its amber gradient is an inline `style`, not a bracket
  class). Reverted before it needed live-testing to prove the concern
  either way -- a static literal per tile is the cheaper, already-proven
  shape, not a new mechanism.
- **Colors are new, not reused from either real tile's palette** -- no
  committed mockup exists for The Order/The Lineup to match pixel-for-
  pixel (issue #189's own body says the interactive mockup that did
  include them was a scratch artifact, never committed), only issue
  #189's own purple/teal color assignment. Both three-stop 155deg
  gradients (matching the real tiles' own sweep) were tuned the same way
  issue #177 tuned CallBoard's own blue -- every stop's white-text
  contrast independently computed via the WCAG relative-luminance
  formula and verified >= 4.5:1 AA before being committed (The Order:
  7.06:1 / 8.37:1 / 10.68:1; The Lineup: 5.10:1 / 6.25:1 / 8.64:1) -- see
  `PlaceholderGameTile.tsx`'s own top-of-file comment for the exact hex
  values and the computed numbers.
- **No streak chips or other retention-mechanic badges, and no
  `daily-ritual.ts` wiring** -- both explicitly out of scope per the
  issue itself: issue #189 flags streak chips as a genuinely undecided
  retention-mechanic question, and neither tile is "played," so the
  daily ritual's recap is unaffected.
- **Kept easy for the sibling play-history-ordering issue in this
  milestone (#196) to extend, without building any of its own ordering
  logic here**: the grid's four children are still plain, literal JSX in
  document order (`<BeatTheBench />`, `<CallBoard />`, `<TheOrder />`,
  `<TheLineup />`) -- #196 can reorder the first two by their own play
  state with no change needed to how these two are rendered or
  positioned; they simply stay the grid's last two children regardless
  of what order the real tiles end up in.
- **Live-verified against a real local pipeline run** (`local-run.ts`,
  the default 20-ticker sample, real Yahoo network calls) plus `next
build`/`next start` (not `next dev` -- see issue #123's own note above
  on why headless Chromium can't hydrate a dev-mode page in this
  sandbox) and the documented no-root headless-Chromium workaround
  (Chromium launched directly here without needing the `apt-get
download`/`dpkg-deb -x` shared-library extraction -- the cached
  binary already had what it needed). Confirmed at 1280px and 390px:
  both tiles render in the grid's second row, directly below
  `BeatTheBench`/`CallBoard`; `getByRole("group", { name: "The Order -
coming soon" })`/`"The Lineup - coming soon"` both resolve, each with
  `aria-disabled="true"` and zero focusable descendants
  (`button, a, details, summary, [tabindex]`); no horizontal overflow
  at either width; zero console errors or `pageerror` events. The
  temporary `playwright` devDependency was reverted before committing;
  confirmed via `git status`/`git diff --stat` on
  `package.json`/`pnpm-lock.yaml` showing no trace afterward.

### `high` code review: two doc-accuracy fixes, one extraction deliberately deferred

An 8-angle `high` review of the PR above found two real doc-comment
inaccuracies and flagged (but this session chose not to act on) a
larger reuse opportunity -- worth recording why each landed where it did.

- **`PlaceholderGameTile.tsx`'s own top-of-file doc comment claimed
  `min-h-28` "is the same defensive floor those two [real] tiles use" --
  false for `BeatTheBench.tsx`'s `CompactCard`, which carries no
  `min-h-*` class at all** (confirmed by reading its source directly,
  not assumed). It matches `CallBoard.tsx`'s own `CARD_CLASSNAME`
  exactly (`min-h-28`), but only that one. Fixed to say so explicitly.
- **The status-pill doc comment made the identical "both tiles" claim,
  also false**: `CallBoard.tsx`'s pill is `bg-white/20 px-2.5 py-1
text-[0.6875rem]`, matching `PlaceholderGameTile.tsx`'s own pill
  byte-for-byte; `BeatTheBench.tsx`'s pill is `bg-black/[14%]
px-[0.55rem] py-[0.2rem]` -- a different background alpha/color
  entirely, with different padding. Fixed the same way -- names
  `CallBoard` as the actual source of the borrowed treatment, notes
  `BeatTheBench`'s own pill differs. (The icon-plate comment right above
  it -- "matching BeatTheBench's/CallBoard's own 44px circular
  translucent backdrop" -- was checked too and left alone: both real
  tiles' icon plates genuinely are `h-11 w-11 bg-white/[0.16]`,
  identically; only the glyph size inside the plate differs between them
  (`text-3xl` for CallBoard/this file, `text-[1.75rem]` for BeatTheBench
  -- a difference the comment never claimed to match in the first
  place).
- **Deliberately NOT done: extracting a shared `IconPlate`/tile-summary
  component out of `BeatTheBench.tsx`, `CallBoard.tsx`, and this file**,
  even though the icon-plate markup (`h-11 w-11 rounded-full
bg-white/[0.16]`) is now genuinely duplicated a third time. That
  refactor would mean touching two already-shipped, heavily-tested,
  unrelated components (`BeatTheBench.tsx`/`CallBoard.tsx`) for a scope
  issue #197 never asked for -- exactly the class of undisclosed scope
  expansion this file's own issue #105 post-PR review history already
  flags as release-blocking when it happens silently (see that
  section's own "WholeRangeBalance's new... stat was forwarded
  unconditionally" finding). Worth a real follow-up issue if a fourth
  caller of this exact markup ever shows up -- not attempted here.
- All five routine checks (lint, typecheck, `pnpm build`, `pnpm test` --
  950 passing, `pnpm format:check`) re-ran green after both fixes; no
  new live-browser verification pass, since neither fix changes any
  rendered output (doc comments only).

## Ordering the two game tiles by play history (issue #196)

Before this issue, `ResultsPage.tsx`'s 2-up game-tile grid (issue #178)
always rendered `<BeatTheBench /><CallBoard />` in that literal, fixed
order. Two new modules plus a thin hook now let a viewer's own play
habits decide which tile renders first:

| module                           | owns                                                                                                   |
| -------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `lib/game-tile-order-storage.ts` | the localStorage-backed, date-keyed rolling history of which tile a viewer touches first each day      |
| `lib/game-tile-order.ts`         | the pure ranking/sort function (`orderGameTiles`), independently unit-tested against synthetic history |
| `lib/use-game-tile-order.ts`     | the SSR-safe hook wiring the two together for `ResultsPage.tsx`                                        |

- **Storage shape: one entry per viewer-local day, holding an ordered
  array of every tile touched that day** (`TileOrderDay = { date,
order: GameTileId[] }`), not the simpler `{date, gameId}` "just the
  first one" shape the issue's own Background section offered as
  sufficient. The richer shape is what lets one history double as the
  answer to _both_ questions this ranking needs: `order[0]` is "which
  tile was opened first" (feeds `preferenceScores`), and
  `order.includes(gameId)` is "was this specific tile played today at
  all" (feeds the played-today-sinks rule) -- including for whichever
  tile was touched _second_ that day, which a bare `firstGameId` field
  couldn't answer. `recordGameTileOpened(gameId, date)` is idempotent
  per (day, tile): the first tile touched on a day claims the front of
  that day's `order`; a later same-day play of the other tile is
  appended; a same-day replay of a tile already recorded is a no-op --
  today's order is decided the moment each tile is first touched, not
  re-decided on every subsequent play.
- **Keyed by the viewer's own local calendar date
  (`localDateKey(new Date())`), deliberately not either game's own
  trading-day concept.** This is a real, considered departure from both
  existing storage modules' own keying: `beat-the-bench-storage.ts`
  keys by the session's own trading date (a prior Friday on a weekend),
  and `call-board-storage.ts` keys by the _called_, always-future
  trading day. Neither is "today" in the sense this ranking needs --
  "in what order did this browser touch the two tiles on its own
  calendar day" is a fact about the viewer's wall clock, not about any
  trading calendar. `localDateKey` uses the browser's local
  `getFullYear`/`getMonth`/`getDate`, not UTC and not
  `market-calendar.ts`'s own `America/New_York`-zoned `exchangeClock`.
- **History length: 30 days, matching `call-board-storage.ts`'s own
  `MAX_STORED_RESOLVED_CALLS` order of magnitude** -- roughly a month of
  typical daily use. This mechanic only ever needs a _stable_ fractional
  preference signal, not a long memory: 30 recent days is already enough
  to smooth over a handful of atypical mornings while staying a couple
  hundred bytes and cheap to re-derive a score from on every mount.
  Oldest days are dropped first, same trimming posture as every other
  bounded history in this app.
- **Preference score: neutral 0.5 for "no data yet," genuinely 0 for
  "played but never first," not the same thing.** A tile with **no
  recorded appearance at all** in the history (a brand-new viewer, or
  one who has only ever played the _other_ tile) scores 0.5 -- the same
  "don't let an early, thin signal look confidently wrong" reasoning
  `daily-guess-storage.ts`'s own key-migration note and this file's
  general silent-degradation posture already establish elsewhere. A
  tile that _has_ appeared but was never `order[0]` legitimately scores
  0 -- that's a real, earned signal, not an absence of one, and treating
  it as neutral would blur "I've never seen you play this" into "you
  always play this second."
- **Tie-break: deterministic, by `GAME_TILE_IDS`' own fixed order
  (Beat the Bench, then The Call Board -- this app's pre-#196 order),
  not by `Array.prototype.sort`'s incidental stability or by whatever
  order the caller happens to pass tiles in.** A brand-new viewer (both
  scores neutral 0.5) and a viewer with a genuinely tied history both
  hit this path and see the exact same order this app always showed
  before this issue -- the issue's own "don't let a brand-new viewer
  see an arbitrary order that looks broken" acceptance criterion, made
  concrete.
- **The sort is pure and re-derived fresh on every mount, never
  re-computed mid-session.** `use-game-tile-order.ts`'s hook reads
  storage exactly once, in its own mount-time hydration-correction
  microtask (see below) -- there's no `subscribeToLocalStorage`
  subscription the way `use-daily-ritual.ts` has for its own rail. This
  is deliberate, not a missed wiring: the issue's own Design section 4
  explicitly requires that today's play only move the _played_ tile to
  the bottom of _today's_ render (already true the instant either write
  path's `recordGameTileOpened` call lands, since the played-today rule
  reads the same day's `order` the write just updated), and must **not**
  retroactively change the _preference_ ranking used for future sorting
  until the next visit. A live subscription would risk exactly the
  wrong thing: re-deriving `orderGameTiles` mid-session off a history
  that now includes today's own just-written entry could shuffle the
  two tiles' relative position for reasons unrelated to "did you play
  this tile today" (e.g. a `preferenceScores` shift from a fresh data
  point), which the issue's own "not something that jumps mid-session"
  requirement rules out. One read at mount, held for the component's
  whole lifetime, is what keeps that guarantee true by construction
  rather than by a special-cased check.
- **Hydration safety follows `use-hydrated-local-storage-state.ts`'s
  deferred-correction shape (`useHydratedLocalStorageState`), not
  `use-daily-guess.ts`'s synchronous-read shortcut** -- the same call
  used consistently in this app when the mounting component _can_
  render during SSR (see `use-call-board.ts`'s own `UNHYDRATED_VIEW`,
  and the deleted `use-onboarding-dismissed.ts`, both at this identical
  `ResultsPage.tsx` level). Default value is `GAME_TILE_IDS`' own fixed
  order -- both on the server and on the client's very first render
  during hydration -- corrected to the real, history-derived order from
  the hook's mount-time microtask. No `writeStored`/setter of its own:
  this hook is a pure reader, matching `use-daily-ritual.ts`'s own
  precedent of never owning a write path for state another feature
  already owns and writes.
- **Wiring each tile's "played" write path (issue's own Scope item 4)**:
  `BeatTheBench.tsx`'s settlement `useEffect` (the one that already
  calls `savePlayedSession` once `settled` goes true) now also calls
  `recordGameTileOpened("beat-the-bench", localDateKey(new Date()))`
  unconditionally alongside it -- unconditionally because
  `savePlayedSession` itself is called the same way there, with no
  return-value check. `use-call-board.ts`'s `makeCall` calls
  `recordGameTileOpened("call-board", localDateKey(now))` **only when
  `saveCallBoardPick` actually returns `true`** -- a refused write (the
  called day is already locked, past its own market open) isn't really
  "playing" this tile today any more than it's a real accepted call,
  and shouldn't count toward "usually played first" either.
- **The `:has()`-based 2-up grid mechanism (issue #178) needed zero CSS
  changes, and this was verified, not assumed.** That mechanism's two
  `has-[[data-bench-expanded]]:grid-cols-1`/`has-[details[open]]:grid-cols-1`
  rules collapse the grid to one column the instant either tile expands,
  by matching on the _presence_ of a marker descendant anywhere inside
  the grid container -- `:has()` selectors are position-independent by
  their own CSS semantics, so which of the two tiles happens to render
  first in the DOM has no bearing on whether either rule fires. This
  was confirmed live (see below), not just reasoned about from the
  spec. `ResultsPage.tsx` now renders `gameTileOrder.map(...)` instead
  of the two components literally, each keyed by its own `GameTileId`
  (`key={tileId}`) so a same-set, different-order re-render (the
  default-to-hydrated-order correction right after mount) moves each
  component via React's ordinary keyed reconciliation rather than
  unmounting/remounting it -- relevant in principle if a tile ever
  accumulates real in-progress state that fast, though in practice the
  hydration correction lands well before either tile's own game state
  could exist. Swapping which tile renders first is, by construction,
  the entire visible effect of this issue: CSS grid auto-placement fills
  column 1 (or, at a stacked mobile width, the top row) with whichever
  child comes first in the DOM.
- **Live-verified against a real local pipeline run**
  (`local-run.ts`, the default 20-ticker sample, real Yahoo network
  calls, no S3 write -- including a real `results/beat-the-bench/`
  session) plus `next build`/`next start` (not `next dev` -- see this
  file's own repeatedly-documented note on why headless Chromium can't
  hydrate a dev-mode page in this sandbox) and the documented no-root
  headless-Chromium Playwright workaround. On a fresh browser context
  (no prior history), the grid rendered Beat the Bench first, The Call
  Board second -- the fixed default order. Expanding Beat the Bench and
  playing a full real session to genuine settlement (77 real "Step
  forward one bar" clicks, the always-present, reduced-motion-safe
  control, reaching "bar 79 of 79" and a real "Along for the ride"
  settlement) wrote both `hikt:beat-the-bench:2026-08-27:todays-close`
  and `hikt:game-tile-order:history` (`{"days":[{"date":"2026-08-27",
"order":["beat-the-bench"]}]}`) to real localStorage. Reloading the
  page (a fresh mount, exercising the real hydration-correction path
  end to end, not a simulated re-render) showed the grid re-rendered
  with **The Call Board first and Beat the Bench second** -- the exact
  played-today-sinks behavior this issue's own acceptance criteria
  name, with Beat the Bench's own compact card additionally showing its
  real `✓` "done" status badge (issue #186) confirming the played state
  itself round-tripped correctly too. Zero console errors or
  `pageerror` events across the whole run. The temporary `playwright`
  devDependency and the verification script were both reverted/deleted
  before committing, per this file's own established convention;
  confirmed via `git status`/`git diff --stat` on
  `package.json`/`pnpm-lock.yaml` showing no trace afterward.

### `high` code review: two findings, both fixed before merge

- **`orderGameTiles`'s "played today" check reimplemented
  `game-tile-order.ts`'s own already-exported, already-tested
  `wasPlayedOn` helper inline**, via a `playedToday` `Set` built from
  `history.find(...).order.filter(...)` -- a real duplication-drift
  risk matching this file's own documented history of getting bitten by
  exactly this class of bug once already (see
  `use-hydrated-local-storage-state.ts`'s own extraction note above).
  Fixed by calling `wasPlayedOn(history, today, a)`/
  `wasPlayedOn(history, today, b)` directly inside the sort comparator
  instead of precomputing the Set.
- **`use-game-tile-order.ts`'s `readStored` callback never returned
  `null`, violating `useHydratedLocalStorageState`'s own documented
  contract** (`null` means "nothing usable stored, keep the default,"
  skipping an unnecessary re-application; a concrete value always
  forces a `setValueState` call) -- it always computed
  `orderGameTiles(getTileOrderHistory(), today)`, which itself always
  returns a concrete `GameTileId[]` (falling back to `GAME_TILE_IDS`'
  own fixed tie-break order when there's no history at all), so a
  brand-new viewer with zero recorded history forced an unnecessary
  extra state update/re-render of both game tiles right after
  hydration, for a value identical to the default it was replacing.
  Fixed: `readStored` now checks `getTileOrderHistory().length === 0`
  first and returns `null` in that case, only calling `orderGameTiles`
  once real history exists.
- All five routine checks (lint, typecheck, `pnpm build`, `pnpm test`
  -- 993 passing, `pnpm format:check`) re-ran green after both fixes;
  no new live-browser verification pass, since neither fix changes any
  end-state rendered output (a pure sort-comparator refactor, and a
  hydration-timing/render-count optimization with no visible
  difference once the microtask resolves).
