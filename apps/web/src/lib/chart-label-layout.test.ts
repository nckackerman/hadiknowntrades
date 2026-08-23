import { describe, expect, it } from "vitest";

import {
  boxesOverlap,
  labelBox,
  resolveLabelOffsets,
  type LabelLayoutInput,
} from "./chart-label-layout";

/**
 * Asserts every pair of resolved labels has a non-overlapping bounding
 * box -- the acceptance criterion issue #68 itself specifies ("a
 * synthetic fixture ... renders with no visually overlapping label
 * text"), checked against the exact same box geometry the layout
 * algorithm reasons about (labelBox), not a hand-duplicated copy of it.
 */
function assertNoOverlaps(inputs: readonly LabelLayoutInput[]): void {
  const labelYs = resolveLabelOffsets(inputs);
  const boxes = inputs.map((input, i) => labelBox(input, labelYs[i]!));

  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      expect(boxesOverlap(boxes[i]!, boxes[j]!)).toBe(false);
    }
  }
}

describe("resolveLabelOffsets", () => {
  it("leaves a single label at its base offset (above)", () => {
    const inputs: LabelLayoutInput[] = [
      {
        x: 400,
        y: 200,
        isAbove: true,
        anchor: "middle",
        primaryText: "Buy AAPL",
        secondaryText: "Jan 1, 2024 · $10.00",
      },
    ];
    expect(resolveLabelOffsets(inputs)).toEqual([200 - 14]);
  });

  it("leaves a single label at its base offset (below)", () => {
    const inputs: LabelLayoutInput[] = [
      {
        x: 400,
        y: 200,
        isAbove: false,
        anchor: "middle",
        primaryText: "Sell AAPL",
        secondaryText: "Jan 1, 2024 · $10.00",
      },
    ];
    expect(resolveLabelOffsets(inputs)).toEqual([200 + 24]);
  });

  it("leaves two well-separated markers at their own base offsets (no collision)", () => {
    const inputs: LabelLayoutInput[] = [
      {
        x: 50,
        y: 200,
        isAbove: true,
        anchor: "start",
        primaryText: "Buy AAPL",
        secondaryText: "Jan 1, 2024 · $10.00",
      },
      {
        x: 830,
        y: 150,
        isAbove: false,
        anchor: "end",
        primaryText: "Sell AAPL",
        secondaryText: "Jan 1, 2025 · $30.00",
      },
    ];
    expect(resolveLabelOffsets(inputs)).toEqual([200 - 14, 150 + 24]);
    assertNoOverlaps(inputs);
  });

  /**
   * The real-world case the issue describes ("a sell a few days after a
   * buy"): a single trade's open and close land only a few days apart
   * on a multi-year x-axis (a handful of pixels), *and* a real,
   * moderate gain moves the close's y-position closer to the open's
   * (the close's value is compounded from the open's, so a bigger gain
   * moves the close point further up the log-scaled y-axis). The
   * open's label sits above its own point, the close's below its own --
   * for a moderate gain, the close's "below" label creeps up close
   * enough to the open's own point to collide with the open's "above"
   * label. (A huge gain would push the close point -- and its label --
   * far enough away on the log-scaled axis that they'd never come close
   * regardless; this fixture's y-gap is deliberately in the range that
   * does collide.)
   */
  it("pushes a colliding open+close pair (of the same trade, a moderate gain) apart instead of overlapping", () => {
    const inputs: LabelLayoutInput[] = [
      {
        x: 402,
        y: 300,
        isAbove: true, // open
        anchor: "middle",
        primaryText: "Buy AAPL",
        secondaryText: "Jun 1, 2024 · $10.00",
      },
      {
        x: 406,
        y: 270, // a real, moderate gain -- higher value, smaller y -- 4 days later
        isAbove: false, // close
        anchor: "middle",
        primaryText: "Sell AAPL",
        secondaryText: "Jun 5, 2024 · $30.00",
      },
    ];

    // Confirms the fixture is a genuine pre-fix collision, not a
    // vacuous check -- at their un-stacked base offsets these two boxes
    // do overlap.
    expect(boxesOverlap(labelBox(inputs[0]!, 300 - 14), labelBox(inputs[1]!, 270 + 24))).toBe(true);

    const labelYs = resolveLabelOffsets(inputs);
    // At least one label had to move off its base offset to clear the
    // collision confirmed above.
    expect(labelYs).not.toEqual([300 - 14, 270 + 24]);
    assertNoOverlaps(inputs);
  });

  it("stacks three markers all crowded onto the same x/y with no pairwise overlap", () => {
    const inputs: LabelLayoutInput[] = Array.from({ length: 3 }, (_, i) => ({
      x: 500 + i, // 1px apart -- effectively the same x
      y: 180,
      isAbove: i % 2 === 0,
      anchor: "middle" as const,
      primaryText: `Buy TICK${i}`,
      secondaryText: `Jun ${i + 1}, 2024 · $${(i + 1) * 10}.00`,
    }));

    assertNoOverlaps(inputs);
  });

  it("keeps every marker's label on its own side of its point (above stays above, below stays below)", () => {
    const inputs: LabelLayoutInput[] = [
      {
        x: 500,
        y: 180,
        isAbove: true,
        anchor: "middle",
        primaryText: "Buy AAPL",
        secondaryText: "Jun 1, 2024 · $10.00",
      },
      {
        x: 502,
        y: 180,
        isAbove: true,
        anchor: "middle",
        primaryText: "Buy MSFT",
        secondaryText: "Jun 2, 2024 · $20.00",
      },
    ];

    const labelYs = resolveLabelOffsets(inputs);
    for (const labelY of labelYs) {
      expect(labelY).toBeLessThan(180);
    }
  });
});

describe("boxesOverlap", () => {
  it("detects overlapping rectangles", () => {
    expect(
      boxesOverlap(
        { left: 0, right: 10, top: 0, bottom: 10 },
        { left: 5, right: 15, top: 5, bottom: 15 },
      ),
    ).toBe(true);
  });

  it("detects non-overlapping rectangles", () => {
    expect(
      boxesOverlap(
        { left: 0, right: 10, top: 0, bottom: 10 },
        { left: 20, right: 30, top: 0, bottom: 10 },
      ),
    ).toBe(false);
  });

  it("treats exactly-touching edges as non-overlapping", () => {
    expect(
      boxesOverlap(
        { left: 0, right: 10, top: 0, bottom: 10 },
        { left: 10, right: 20, top: 0, bottom: 10 },
      ),
    ).toBe(false);
  });
});
