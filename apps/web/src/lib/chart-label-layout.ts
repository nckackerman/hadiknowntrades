// Vertical collision avoidance for PortfolioChart's trade marker labels
// (issue #68). Kept separate from the component, same reasoning
// chart-scales.ts's own header comment gives: the actual layout logic is
// the only genuinely tricky part, and it's unit-testable without
// rendering React/SVG at all.
//
// Each marker's label is two lines of text (a verb+ticker line, a
// date+price line) positioned at a fixed offset above ("open" events) or
// below ("close" events) its point. With no collision awareness, two
// markers whose dates land close together on the x-axis render with
// overlapping label text -- a common case in practice: a trade's close
// doesn't move the portfolio value (only the *next* open/close pair
// does), so a close event immediately followed by the next trade's open
// event often sit at nearly the same y *and* a small x gap.
//
// The fix: estimate each label's on-screen bounding box and greedily
// push a colliding label further from its own point, in the same
// direction it already points (an "above" label stays above, a "below"
// label stays below -- never flips to the opposite side of its point) --
// the "more vertical offset / stacking" mechanism issue #68 itself
// suggests, rather than a leader-line redesign.

/** SVG text has no layout-free way to measure real glyph widths outside
 * a live DOM (see apps/web/CLAUDE.md's jsdom getBoundingClientRect note
 * -- SVG elements report zero size under jsdom, and even a real browser
 * needs an actual mounted <text> to call getBBox on) -- these are a
 * deliberate per-character estimate, generous enough that a real
 * rendered label is never wider than what this predicts (avoiding
 * false negatives), calibrated against this app's own two font
 * sizes/weights (10.5px/600 for the primary line, 10px/400 for the
 * secondary line -- see PortfolioChart.tsx's marker <text> elements). */
const CHAR_WIDTH_PRIMARY = 6.4;
const CHAR_WIDTH_SECONDARY = 5.8;

/** Matches the fixed 13px gap PortfolioChart already renders between a
 * label's two lines (`labelY` and `labelY + 13`). */
const LINE_GAP = 13;

/** Rough half-height of one line of 10-10.5px text, used to pad a
 * label's bounding box above its first line's baseline and below its
 * second line's baseline. */
const LINE_HALF_HEIGHT = 7;

/** Matches PortfolioChart's own pre-#68 fixed offsets (`p.y - 14` /
 * `p.y + 24`) -- the "no collision" case must render identically to
 * before this issue, not just "close enough". */
const BASE_OFFSET_ABOVE = 14;
const BASE_OFFSET_BELOW = 24;

/** Vertical distance added per stacking level for a still-colliding
 * label -- comfortably larger than one label block's own height
 * (two lines, LINE_GAP + 2*LINE_HALF_HEIGHT ~= 27px) so a label pushed
 * out one level clears the block it collided with, not just its edge. */
const STACK_STEP = 28;

/** Safety valve against a pathological infinite loop -- mathematically
 * unreachable (each level moves strictly further from every previously
 * placed box, so an overlap-free level is always eventually found), but
 * this is a UI layout, not a proof, and a bounded loop costs nothing. */
const MAX_STACK_LEVELS = 20;

export type LabelAnchor = "start" | "middle" | "end";

export interface LabelLayoutInput {
  x: number;
  y: number;
  /** true for an "open" event (label above its point), false for a
   * "close" event (label below). */
  isAbove: boolean;
  anchor: LabelAnchor;
  primaryText: string;
  secondaryText: string;
}

export interface LabelBox {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/**
 * The vertical extent a label's box must stay within (in the same local
 * coordinate space as each input's own `y`) -- optional, since this
 * module has no inherent notion of a canvas. Without a bound, the
 * greedy stacking loop below has nothing stopping it from pushing a
 * still-colliding label further and further from its point until its
 * box is pushed **off the visible chart entirely** (clipped by the
 * enclosing SVG's own viewBox, not just "still a bit crowded") -- found
 * in code review: a small cluster of markers near the same x *and* y
 * (the exact case this module exists to handle) can need several stack
 * levels to fully separate, and each level moves a label another
 * `STACK_STEP` away with no ceiling. When a bound is supplied, the loop
 * stops advancing a label once the *next* level would cross it,
 * accepting whatever residual overlap remains at the last in-bounds
 * position -- a label that's still a little crowded but visible is
 * strictly better than one pushed off-canvas and invisible.
 */
export interface LabelLayoutBounds {
  minY: number;
  maxY: number;
}

function labelWidth(primaryText: string, secondaryText: string): number {
  return Math.max(
    primaryText.length * CHAR_WIDTH_PRIMARY,
    secondaryText.length * CHAR_WIDTH_SECONDARY,
  );
}

/** The bounding box a label would occupy if its first line's baseline
 * were placed at `labelY` -- exported for direct use in tests, so a
 * test can assert "no overlap" against the exact same geometry the
 * layout algorithm itself reasons about, without duplicating these
 * constants. */
export function labelBox(input: LabelLayoutInput, labelY: number): LabelBox {
  const width = labelWidth(input.primaryText, input.secondaryText);
  const left =
    input.anchor === "start"
      ? input.x
      : input.anchor === "end"
        ? input.x - width
        : input.x - width / 2;
  return {
    left,
    right: left + width,
    top: labelY - LINE_HALF_HEIGHT,
    bottom: labelY + LINE_GAP + LINE_HALF_HEIGHT,
  };
}

export function boxesOverlap(a: LabelBox, b: LabelBox): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

/**
 * Resolves a label-baseline y-position (`labelY`, matching
 * PortfolioChart's own pre-existing convention) for each input, in the
 * same order given, such that no two resulting boxes overlap.
 *
 * Processes inputs in the order given (PortfolioChart passes them in
 * x order) with a greedy "place at the base offset; if that box
 * overlaps any already-placed box, step further out and retry" strategy
 * against every box placed so far -- proportional to this chart's small
 * marker count (at most 6, one open+close pair per trade, up to 3
 * trades), so brute-force pairwise checking per placement is plenty
 * fast, and no more complex packing algorithm is warranted.
 *
 * `bounds`, if given, caps how far a label can be pushed (see
 * `LabelLayoutBounds`'s own doc comment) -- a still-colliding label at
 * the bound simply stays at its last in-bounds position rather than
 * being clipped off-canvas.
 */
export function resolveLabelOffsets(
  inputs: readonly LabelLayoutInput[],
  bounds?: LabelLayoutBounds,
): number[] {
  const placedBoxes: LabelBox[] = [];
  const results: number[] = [];

  for (const input of inputs) {
    const base = input.isAbove ? BASE_OFFSET_ABOVE : BASE_OFFSET_BELOW;
    let labelY = input.isAbove ? input.y - base : input.y + base;
    let box = labelBox(input, labelY);

    for (
      let level = 1;
      level <= MAX_STACK_LEVELS && placedBoxes.some((placed) => boxesOverlap(placed, box));
      level += 1
    ) {
      const offset = base + level * STACK_STEP;
      const nextLabelY = input.isAbove ? input.y - offset : input.y + offset;
      const nextBox = labelBox(input, nextLabelY);
      if (bounds && (nextBox.top < bounds.minY || nextBox.bottom > bounds.maxY)) {
        break; // Would clip off-canvas -- stay at the last in-bounds position.
      }
      labelY = nextLabelY;
      box = nextBox;
    }

    placedBoxes.push(box);
    results.push(labelY);
  }

  return results;
}
