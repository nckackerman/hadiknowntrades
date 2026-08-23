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
- `"intraday-daily"` (1W/1M/3M/1Y, 1W since issue #60): a `DaySelector` (plain `<select>`, not
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

## Custom start-date anchor picker (issue #11)

`GET /api/results?anchor=YYYY-MM` is the same route as `?range=...`
(`app/api/results/route.ts` branches on which query param is present),
not a second route file -- see `docs/plans/issue-11-plan.md`'s section
1.5 for why this differs from the (deferred) live-compute design's own
recommendation of a genuinely separate route: once a custom anchor is
_also_ just a precomputed S3 read (the coarsened design this issue
actually shipped), there's no backing-logic/cache-semantics difference
left to justify a second route.

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
  `parseAnchorMonth` validates shape only
  (via `packages/core`'s `anchorMonthToDate`) -- it does **not** also
  check the parsed anchor against `customRangeAnchors(asOf)`'s current
  252-month window, since this route's own server-side "now" and the
  pipeline's last-run "now" can disagree by up to one anchor right around
  a month boundary; an anchor outside the actually-published set just
  falls through to the ordinary `not_found` 404 instead, same as any
  preset range not yet computed on a first-ever pipeline run.
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
  `RangeSelector`, same reasoning `DaySelector` already established (see
  "Two result models" above): up to 252 anchor options is far too many
  for pill buttons. Its leading, disabled placeholder option ("Choose a
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
  A new `useCustomResults(anchor: AnchorMonth | null)` hook
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
  only in which field identifies the result (`range` vs. `anchorMonth`),
  so `WindowResultBody` takes a structural `WindowLikeResult` (the fields
  it actually reads -- neither `range` nor `anchorMonth`) plus a
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
- **`CustomWindowResult.startDate` is the anchor's own literal calendar
  boundary** (e.g. `"2019-03-01"`), not forward-snapped to the nearest
  real trading day -- same convention `WindowResult.startDate` already
  follows for presets. The forward-snap is only ever visible in the
  actual `trades`/`benchmark` data (via the ordinary slicing filter every
  window already goes through), never a separate displayed field or UI
  affordance -- there was no missing/holiday-date UI work needed for this
  feature at all, unlike what the deferred live-compute design's own
  section 2 had planned for. See `packages/core/CLAUDE.md`'s "Custom
  date-range anchors" section for the full reasoning.

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
  `` `custom-${data.anchorMonth}-${data.dataAsOf}-${mode}` ``) so a mode
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
