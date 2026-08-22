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
- `"intraday-daily"` (1M/3M/1Y): a `DaySelector` (plain `<select>`, not
  a pill toggle like `RangeSelector` -- a window can hold ~252 trading
  days, too many for buttons) picks which day's `IntradayDayResult` to
  view, defaulting to the most recent day. Selected day is URL state
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
  `next/font` at all -- inline `style` props plus one small `<style>`
  tag for the `prefers-color-scheme: dark` swap, with the actual color
  values hand-copied from `globals.css`'s tokens rather than referenced
  (there's no shared `:root` to reference into). If `globals.css`'s
  `--status-critical`/`--background`/etc. values ever change, update the
  copies in `global-error.tsx` too -- nothing enforces that they stay in
  sync.
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
  (1M/3M/1Y, issue #28) and the route turns that into a 404 -- not an
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

## Daily guessing game (issue #34)

`ResultsPanel.tsx`'s intraday-daily branch (see "Two result models"
above) gates `HeroStat`, `PortfolioChart`, and the trade list behind a
`DailyGuessForm` prompt ("what do you think $20 turned into on
{date}?") for whichever day is currently active - the window model
(5Y/MAX) is untouched, since a whole-window result barely changes day to
day and was never a meaningful thing to guess against (see the issue's
own rationale). `DaySelector` and the day-picker row itself stay visible
throughout - browsing to a different day never requires guessing the day
you're passing through, only whichever day is currently selected when
its content would otherwise render.

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
