import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  beatTheBenchKey,
  readPlayedSession,
  savePlayedSession,
  type PlayedSession,
} from "./beat-the-bench-storage";

const RECORD: PlayedSession = {
  played: true,
  outcome: "win",
  playerBalance: 20.0859584,
  benchmarkBalance: 20.0105796,
  moves: 2,
};

describe("beatTheBenchKey", () => {
  // Asserted literally rather than round-tripped -- a rename here would
  // otherwise silently orphan every already-stored record.
  it("is hikt:beat-the-bench:{date}:{mode}", () => {
    expect(beatTheBenchKey("2026-08-26", "todays-close")).toBe(
      "hikt:beat-the-bench:2026-08-26:todays-close",
    );
    expect(beatTheBenchKey("2026-08-26", "mystery")).toBe("hikt:beat-the-bench:2026-08-26:mystery");
  });
});

describe("readPlayedSession / savePlayedSession", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    window.localStorage.clear();
  });

  it("round-trips a finished session", () => {
    expect(savePlayedSession("2026-08-26", "todays-close", RECORD)).toBe(true);
    expect(readPlayedSession("2026-08-26", "todays-close")).toEqual(RECORD);
  });

  it("keeps modes and dates independent", () => {
    savePlayedSession("2026-08-26", "todays-close", RECORD);

    expect(readPlayedSession("2026-08-26", "mystery")).toBeNull();
    expect(readPlayedSession("2026-08-25", "todays-close")).toBeNull();
  });

  it("stores a zero-move play as a real result, not as 'didn't play'", () => {
    const alongForTheRide: PlayedSession = { ...RECORD, outcome: "tie", moves: 0 };
    savePlayedSession("2026-08-26", "todays-close", alongForTheRide);

    expect(readPlayedSession("2026-08-26", "todays-close")).toEqual(alongForTheRide);
  });

  it("reads nothing for a day never played", () => {
    expect(readPlayedSession("2026-08-26", "todays-close")).toBeNull();
  });

  it("treats a malformed or stale-format value as nothing stored", () => {
    const key = beatTheBenchKey("2026-08-26", "todays-close");
    const malformed = [
      "not json at all",
      "null",
      '"win"',
      "[]",
      JSON.stringify({ outcome: "win", playerBalance: 20, benchmarkBalance: 20, moves: 1 }), // no `played`
      JSON.stringify({ ...RECORD, outcome: "draw" }),
      JSON.stringify({ ...RECORD, playerBalance: "20.09" }),
      JSON.stringify({ ...RECORD, benchmarkBalance: Number.NaN }), // serializes to null
      JSON.stringify({ ...RECORD, moves: -1 }),
    ];

    for (const value of malformed) {
      window.localStorage.setItem(key, value);
      expect(readPlayedSession("2026-08-26", "todays-close")).toBeNull();
    }
  });

  // The degradation path this app's whole two-layer localStorage pattern
  // exists for (see local-storage.ts): storage disabled by policy or by
  // private browsing throws on *reads* as well as writes, and a
  // nice-to-have game must never be able to crash the page over it.
  it("degrades to 'never played' when storage itself throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });

    expect(() => savePlayedSession("2026-08-26", "todays-close", RECORD)).not.toThrow();
    expect(savePlayedSession("2026-08-26", "todays-close", RECORD)).toBe(false);
    expect(() => readPlayedSession("2026-08-26", "todays-close")).not.toThrow();
    expect(readPlayedSession("2026-08-26", "todays-close")).toBeNull();
  });
});
