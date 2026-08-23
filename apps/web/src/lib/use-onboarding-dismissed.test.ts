import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as onboardingStorageLib from "./onboarding-storage";
import { useOnboardingDismissed } from "./use-onboarding-dismissed";

const STORAGE_KEY = "hikt:onboarding-dismissed";

/** The hook's mount-time "hydrate from storage" correction runs inside a
 * microtask (see use-onboarding-dismissed.ts's own comment on why, mirroring
 * use-starting-capital.ts) -- tests that need to observe the corrected
 * value must flush the microtask queue first. */
async function flushMicrotasks(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

describe("useOnboardingDismissed", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("defaults to not dismissed when nothing is stored", async () => {
    const { result } = renderHook(() => useOnboardingDismissed());
    await flushMicrotasks();

    expect(result.current[0]).toBe(false);
  });

  it("starts not dismissed on the very first render, even when a dismissal is already stored -- the hydration-safety tradeoff this hook's own doc comment describes", () => {
    window.localStorage.setItem(STORAGE_KEY, "1");

    const { result } = renderHook(() => useOnboardingDismissed());

    expect(result.current[0]).toBe(false);
  });

  it("hydrates to dismissed shortly after mount when a previous dismissal is stored", async () => {
    window.localStorage.setItem(STORAGE_KEY, "1");

    const { result } = renderHook(() => useOnboardingDismissed());
    await flushMicrotasks();

    expect(result.current[0]).toBe(true);
  });

  it("stays not dismissed after mount when localStorage.getItem itself throws", async () => {
    vi.spyOn(window.localStorage, "getItem").mockImplementation(() => {
      throw new Error("access denied");
    });

    const { result } = renderHook(() => useOnboardingDismissed());
    await flushMicrotasks();

    expect(result.current[0]).toBe(false);
  });

  it("updates state and persists the dismissal to localStorage when dismiss() is called", async () => {
    const { result } = renderHook(() => useOnboardingDismissed());
    await flushMicrotasks();

    act(() => {
      result.current[1]();
    });

    expect(result.current[0]).toBe(true);
    expect(window.localStorage.getItem(STORAGE_KEY)).not.toBeNull();
  });

  it("still updates in-memory state even if the localStorage write itself throws", async () => {
    vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
      throw new Error("quota exceeded");
    });

    const { result } = renderHook(() => useOnboardingDismissed());
    await flushMicrotasks();

    act(() => {
      result.current[1]();
    });

    expect(result.current[0]).toBe(true);
  });

  it("reads through onboarding-storage.ts's isOnboardingDismissed, not localStorage directly", async () => {
    const readSpy = vi.spyOn(onboardingStorageLib, "isOnboardingDismissed");

    renderHook(() => useOnboardingDismissed());
    await flushMicrotasks();

    expect(readSpy).toHaveBeenCalled();
  });

  it("writes through onboarding-storage.ts's dismissOnboarding, not localStorage directly", async () => {
    const writeSpy = vi.spyOn(onboardingStorageLib, "dismissOnboarding");
    const { result } = renderHook(() => useOnboardingDismissed());
    await flushMicrotasks();

    act(() => {
      result.current[1]();
    });

    expect(writeSpy).toHaveBeenCalled();
  });

  // The mount-to-microtask race guard itself (a deferred hydration read
  // clobbering an in-flight setValue update) is now generic shared logic
  // -- see use-hydrated-local-storage-state.test.ts's own dedicated
  // regression test for that. It isn't independently re-tested here: this
  // hook's readStored (readStoredDismissed) only ever reports `true` or
  // `null`, and dismiss() only ever sets `true`, so there's no pair of
  // "stale stored value" vs. "just-set value" that could actually differ
  // and produce an observable clobber for this particular caller the way
  // use-starting-capital.test.ts's numeric version still can.
});
