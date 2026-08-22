import { afterEach, describe, expect, it, vi } from "vitest";

import { readLocalStorage, writeLocalStorage } from "./local-storage";

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
