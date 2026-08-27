import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { HeroStat } from "./HeroStat";
import { stubPrefersReducedMotion } from "@/lib/stub-prefers-reduced-motion.test-util";

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

  describe("multiplier badge (issue #45)", () => {
    it("renders the multiplier alongside the dollar figures, next to (not replacing) them", () => {
      render(<HeroStat startingCapital={20} endingBalance={6876.86} />);

      // 6876.86 / 20 = 343.843, rounds to a whole "344x" -- see
      // format-currency.test.ts for the rounding rules themselves.
      expect(screen.getByText("(344x)")).toBeInTheDocument();
      // The dollar figures are still there too -- this is additive, not
      // a replacement (see the earlier "renders the starting capital
      // plainly" test for the fuller assertion on those).
      expect(
        screen.getByText("$20.00", { selector: "span:not([aria-hidden])" }),
      ).toBeInTheDocument();
    });

    it("shows the final multiplier immediately, not tied to the count-up animation", () => {
      stubPrefersReducedMotion(false);
      // Never invoke the callback -- the count-up figure itself is still
      // stuck at its starting value (see the equivalent dollar-figure
      // test above), but the multiplier badge isn't driven by the same
      // animation and should already read the final ratio.
      vi.spyOn(window, "requestAnimationFrame").mockReturnValue(1);

      render(<HeroStat startingCapital={20} endingBalance={6876.86} />);

      expect(screen.getByText("(344x)")).toBeInTheDocument();
    });

    it("is plain static text, not wired to aria-live or aria-hidden the way the animated figure is", () => {
      render(<HeroStat startingCapital={20} endingBalance={6876.86} />);

      const badge = screen.getByText("(344x)");
      expect(badge).not.toHaveAttribute("aria-live");
      expect(badge).not.toHaveAttribute("aria-hidden");
    });

    it("colors the badge as a gain when the multiplier is at least 1x", () => {
      render(<HeroStat startingCapital={20} endingBalance={6876.86} />);

      expect(screen.getByText("(344x)")).toHaveStyle({ color: "var(--status-good)" });
    });

    it("colors the badge as a loss when the multiplier is below 1x", () => {
      render(<HeroStat startingCapital={20} endingBalance={5} />);

      const badge = screen.getByText("(0.3x)");
      expect(badge).toBeInTheDocument();
      expect(badge).toHaveStyle({ color: "var(--status-critical)" });
    });

    it("colors a flat, exactly-1x result as a gain (not critical), matching TradeRow's >= threshold", () => {
      render(<HeroStat startingCapital={20} endingBalance={20} />);

      expect(screen.getByText("(1x)")).toHaveStyle({ color: "var(--status-good)" });
    });
  });

  describe("displayStartingCapital rescaling (issue #15)", () => {
    it("defaults to no-op (displayStartingCapital omitted): rendering is pixel-identical to before this prop existed", () => {
      stubPrefersReducedMotion(true);
      vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb: FrameRequestCallback) => {
        cb(performance.now());
        return 1;
      });

      render(<HeroStat startingCapital={20} endingBalance={6876.86} />);

      expect(
        screen.getByText("$20.00", { selector: "span:not([aria-hidden])" }),
      ).toBeInTheDocument();
      expect(screen.getAllByText("$6.9K")).toHaveLength(2);
      expect(screen.getByText("(344x)")).toBeInTheDocument();
    });

    it("rescales the starting-capital and settled ending-balance figures to displayStartingCapital, leaving the multiplier unaffected", () => {
      stubPrefersReducedMotion(true);
      vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb: FrameRequestCallback) => {
        cb(performance.now());
        return 1;
      });

      render(
        <HeroStat startingCapital={20} endingBalance={6876.86} displayStartingCapital={500} />,
      );

      expect(
        screen.getByText("$500.00", { selector: "span:not([aria-hidden])" }),
      ).toBeInTheDocument();
      // 500 * (6876.86 / 20) = 171,921.5 -> compact "$172K".
      expect(screen.getAllByText("$172K")).toHaveLength(2);
      // The multiplier is unaffected by the rescale -- still 344x.
      expect(screen.getByText("(344x)")).toBeInTheDocument();
    });

    it("rescales the mid-tween animated figure proportionally too, not just the settled value", () => {
      stubPrefersReducedMotion(false);
      // Never invoke the callback -- observe the figure still stuck at
      // its starting value mid-tween.
      vi.spyOn(window, "requestAnimationFrame").mockReturnValue(1);

      render(
        <HeroStat startingCapital={20} endingBalance={6876.86} displayStartingCapital={500} />,
      );

      // Mid-tween the animated value still equals `startingCapital`
      // (20) -- rescaled by 500/20 that's exactly displayStartingCapital
      // itself (500), same as the static starting-capital figure.
      expect(screen.getAllByText("$500.00").length).toBeGreaterThanOrEqual(2);
    });

    it("exercises the existing large-number formatting path at a Max-range-scale multiplier combined with a large user-entered starting capital", () => {
      stubPrefersReducedMotion(true);
      vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb: FrameRequestCallback) => {
        cb(performance.now());
        return 1;
      });

      // ~35.8Mx multiplier (packages/core/CLAUDE.md's ~$716M-from-$20
      // case), rescaled to a $1,000,000 user-entered starting capital.
      render(
        <HeroStat
          startingCapital={20}
          endingBalance={716_000_000}
          displayStartingCapital={1_000_000}
        />,
      );

      // The starting-capital figure itself goes through the same
      // large-number formatting ladder once the user enters a large
      // enough value: "$1M", not a wall of digits.
      expect(screen.getByText("$1M", { selector: "span:not([aria-hidden])" })).toBeInTheDocument();
      // 1,000,000 * (716,000,000 / 20) = 35,800,000,000,000 -> "$35.8T".
      expect(screen.getAllByText("$35.8T")).toHaveLength(2);
      expect(screen.getByText("(35.8Mx)")).toBeInTheDocument();
    });
  });

  describe("celebration burst (issue #36)", () => {
    it("fires once the count-up lands on a gain", () => {
      stubPrefersReducedMotion(false);
      // Land on the final value in a single frame, same technique as
      // the reduced-motion test above -- just without reduced motion
      // itself, so this exercises the "landed via the real tween" path.
      vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb: FrameRequestCallback) => {
        cb(performance.now() + 100_000);
        return 1;
      });

      render(<HeroStat startingCapital={20} endingBalance={6876.86} />);

      expect(screen.getByTestId("celebration-burst")).toBeInTheDocument();
    });

    it("does not fire when the reveal is not a gain", () => {
      stubPrefersReducedMotion(false);
      vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb: FrameRequestCallback) => {
        cb(performance.now() + 100_000);
        return 1;
      });

      render(<HeroStat startingCapital={20} endingBalance={20} />);

      expect(screen.queryByTestId("celebration-burst")).not.toBeInTheDocument();
    });

    it("does not fire when the ending balance is below starting capital", () => {
      stubPrefersReducedMotion(false);
      vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb: FrameRequestCallback) => {
        cb(performance.now() + 100_000);
        return 1;
      });

      render(<HeroStat startingCapital={20} endingBalance={5} />);

      expect(screen.queryByTestId("celebration-burst")).not.toBeInTheDocument();
    });

    it("does not fire on a gain when the user prefers reduced motion", () => {
      stubPrefersReducedMotion(true);
      vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb: FrameRequestCallback) => {
        cb(performance.now());
        return 1;
      });

      render(<HeroStat startingCapital={20} endingBalance={6876.86} />);

      expect(screen.queryByTestId("celebration-burst")).not.toBeInTheDocument();
    });

    it("has not fired yet mid-count, before the reveal lands", () => {
      stubPrefersReducedMotion(false);
      // Never invoke the callback -- the count-up is stuck at `from`, so
      // the reveal hasn't "landed" yet even though the result is a gain.
      vi.spyOn(window, "requestAnimationFrame").mockReturnValue(1);

      render(<HeroStat startingCapital={20} endingBalance={6876.86} />);

      expect(screen.queryByTestId("celebration-burst")).not.toBeInTheDocument();
    });
  });

  describe("burst magnitude scaling (issue #125)", () => {
    /** Land the count-up on its final value in a single frame. */
    function landTheReveal() {
      vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb: FrameRequestCallback) => {
        cb(performance.now() + 100_000);
        return 1;
      });
    }

    it("leaves callers that don't opt in on the pre-#125 fixed burst", () => {
      stubPrefersReducedMotion(false);
      landTheReveal();

      // A 1.05x win -- suppressed outright once scaling is on (below),
      // but this call site (the intraday-daily per-day drill-down, which
      // deliberately doesn't opt in) still gets the full burst.
      render(<HeroStat startingCapital={20} endingBalance={21} />);

      expect(screen.getByTestId("celebration-burst").children.length).toBe(24);
    });

    it("suppresses the burst for a small-magnitude win", () => {
      stubPrefersReducedMotion(false);
      landTheReveal();

      render(
        <HeroStat startingCapital={20} endingBalance={21} scaleCelebrationToMagnitude={true} />,
      );

      expect(screen.queryByTestId("celebration-burst")).not.toBeInTheDocument();
      // The win is still marked as one everywhere else -- only the
      // confetti is scaled back, not the badge or the accent glow.
      expect(screen.getByText("(1.1x)")).toBeInTheDocument();
    });

    it("fires a smaller-than-full burst for a mid-magnitude win", () => {
      stubPrefersReducedMotion(false);
      landTheReveal();

      render(
        <HeroStat startingCapital={20} endingBalance={40} scaleCelebrationToMagnitude={true} />,
      );

      const burst = screen.getByTestId("celebration-burst");
      expect(burst.children.length).toBeGreaterThan(0);
      expect(burst.children.length).toBeLessThan(24);
    });

    it("fires the full burst for a large-magnitude (Max-range-scale) win", () => {
      stubPrefersReducedMotion(false);
      landTheReveal();

      // $20 -> ~$716M, the real Max-range figure documented in
      // apps/web/CLAUDE.md -- ~35.8Mx.
      render(
        <HeroStat
          startingCapital={20}
          endingBalance={716_000_000}
          scaleCelebrationToMagnitude={true}
        />,
      );

      expect(screen.getByTestId("celebration-burst").children.length).toBe(24);
    });

    // The load-bearing property of this whole issue: the tier is an
    // intensity dial layered on top of shouldCelebrate(isGain, settled)
    // -- it can scale an approved burst down (even to nothing), but it
    // must never fire one shouldCelebrate already said no to.
    it("never introduces a burst where shouldCelebrate already says no", () => {
      const cases: { name: string; props: { startingCapital: number; endingBalance: number } }[] = [
        // Not a gain at all (`isGain` false).
        { name: "flat", props: { startingCapital: 20, endingBalance: 20 } },
        { name: "loss", props: { startingCapital: 20, endingBalance: 5 } },
      ];

      for (const { name, props } of cases) {
        stubPrefersReducedMotion(false);
        landTheReveal();

        const { unmount } = render(<HeroStat {...props} scaleCelebrationToMagnitude={true} />);

        expect(screen.queryByTestId("celebration-burst"), name).not.toBeInTheDocument();
        unmount();
        vi.restoreAllMocks();
      }

      // Reduced motion, with a multiplier the top tier would otherwise
      // celebrate as loudly as possible.
      stubPrefersReducedMotion(true);
      landTheReveal();
      const reducedMotion = render(
        <HeroStat
          startingCapital={20}
          endingBalance={716_000_000}
          scaleCelebrationToMagnitude={true}
        />,
      );
      expect(screen.queryByTestId("celebration-burst")).not.toBeInTheDocument();
      reducedMotion.unmount();
      vi.restoreAllMocks();

      // Same huge multiplier, but the tween hasn't landed yet
      // (`settled` false) -- never invoke the RAF callback.
      stubPrefersReducedMotion(false);
      vi.spyOn(window, "requestAnimationFrame").mockReturnValue(1);
      render(
        <HeroStat
          startingCapital={20}
          endingBalance={716_000_000}
          scaleCelebrationToMagnitude={true}
        />,
      );
      expect(screen.queryByTestId("celebration-burst")).not.toBeInTheDocument();
    });
  });

  describe("reveal accent (issue #77)", () => {
    it("adds no accent class to the visible figure before the reveal settles", () => {
      stubPrefersReducedMotion(false);
      // Never invoke the callback -- still mid-tween, not settled yet.
      vi.spyOn(window, "requestAnimationFrame").mockReturnValue(1);

      const { container } = render(<HeroStat startingCapital={20} endingBalance={6876.86} />);

      expect(container.querySelector(".hero-figure-accent")).not.toBeInTheDocument();
    });

    it("adds the accent class, colored as a gain, and plays the entrance animation once settled with motion allowed", () => {
      stubPrefersReducedMotion(false);
      vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb: FrameRequestCallback) => {
        cb(performance.now() + 100_000);
        return 1;
      });

      const { container } = render(<HeroStat startingCapital={20} endingBalance={6876.86} />);

      const figure = container.querySelector(".hero-figure-accent");
      expect(figure).toBeInTheDocument();
      expect(figure).toHaveClass("hero-figure-accent-animate");
      expect(figure).toHaveStyle({ "--hero-accent-glow": "var(--status-good)" });
    });

    it("colors the accent as a loss when the multiplier is below 1x", () => {
      stubPrefersReducedMotion(true);
      vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb: FrameRequestCallback) => {
        cb(performance.now());
        return 1;
      });

      const { container } = render(<HeroStat startingCapital={20} endingBalance={5} />);

      const figure = container.querySelector(".hero-figure-accent");
      expect(figure).toBeInTheDocument();
      expect(figure).toHaveStyle({ "--hero-accent-glow": "var(--status-critical)" });
    });

    it("skips the entrance animation, but still shows the glow instantly, when reduced motion is requested", () => {
      stubPrefersReducedMotion(true);
      // Fire the first available frame synchronously, same as
      // use-count-up's own reduced-motion test above.
      vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb: FrameRequestCallback) => {
        cb(performance.now());
        return 1;
      });

      const { container } = render(<HeroStat startingCapital={20} endingBalance={6876.86} />);

      const figure = container.querySelector(".hero-figure-accent");
      expect(figure).toBeInTheDocument();
      expect(figure).not.toHaveClass("hero-figure-accent-animate");
    });

    // Regression test for a real bug found in `/code-review`: `settled`
    // (this accent's own gate) is trivially `true` at mount whenever
    // startingCapital === endingBalance (a flat result), unlike `isGain`
    // (which stays strictly false at mount even for a flat result and is
    // what makes shouldCelebrate's own `isGain && settled` short-circuit
    // safe). No requestAnimationFrame mocking is needed here at all --
    // `settled` is already true on the very first render for this case,
    // before any animation frame could fire.
    it("is settled immediately for a flat result (startingCapital === endingBalance), still reading the reduced-motion preference safely", () => {
      stubPrefersReducedMotion(true);

      const { container } = render(<HeroStat startingCapital={20} endingBalance={20} />);

      const figure = container.querySelector(".hero-figure-accent");
      expect(figure).toBeInTheDocument();
      expect(figure).not.toHaveClass("hero-figure-accent-animate");
    });

    // Regression test for a real bug found in `/code-review`, the same
    // class FadeInWrapper's own test (ResultsPanel.test.tsx) already
    // covers: the first version of this feature re-read
    // prefersReducedMotion() on every HeroStat render instead of once at
    // mount, so if the OS-level preference changed value between two
    // renders of an *already-settled* instance (no remount -- e.g. a
    // displayStartingCapital edit, issue #15), the animate class could
    // flip on already-visible content, replaying the entrance animation
    // well after the real reveal. The useState lazy-initializer fix
    // reads prefersReducedMotion() exactly once, at mount.
    it("keeps the accent's animate class fixed across a re-render of an already-settled figure, even if the OS motion preference changes mid-session", () => {
      stubPrefersReducedMotion(false);
      vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb: FrameRequestCallback) => {
        cb(performance.now() + 100_000);
        return 1;
      });

      const { container, rerender } = render(
        <HeroStat startingCapital={20} endingBalance={6876.86} />,
      );
      expect(container.querySelector(".hero-figure-accent")).toHaveClass(
        "hero-figure-accent-animate",
      );

      // Flip the stubbed preference, then re-render the same mounted
      // instance with an unrelated prop change -- must not remount
      // HeroStat (a real remount would replay the reveal by design).
      stubPrefersReducedMotion(true);
      rerender(
        <HeroStat startingCapital={20} endingBalance={6876.86} displayStartingCapital={500} />,
      );

      expect(container.querySelector(".hero-figure-accent")).toHaveClass(
        "hero-figure-accent-animate",
      );
    });
  });
});
