import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { OnboardingIntro } from "./OnboardingIntro";

/** See use-onboarding-dismissed.test.ts's identical helper -- the hook's
 * mount-time hydration read is deferred to a microtask. */
async function flushMicrotasks(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

describe("OnboardingIntro", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    window.localStorage.clear();
  });

  it("renders the intro banner for a first-time visitor", () => {
    render(<OnboardingIntro />);

    expect(screen.getByRole("note")).toBeInTheDocument();
  });

  it("hides the banner after dismiss is clicked", async () => {
    const user = userEvent.setup();
    render(<OnboardingIntro />);
    await flushMicrotasks();

    await user.click(screen.getByRole("button", { name: "Dismiss intro" }));

    expect(screen.queryByRole("note")).not.toBeInTheDocument();
  });

  it("persists the dismissal so a fresh mount (e.g. after a reload) stays hidden", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<OnboardingIntro />);
    await flushMicrotasks();

    await user.click(screen.getByRole("button", { name: "Dismiss intro" }));
    unmount();

    render(<OnboardingIntro />);
    await flushMicrotasks();

    expect(screen.queryByRole("note")).not.toBeInTheDocument();
  });

  it("still renders the banner on the very first render even when a dismissal is already stored, correcting to hidden only after mount (hydration-safety, see use-onboarding-dismissed.ts)", async () => {
    window.localStorage.setItem("hikt:onboarding-dismissed", "1");

    render(<OnboardingIntro />);
    expect(screen.getByRole("note")).toBeInTheDocument();

    await flushMicrotasks();
    expect(screen.queryByRole("note")).not.toBeInTheDocument();
  });
});
