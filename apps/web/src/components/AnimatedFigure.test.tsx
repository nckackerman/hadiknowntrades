import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { AnimatedFigure } from "./AnimatedFigure";

// jsdom computes no real text metrics, so nothing here can assert the
// actual reserved *width* -- that is what issue #147's own headless-
// Chromium per-frame measurement is for, and what issue #107's version of
// this bug slipped through by only ever being unit-tested. What jsdom
// can hold onto is the structure that makes the reservation work at all:
// the probes exist, they're one per ladder tier, they're hidden, and
// they stay out of the figure's own text.
describe("AnimatedFigure (issue #147)", () => {
  function probesOf(container: HTMLElement): string[] {
    return Array.from(container.querySelectorAll("[data-figure-probe]")).map(
      (el) => el.getAttribute("data-figure-probe") ?? "",
    );
  }

  it("renders the value it's given", () => {
    render(<AnimatedFigure from={20} to={1145.91} value="$994.72" />);

    expect(screen.getByText("$994.72")).toBeInTheDocument();
  });

  it("renders a hidden width probe for every ladder tier the tween crosses", () => {
    const { container } = render(<AnimatedFigure from={20} to={1145.91} value="$994.72" />);

    expect(probesOf(container)).toEqual(["$99.99", "$999.99", "$9.9K"]);
  });

  it("renders a single probe when the tween crosses no unit boundary", () => {
    const { container } = render(<AnimatedFigure from={20} to={21.43} value="$21.09" />);

    expect(probesOf(container)).toEqual(["$99.99"]);
  });

  it("keeps every probe out of the accessibility tree and out of the painted output", () => {
    const { container } = render(<AnimatedFigure from={20} to={1145.91} value="$994.72" />);

    for (const probe of container.querySelectorAll("[data-figure-probe]")) {
      expect(probe.getAttribute("aria-hidden")).toBe("true");
      // `visibility: hidden`, not `display: none` -- a probe with no
      // layout box reserves nothing at all.
      expect(probe.classList.contains("invisible")).toBe(true);
      expect(probe.classList.contains("hidden")).toBe(false);
    }
  });

  it("keeps the probes out of the figure's own text content", () => {
    // The probe text is painted from its attribute by
    // globals.css's `.figure-width-probe::after`, deliberately -- a real
    // text node would make this figure read "$99.99$999.99$9.9K$994.72"
    // to getByText and to anything else walking the DOM.
    const { container } = render(<AnimatedFigure from={20} to={1145.91} value="$994.72" />);

    expect(container.firstElementChild?.textContent).toBe("$994.72");
  });

  it("passes through the caller's own span attributes, keeping its own grid class", () => {
    // HeroStat leans on both: `aria-hidden` (its animated twin is hidden
    // from assistive tech, with a static sr-only span carrying the final
    // value) and the reveal-accent class/custom property (issue #77).
    const { container } = render(
      <AnimatedFigure
        aria-hidden="true"
        className="hero-figure-accent"
        style={{ color: "red" }}
        from={20}
        to={21.43}
        value="$21.43"
      />,
    );

    const figure = container.firstElementChild as HTMLElement;
    expect(figure.getAttribute("aria-hidden")).toBe("true");
    expect(figure.classList.contains("hero-figure-accent")).toBe(true);
    expect(figure.classList.contains("grid")).toBe(true);
    expect(figure.style.color).toBe("red");
  });
});
