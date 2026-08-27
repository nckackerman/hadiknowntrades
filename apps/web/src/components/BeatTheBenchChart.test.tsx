import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { positionsThroughBar } from "@/lib/beat-the-bench";
import { SPY_SESSION_BARS } from "@/test-fixtures/spy-session-bars";
import { BeatTheBenchChart, positionRuns } from "./BeatTheBenchChart";

describe("positionRuns", () => {
  it("draws one unbroken run when the player never moves", () => {
    expect(positionRuns(positionsThroughBar([], 4), 4)).toEqual([
      { position: "holding", from: 0, to: 4 },
    ]);
  });

  it("has nothing to draw before a second bar exists", () => {
    expect(positionRuns(positionsThroughBar([], 0), 0)).toEqual([]);
  });

  // The run boundaries are what colour the line: a segment is ridden in
  // whatever position the player held at its *start*, so selling at bar
  // 2 means the 1->2 segment is still in-market and only 2->3 onward is
  // dashed. Getting this off by one would draw the sell one bar late.
  it("splits at a move, sharing the boundary bar so the line doesn't break", () => {
    expect(positionRuns(positionsThroughBar([2], 4), 4)).toEqual([
      { position: "holding", from: 0, to: 2 },
      { position: "cash", from: 2, to: 4 },
    ]);
  });

  it("handles a sell and a buy-back", () => {
    expect(positionRuns(positionsThroughBar([2, 3], 4), 4)).toEqual([
      { position: "holding", from: 0, to: 2 },
      { position: "cash", from: 2, to: 3 },
      { position: "holding", from: 3, to: 4 },
    ]);
  });
});

describe("BeatTheBenchChart", () => {
  it("labels itself with the live bar, and points at the readouts for the detail", () => {
    render(
      <BeatTheBenchChart
        bars={SPY_SESSION_BARS}
        revealedIndex={12}
        positions={positionsThroughBar([], 12)}
      />,
    );

    const chart = screen.getByRole("img");
    expect(chart.getAttribute("aria-label")).toContain("10:30 AM");
    expect(chart.getAttribute("aria-label")).toContain("the live figures below it");
  });

  it("never reads a price the player hasn't reached, so the axis can't leak the day's range", () => {
    // The scale is built from revealed prices only -- an axis fitted to
    // the whole session would publish the day's high and low before the
    // player got there. Drawn with a wildly out-of-range future bar, the
    // rendered geometry must be identical to one without it.
    const withFuture = [
      ...SPY_SESSION_BARS.slice(0, 6),
      { time: "10:00:00", close: 9_999 },
      ...SPY_SESSION_BARS.slice(7, 12),
    ];

    const plain = render(
      <BeatTheBenchChart
        bars={SPY_SESSION_BARS.slice(0, 12)}
        revealedIndex={5}
        positions={positionsThroughBar([], 5)}
      />,
    );
    const plainPoints = plain.container.querySelector("polyline")!.getAttribute("points");
    plain.unmount();

    const spoiled = render(
      <BeatTheBenchChart
        bars={withFuture}
        revealedIndex={5}
        positions={positionsThroughBar([], 5)}
      />,
    );
    expect(spoiled.container.querySelector("polyline")!.getAttribute("points")).toBe(plainPoints);
  });
});
