import { afterEach, describe, expect, it, vi } from "vitest";

import { getDailyGuess, saveDailyGuess } from "./daily-guess-storage";

describe("getDailyGuess / saveDailyGuess", () => {
  afterEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it("returns null for a (range, date, mode) triple that hasn't been guessed yet", () => {
    expect(getDailyGuess("1M", "2026-08-20", "long")).toBeNull();
  });

  it("round-trips a saved guess (and the starting capital it was made against) for its exact (range, date, mode) triple", () => {
    saveDailyGuess("1M", "2026-08-20", "long", 42.5, 20);

    expect(getDailyGuess("1M", "2026-08-20", "long")).toEqual({ guess: 42.5, startingCapital: 20 });
  });

  it("keeps guesses for different dates independent", () => {
    saveDailyGuess("1M", "2026-08-20", "long", 10, 20);
    saveDailyGuess("1M", "2026-08-21", "long", 99, 20);

    expect(getDailyGuess("1M", "2026-08-20", "long")).toEqual({ guess: 10, startingCapital: 20 });
    expect(getDailyGuess("1M", "2026-08-21", "long")).toEqual({ guess: 99, startingCapital: 20 });
  });

  it("keeps guesses for the same date on different ranges independent (per issue: 1M/3M/1Y can genuinely differ on the same date)", () => {
    saveDailyGuess("1M", "2026-08-20", "long", 10, 20);
    saveDailyGuess("3M", "2026-08-20", "long", 25, 20);
    saveDailyGuess("1Y", "2026-08-20", "long", 99, 20);

    expect(getDailyGuess("1M", "2026-08-20", "long")).toEqual({ guess: 10, startingCapital: 20 });
    expect(getDailyGuess("3M", "2026-08-20", "long")).toEqual({ guess: 25, startingCapital: 20 });
    expect(getDailyGuess("1Y", "2026-08-20", "long")).toEqual({ guess: 99, startingCapital: 20 });
  });

  it("does not treat a guess saved under one range as satisfying the same date under another range", () => {
    saveDailyGuess("1M", "2026-08-20", "long", 10, 20);

    expect(getDailyGuess("3M", "2026-08-20", "long")).toBeNull();
    expect(getDailyGuess("1Y", "2026-08-20", "long")).toBeNull();
  });

  it("keeps guesses for the same (range, date) independent across mode (issue #13) -- the same date can carry a genuinely different result depending on long-only vs. long+short", () => {
    saveDailyGuess("1M", "2026-08-20", "long", 10, 20);
    saveDailyGuess("1M", "2026-08-20", "long-short", 55, 20);

    expect(getDailyGuess("1M", "2026-08-20", "long")).toEqual({ guess: 10, startingCapital: 20 });
    expect(getDailyGuess("1M", "2026-08-20", "long-short")).toEqual({
      guess: 55,
      startingCapital: 20,
    });
  });

  it("does not treat a guess saved under one mode as satisfying the same (range, date) under another mode", () => {
    saveDailyGuess("1M", "2026-08-20", "long", 10, 20);

    expect(getDailyGuess("1M", "2026-08-20", "long-short")).toBeNull();
  });

  it("overwrites a previous guess for the same (range, date, mode) triple", () => {
    saveDailyGuess("1M", "2026-08-20", "long", 10, 20);
    saveDailyGuess("1M", "2026-08-20", "long", 20, 20);

    expect(getDailyGuess("1M", "2026-08-20", "long")).toEqual({ guess: 20, startingCapital: 20 });
  });

  it("treats a corrupted/hand-edited stored value as 'never guessed' rather than throwing", () => {
    window.localStorage.setItem("hikt:daily-guess:1M:2026-08-20:long", "not valid json{{{");
    expect(() => getDailyGuess("1M", "2026-08-20", "long")).not.toThrow();
    expect(getDailyGuess("1M", "2026-08-20", "long")).toBeNull();

    window.localStorage.setItem(
      "hikt:daily-guess:1M:2026-08-21:long",
      JSON.stringify({ guess: "not a number", startingCapital: 20 }),
    );
    expect(getDailyGuess("1M", "2026-08-21", "long")).toBeNull();

    window.localStorage.setItem("hikt:daily-guess:1M:2026-08-22:long", JSON.stringify({ nope: 1 }));
    expect(getDailyGuess("1M", "2026-08-22", "long")).toBeNull();
  });

  it("treats a negative stored guess as invalid/absent (no real form submission can produce one, so it can only be hand-edited/corrupt)", () => {
    window.localStorage.setItem(
      "hikt:daily-guess:1M:2026-08-20:long",
      JSON.stringify({ guess: -5, startingCapital: 20 }),
    );

    expect(getDailyGuess("1M", "2026-08-20", "long")).toBeNull();
  });

  it("treats a non-positive stored startingCapital as invalid/absent (no real form submission can produce one, so it can only be hand-edited/corrupt)", () => {
    window.localStorage.setItem(
      "hikt:daily-guess:1M:2026-08-20:long",
      JSON.stringify({ guess: 42, startingCapital: 0 }),
    );

    expect(getDailyGuess("1M", "2026-08-20", "long")).toBeNull();
  });

  it("still accepts a stored guess of exactly 0 (a legitimate guess -- 'it went to zero')", () => {
    window.localStorage.setItem(
      "hikt:daily-guess:1M:2026-08-20:long",
      JSON.stringify({ guess: 0, startingCapital: 20 }),
    );

    expect(getDailyGuess("1M", "2026-08-20", "long")).toEqual({ guess: 0, startingCapital: 20 });
  });

  describe("legacy two-part key fallback (issue #13's mode toggle changed the key format)", () => {
    it("falls back to the pre-issue-#13 two-part key for mode 'long' when the new three-part key has nothing", () => {
      window.localStorage.setItem(
        "hikt:daily-guess:1M:2026-08-20",
        JSON.stringify({ guess: 15, startingCapital: 20 }),
      );

      expect(getDailyGuess("1M", "2026-08-20", "long")).toEqual({
        guess: 15,
        startingCapital: 20,
      });
    });

    it("does not fall back to the legacy key for mode 'long-short' (that mode never had an old-format entry)", () => {
      window.localStorage.setItem(
        "hikt:daily-guess:1M:2026-08-20",
        JSON.stringify({ guess: 15, startingCapital: 20 }),
      );

      expect(getDailyGuess("1M", "2026-08-20", "long-short")).toBeNull();
    });

    it("prefers a value at the new three-part key over the legacy key when both exist", () => {
      window.localStorage.setItem(
        "hikt:daily-guess:1M:2026-08-20",
        JSON.stringify({ guess: 15, startingCapital: 20 }),
      );
      saveDailyGuess("1M", "2026-08-20", "long", 30, 20);

      expect(getDailyGuess("1M", "2026-08-20", "long")).toEqual({
        guess: 30,
        startingCapital: 20,
      });
    });

    it("treats a corrupted legacy-key value as 'never guessed' rather than throwing", () => {
      window.localStorage.setItem("hikt:daily-guess:1M:2026-08-20", "not valid json{{{");

      expect(() => getDailyGuess("1M", "2026-08-20", "long")).not.toThrow();
      expect(getDailyGuess("1M", "2026-08-20", "long")).toBeNull();
    });

    it("does not treat a legacy-key entry under one range as satisfying the same date under another range", () => {
      window.localStorage.setItem(
        "hikt:daily-guess:1M:2026-08-20",
        JSON.stringify({ guess: 15, startingCapital: 20 }),
      );

      expect(getDailyGuess("3M", "2026-08-20", "long")).toBeNull();
    });
  });

  it("degrades to a no-op read/write when localStorage itself throws, without crashing the caller", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });

    expect(() => saveDailyGuess("1M", "2026-08-20", "long", 5, 20)).not.toThrow();
    expect(getDailyGuess("1M", "2026-08-20", "long")).toBeNull();
  });
});
