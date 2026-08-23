import { afterEach, describe, expect, it, vi } from "vitest";

import { dismissChartTapHint, isChartTapHintDismissed } from "./chart-tap-hint-storage";

const STORAGE_KEY = "hikt:chart-tap-hint-dismissed";

describe("isChartTapHintDismissed / dismissChartTapHint", () => {
  afterEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it("reports not dismissed when nothing is stored", () => {
    expect(isChartTapHintDismissed()).toBe(false);
  });

  it("reports dismissed after dismissChartTapHint() is called", () => {
    dismissChartTapHint();

    expect(isChartTapHintDismissed()).toBe(true);
  });

  it("writes under a namespaced key, not a bare key that could collide with another feature", () => {
    dismissChartTapHint();

    expect(window.localStorage.getItem(STORAGE_KEY)).not.toBeNull();
  });

  it("treats an unrecognized stored value (hand-edited/corrupt) as 'not dismissed' rather than throwing", () => {
    window.localStorage.setItem(STORAGE_KEY, "not-the-expected-sentinel");

    expect(() => isChartTapHintDismissed()).not.toThrow();
    expect(isChartTapHintDismissed()).toBe(false);
  });

  it("degrades to 'not dismissed' when localStorage.getItem itself throws", () => {
    vi.spyOn(window.localStorage, "getItem").mockImplementation(() => {
      throw new Error("access denied");
    });

    expect(isChartTapHintDismissed()).toBe(false);
  });

  it("does not throw when localStorage.setItem itself throws (e.g. private-mode Safari)", () => {
    vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
      throw new Error("quota exceeded");
    });

    expect(() => dismissChartTapHint()).not.toThrow();
  });
});
