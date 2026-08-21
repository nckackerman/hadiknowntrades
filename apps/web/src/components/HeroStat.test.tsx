import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { HeroStat } from "./HeroStat";

/** See use-count-up.test.ts's identical helper -- jsdom doesn't implement matchMedia at all, so tests stub it the way real browsers implement it. */
function stubPrefersReducedMotion(matches: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockReturnValue({
      matches,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
  );
}

describe("HeroStat", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("renders the starting capital plainly, unaffected by the count-up", () => {
    render(<HeroStat startingCapital={20} endingBalance={6876.86} />);

    // Scoped to the non-hidden span: at mount the count-up's own figure
    // also happens to read "$20.00" (it starts there), so a plain
    // getByText would match two elements.
    expect(screen.getByText("$20.00", { selector: "span:not([aria-hidden])" })).toBeInTheDocument();
  });

  it("starts the visible ending-balance figure at the starting capital, not the final value", () => {
    stubPrefersReducedMotion(false);
    // Never invoke the callback -- observe the very first render, before
    // any animation frame has had a chance to advance the count.
    vi.spyOn(window, "requestAnimationFrame").mockReturnValue(1);

    render(<HeroStat startingCapital={20} endingBalance={6876.86} />);

    // Two "$20.00"s: the static starting-capital figure, and the
    // *visible* ending-balance figure mid-reveal (still at its starting
    // value) -- not counting the always-final sr-only span, which
    // already reads "$6.9K" at this point (see the next test).
    expect(screen.getAllByText("$20.00")).toHaveLength(2);
    expect(screen.queryByText("$6.9K", { selector: ":not(.sr-only)" })).not.toBeInTheDocument();
  });

  it("exposes only the final value to assistive tech, even while the visible figure is mid-count", () => {
    stubPrefersReducedMotion(false);
    vi.spyOn(window, "requestAnimationFrame").mockReturnValue(1);

    render(<HeroStat startingCapital={20} endingBalance={6876.86} />);

    // The visible mid-count span is aria-hidden; the always-final
    // sr-only span is what assistive tech actually sees.
    const srOnlyFinal = screen.getByText("$6.9K", { selector: ".sr-only" });
    expect(srOnlyFinal).toBeInTheDocument();
    expect(srOnlyFinal).not.toHaveAttribute("aria-hidden");
  });

  it("renders the settled ending balance identically to the pre-animation static markup when reduced motion is requested", () => {
    stubPrefersReducedMotion(true);
    // Fire the first available frame synchronously so the settle-to-`to`
    // tick (see use-count-up.ts) runs within this test instead of on
    // jsdom's real ~16ms animation-frame interval.
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb: FrameRequestCallback) => {
      cb(performance.now());
      return 1;
    });

    render(<HeroStat startingCapital={20} endingBalance={6876.86} />);

    expect(screen.getAllByText("$6.9K")).toHaveLength(2); // visible + sr-only, both final
    expect(screen.getAllByText("$20.00")).toHaveLength(1); // only the static starting-capital figure
  });
});
