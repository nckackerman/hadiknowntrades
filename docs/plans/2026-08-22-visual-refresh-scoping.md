# Custom date-range picker + dark mode + visual polish -- scoping

Planning session, 2026-08-22. Goal going in: "a flight-booking-style
calendar date-range picker" on top of the preset ranges, dark mode by
default, and general visual polish. Three parallel research passes (range
picker/data-flow, theming, backend data-granularity) plus a live
localhost:3000 screenshot pass (light and dark) grounded this before
writing anything. Result: **3 issues filed**, none of them what the
original one-line ask would have produced verbatim -- see each section
for why.

## Issue #75: Day-precision calendar picker for the custom start date

**The flight-booking framing already shipped once, in a deliberately
coarsened form.** Issue #11 ("Custom start-date anchor picker," closed,
merged as #58) is exactly this ask, and its own plan
(`docs/plans/issue-11-plan.md`) already researched and rejected a fully
free start+end, day-granularity picker: a day x day grid over a 21-year
window is ~14 million pairs, not nightly-recomputable, and there's no
durable store of raw daily closes to compute against on demand (the
pipeline fetches full history per ticker and discards it after each
run). What shipped instead: a month-granularity start anchor (`<select>`
of 252 options), end pinned to "today."

Presented three framings to the user (day-precision start only /
free start+end / coarse-both-endpoints); **chose day-precision start,
end still pinned to "today"** -- the smallest step that gets a real
calendar UI without reopening the 14-million-pair problem #11 already
closed. Filed as #75, scoped as _superseding_ #11's month system
end-to-end (data model, S3 keys, UI), not adding a third parallel option.

The one real open risk carried into the issue: scaling the anchor set
~21x (252 monthly -> ~5,292 trading-day anchors) is unverified against
the pipeline's 15-minute Lambda budget -- the 252-anchor baseline (154s,
431.5KB) doesn't linearly guarantee the daily-anchor number fits. #75's
acceptance criteria require a live benchmark before the schema/S3-key
change lands, with three documented fallbacks (raise write concurrency,
shrink the lookback window, or split the pipeline into two invocations)
if it doesn't. Flagged as plan-first, not straight-to-implementation, for
that reason.

## Issues #76 + #77 (milestone "Dark mode & visual refresh")

Explored current theming before proposing anything: `globals.css` has
**zero theme infrastructure beyond a bare `prefers-color-scheme` media
query** -- no toggle, no class, no stored preference, no `next-themes`.
Dark values already exist and render correctly (live-verified this
session via a real headless-Chromium screenshot with `colorScheme:
"dark"` against `localhost:3000`) -- the gap is purely "not the default
for an OS-light visitor," not "doesn't exist yet."

Presented three scope options for "dark by default" (dark-always-no-toggle
/ dark-default-with-toggle / dark-default-respecting-explicit-light-OS-pref);
**user chose dark-always-no-toggle** -- simplest, and consistent with
this app's "learning exercise, not production" framing in the root
`CLAUDE.md`. Filed as **#76**: delete the light branch and its token
values entirely, promote dark to the only `:root` palette, fix
`global-error.tsx`'s independently-hand-copied light/dark swap
(`apps/web/CLAUDE.md` already flagged these two can drift).

**"Make it pop" was the vaguest part of the original ask, and most of
the obvious answers were already shipped** -- the "Better UI" (#61,
closed 5/5: #63-68) and "Reveal animation & visual delight" (#3, closed
2/2: #35-36) milestones already cover onboarding, mobile layout, loading
transitions, touch affordances, a11y announcements, chart label
collisions, count-up reveal, and confetti. #61's own scoping pass
explicitly investigated and _dropped_ a "visual hierarchy" polish
candidate for lack of a concrete defect. Rather than re-propose something
already covered or already rejected, took the live dark-mode screenshot
above as evidence and found a genuinely different, unaddressed gap: flat
near-black surfaces with no elevation (cards distinguished from
background only by a 1px border), a bare-stroke chart with no area fill,
and a flat-white hero number with no accent treatment on the app's one
emotional focal point. Filed as **#77**, scoped to those three concrete,
screenshot-justified items, explicitly out-of-scope on re-litigating
typographic hierarchy and on any UI/animation library (this app has
none, by consistent convention, and #77 keeps it that way).

**Sequencing**: #76 before #77 -- polish should style the final,
sole dark palette, not a soon-to-be-deleted light branch too. #75 is
independent of both (different files, different subsystem) and can run
in parallel.

## Drive-by fix (not a filed issue)

Root `CLAUDE.md`'s "backlog-labeled issues (#11-#15)" line was stale --
the backend-granularity research pass surfaced that #11, #12, #13, #15,
#31-#34 have all since shipped (closed) despite still carrying the
`backlog` label, a label-hygiene gap rather than a live scope signal.
Only #14 (Variable position sizing) is genuinely open. Corrected the
`CLAUDE.md` line in place rather than filing an issue for a one-line doc
fix; the underlying label-hygiene gap across those 8 closed issues was
noted but not touched -- unrelated to today's ask and not something to
silently bulk-edit without asking.
