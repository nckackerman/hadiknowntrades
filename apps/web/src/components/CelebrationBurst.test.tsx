import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { CelebrationBurst } from "./CelebrationBurst";

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
});
