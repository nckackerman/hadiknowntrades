# Daily hub, condensed (2026-08)

Design reference for three build issues that condense the landing page
into more of a daily-game hub, following a research pass against real
daily-game sites (NYT Games' hub, Puzzmo, Wordle, Duolingo, and a few
indie stock-market Wordle clones -- Stockle, Wallstreetle, NQdle) plus
an independent staff-designer + staff-PM review of the resulting
mockup.

**99% visual/behavioral fidelity to `mockup-daily-hub-condensed.html`
is the bar for the three build issues below -- not pixel-perfect, but
the same structure, spacing, and interaction timing.** Open that file
directly in a browser: it's a real, interactive HTML/CSS/JS mockup (not
React, not shipped code) with a "State" toggle (Fresh day / Played
today / Returning streaker) and a "Width" toggle (Desktop / Mobile) in
its own toolbar row -- that toolbar is mockup-only chrome, not part of
the design itself, and isn't in any of the screenshots below.

## What changed, and why

- **The "Today, so far" status rail is gone.** It mostly repeated
  information already on the two game cards below it (Beat the Bench's
  own status line already said "Not played yet today"; The Call Board's
  already said "0 of 3 called this week"). That status now lives as a
  small at-a-glance badge in each card's own top-right corner --
  reusing the same done/partial/todo glyph vocabulary
  `DailyRitual.tsx`'s `STEP_STYLES` already defines, just relocated
  onto the card it describes. Beat the Bench also grows a small
  win/loss/tie "recent form" strip once there's history to show;
  The Call Board grows the same four-outcome history strip
  (`callOutcomeFor`'s own exact/right-direction/near-miss/far-miss
  classification, unchanged) in miniature.
- **The shareable recap collapses into a single-line disclosure**
  (locked: "🔒 Today's recap unlocks after you play Beat the Bench";
  unlocked: "✓ Today's recap is ready — Copy"), matching this app's own
  existing "Explore other windows"/"More options" disclosure
  convention instead of staying a large, always-expanded panel.
- **The hero's date moved out of the showcase box and up next to the
  page title** (a small pill, "YESTERDAY · AUG 27, 2026"), one line
  shorter inside the box as a result.
- **The explanatory tagline paragraph under the title is gone.** The
  full methodology/disclaimer is unchanged and still one click away
  inside "Explore other windows" (true since issue #165) -- this pass
  adds a short footer line pointing at it, specifically so removing the
  tagline doesn't leave a first-time visitor with zero pre-scroll
  framing at all (a real risk the PM review flagged explicitly).
- **A "pop" visual pass on the two real game tiles**: a soft circular
  icon plate behind each emoji, a colored ambient glow under each tile
  matching its own hue (amber/blue -- both already the exact production
  gradients, unchanged), and chunky "juicy" press-buttons (a solid
  bottom edge that flattens on click) on "Watch it happen" and "Copy
  recap".

## What's deliberately NOT in scope here

**The Order and The Lineup — two new placeholder games explored earlier
in this same design pass — are not part of these issues.** An
independent staff-designer + staff-PM review (run specifically to
pressure-test this pass before it became build issues) recommended
parking both: neither has a real daily-selection/curation mechanism
designed yet (which 5 stocks make a fair ranking puzzle; which 5
three-letter tickers make a fair mystery set), and the PM review's
sharpest finding was that a 3-letters-only constraint structurally
excludes almost every S&P 500 company a casual player would recognize
(AAPL, MSFT, GOOGL, AMZN, META, NVDA, TSLA are all 4-5 letters). See
the backlog issue for the full writeup -- this reference and the three
build issues below only cover the two real, already-shipped games
(Beat the Bench, The Call Board) plus the hero/ritual condensation.

## Files

- `mockup-daily-hub-condensed.html` -- the interactive mockup itself.
- `before-desktop.png` / `before-mobile.png` -- the current shipped
  page (as of the hero-grow-on-reveal + Beat-the-Bench-collapsible
  change, merged just ahead of this reference) for direct comparison.
- `after-desktop-fresh.png` / `after-mobile-fresh.png` -- the target
  design, first-time-visitor state (nothing played, no history).
- `after-desktop-returning.png` / `after-mobile-returning.png` -- the
  target design with a returning player's history on every surface
  (both cards' badges/streak strips, the unlocked recap).
- `after-desktop-revealed.png` -- the hero after "Watch it happen" is
  clicked, confirming the box still grows in place to fit the chart
  (unchanged behavior from the already-shipped grow-on-reveal design).
