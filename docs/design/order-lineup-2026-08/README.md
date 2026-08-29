# The Order & The Lineup — design reference (Aug 2026)

Resolves issue #189's parked design gaps for the two remaining placeholder
tiles (`PlaceholderGameTile.tsx`, issue #197) with a real, played,
iterated-on interactive mock rather than a static drawing — the same
mistake issue #189 itself flags about the _original_ pre-park mockup
("a scratch artifact, not committed to this repo... rebuild from this
description rather than hunting for the original") is not repeated here:
**`mockup-order-lineup.html` in this folder is the real, complete,
self-contained mock**, open it directly in a browser to play both games
end to end with sample data.

Two independent specialist design passes (`spec-the-order.md`,
`spec-the-lineup.md`) did the first round of resolving issue #189's own
named gaps (daily-selection algorithm, attempt/guess budget, WCAG-safe
feedback glyphs, the streak-chip call, recap copy, rotation). The mock
was then hand-iterated against real human feedback through several more
rounds — those specs are the real reasoning behind most of what shipped,
but **three mechanics changed after the specs were written and are only
correct in the mock and this README, not in the spec files**:

1. **The Order's pool is Magnificent Seven only** (AAPL, MSFT, AMZN,
   NVDA, META, TSLA, and GOOGL), not the spec's original 240-name curated
   allowlist. 5 of the 7 are shown each day; a concrete pipeline
   algorithm for _which_ 5 still needs to be designed (see "What's left
   for the build issue" below) — the mock hardcodes one sample day.
2. **A locking mechanic**, not in either spec: the instant a slot in The
   Order scores exact, it's fixed in place for every remaining attempt
   that day — highlighted gold, its move controls replaced with a
   "★ Locked" badge — so later attempts only ever reorder what's still
   genuinely unresolved.
3. **The Lineup's guessing model is whole-board, not per-column**, and
   ticker length itself is now a hidden variable: columns can be real
   3- _or_ 4-letter tickers, every column always shows 4 slots regardless
   of the true length, and there is no explicit "reveal the length"
   affordance — a slot that never scores exact no matter what's tried is
   how a player discovers a column is shorter than 4. The player submits
   all 5 columns at once each round (not one column, one guess, repeat)
   against a 7-round budget (not 15 per-column guesses), and a shared
   "letters tried" tracker (a `Quordle`-style on-screen keyboard showing
   the single best result seen anywhere on the board for each letter)
   helps manage the added cross-column ambiguity.

## Screenshots

All captured from the real mock (`mockup-order-lineup.html`), Chromium,
1180px viewport unless noted — **these are the ~99%-visual-fidelity
target for the real build**, not just an illustration; match colors,
spacing, type, and the glyph/color feedback language pixel-for-pixel
where the mock and the real app's own design tokens already agree (they
should — the mock was built entirely from `globals.css`'s real token
values, not invented ones).

| file                                 | what it shows                                                                      |
| ------------------------------------ | ---------------------------------------------------------------------------------- |
| `screenshots/overview-desktop.png`   | Both games top to bottom, plus the 2x2 grid-context preview, at 1180px             |
| `screenshots/order-idle.png`         | The Order, fresh shuffle, no guesses yet                                           |
| `screenshots/order-inprogress.png`   | After one guess: 2 locked (gold), a mix of close/far glyphs in the history strip   |
| `screenshots/order-win.png`          | Solved in 1: every row locked gold, reveal list with real returns, streak stats    |
| `screenshots/order-lose.png`         | Out of guesses: partial locks, full reveal list, streak reset to 0                 |
| `screenshots/lineup-idle.png`        | The Lineup, fresh board, explainer text, empty "letters tried" tracker             |
| `screenshots/lineup-inprogress.png`  | After one round: 1 column locked green, exact/rowmatch/colmatch/absent all visible |
| `screenshots/lineup-win.png`         | All 5 solved: full green board, length recap line, guess-history log expanded      |
| `screenshots/lineup-lose.png`        | Budget exhausted: 1 solved, the rest revealed (dim "–" for the phantom 4th slot)   |
| `screenshots/overview-mobile.png`    | Full page at 390px — confirmed no horizontal overflow                              |
| `screenshots/lineup-idle-mobile.png` | The Lineup panel at 390px specifically (the tightest layout of the two)            |

## What's left for the build issue(s)

This mock proves the _interaction design_ end to end with sample data. A
real build still needs, per game:

- **A concrete, real-data-validated daily-selection algorithm** for the
  actual shipped pool (Mag 7 for The Order; the biggest-movers-among-3-
  and-4-letter-tickers rule already in `spec-the-lineup.md` for The
  Lineup, unaffected by the mechanic changes above) — pulled and checked
  against real recent trading days the way `spec-the-order.md`'s own
  now-superseded algorithm originally was, not just asserted.
- A new small nightly-written pipeline object per game (there is no
  existing precomputed data this can read from as-is — Mag 7 closes and
  the 3-/4-letter mover ranking are both new computations).
- Real client-side storage + streak tracking (both specs' own
  recommendation: a small gold streak stat inside the expanded panel
  only, never a badge on the collapsed tile — matching `CallBoard.tsx`'s
  own shipped precedent).
- Integration into `ResultsPage.tsx`'s existing game-tile grid, replacing
  `PlaceholderGameTile.tsx`'s two static exports in place (same grid
  position, same icons/gradient colors — those are already committed and
  unchanged).

See the two spec files for the full reasoning on accessibility, recap
copy, and rotation/repeat-avoidance — still accurate except where this
README says otherwise.
