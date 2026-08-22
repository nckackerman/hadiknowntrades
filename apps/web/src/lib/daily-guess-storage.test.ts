import { afterEach, describe, expect, it, vi } from "vitest";

import { getDailyGuess, saveDailyGuess } from "./daily-guess-storage";

describe("getDailyGuess / saveDailyGuess", () => {
  afterEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it("returns null for a (range, date) pair that hasn't been guessed yet", () => {
    expect(getDailyGuess("1M", "2026-08-20")).toBeNull();
  });

  it("round-trips a saved guess (and the starting capital it was made against) for its exact (range, date) pair", () => {
    saveDailyGuess("1M", "2026-08-20", 42.5, 20);

    expect(getDailyGuess("1M", "2026-08-20")).toEqual({ guess: 42.5, startingCapital: 20 });
  });

  it("keeps guesses for different dates independent", () => {
    saveDailyGuess("1M", "2026-08-20", 10, 20);
    saveDailyGuess("1M", "2026-08-21", 99, 20);

    expect(getDailyGuess("1M", "2026-08-20")).toEqual({ guess: 10, startingCapital: 20 });
    expect(getDailyGuess("1M", "2026-08-21")).toEqual({ guess: 99, startingCapital: 20 });
  });

  it("keeps guesses for the same date on different ranges independent (per issue: 1M/3M/1Y can genuinely differ on the same date)", () => {
    saveDailyGuess("1M", "2026-08-20", 10, 20);
    saveDailyGuess("3M", "2026-08-20", 25, 20);
    saveDailyGuess("1Y", "2026-08-20", 99, 20);

    expect(getDailyGuess("1M", "2026-08-20")).toEqual({ guess: 10, startingCapital: 20 });
    expect(getDailyGuess("3M", "2026-08-20")).toEqual({ guess: 25, startingCapital: 20 });
    expect(getDailyGuess("1Y", "2026-08-20")).toEqual({ guess: 99, startingCapital: 20 });
  });

  it("does not treat a guess saved under one range as satisfying the same date under another range", () => {
    saveDailyGuess("1M", "2026-08-20", 10, 20);

    expect(getDailyGuess("3M", "2026-08-20")).toBeNull();
    expect(getDailyGuess("1Y", "2026-08-20")).toBeNull();
  });

  it("overwrites a previous guess for the same (range, date) pair", () => {
    saveDailyGuess("1M", "2026-08-20", 10, 20);
    saveDailyGuess("1M", "2026-08-20", 20, 20);

    expect(getDailyGuess("1M", "2026-08-20")).toEqual({ guess: 20, startingCapital: 20 });
  });

  it("treats a corrupted/hand-edited stored value as 'never guessed' rather than throwing", () => {
    window.localStorage.setItem("hikt:daily-guess:1M:2026-08-20", "not valid json{{{");
    expect(() => getDailyGuess("1M", "2026-08-20")).not.toThrow();
    expect(getDailyGuess("1M", "2026-08-20")).toBeNull();

    window.localStorage.setItem(
      "hikt:daily-guess:1M:2026-08-21",
      JSON.stringify({ guess: "not a number", startingCapital: 20 }),
    );
    expect(getDailyGuess("1M", "2026-08-21")).toBeNull();

    window.localStorage.setItem("hikt:daily-guess:1M:2026-08-22", JSON.stringify({ nope: 1 }));
    expect(getDailyGuess("1M", "2026-08-22")).toBeNull();
  });

  it("treats a negative stored guess as invalid/absent (no real form submission can produce one, so it can only be hand-edited/corrupt)", () => {
    window.localStorage.setItem(
      "hikt:daily-guess:1M:2026-08-20",
      JSON.stringify({ guess: -5, startingCapital: 20 }),
    );

    expect(getDailyGuess("1M", "2026-08-20")).toBeNull();
  });

  it("treats a non-positive stored startingCapital as invalid/absent (no real form submission can produce one, so it can only be hand-edited/corrupt)", () => {
    window.localStorage.setItem(
      "hikt:daily-guess:1M:2026-08-20",
      JSON.stringify({ guess: 42, startingCapital: 0 }),
    );

    expect(getDailyGuess("1M", "2026-08-20")).toBeNull();
  });

  it("still accepts a stored guess of exactly 0 (a legitimate guess -- 'it went to zero')", () => {
    window.localStorage.setItem(
      "hikt:daily-guess:1M:2026-08-20",
      JSON.stringify({ guess: 0, startingCapital: 20 }),
    );

    expect(getDailyGuess("1M", "2026-08-20")).toEqual({ guess: 0, startingCapital: 20 });
  });

  it("degrades to a no-op read/write when localStorage itself throws, without crashing the caller", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });

    expect(() => saveDailyGuess("1M", "2026-08-20", 5, 20)).not.toThrow();
    expect(getDailyGuess("1M", "2026-08-20")).toBeNull();
  });
});
