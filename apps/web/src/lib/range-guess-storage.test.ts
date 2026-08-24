import { afterEach, describe, expect, it, vi } from "vitest";

import { getRangeGuess, saveRangeGuess } from "./range-guess-storage";

describe("getRangeGuess / saveRangeGuess", () => {
  afterEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it("returns null for a (range, mode) pair that hasn't been guessed yet", () => {
    expect(getRangeGuess("1M", "long")).toBeNull();
  });

  it("round-trips a saved guess (and the starting capital it was made against) for its exact (range, mode) pair", () => {
    saveRangeGuess("1M", "long", 42.5, 20);

    expect(getRangeGuess("1M", "long")).toEqual({ guess: 42.5, startingCapital: 20 });
  });

  it("keeps guesses for different ranges independent", () => {
    saveRangeGuess("1M", "long", 10, 20);
    saveRangeGuess("3M", "long", 99, 20);

    expect(getRangeGuess("1M", "long")).toEqual({ guess: 10, startingCapital: 20 });
    expect(getRangeGuess("3M", "long")).toEqual({ guess: 99, startingCapital: 20 });
  });

  it("keeps guesses for the same range independent across mode (issue #13) -- the same range can carry a genuinely different chained result depending on long-only vs. long+short", () => {
    saveRangeGuess("1M", "long", 10, 20);
    saveRangeGuess("1M", "long-short", 55, 20);

    expect(getRangeGuess("1M", "long")).toEqual({ guess: 10, startingCapital: 20 });
    expect(getRangeGuess("1M", "long-short")).toEqual({ guess: 55, startingCapital: 20 });
  });

  it("does not treat a guess saved under one mode as satisfying the same range under another mode", () => {
    saveRangeGuess("1M", "long", 10, 20);

    expect(getRangeGuess("1M", "long-short")).toBeNull();
  });

  it("overwrites a previous guess for the same (range, mode) pair", () => {
    saveRangeGuess("1M", "long", 10, 20);
    saveRangeGuess("1M", "long", 20, 20);

    expect(getRangeGuess("1M", "long")).toEqual({ guess: 20, startingCapital: 20 });
  });

  it("treats a corrupted/hand-edited stored value as 'never guessed' rather than throwing", () => {
    window.localStorage.setItem("hikt:range-guess:1M:long", "not valid json{{{");
    expect(() => getRangeGuess("1M", "long")).not.toThrow();
    expect(getRangeGuess("1M", "long")).toBeNull();

    window.localStorage.setItem(
      "hikt:range-guess:1M:long-short",
      JSON.stringify({ guess: "not a number", startingCapital: 20 }),
    );
    expect(getRangeGuess("1M", "long-short")).toBeNull();
  });

  it("treats a negative stored guess as invalid/absent (no real form submission can produce one, so it can only be hand-edited/corrupt)", () => {
    window.localStorage.setItem(
      "hikt:range-guess:1M:long",
      JSON.stringify({ guess: -5, startingCapital: 20 }),
    );

    expect(getRangeGuess("1M", "long")).toBeNull();
  });

  it("treats a non-positive stored startingCapital as invalid/absent (no real form submission can produce one, so it can only be hand-edited/corrupt)", () => {
    window.localStorage.setItem(
      "hikt:range-guess:1M:long",
      JSON.stringify({ guess: 42, startingCapital: 0 }),
    );

    expect(getRangeGuess("1M", "long")).toBeNull();
  });

  it("still accepts a stored guess of exactly 0 (a legitimate guess -- 'it went to zero')", () => {
    window.localStorage.setItem(
      "hikt:range-guess:1M:long",
      JSON.stringify({ guess: 0, startingCapital: 20 }),
    );

    expect(getRangeGuess("1M", "long")).toEqual({ guess: 0, startingCapital: 20 });
  });

  it("degrades to a no-op read/write when localStorage itself throws, without crashing the caller", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });

    expect(() => saveRangeGuess("1M", "long", 5, 20)).not.toThrow();
    expect(getRangeGuess("1M", "long")).toBeNull();
  });
});
