# UI simplification pass -- reference assets

Design references for the "bare minimum daily-game landing" pass agreed
in chat (August 2026), backing GitHub issues filed from this plan. Not
itself a build issue -- just the images/mockup those issues embed so a
fresh agent can match the intended layout without re-deriving it from
prose alone.

- `before-desktop-fold.png` / `before-desktop-full.png` / `before-mobile-fold.png` --
  the real, currently-shipped landing page (1440x900 and 390x844,
  captured against a real local pipeline run).
- `after-desktop-fold.png` / `after-desktop-full.png` / `after-mobile-fold.png` --
  the proposed simplified landing, from `mockup-simplified.html` below.
- `after-desktop-expanded.png` -- the same mockup after clicking "Watch
  it happen," showing the chart's click-to-reveal state.
- `mockup-simplified.html` -- a standalone, static HTML/CSS mockup (no
  React, no build step) of the proposed landing. **Illustrative only**:
  it establishes layout, copy tone, and which pieces are separate
  sections vs. nested -- it is not real component code and its exact
  pixel values aren't sacred. 99% visual fidelity to it is the bar, not
  100%.

Pixel-perfect fidelity to these images isn't the goal -- close enough
that a reviewer glancing at both side by side agrees they match is.
