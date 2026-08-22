import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as localStorageLib from "./local-storage";
import { DEFAULT_STARTING_CAPITAL, MAX_STARTING_CAPITAL } from "./starting-capital";
import { useStartingCapital } from "./use-starting-capital";

const STORAGE_KEY = "hikt:startingCapital";

/** The hook's mount-time "hydrate from storage" correction runs inside a
 * microtask (see use-starting-capital.ts's own comment on why), not
 * synchronously during render -- tests that need to observe the
 * corrected value must flush the microtask queue first. */
async function flushMicrotasks(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

describe("useStartingCapital", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("defaults to DEFAULT_STARTING_CAPITAL when nothing is stored", async () => {
    const { result } = renderHook(() => useStartingCapital());
    await flushMicrotasks();

    expect(result.current[0]).toBe(DEFAULT_STARTING_CAPITAL);
  });

  it("starts at DEFAULT_STARTING_CAPITAL on the very first render, even when a different value is already stored -- the hydration-safety tradeoff this hook's own doc comment describes", () => {
    window.localStorage.setItem(STORAGE_KEY, "5000");

    const { result } = renderHook(() => useStartingCapital());

    expect(result.current[0]).toBe(DEFAULT_STARTING_CAPITAL);
  });

  it("hydrates from a previously stored value shortly after mount", async () => {
    window.localStorage.setItem(STORAGE_KEY, "5000");

    const { result } = renderHook(() => useStartingCapital());
    await flushMicrotasks();

    expect(result.current[0]).toBe(5000);
  });

  it("falls back to the default for a stored value that no longer parses (corrupted/garbage data)", async () => {
    window.localStorage.setItem(STORAGE_KEY, "not-a-number");

    const { result } = renderHook(() => useStartingCapital());
    await flushMicrotasks();

    expect(result.current[0]).toBe(DEFAULT_STARTING_CAPITAL);
  });

  it("falls back to the default when localStorage.getItem itself throws (e.g. private-mode Safari)", async () => {
    vi.spyOn(window.localStorage, "getItem").mockImplementation(() => {
      throw new Error("access denied");
    });

    const { result } = renderHook(() => useStartingCapital());
    await flushMicrotasks();

    expect(result.current[0]).toBe(DEFAULT_STARTING_CAPITAL);
  });

  it("updates state and persists the (clamped) value to localStorage", async () => {
    const { result } = renderHook(() => useStartingCapital());
    await flushMicrotasks();

    act(() => {
      result.current[1](1000);
    });

    expect(result.current[0]).toBe(1000);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("1000");
  });

  it("clamps an out-of-range value on write", async () => {
    const { result } = renderHook(() => useStartingCapital());
    await flushMicrotasks();

    act(() => {
      result.current[1](Number.MAX_SAFE_INTEGER);
    });

    expect(result.current[0]).toBe(MAX_STARTING_CAPITAL);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe(String(MAX_STARTING_CAPITAL));
  });

  it("still updates in-memory state even if the localStorage write itself throws", async () => {
    vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
      throw new Error("quota exceeded");
    });

    const { result } = renderHook(() => useStartingCapital());
    await flushMicrotasks();

    act(() => {
      result.current[1](250);
    });

    expect(result.current[0]).toBe(250);
  });

  // Regression coverage for a real code-review finding: this hook used to
  // call window.localStorage.getItem/setItem directly, duplicating the
  // try/catch/SSR-guard logic apps/web/CLAUDE.md documents
  // local-storage.ts's readLocalStorage/writeLocalStorage as the one
  // place this app should do that. These assert the hook actually routes
  // through those shared helpers (not just that the end-to-end behavior
  // happens to match, which the tests above already cover) so a future
  // change back to a direct window.localStorage call would fail here.
  it("reads through local-storage.ts's readLocalStorage, not window.localStorage directly", async () => {
    const readSpy = vi.spyOn(localStorageLib, "readLocalStorage");

    renderHook(() => useStartingCapital());
    await flushMicrotasks();

    expect(readSpy).toHaveBeenCalledWith(STORAGE_KEY);
  });

  it("writes through local-storage.ts's writeLocalStorage, not window.localStorage directly", async () => {
    const writeSpy = vi.spyOn(localStorageLib, "writeLocalStorage");
    const { result } = renderHook(() => useStartingCapital());
    await flushMicrotasks();

    act(() => {
      result.current[1](1000);
    });

    expect(writeSpy).toHaveBeenCalledWith(STORAGE_KEY, "1000");
  });
});
