import { describe, expect, it } from "vitest";

import {
  DEFAULT_STARTING_CAPITAL,
  MAX_STARTING_CAPITAL,
  MIN_STARTING_CAPITAL,
  clampStartingCapital,
  parseStartingCapital,
} from "./starting-capital";

describe("clampStartingCapital", () => {
  it("leaves an in-range value untouched", () => {
    expect(clampStartingCapital(500)).toBe(500);
  });

  it("clamps a value below MIN_STARTING_CAPITAL up to the minimum", () => {
    expect(clampStartingCapital(0)).toBe(MIN_STARTING_CAPITAL);
    expect(clampStartingCapital(-100)).toBe(MIN_STARTING_CAPITAL);
  });

  it("clamps a value above MAX_STARTING_CAPITAL down to the maximum", () => {
    expect(clampStartingCapital(Number.MAX_SAFE_INTEGER)).toBe(MAX_STARTING_CAPITAL);
  });
});

describe("parseStartingCapital", () => {
  it("parses a plain positive number", () => {
    expect(parseStartingCapital("1000")).toBe(1000);
  });

  it("parses and clamps a value above the maximum", () => {
    expect(parseStartingCapital("999999999999")).toBe(MAX_STARTING_CAPITAL);
  });

  it("returns null for blank/whitespace-only input", () => {
    expect(parseStartingCapital("")).toBeNull();
    expect(parseStartingCapital("   ")).toBeNull();
  });

  it("returns null for non-numeric text", () => {
    expect(parseStartingCapital("abc")).toBeNull();
  });

  it("returns null for zero or negative input", () => {
    expect(parseStartingCapital("0")).toBeNull();
    expect(parseStartingCapital("-20")).toBeNull();
  });

  it("returns null for NaN/Infinity-producing input", () => {
    expect(parseStartingCapital("Infinity")).toBeNull();
    expect(parseStartingCapital("NaN")).toBeNull();
  });

  it("still parses today's fixed default", () => {
    expect(parseStartingCapital(String(DEFAULT_STARTING_CAPITAL))).toBe(DEFAULT_STARTING_CAPITAL);
  });
});
