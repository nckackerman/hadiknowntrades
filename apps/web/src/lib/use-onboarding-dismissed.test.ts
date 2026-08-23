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

  // Regression coverage mirroring use-starting-capital.test.ts's identical
  // race-condition test: the mount effect's hydration read is deferred to
  // a microtask, leaving a window between mount and that microtask
  // actually running. A dismiss() call landing in that window must not get
  // clobbered back to "not dismissed" once the deferred microtask finally
  // runs against stale-looking storage state.
  it("keeps an in-flight dismiss() update instead of letting the deferred hydration microtask clobber it (race condition guard)", async () => {
    vi.spyOn(onboardingStorageLib, "isOnboardingDismissed").mockReturnValue(false);

    const { result } = renderHook(() => useOnboardingDismissed());

    // Synchronously, in the window between mount (which queues the
    // hydration microtask) and that microtask actually running.
    act(() => {
      result.current[1]();
    });

    await flushMicrotasks();

    // Without the guard, the now-run hydration microtask (seeing the
    // mocked "not dismissed" storage read) would have set this back to
    // false.
    expect(result.current[0]).toBe(true);
  });
});
