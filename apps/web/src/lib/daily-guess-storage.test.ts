import { afterEach, describe, expect, it, vi } from "vitest";

import { getDailyGuess, saveDailyGuess } from "./daily-guess-storage";

describe("getDailyGuess / saveDailyGuess", () => {
  afterEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it("returns null for a date that hasn't been guessed yet", () => {
    expect(getDailyGuess("2026-08-20")).toBeNull();
  });

  it("round-trips a saved guess for its exact date", () => {
    saveDailyGuess("2026-08-20", 42.5);

    expect(getDailyGuess("2026-08-20")).toBe(42.5);
  });

  it("keeps guesses for different dates independent", () => {
    saveDailyGuess("2026-08-20", 10);
    saveDailyGuess("2026-08-21", 99);

    expect(getDailyGuess("2026-08-20")).toBe(10);
    expect(getDailyGuess("2026-08-21")).toBe(99);
  });

  it("overwrites a previous guess for the same date", () => {
    saveDailyGuess("2026-08-20", 10);
    saveDailyGuess("2026-08-20", 20);

    expect(getDailyGuess("2026-08-20")).toBe(20);
  });

  it("treats a corrupted/hand-edited stored value as 'never guessed' rather than throwing", () => {
    window.localStorage.setItem("hikt:daily-guess:2026-08-20", "not valid json{{{");
    expect(() => getDailyGuess("2026-08-20")).not.toThrow();
    expect(getDailyGuess("2026-08-20")).toBeNull();

    window.localStorage.setItem(
      "hikt:daily-guess:2026-08-21",
      JSON.stringify({ guess: "not a number" }),
    );
    expect(getDailyGuess("2026-08-21")).toBeNull();

    window.localStorage.setItem("hikt:daily-guess:2026-08-22", JSON.stringify({ nope: 1 }));
    expect(getDailyGuess("2026-08-22")).toBeNull();
  });

  it("degrades to a no-op read/write when localStorage itself throws, without crashing the caller", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });

    expect(() => saveDailyGuess("2026-08-20", 5)).not.toThrow();
    expect(getDailyGuess("2026-08-20")).toBeNull();
  });
});
