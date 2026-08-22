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

## Importing `@hadiknowntrades/core`

Import it by its normal package specifier
(`from "@hadiknowntrades/core"`) - that works fine with `next build`'s
Turbopack bundler. If a _new_ `Module not found: Can't resolve
'./something.js'` error ever comes from inside `packages/core/src/...`
during a build, don't add a `.js` extension or a workaround here first -
see `packages/core/CLAUDE.md`'s "Internal imports" note: the fix belongs
in `packages/core`'s own relative-import style, not in how this app
imports the package.
