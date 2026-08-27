# Gamified hero + NYT-Games-style tiles -- reference assets

Design references for the "gamified hero" pass agreed in chat (August
2026), backing GitHub issues filed from this plan. Follows the earlier
`docs/design/ui-simplification-2026-08/` pass (issues #161-166) -- read
that folder's README too if you haven't already, since this pass builds
directly on top of what it shipped (the daily hero, the collapsed CTA
cards).

- `before-desktop.png` / `before-mobile.png` -- the real, currently-shipped
  daily hero + CTA cards (1440x900 and 390x844), captured against a real
  local pipeline run.
- `after-desktop-default.png` -- the proposed fixed-height "showcase" box
  in its default state: statement/figures/tickers settled, chart hidden,
  a "Watch it happen" button in its place.
- `after-desktop-revealed.png` -- the same box after clicking "Watch it
  happen": the chart has replaced the button in the exact same slot, same
  box height throughout.
- `after-mobile-default.png` -- the default state at 390px, including a
  4-digit starting amount wrapping cleanly onto two lines (a real bug
  this pass found and fixed -- see the mockup file's own CSS comments
  near `.showcase-figures`).
- `mockup-gamified-hero.html` -- a standalone, static HTML/CSS/JS mockup
  (no React, no build step) of the proposed showcase + two NYT-Games-style
  game tiles. **Illustrative only**: it establishes layout, animation
  timing, the seeded-per-day determinism, and the chart's click-to-reveal
  behavior -- it is not real component code, and its exact pixel values
  aren't sacred. 99% visual fidelity to it is the bar, not 100%. Its own
  `rollDay()`/`mulberry32()` JS is a mockup-only stand-in for what the
  real app should do with `packages/core`/`lib/daily-challenge.ts` and
  the already-shipped `mulberry32` in `lib/beat-the-bench-percentile.ts`
  -- see the issues themselves for exactly which real functions to reuse.

Pixel-perfect fidelity to these images isn't the goal -- close enough
that a reviewer glancing at both side by side agrees they match is.
