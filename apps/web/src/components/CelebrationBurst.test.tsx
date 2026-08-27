import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { celebrationIntensityFor, FULL_CELEBRATION_INTENSITY } from "@/lib/celebration-magnitude";
import { CelebrationBurst } from "./CelebrationBurst";

/** Every rendered piece's `left` percentage, as plain numbers. */
function pieceLeftPercents(burst: HTMLElement): number[] {
  return Array.from(burst.children).map((child) =>
    Number.parseFloat((child as HTMLElement).style.left),
  );
}

describe("CelebrationBurst", () => {
  it("renders nothing when inactive", () => {
    render(<CelebrationBurst active={false} />);

    expect(screen.queryByTestId("celebration-burst")).not.toBeInTheDocument();
  });

  it("renders a burst of confetti pieces when active", () => {
    render(<CelebrationBurst active={true} />);

    const burst = screen.getByTestId("celebration-burst");
    expect(burst).toHaveAttribute("aria-hidden", "true");
    expect(burst.children.length).toBeGreaterThan(0);
  });

  it("is purely decorative -- hidden from assistive tech and never intercepts pointer events", () => {
    render(<CelebrationBurst active={true} />);

    const burst = screen.getByTestId("celebration-burst");
    expect(burst).toHaveAttribute("aria-hidden", "true");
    expect(burst.className).toContain("pointer-events-none");
  });

  it("defaults to the original full-width 24-piece burst when no intensity is given", () => {
    render(<CelebrationBurst active={true} />);

    const burst = screen.getByTestId("celebration-burst");
    expect(burst.children.length).toBe(FULL_CELEBRATION_INTENSITY.pieceCount);
    // The default spread of 100 reproduces the pre-#125 `Math.random() * 100`
    // distribution: every piece lands somewhere inside the full row.
    for (const left of pieceLeftPercents(burst)) {
      expect(left).toBeGreaterThanOrEqual(0);
      expect(left).toBeLessThanOrEqual(100);
    }
  });

  describe("magnitude scaling (issue #125)", () => {
    it("renders a visibly smaller, tighter burst for a small-magnitude result", () => {
      // A 2x window: a real, respectable win, but not a spectacular one.
      render(<CelebrationBurst active={true} intensity={celebrationIntensityFor(2)} />);

      const burst = screen.getByTestId("celebration-burst");
      expect(burst.children.length).toBeGreaterThan(0);
      expect(burst.children.length).toBeLessThan(FULL_CELEBRATION_INTENSITY.pieceCount);
      // ...and confined to a narrow band around the figure, rather than
      // spread across the whole row like the full burst.
      for (const left of pieceLeftPercents(burst)) {
        expect(left).toBeGreaterThan(20);
        expect(left).toBeLessThan(80);
      }
    });

    it("renders the full burst for a large-magnitude result", () => {
      // ~35.8Mx, a real Max-range-scale result.
      render(<CelebrationBurst active={true} intensity={celebrationIntensityFor(35_800_000)} />);

      const burst = screen.getByTestId("celebration-burst");
      expect(burst.children.length).toBe(FULL_CELEBRATION_INTENSITY.pieceCount);
    });

    it("renders nothing at all for a marginal win the suppressed tier covers", () => {
      render(<CelebrationBurst active={true} intensity={celebrationIntensityFor(1.05)} />);

      // Not just an empty overlay div -- no burst marker in the DOM at all.
      expect(screen.queryByTestId("celebration-burst")).not.toBeInTheDocument();
    });

    it("never renders while inactive, however large the intensity says the win was", () => {
      // The whole point of the tier being an *intensity dial*: it can
      // scale a burst down (even to nothing), but it can never turn one
      // on that `shouldCelebrate` already said no to.
      render(<CelebrationBurst active={false} intensity={celebrationIntensityFor(35_800_000)} />);

      expect(screen.queryByTestId("celebration-burst")).not.toBeInTheDocument();
    });
  });
});
