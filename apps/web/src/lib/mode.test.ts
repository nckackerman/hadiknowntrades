import { describe, expect, it } from "vitest";

import { DEFAULT_MODE, parseMode } from "./mode";

describe("parseMode", () => {
  it("accepts both modes, case-insensitively", () => {
    expect(parseMode("long")).toBe("long");
    expect(parseMode("LONG")).toBe("long");
    expect(parseMode("long-short")).toBe("long-short");
    expect(parseMode("Long-Short")).toBe("long-short");
  });

  it("rejects null, empty, and unsupported values", () => {
    expect(parseMode(null)).toBeNull();
    expect(parseMode("")).toBeNull();
    expect(parseMode("short")).toBeNull();
    expect(parseMode("bogus")).toBeNull();
  });
});

describe("DEFAULT_MODE", () => {
  it("is 'long' -- an existing shared link with no ?mode= keeps showing exactly what it showed before this toggle existed", () => {
    expect(DEFAULT_MODE).toBe("long");
  });
});
