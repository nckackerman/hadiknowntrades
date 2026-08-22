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
  day's trades. Both trade-list components share row markup via
  `TradeRow.tsx`.

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
