import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useHydratedLocalStorageState } from "./use-hydrated-local-storage-state";

/** The hook's mount-time "hydrate from storage" correction runs inside a
 * microtask (see the hook's own comment on why) -- tests that need to
 * observe the corrected value must flush the microtask queue first. */
async function flushMicrotasks(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

describe("useHydratedLocalStorageState", () => {
  it("returns the default value on the very first render, even when readStored would return something else -- the hydration-safety tradeoff this hook exists for", () => {
    const readStored = vi.fn(() => "stored");

    const { result } = renderHook(() =>
      useHydratedLocalStorageState<string>("default", readStored, vi.fn()),
    );

    expect(result.current[0]).toBe("default");
  });

  it("corrects to the stored value shortly after mount when readStored finds one", async () => {
    const readStored = vi.fn(() => "stored");

    const { result } = renderHook(() =>
      useHydratedLocalStorageState<string>("default", readStored, vi.fn()),
    );
    await flushMicrotasks();

    expect(result.current[0]).toBe("stored");
  });

  it("stays at the default when readStored finds nothing (returns null)", async () => {
    const readStored = vi.fn(() => null);

    const { result } = renderHook(() =>
      useHydratedLocalStorageState<string>("default", readStored, vi.fn()),
    );
    await flushMicrotasks();

    expect(result.current[0]).toBe("default");
  });

  it("updates state and calls writeStored when setValue is called", async () => {
    const readStored = vi.fn(() => null);
    const writeStored = vi.fn();

    const { result } = renderHook(() =>
      useHydratedLocalStorageState<string>("default", readStored, writeStored),
    );
    await flushMicrotasks();

    act(() => {
      result.current[1]("next");
    });

    expect(result.current[0]).toBe("next");
    expect(writeStored).toHaveBeenCalledWith("next");
  });

  // Regression coverage for the race-condition guard use-starting-capital.ts
  // originally established (see its own git history): the mount effect's
  // hydration read is deferred to a microtask, leaving a window between
  // mount and that microtask actually running. A setValue call landing in
  // that window must not get clobbered back to a stale readStored() result
  // once the deferred microtask finally runs.
  it("keeps an in-flight setValue update instead of letting the deferred hydration microtask clobber it with a stale readStored() result", async () => {
    const readStored = vi.fn(() => "stale");

    const { result } = renderHook(() =>
      useHydratedLocalStorageState<string>("default", readStored, vi.fn()),
    );

    // Synchronously, in the window between mount (which queues the
    // hydration microtask) and that microtask actually running.
    act(() => {
      result.current[1]("fresh");
    });

    await flushMicrotasks();

    // Without the guard, the now-run hydration microtask would have
    // overwritten this back to "stale".
    expect(result.current[0]).toBe("fresh");
  });
});
