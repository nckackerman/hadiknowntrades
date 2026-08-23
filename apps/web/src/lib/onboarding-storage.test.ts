import { afterEach, describe, expect, it, vi } from "vitest";

import { dismissOnboarding, isOnboardingDismissed } from "./onboarding-storage";

const STORAGE_KEY = "hikt:onboarding-dismissed";

describe("isOnboardingDismissed / dismissOnboarding", () => {
  afterEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it("reports not dismissed when nothing is stored", () => {
    expect(isOnboardingDismissed()).toBe(false);
  });

  it("reports dismissed after dismissOnboarding() is called", () => {
    dismissOnboarding();

    expect(isOnboardingDismissed()).toBe(true);
  });

  it("writes under a namespaced key, not a bare key that could collide with another feature", () => {
    dismissOnboarding();

    expect(window.localStorage.getItem(STORAGE_KEY)).not.toBeNull();
  });

  it("treats an unrecognized stored value (hand-edited/corrupt) as 'not dismissed' rather than throwing", () => {
    window.localStorage.setItem(STORAGE_KEY, "not-the-expected-sentinel");

    expect(() => isOnboardingDismissed()).not.toThrow();
    expect(isOnboardingDismissed()).toBe(false);
  });

  it("degrades to 'not dismissed' when localStorage.getItem itself throws", () => {
    vi.spyOn(window.localStorage, "getItem").mockImplementation(() => {
      throw new Error("access denied");
    });

    expect(isOnboardingDismissed()).toBe(false);
  });

  it("does not throw when localStorage.setItem itself throws (e.g. private-mode Safari)", () => {
    vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
      throw new Error("quota exceeded");
    });

    expect(() => dismissOnboarding()).not.toThrow();
  });
});
