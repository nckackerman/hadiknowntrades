import { afterEach, describe, expect, it, vi } from "vitest";

import { readLocalStorage, subscribeToLocalStorage, writeLocalStorage } from "./local-storage";

describe("readLocalStorage / writeLocalStorage", () => {
  afterEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it("round-trips a written value", () => {
    expect(writeLocalStorage("k", "v")).toBe(true);
    expect(readLocalStorage("k")).toBe("v");
  });

  it("returns null for a key that was never set", () => {
    expect(readLocalStorage("nope")).toBeNull();
  });

  it("returns null when localStorage.getItem throws (e.g. disabled storage)", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });

    expect(readLocalStorage("k")).toBeNull();
  });

  it("returns false, without throwing, when localStorage.setItem throws (e.g. Safari private browsing)", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });

    expect(() => writeLocalStorage("k", "v")).not.toThrow();
    expect(writeLocalStorage("k", "v")).toBe(false);
  });

  it("returns null/false without touching localStorage when window is unavailable (SSR)", () => {
    const originalWindow = globalThis.window;
    // @ts-expect-error -- deliberately simulating an SSR environment where `window` doesn't exist.
    delete globalThis.window;

    try {
      expect(readLocalStorage("k")).toBeNull();
      expect(writeLocalStorage("k", "v")).toBe(false);
    } finally {
      globalThis.window = originalWindow;
    }
  });
});

describe("subscribeToLocalStorage (issue #133)", () => {
  afterEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it("notifies subscribers on a successful write", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToLocalStorage(listener);

    writeLocalStorage("k", "v");

    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("stops notifying once unsubscribed", () => {
    const listener = vi.fn();
    subscribeToLocalStorage(listener)();

    writeLocalStorage("k", "v");

    expect(listener).not.toHaveBeenCalled();
  });

  it("does not notify for a write that failed -- nothing changed", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToLocalStorage(listener);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });

    expect(writeLocalStorage("k", "v")).toBe(false);
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("notifies every subscriber, and survives one unsubscribing itself mid-notification", () => {
    const other = vi.fn();
    // A React effect cleanup racing a write really can do this; iterating
    // the live set would skip `other` (or throw) if it did.
    const unsubscribeSelf = subscribeToLocalStorage(() => unsubscribeSelf());
    const unsubscribeOther = subscribeToLocalStorage(other);

    writeLocalStorage("k", "v");

    expect(other).toHaveBeenCalledTimes(1);
    unsubscribeOther();
  });

  it("also notifies on a cross-tab `storage` event", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToLocalStorage(listener);

    // The browser fires this only for writes made in *other* tabs of the
    // same origin, never for the document that did the writing -- which is
    // why the in-process notification above has to exist as well.
    window.dispatchEvent(new StorageEvent("storage", { key: "k", newValue: "v" }));

    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });
});
