# Issue #61 ("Epic: Better UI") scoping

Research pass over the 6 candidates + 1 standalone quick-win listed in issue
#61. Each candidate was checked against the real current code, not taken on
the epic's one-paragraph description alone. Result: **5 issues to file**, one
candidate dropped (didn't hold up under investigation, see its own section),
plus the standalone quick-win carried through unchanged. Nothing here has
been created on GitHub -- these are drafts for a manager to review and `gh
issue create`.

---

## Issue 1: Mobile layout pass for the top controls

### Full agent-ready issue body

```markdown
Title: Mobile layout pass for the top controls

## Goal

Verify and fix how the page's controls row and each result branch's header
row lay out at real mobile widths (~360-430px) -- right now nothing has been
screenshot-verified at mobile widths since starting capital (#15) landed
inside the same rows as day/mode switching (#13/#28), and the epic's own
premise (three stacked rows) doesn't match the actual DOM -- see Background.

## Background

- **The epic issue describes "three selector rows... plus the starting
  capital input all stack always visible" -- that's not the current
  structure.** `ResultsPage.tsx:117-122` renders `RangeSelector`, "or",
  `CustomRangeSelector`, and `ModeToggle` as siblings in **one** flex-wrap
  row (`className="flex flex-wrap items-center gap-3"`, line 117), not three
  separate rows -- Tailwind's `flex-wrap` already lets them wrap onto
  multiple lines on narrow viewports, it isn't unhandled. `StartingCapitalInput`
  isn't in that row at all -- it renders inside `ResultsPanel.tsx`, paired
  with the hero-stat block via `justify-between` (window branch:
  `ResultsPanel.tsx:284-297`; intraday-daily branch:
  `ResultsPanel.tsx:502,545-551`), and in the intraday branch it shares that
  same row with `DaySelector` too (`ResultsPanel.tsx:552-558`).
- **The real, unverified risk**: on a ~375px viewport, `ResultsPage.tsx`'s
  controls row (up to 4 items: 6 range pills, an "or", a `<select>`, a
  2-pill mode toggle) wraps to multiple lines, and separately
  `ResultsPanel.tsx`'s own header row (hero stat block + starting-capital
  input + day selector, in the intraday branch) _also_ wraps via its own
  `flex-wrap` (`ResultsPanel.tsx:502`) -- nobody has confirmed via an actual
  rendered screenshot (per `apps/web/CLAUDE.md`'s "Headless-browser
  screenshot verification" section -- jsdom has no layout engine, so this
  needs a real browser) how many lines of controls now stack above the
  hero figure on first paint, or whether any control gets visually cramped.
- Use the throwaway-debug-route technique documented in
  `apps/web/CLAUDE.md` (no local `RESULTS_BUCKET`/AWS creds in this
  environment) to render `ResultsPage` or `ResultsPanel` with realistic
  props and screenshot at a mobile viewport width before making any change,
  so the actual problem (if any) is diagnosed from evidence, not assumption.

## Scope

- Screenshot-verify the current layout at a real mobile width (~375px) in
  both the window-model and intraday-daily-model branches, before touching
  any code.
- If the screenshot confirms a real problem (controls pushing the result
  below the fold, a cramped/overlapping control), fix it with layout-only
  changes to `ResultsPage.tsx`'s controls row and/or `ResultsPanel.tsx`'s
  header rows -- e.g. tighter mobile spacing, reordering, or (implementer's
  call, left open the same way issue #31 left its tone decision open)
  collapsing less-essential controls (custom-anchor picker, mode toggle)
  behind a `<details>` "More options" disclosure on narrow viewports only,
  matching the disclosure pattern `PortfolioChart.tsx`'s own "View chart
  data as a table" and `AboutSection.tsx`'s "Methodology & assumptions"
  already establish.
- No functional/prop changes to `RangeSelector`/`CustomRangeSelector`/
  `ModeToggle`/`StartingCapitalInput`/`DaySelector` themselves -- this is a
  wrapper/layout change in the two parent components only.
- Re-screenshot after the fix to confirm the actual improvement, same
  viewport.

## Out of scope

- No redesign of any individual control's own visual style.
- No change to desktop/tablet layout -- this issue is mobile-width only.
- If the screenshot shows the current layout is already acceptable, this
  issue should conclude with that finding documented (and no-op layout
  changes), not a change forced to justify the issue.

## Acceptance criteria

- [ ] A real-browser screenshot at ~375px width exists (before) showing the
      current controls-row + header-row layout for both branches.
- [ ] If a real problem is confirmed, a layout fix lands and a second
      screenshot (after) confirms the improvement.
- [ ] No behavioral change to any control -- range/anchor/mode/day
      selection and starting-capital editing all still work identically.
- [ ] Lint, typecheck, `pnpm build`, `pnpm test`, `pnpm format:check` all pass.
```

### Delegation mode

**Straight to implementation** -- narrow, layout-only, no schema/API touch.
The one embedded judgment call (whether/how to collapse secondary controls
behind a disclosure) is explicitly left open in Scope with a documented
precedent to follow, the same way issue #31 left its tone decision open for
the implementer -- not blocking, not ambiguous enough to need a
plan-first pass.

### Files touched

`apps/web/src/components/ResultsPage.tsx` (controls row, ~lines 107-137),
`apps/web/src/components/ResultsPanel.tsx` (both header rows: window branch
~lines 281-298, intraday-daily branch ~lines 500-560).

---

## Issue 2: First-visit onboarding / empty-state explainer

### Full agent-ready issue body

```markdown
Title: First-visit onboarding / empty-state explainer

## Goal

A dismissible, one-line intro shown above the results for a first-time
visitor, framing what the page is before they land mid-result with no
context.

## Background

- `ResultsPage.tsx:18` sets `DEFAULT_RANGE: PresetRange = "1Y"` -- confirmed:
  a first-time visitor with no `?range=`/`?anchor=` in the URL lands
  directly on a fully-resolved 1Y result (e.g. "$20 -> $472K") with no
  framing beyond the one-line `<p>` under the `<h1>`
  (`ResultsPage.tsx:112-115`, "A hindsight toy, not investment advice...").
  `AboutSection.tsx`'s fuller methodology/disclaimer exists but sits at the
  very bottom of the page (`ResultsPage.tsx:135`), unlikely to be the first
  thing read.
- This app already has an established, working pattern for exactly this
  shape of feature -- a dismissible, localStorage-persisted, per-visitor
  preference -- see `apps/web/CLAUDE.md`'s "localStorage pattern" section:
  a thin feature-specific storage module (own namespaced key prefix, e.g.
  `hikt:onboarding-dismissed`, following `daily-guess-storage.ts`'s
  `hikt:daily-guess:` / `use-starting-capital.ts`'s `hikt:startingCapital`
  precedent) built on `lib/local-storage.ts`'s `readLocalStorage`/
  `writeLocalStorage` (never `window.localStorage` directly), plus a
  `"use client"` hook reading it once via a `useState` initializer.
- **Hydration-safety wrinkle to carry over from the existing precedent**:
  `use-starting-capital.ts`'s own note documents that reading
  `localStorage` synchronously during the initial render (rather than
  deferring the "dismissed" correction into a `queueMicrotask`/effect after
  mount) risks a hydration mismatch. Unlike `use-daily-guess.ts` (safe
  because it's only ever mounted inside `ResultsPanel`'s client-only
  `success` branch), a page-level banner mounted unconditionally on the
  root page _can_ render during SSR -- so this needs the
  `use-starting-capital.ts`-style "always start visible, correct to
  dismissed after mount" approach, not the `use-daily-guess.ts`-style
  "safe to read synchronously" shortcut. Read both hooks before
  implementing.

## Scope

- A new dismissible banner/callout component (e.g. `OnboardingIntro.tsx`)
  rendered in `ResultsPage.tsx`, above (or as part of) the header, framing
  the page in one or two sentences (e.g. what "hindsight, 3 trades, $20" means)
  with a dismiss control.
- A new storage module (`lib/onboarding-storage.ts` or similar, following
  `daily-guess-storage.ts`'s two-layer shape) + a `"use client"` hook,
  built on `lib/local-storage.ts`.
- Once dismissed, never shows again on that browser (no re-prompt logic
  needed -- a single boolean flag, not a keyed/versioned state like the
  daily-guess feature needs).

## Out of scope

- No onboarding beyond a single dismissible line/callout -- no multi-step
  tour, no modal.
- No change to `DEFAULT_RANGE` or first-load fetch behavior.

## Acceptance criteria

- [ ] A first-time visitor (no stored dismissal) sees the intro banner
      above the results.
- [ ] Dismissing it hides it immediately and it stays hidden across a page
      reload (verified live, not just via unit test, the same way
      `use-starting-capital.ts`'s own reload verification was done).
- [ ] No hydration-mismatch console warning on first load (server and
      client's first render agree).
- [ ] Lint, typecheck, `pnpm build`, `pnpm test`, `pnpm format:check` all pass.
```

### Delegation mode

**Straight to implementation** -- narrow, well-precedented (two existing
localStorage features to copy the shape of), no product ambiguity about
what "dismissible intro" means. The hydration-safety wrinkle is a real
technical trap but a documented, already-solved one (`use-starting-capital.ts`),
not a design question.

### Files touched

New: `apps/web/src/components/OnboardingIntro.tsx`,
`apps/web/src/lib/onboarding-storage.ts`,
`apps/web/src/lib/use-onboarding-intro.ts` (naming indicative). Edited:
`apps/web/src/components/ResultsPage.tsx` (mount point, near the header,
~lines 107-123).

---

## Issue 3: Range/anchor switch loading transition

_(Renamed and re-scoped from the epic's "Micro-interaction polish on
range/mode switching" -- see Background for why "mode switching" was
dropped from the title/scope.)_

### Full agent-ready issue body

```markdown
Title: Range/anchor switch loading transition

## Goal

Soften the abrupt skeleton-to-content flash when switching preset range or
custom-anchor month -- the one real "just swaps content" gap this app still
has. Mode and day switching already get a smoother, existing transition and
are explicitly out of scope -- see Background for why.

## Background

- **The epic's premise ("switching ranges or mode currently just swaps
  content") is only half true -- checked both paths directly:**
  - **Range switching is the real gap.** `useFetchResultsState`
    (`lib/use-results.ts:74-140`) resets state to `{status: "loading"}`
    synchronously the moment its `url` input changes
    (`lib/use-results.ts:86-89`) -- since `useResults(range)` builds its URL
    from `range` alone (`lib/use-results.ts:149-153`), every range switch
    (and, by the same mechanism, every custom-anchor switch via
    `useCustomResults`) unmounts the success tree, mounts
    `ResultsPanel.tsx`'s `LoadingSkeleton` (`ResultsPanel.tsx:121-134`) for
    the real network round-trip, then unmounts that and mounts the new
    success tree. No transition softens either handoff today.
  - **Mode switching already has a real transition and needs none added.**
    `ResultsPage.tsx`'s `selectMode` (line 101-105) only ever sets `?mode=`
    -- it never touches the URL `useResults`/`useCustomResults` fetch from,
    so switching mode causes **no refetch and no loading state at all**: the
    already-fetched result's `longShort` variant is selected instantly
    (`selectVariant`, `ResultsPanel.tsx:79-81`), and `HeroStat`'s `heroKey`
    is deliberately keyed on `mode` (`ResultsPanel.tsx:538` /
    `ResultsPanel.tsx:684`) specifically so a mode switch remounts `HeroStat`
    and replays its count-up reveal (issue #35/#36) -- already a genuine,
    existing "continuous exploration" transition, not a bare swap.
  - **Day switching is likewise already instant and already gets the same
    reveal.** Selecting a day just changes which already-fetched
    `IntradayDayResult` `activeDay` (`ResultsPanel.tsx:391-396`) points to
    -- no fetch, no loading state -- and `heroKey` is keyed on
    `activeDay.date` too (`ResultsPanel.tsx:538`), so it gets the same
    remount-and-reveal treatment.
- So the only genuinely bare "loading skeleton -> new numbers" swap left is
  the range/custom-anchor fetch-triggered one.

## Scope

- Soften the `LoadingSkeleton` <-> success-tree handoff specifically for a
  range or custom-anchor switch -- e.g. a brief CSS fade-in applied to the
  success tree's outer wrapper on mount (following the same plain-CSS-
  keyframe, no-library convention `globals.css`'s `confetti-fall` keyframe
  already establishes for `CelebrationBurst.tsx`), or a comparable
  lightweight transition. Respect `prefers-reduced-motion` the same way
  `should-celebrate.ts`/the confetti keyframe's own media-query guard
  already do -- reuse `lib/prefers-reduced-motion.ts` rather than adding a
  second check.
- Scope this to `ResultsPanel.tsx`'s three success-branch wrappers
  (`"window"`, `"custom-window"`, `"intraday-daily"`) and, if needed, a new
  `globals.css` keyframe.

## Out of scope

- Mode switching and day switching -- both already transition via
  `HeroStat`'s existing keyed-remount reveal (see Background); adding a
  second, different transition mechanism on top would fight that existing
  one rather than complement it.
- `LoadingSkeleton`'s own appearance/shape -- unchanged.
- Any change to `use-results.ts`'s fetch/state-machine logic -- this is a
  presentation-only change layered on top of the existing states.

## Acceptance criteria

- [ ] Switching preset range or custom anchor shows a visibly softened
      transition into the new result (screenshot or screen-recording
      verified, not just unit-tested -- jsdom has no real paint/animation
      timing).
- [ ] The transition is skipped/instant under `prefers-reduced-motion: reduce`
      (verified the same way `CelebrationBurst.test.tsx`/`should-celebrate.test.ts`
      already verify their own reduced-motion gating).
- [ ] Mode and day switching are visually unchanged by this issue.
- [ ] Lint, typecheck, `pnpm build`, `pnpm test`, `pnpm format:check` all pass.
```

### Delegation mode

**Straight to implementation** -- the underlying mechanism (CSS
keyframe + reduced-motion guard) is fully precedented by
`CelebrationBurst`/`confetti-fall`; the only open call (exact easing/
duration) is cosmetic and low-stakes, not a product decision.

### Files touched

`apps/web/src/components/ResultsPanel.tsx` (the three success-branch outer
wrapper `<div>`s -- window ~line 281, custom-window return via
`WindowResultBody`, intraday-daily ~line 500), `apps/web/src/app/globals.css`
(new keyframe, if that's the chosen mechanism).

---

## Issue 4: Touch discoverability for the chart

### Full agent-ready issue body

```markdown
Title: Touch discoverability for the chart

## Goal

Signal to a touch user that the portfolio chart responds to a tap -- it
already does (issue #44), but nothing on screen says so.

## Background

- `PortfolioChart.tsx` already wires the same `revealNearestPoint` handler
  to both `onPointerMove` and `onPointerDown` (`PortfolioChart.tsx:160-161`,
  issue #44's own fix for exactly this gap on the _interaction_ side) plus
  full keyboard arrow-key navigation (`PortfolioChart.tsx:165-175`) -- the
  functionality is real and complete.
- **The one static hint the component does show is desktop/keyboard-only,
  verified word-for-word**: the below-chart readout's idle state
  (`PortfolioChart.tsx:342`) reads _"Hover or focus the chart (use the
  arrow keys) to inspect a point."_ -- it never mentions tapping at all,
  despite tap being fully supported. A touch user reading this caption
  would reasonably conclude the chart isn't interactive for them.
- No other visual affordance (icon, pulse, first-tap hint) exists anywhere
  in the component today -- confirmed by reading the full file; the only
  other text near the chart is `ChartDataTable`'s "View chart data as a
  table" summary (`PortfolioChart.tsx:365`), unrelated to this gap.

## Scope

- At minimum, fix the idle caption (`PortfolioChart.tsx:342`) to mention
  tapping, not just hover/keyboard -- e.g. conditionally on touch support,
  or unconditionally with wording that reads naturally for both ("Tap,
  hover, or use the arrow keys to inspect a point.").
- Optionally (implementer's call, left open the same way issue #31 left its
  tone decision open): a lightweight one-time visual affordance (e.g. a
  brief pulse on the most recent marker, or a small persisted "you can tap
  this" hint) for touch users specifically. If built, it should reuse
  `lib/local-storage.ts` for any dismiss/seen-once state, following the
  established two-layer pattern (`daily-guess-storage.ts`), not a bespoke
  storage call.

## Out of scope

- No change to the actual tap/hover/keyboard interaction logic itself
  (issue #44 already covers that) -- this issue is purely about
  discoverability/affordance.
- No charting-library swap (explicitly rejected in the epic's own
  "Pushback" note).

## Acceptance criteria

- [ ] The idle caption no longer reads as keyboard/mouse-only -- a touch
      user reading it understands tapping works.
- [ ] If a visual affordance is added, it's screenshot-verified on both a
      touch-simulated and non-touch viewport, and respects
      `prefers-reduced-motion` if it animates.
- [ ] Lint, typecheck, `pnpm build`, `pnpm test`, `pnpm format:check` all pass.
```

### Delegation mode

**Straight to implementation** -- the minimum fix (caption wording) is a
one-line, zero-ambiguity change; the optional visual-affordance extension
has an open judgment call (whether to build it, and its exact form)
explicitly flagged in Scope for the implementer/reviewer, the same pattern
several already-shipped issues in this repo use.

### Files touched

`apps/web/src/components/PortfolioChart.tsx` only.

---

## Issue 5: Accessibility announcement for the guess-then-reveal moment

### Full agent-ready issue body

```markdown
Title: Accessibility announcement for the guess-then-reveal moment

## Goal

Announce the intraday-daily model's guess-to-reveal content swap to screen
reader users via `aria-live`, matching patterns this app already uses
elsewhere -- confirmed missing here, not assumed.

## Background

- `ResultsPanel.tsx`'s intraday-daily branch (`ResultsPanel.tsx:472-625`)
  gates `HeroStat`/`WorstCaseStat`/the methodology paragraph/
  `BenchmarkStat`/the "You guessed $X" line/`PortfolioChart`/the trade list
  behind `guess === null` (issue #34) -- submitting `DailyGuessForm` swaps a
  small form (`ResultsPanel.tsx:515-519`) for a large block of genuinely new
  content (`ResultsPanel.tsx:537-622`). **Checked the full file: no
  `aria-live` region anywhere in this branch covers that swap.** A screen
  reader user who submits the guess form gets no announcement that anything
  changed -- they'd have to manually navigate forward to discover the
  reveal happened at all.
- This app already has two working `aria-live` precedents to follow, not
  invent from scratch: `LoadingSkeleton`'s `aria-live="polite"` +
  `aria-busy="true"` wrapper (`ResultsPanel.tsx:123`), and
  `PortfolioChart.tsx`'s own hover-tooltip readout region
  (`aria-live="polite"`, `PortfolioChart.tsx:323`).
- **A real trap to avoid, already documented and already worked around
  once in this exact codebase**: `apps/web/CLAUDE.md`'s "Client-side
  animation" section explicitly warns not to wire `aria-live` to a
  per-frame animating value (`HeroStat`'s count-up spams assistive tech
  with every intermediate number) -- `HeroStat` avoids this via
  `aria-hidden`+a static `sr-only` twin instead. Whatever `aria-live`
  region this issue adds must announce the _fact of the reveal_ (e.g. "Result
  revealed" or a static summary), not be wired to `HeroStat`'s own animating
  figure.

## Scope

- Add an `aria-live="polite"` region (or equivalent, e.g.
  `role="status"`) covering the guess -> reveal transition in
  `ResultsPanel.tsx`'s intraday-daily branch, so the swap from
  `DailyGuessForm` to the real content is announced.
- Exact announcement wording/scope (e.g. just "Results revealed" vs. a
  richer static summary) is an implementer/reviewer judgment call, left
  open here the same way issue #31 left its own tone decision open --
  constrained only by the "don't wire it to an animating value" rule above.
- Verify with a real screen-reader-adjacent check (e.g. asserting the live
  region's role/content in a component test, per this app's existing
  `aria-live` test patterns) plus a manual read of the rendered DOM
  transition, not assumption alone.

## Out of scope

- No change to `HeroStat`'s own animation/`aria-hidden`/`sr-only`
  handling -- already correct, per the trap noted above.
- No change to the window model (5Y/MAX) -- it has no guess-then-reveal
  gate at all (issue #34's own scope).
- No broader accessibility audit of the rest of the app -- this issue is
  scoped to this one flow, per the epic's own framing of it as "the app's
  one genuinely interactive/stateful flow, most likely to have a gap."

## Acceptance criteria

- [ ] Submitting a guess (or loading a day with an already-stored guess)
      triggers an `aria-live` announcement of the reveal, verified in a
      component test.
- [ ] The announcement is not wired to any per-frame animating value.
- [ ] No regression to the existing guess-gate behavior or any other
      `ResultsPanel.test.tsx` coverage.
- [ ] Lint, typecheck, `pnpm build`, `pnpm test`, `pnpm format:check` all pass.
```

### Delegation mode

**Straight to implementation** -- two working `aria-live` precedents
already exist in this exact codebase to copy, and the one real trap
(don't wire it to an animating value) is already documented with a known
solution shape. The only open call (exact wording) is explicitly flagged
as a judgment call, not a blocker.

### Files touched

`apps/web/src/components/ResultsPanel.tsx` (intraday-daily branch, ~lines
500-624).

---

## Dropped candidate: "Visual hierarchy pass across the stat blocks"

**Not written up as an issue.** The epic's premise -- "hero stat, worst-case
contrast stat, benchmark sentence, and the narrative trade list currently
read at similar typographic weight" -- does not hold up against the actual
code:

- `HeroStat.tsx:107`: `text-[clamp(2.5rem,6vw,4rem)] font-semibold` (40-64px).
- `WorstCaseStat.tsx:40`: `text-xl ... sm:text-2xl` (20-24px), **fixed
  `--text-muted` tone**, explicitly _not_ the gain/loss color `HeroStat`
  uses (`WorstCaseStat.tsx:9-26`'s own doc comment).
- `BenchmarkStat.tsx:71`: plain `text-sm text-secondary` (14px) prose, no
  bold/coloring at all (`BenchmarkStat.tsx:52-54`'s own doc comment:
  "deliberate simplicity... not itself a signal").
- `TradeList.tsx:65`: `text-sm` (14px) prose, but inside its own bordered
  `rounded-lg border ... bg-[var(--surface-1)]` container -- visually
  contained/set apart from the bare-paragraph `BenchmarkStat` above it,
  not just differently sized.

That's already a real four-tier scale (64px bold -> 24px muted -> 14px bare
prose -> 14px prose-in-a-box), and per `apps/web/CLAUDE.md`'s own notes,
each tier's "reads as secondary/muted/contextual, not competing" property
was individually screenshot-verified when it shipped (issue #31's
`WorstCaseStat`, issue #12's `BenchmarkStat`, issue #45's multiplier
badge). The epic's stated problem appears to already be solved by work
that landed after the epic's planning round ran. No concrete layout
defect was found to justify a new issue. If a real problem surfaces later,
it needs to start from an actual screenshot showing what reads wrong --
this is not something to speculatively re-scope without that evidence.

---

## Standalone quick win: Chart point-label collision fix

_(Carried through from issue #61 largely unchanged -- already well-scoped
there, confirmed real by reading the code.)_

### Full agent-ready issue body

```markdown
Title: Fix portfolio chart point-label collision for closely-spaced trade dates

## Goal

Prevent two trade markers' text labels from visually overlapping when their
dates land close together on the chart's x-axis.

## Background

- `PortfolioChart.tsx:270-305` renders each trade open/close marker with two
  lines of text (`eventLabelVerb(event)` + ticker, then date + price)
  positioned at a fixed offset above or below the point
  (`isAbove = event.type === "open"`, `labelY = isAbove ? p.y - 14 : p.y +
24`, line 272-273).
- **Confirmed by reading the full component: there is no collision
  avoidance between adjacent markers' labels at all.** `anchorFor`
  (`PortfolioChart.tsx:70-74`) only adjusts a label's `text-anchor`
  (start/middle/end) to keep it from running past the plot's left/right
  edge -- it has no awareness of any other marker's position. When two
  trades' dates are close together on the x-axis (e.g. a sell a few days
  after a buy, or one trade's close immediately followed by the next
  trade's open), their labels can and do overlap, since both simply render
  at their own point's fixed vertical/horizontal offset regardless of
  neighboring labels.

## Scope

- Add collision detection/avoidance between adjacent event markers' labels
  -- e.g. detecting when two markers' `x` positions are within some pixel
  threshold and shifting one label further (more vertical offset, or
  alternating stacking), or switching to a leader-line style label for the
  colliding pair. Implementer's choice of exact mechanism, constrained by:
  keeping the existing "no charting library" approach (plain SVG, per this
  file's own header comment and the epic's own "Pushback" note against
  reintroducing one).
- Cover the fix with a test asserting no two labels' bounding regions
  overlap for a synthetic close-together-trades fixture.

## Out of scope

- No change to marker/line/gridline rendering, hover tooltip, or the
  accessible data-table fallback (`ChartDataTable`) -- purely the direct
  on-chart text labels.
- No charting-library swap.

## Acceptance criteria

- [ ] A synthetic fixture with two trade dates ~4 days apart (the epic's
      own example) renders with no visually overlapping label text
      (screenshot-verified, both light and dark themes, per this app's
      established verification convention).
- [ ] Existing `PortfolioChart.test.tsx` coverage still passes; a new test
      covers the collision case specifically.
- [ ] Lint, typecheck, `pnpm build`, `pnpm test`, `pnpm format:check` all pass.
```

### Delegation mode

**Straight to implementation** -- isolated to one file, a well-understood
bug (missing collision math) with no product ambiguity about the desired
end state (labels shouldn't overlap). Already flagged as "ready today" by
the epic itself.

### Files touched

`apps/web/src/components/PortfolioChart.tsx` only.

---

## Sequencing & Overlap

### File-touch matrix

| Issue                              | Files touched                                                          |
| ---------------------------------- | ---------------------------------------------------------------------- |
| 1. Mobile layout pass              | `ResultsPage.tsx`, `ResultsPanel.tsx` (header rows, both branches)     |
| 2. Onboarding intro                | `ResultsPage.tsx` (new region), new files only otherwise               |
| 3. Range/anchor loading transition | `ResultsPanel.tsx` (outer wrapper divs, all 3 branches), `globals.css` |
| 4. Touch discoverability           | `PortfolioChart.tsx`                                                   |
| 5. Guess-reveal aria-live          | `ResultsPanel.tsx` (intraday-daily branch)                             |
| Quick win. Label collision         | `PortfolioChart.tsx`                                                   |

### Real conflicts (same file, parallel PRs would fight)

- **Issues 1, 3, and 5 all edit `ResultsPanel.tsx`, and two pairs overlap in
  the _same region_, not just the same file:**
  - Issue 1 (mobile layout) restructures the intraday-daily branch's top
    row wrapper (`~lines 500-560`).
  - Issue 5 (aria-live) wraps the same branch's reveal content
    (`~lines 500-624`) in a live region.
  - Issue 3 (loading transition) adds a fade-in class to each branch's
    _outer_ wrapper `<div>`, including the same intraday-daily branch.
  - Running these three in parallel worktrees would produce real merge
    conflicts, not just same-file churn. **Recommended order: 5 -> 1 -> 3**
    (aria-live is the smallest/most self-contained change to land first;
    the mobile layout restructure should land on top of it; the fade-in
    transition should be layered onto the already-restructured wrapper divs
    last, so it doesn't get rebased mid-restructure).
- **Issues 4 and the quick win (label collision) both edit
  `PortfolioChart.tsx`**, and issue 4's minimum-scope fix (the idle caption)
  is independent of the label positions the quick win changes, but any
  optional visual-affordance extension issue 4 builds could plausibly touch
  the same marker-rendering block. **Recommended order: quick win first**
  (it's a pure bug fix, no reason to block it, and the epic itself flags it
  as ready today), **then issue 4** rebased on top.
- **Issues 1 and 2 both touch `ResultsPage.tsx`**, but in different regions
  (issue 1: the existing controls row, ~lines 117-122; issue 2: a new
  banner inserted near the header, likely above or within lines 107-123) --
  low real conflict risk, safe to run in parallel with a normal rebase, not
  called out as needing strict sequencing.

### Fully independent (safe to build in parallel right now)

- **Issue 2 (onboarding)** is the most independent: touches `ResultsPage.tsx`
  only in a new, additive region, plus entirely new files. Safe in parallel
  with everything.
- The **quick win (label collision)** and **issue 5 (aria-live)** don't share
  any file and can run fully in parallel with each other.
- The **quick win** and **issue 2** don't share any file.

### Recommended build/batching plan

No single issue here is oversized enough to need splitting before
delegation -- each is a single PR's worth of work, consistent with this
repo's existing issue sizes.

**Wave 1 (3 parallel workers, zero real conflicts):**

- Quick win: chart point-label collision fix
- Issue 5: guess-reveal aria-live announcement
- Issue 2: first-visit onboarding intro

**Wave 2 (after Wave 1 merges; 2 parallel workers):**

- Issue 4: touch discoverability (rebases cleanly on the quick win's now-merged
  label logic)
- Issue 1: mobile layout pass (rebases cleanly on issue 5's now-merged
  aria-live wrapper)

**Wave 3 (solo, after Wave 2 merges):**

- Issue 3: range/anchor loading transition (wants issue 1's already-
  restructured wrapper divs to add its fade-in class to, rather than
  fighting a concurrent restructure)

All six issues are "straight to implementation" per the delegation-mode
calls above -- none needs a plan-first + independent-review pass. The
dropped "visual hierarchy" candidate needs no delegation at all (not being
filed); if it resurfaces later it should start from a concrete screenshot,
not another scoping pass.
