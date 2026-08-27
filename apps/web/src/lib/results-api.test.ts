import {
  MYSTERY_INDEX_KEY,
  MYSTERY_POOL_MANIFEST_KEY,
  mysterySessionKey,
  PRESET_RANGES,
  RESULTS_SCHEMA_VERSION,
  TODAYS_CLOSE_SESSION_KEY,
  type CustomWindowResult,
  type PrecomputedResult,
} from "@hadiknowntrades/core";
import { describe, expect, it, vi } from "vitest";

import {
  getCustomAnchorsResponse,
  getCustomResultsResponse,
  getMysteryRevealResponse,
  getMysterySessionResponse,
  getResultsResponse,
  getTodaysCloseSessionResponse,
  isCanonicalRange,
  isMysterySessionId,
  parseAnchorDate,
  parseRange,
  type ResultReader,
} from "./results-api";

function fixtureResult(range: (typeof PRESET_RANGES)[number]): PrecomputedResult {
  return {
    schemaVersion: RESULTS_SCHEMA_VERSION,
    model: "window",
    range,
    generatedAt: "2024-06-15T00:00:00.000Z",
    dataAsOf: "2024-06-14",
    startDate: "2024-05-14",
    endDate: "2024-06-15",
    maxTrades: 3,
    startingCapital: 20,
    endingBalance: 42,
    trades: [],
    worstCase: { endingBalance: 20, trades: [] },
    longShort: { endingBalance: 42, trades: [], worstCase: { endingBalance: 20, trades: [] } },
    universeSize: 500,
    skippedTickers: [],
    benchmark: null,
    benchmarkSeries: null,
  };
}

function fixtureCustomResult(anchorDate: string): CustomWindowResult {
  return {
    schemaVersion: RESULTS_SCHEMA_VERSION,
    model: "custom-window",
    anchorDate,
    generatedAt: "2024-06-15T00:00:00.000Z",
    dataAsOf: "2024-06-14",
    startDate: anchorDate,
    endDate: "2024-06-15",
    maxTrades: 3,
    startingCapital: 20,
    endingBalance: 42,
    trades: [],
    worstCase: { endingBalance: 20, trades: [] },
    longShort: { endingBalance: 42, trades: [], worstCase: { endingBalance: 20, trades: [] } },
    universeSize: 500,
    skippedTickers: [],
    benchmark: null,
  };
}

/** A ResultReader backed by a plain Map, so tests can control exactly what's "in the bucket". */
function memoryReader(objects: Map<string, string>): ResultReader {
  return {
    async getObject(key) {
      return objects.get(key) ?? null;
    },
  };
}

describe("parseRange", () => {
  it("accepts every preset range, case-insensitively", () => {
    for (const range of PRESET_RANGES) {
      expect(parseRange(range)).toBe(range);
      expect(parseRange(range.toLowerCase())).toBe(range);
    }
  });

  it("rejects null, empty, and unsupported values", () => {
    expect(parseRange(null)).toBeNull();
    expect(parseRange("")).toBeNull();
    expect(parseRange("2Y")).toBeNull();
    expect(parseRange("bogus")).toBeNull();
  });
});

describe("isCanonicalRange", () => {
  it("accepts every preset range, exact-case only", () => {
    for (const range of PRESET_RANGES) {
      expect(isCanonicalRange(range)).toBe(true);
    }
  });

  it("rejects case variants of a valid range -- unlike parseRange, this check does not fold case", () => {
    for (const range of PRESET_RANGES) {
      expect(isCanonicalRange(range.toLowerCase())).toBe(false);
    }
    expect(isCanonicalRange("Max")).toBe(false);
    expect(isCanonicalRange("max")).toBe(false);
  });

  it("rejects empty and unsupported values", () => {
    expect(isCanonicalRange("")).toBe(false);
    expect(isCanonicalRange("2Y")).toBe(false);
    expect(isCanonicalRange("bogus")).toBe(false);
    expect(isCanonicalRange("not-a-range")).toBe(false);
  });
});

describe("getResultsResponse", () => {
  it("returns a clear 400 error for a missing range", async () => {
    const response = await getResultsResponse(null, memoryReader(new Map()));

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("invalid_range");
    expect(body.message).toContain("1M");
    expect(body.message).toContain("MAX");
  });

  it("returns a clear 400 error for an unsupported range", async () => {
    const response = await getResultsResponse("2Y", memoryReader(new Map()));

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("invalid_range");
    expect(body.message).toContain("2Y");
  });

  it("returns a 500 when no reader is configured (RESULTS_BUCKET unset)", async () => {
    const response = await getResultsResponse("1Y", null);

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error).toBe("server_misconfigured");
  });

  it("returns a 404 when the range hasn't been published yet", async () => {
    const response = await getResultsResponse("1Y", memoryReader(new Map()));

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error).toBe("not_found");
  });

  it("returns a 502 when the S3 read fails", async () => {
    const reader: ResultReader = {
      getObject: vi.fn().mockRejectedValue(new Error("access denied")),
    };

    const response = await getResultsResponse("1Y", reader);

    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body.error).toBe("upstream_error");
  });

  it("returns a 502 when the stored object isn't valid JSON", async () => {
    const objects = new Map([["results/1Y.json", "{not json"]]);

    const response = await getResultsResponse("1Y", memoryReader(objects));

    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body.error).toBe("corrupt_data");
  });

  it("returns a 502 (not an uncaught TypeError) when the stored object parses to `null` -- a plausible partial-write shape", async () => {
    const objects = new Map([["results/1Y.json", "null"]]);

    const response = await getResultsResponse("1Y", memoryReader(objects));

    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body.error).toBe("corrupt_data");
  });

  it("returns a 502 when the stored object parses to a non-object primitive", async () => {
    const objects = new Map([["results/1Y.json", "42"]]);

    const response = await getResultsResponse("1Y", memoryReader(objects));

    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body.error).toBe("corrupt_data");
  });

  it("reads the range-specific key and returns the parsed result with 200 and caching headers, case-insensitively", async () => {
    const result = fixtureResult("1Y");
    const objects = new Map([["results/1Y.json", JSON.stringify(result)]]);

    const response = await getResultsResponse("1y", memoryReader(objects));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual(result);
    const cacheControl = response.headers.get("Cache-Control");
    expect(cacheControl).toContain("max-age=300");
    expect(cacheControl).toContain("stale-while-revalidate");
  });

  it("reads a distinct key per range", async () => {
    const getObject = vi.fn().mockResolvedValue(JSON.stringify(fixtureResult("MAX")));
    const reader: ResultReader = { getObject };

    await getResultsResponse("max", reader);

    expect(getObject).toHaveBeenCalledWith("results/MAX.json");
  });

  it("returns a 502 when the stored object's schemaVersion doesn't match the reader's", async () => {
    const staleResult = { ...fixtureResult("1Y"), schemaVersion: 999 };
    const objects = new Map([["results/1Y.json", JSON.stringify(staleResult)]]);

    const response = await getResultsResponse("1Y", memoryReader(objects));

    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body.error).toBe("schema_mismatch");
  });

  it("returns a 502 when a current-schemaVersion object has an unrecognized `model` (e.g. a partial/corrupted write)", async () => {
    // schemaVersion alone doesn't guarantee `model` is one of the two
    // real values -- issue #28 made PrecomputedResult a discriminated
    // union, and this is the check that catches a corrupted/wrong
    // discriminant instead of letting it reach the UI and crash on a
    // missing field (e.g. `.trades` on what the reader assumed was a
    // WindowResult).
    const corrupted = { ...fixtureResult("1Y"), model: "bogus-model" };
    const objects = new Map([["results/1Y.json", JSON.stringify(corrupted)]]);

    const response = await getResultsResponse("1Y", memoryReader(objects));

    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body.error).toBe("schema_mismatch");
  });

  it("sets Cache-Control: no-store on every error response", async () => {
    const responses = await Promise.all([
      getResultsResponse(null, memoryReader(new Map())),
      getResultsResponse("1Y", null),
      getResultsResponse("1Y", memoryReader(new Map())),
    ]);

    for (const response of responses) {
      expect(response.headers.get("Cache-Control")).toBe("no-store");
    }
  });
});

describe("parseAnchorDate", () => {
  it("accepts a well-formed YYYY-MM-DD anchor", () => {
    expect(parseAnchorDate("2019-03-15")).toBe("2019-03-15");
  });

  it("rejects null, empty, and malformed values", () => {
    expect(parseAnchorDate(null)).toBeNull();
    expect(parseAnchorDate("")).toBeNull();
    expect(parseAnchorDate("2019-3-15")).toBeNull();
    expect(parseAnchorDate("2019/03/15")).toBeNull();
    expect(parseAnchorDate("2019-03")).toBeNull();
    expect(parseAnchorDate("bogus")).toBeNull();
  });

  it("rejects a month outside 01-12", () => {
    expect(parseAnchorDate("2019-00-15")).toBeNull();
    expect(parseAnchorDate("2019-13-15")).toBeNull();
  });

  it("rejects a day outside 01-31", () => {
    expect(parseAnchorDate("2019-03-00")).toBeNull();
    expect(parseAnchorDate("2019-03-32")).toBeNull();
  });
});

describe("getCustomResultsResponse", () => {
  it("returns a clear 400 error for a missing anchor", async () => {
    const response = await getCustomResultsResponse(null, memoryReader(new Map()));

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("invalid_anchor");
  });

  it("returns a clear 400 error for a malformed anchor", async () => {
    const response = await getCustomResultsResponse("not-a-date", memoryReader(new Map()));

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("invalid_anchor");
    expect(body.message).toContain("not-a-date");
  });

  it("returns a 500 when no reader is configured (RESULTS_BUCKET unset)", async () => {
    const response = await getCustomResultsResponse("2019-03-15", null);

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error).toBe("server_misconfigured");
  });

  it("returns a 404 when the anchor hasn't been published yet (or is out of the supported range)", async () => {
    const response = await getCustomResultsResponse("2019-03-15", memoryReader(new Map()));

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error).toBe("not_found");
  });

  it("returns a 502 when the S3 read fails", async () => {
    const reader: ResultReader = {
      getObject: vi.fn().mockRejectedValue(new Error("access denied")),
    };

    const response = await getCustomResultsResponse("2019-03-15", reader);

    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body.error).toBe("upstream_error");
  });

  it("returns a 502 when the stored object isn't valid JSON", async () => {
    const objects = new Map([["results/custom/2019-03-15.json", "{not json"]]);

    const response = await getCustomResultsResponse("2019-03-15", memoryReader(objects));

    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body.error).toBe("corrupt_data");
  });

  it("reads the anchor-specific key and returns the parsed result with 200 and caching headers", async () => {
    const result = fixtureCustomResult("2019-03-15");
    const objects = new Map([["results/custom/2019-03-15.json", JSON.stringify(result)]]);

    const response = await getCustomResultsResponse("2019-03-15", memoryReader(objects));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual(result);
    const cacheControl = response.headers.get("Cache-Control");
    expect(cacheControl).toContain("max-age=300");
    expect(cacheControl).toContain("stale-while-revalidate");
  });

  it("reads a distinct key per anchor, namespaced under results/custom/", async () => {
    const getObject = vi.fn().mockResolvedValue(JSON.stringify(fixtureCustomResult("2019-03-15")));
    const reader: ResultReader = { getObject };

    await getCustomResultsResponse("2019-03-15", reader);

    expect(getObject).toHaveBeenCalledWith("results/custom/2019-03-15.json");
  });

  it("returns a 502 when the stored object's schemaVersion doesn't match the reader's", async () => {
    const stale = { ...fixtureCustomResult("2019-03-15"), schemaVersion: 999 };
    const objects = new Map([["results/custom/2019-03-15.json", JSON.stringify(stale)]]);

    const response = await getCustomResultsResponse("2019-03-15", memoryReader(objects));

    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body.error).toBe("schema_mismatch");
  });

  it("returns a 502 when the stored object has an unrecognized model", async () => {
    const corrupted = { ...fixtureCustomResult("2019-03-15"), model: "window" };
    const objects = new Map([["results/custom/2019-03-15.json", JSON.stringify(corrupted)]]);

    const response = await getCustomResultsResponse("2019-03-15", memoryReader(objects));

    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body.error).toBe("schema_mismatch");
  });

  it("sets Cache-Control: no-store on every error response", async () => {
    const responses = await Promise.all([
      getCustomResultsResponse(null, memoryReader(new Map())),
      getCustomResultsResponse("2019-03-15", null),
      getCustomResultsResponse("2019-03-15", memoryReader(new Map())),
    ]);

    for (const response of responses) {
      expect(response.headers.get("Cache-Control")).toBe("no-store");
    }
  });
});

describe("getCustomAnchorsResponse", () => {
  it("returns a 500 when no reader is configured (RESULTS_BUCKET unset)", async () => {
    const response = await getCustomAnchorsResponse(null);

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error).toBe("server_misconfigured");
  });

  it("returns a 404 when the manifest hasn't been published yet", async () => {
    const response = await getCustomAnchorsResponse(memoryReader(new Map()));

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error).toBe("not_found");
  });

  it("returns a 502 when the S3 read fails", async () => {
    const reader: ResultReader = {
      getObject: vi.fn().mockRejectedValue(new Error("access denied")),
    };

    const response = await getCustomAnchorsResponse(reader);

    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body.error).toBe("upstream_error");
  });

  it("returns a 502 when the stored manifest isn't valid JSON", async () => {
    const objects = new Map([["results/custom/index.json", "{not json"]]);

    const response = await getCustomAnchorsResponse(memoryReader(objects));

    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body.error).toBe("corrupt_data");
  });

  it("returns a 502 (not an uncaught TypeError) when the stored manifest parses to `null`", async () => {
    const objects = new Map([["results/custom/index.json", "null"]]);

    const response = await getCustomAnchorsResponse(memoryReader(objects));

    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body.error).toBe("corrupt_data");
  });

  it("returns a 502 when schemaVersion doesn't match", async () => {
    const objects = new Map([
      [
        "results/custom/index.json",
        JSON.stringify({ schemaVersion: 999, anchors: ["2019-03-15"] }),
      ],
    ]);

    const response = await getCustomAnchorsResponse(memoryReader(objects));

    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body.error).toBe("schema_mismatch");
  });

  it("returns a 502 when anchors isn't an array", async () => {
    const objects = new Map([
      [
        "results/custom/index.json",
        JSON.stringify({ schemaVersion: RESULTS_SCHEMA_VERSION, anchors: "2019-03-15" }),
      ],
    ]);

    const response = await getCustomAnchorsResponse(memoryReader(objects));

    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body.error).toBe("schema_mismatch");
  });

  it("reads the manifest key and returns the full manifest (schemaVersion + anchors) with 200 and caching headers", async () => {
    const anchors = ["2019-03-14", "2019-03-15", "2024-06-14"];
    const stored = { schemaVersion: RESULTS_SCHEMA_VERSION, anchors };
    const objects = new Map([["results/custom/index.json", JSON.stringify(stored)]]);

    const response = await getCustomAnchorsResponse(memoryReader(objects));

    expect(response.status).toBe(200);
    const body = await response.json();
    // The full stored object, not a narrowed { anchors } projection
    // (code review finding) -- useCustomAnchors() types the fetched
    // payload as the full CustomAnchorsManifest, so the route must
    // actually return that shape, schemaVersion included.
    expect(body).toEqual(stored);
    const cacheControl = response.headers.get("Cache-Control");
    expect(cacheControl).toContain("max-age=300");
    expect(cacheControl).toContain("stale-while-revalidate");
  });

  it("sets Cache-Control: no-store on every error response", async () => {
    const responses = await Promise.all([
      getCustomAnchorsResponse(null),
      getCustomAnchorsResponse(memoryReader(new Map())),
    ]);

    for (const response of responses) {
      expect(response.headers.get("Cache-Control")).toBe("no-store");
    }
  });
});

describe("getTodaysCloseSessionResponse", () => {
  // Beat the Bench's read path (issue #131). Issue #127 published this
  // object with no route to reach it at all -- these cover the same
  // failure ladder every other results-reading route already has, since
  // this shares readCurrentSchemaObject with them.
  const session = {
    schemaVersion: RESULTS_SCHEMA_VERSION,
    generatedAt: "2026-08-27T00:52:58.157Z",
    ticker: "SPY",
    barIntervalMinutes: 5,
    date: "2026-08-26",
    bars: [
      { time: "09:30:00", close: 765.67 },
      { time: "09:35:00", close: 765.58 },
    ],
  };

  it("returns a 500 when no reader is configured (RESULTS_BUCKET unset)", async () => {
    const response = await getTodaysCloseSessionResponse(null);

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error).toBe("server_misconfigured");
  });

  it("returns a 404 before any pipeline run has published a session", async () => {
    const response = await getTodaysCloseSessionResponse(memoryReader(new Map()));

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error).toBe("not_found");
  });

  it("returns a 502 when the read fails", async () => {
    const reader: ResultReader = {
      getObject: vi.fn().mockRejectedValue(new Error("access denied")),
    };

    const response = await getTodaysCloseSessionResponse(reader);

    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body.error).toBe("upstream_error");
  });

  it("returns a 502 when the stored session isn't valid JSON", async () => {
    const objects = new Map([[TODAYS_CLOSE_SESSION_KEY, "{not json"]]);

    const response = await getTodaysCloseSessionResponse(memoryReader(objects));

    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body.error).toBe("corrupt_data");
  });

  it("returns a 502 when schemaVersion doesn't match", async () => {
    const objects = new Map([
      [TODAYS_CLOSE_SESSION_KEY, JSON.stringify({ ...session, schemaVersion: 999 })],
    ]);

    const response = await getTodaysCloseSessionResponse(memoryReader(objects));

    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body.error).toBe("schema_mismatch");
  });

  it("returns a 502 for a session with no bars, rather than a game with nothing to play", async () => {
    for (const bars of [[], "09:30:00", undefined]) {
      const objects = new Map([[TODAYS_CLOSE_SESSION_KEY, JSON.stringify({ ...session, bars })]]);

      const response = await getTodaysCloseSessionResponse(memoryReader(objects));

      expect(response.status).toBe(502);
      const body = await response.json();
      expect(body.error).toBe("schema_mismatch");
    }
  });

  it("reads the published key and returns the whole session with caching headers", async () => {
    const objects = new Map([[TODAYS_CLOSE_SESSION_KEY, JSON.stringify(session)]]);

    const response = await getTodaysCloseSessionResponse(memoryReader(objects));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(session);
    const cacheControl = response.headers.get("Cache-Control");
    expect(cacheControl).toContain("max-age=300");
    expect(cacheControl).toContain("stale-while-revalidate");
  });

  it("sets Cache-Control: no-store on every error response", async () => {
    const responses = await Promise.all([
      getTodaysCloseSessionResponse(null),
      getTodaysCloseSessionResponse(memoryReader(new Map())),
    ]);

    for (const response of responses) {
      expect(response.headers.get("Cache-Control")).toBe("no-store");
    }
  });
});

// Mystery Day's two routes (issue #132). The pool half is safe to hand
// out; the reveal half is the answer to the game and is deliberately the
// only thing that can produce a date.
describe("Mystery Day routes", () => {
  const POOL_GENERATED_AT = "2026-08-27T01:50:37.927Z";
  const IDS = ["s01", "s02", "s03"];
  const manifest = {
    schemaVersion: RESULTS_SCHEMA_VERSION,
    generatedAt: POOL_GENERATED_AT,
    sessionIds: IDS,
  };
  const index = {
    schemaVersion: RESULTS_SCHEMA_VERSION,
    generatedAt: POOL_GENERATED_AT,
    entries: [
      { sessionId: "s01", date: "2026-07-20" },
      { sessionId: "s02", date: "2026-07-29" },
      { sessionId: "s03", date: "2026-08-04" },
    ],
  };
  function mysterySession(sessionId: string) {
    return {
      schemaVersion: RESULTS_SCHEMA_VERSION,
      ticker: "SPY",
      barIntervalMinutes: 5,
      sessionId,
      bars: [
        { time: "09:30:00", close: 740.03 },
        { time: "09:35:00", close: 740.5 },
      ],
    };
  }
  function pooledObjects(): Map<string, string> {
    const objects = new Map([
      [MYSTERY_POOL_MANIFEST_KEY, JSON.stringify(manifest)],
      [MYSTERY_INDEX_KEY, JSON.stringify(index)],
    ]);
    for (const id of IDS) objects.set(mysterySessionKey(id), JSON.stringify(mysterySession(id)));
    return objects;
  }

  describe("isMysterySessionId", () => {
    // An allowlist, not a shape check: this value is interpolated
    // straight into an S3 key.
    it("accepts only real slot ids", () => {
      expect(isMysterySessionId("s01")).toBe(true);
      expect(isMysterySessionId("s48")).toBe(true);
      expect(isMysterySessionId("s49")).toBe(false);
      expect(isMysterySessionId("s1")).toBe(false);
      expect(isMysterySessionId("../../mystery-index")).toBe(false);
      expect(isMysterySessionId(null)).toBe(false);
    });
  });

  describe("getMysterySessionResponse", () => {
    it("serves the picked session's bars and the pool's own run stamp -- and no date at all", async () => {
      // A pinned random pick, not a bare Math.random(): the same
      // reasoning apps/pipeline's own injectable `random` records.
      const response = await getMysterySessionResponse(memoryReader(pooledObjects()), () => 0.5);

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.session.sessionId).toBe("s02");
      expect(body.poolGeneratedAt).toBe(POOL_GENERATED_AT);
      // The payload-level guarantee is issue #127's (the pipeline refuses
      // to publish a session with a date-shaped substring in it), but the
      // route must not add one back either -- the only date-shaped text
      // in this response is the pool's own run timestamp.
      expect(JSON.stringify(body.session)).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    });

    it("picks across the whole published pool", async () => {
      const objects = pooledObjects();
      const picked = await Promise.all(
        [0, 0.4, 0.9].map(async (roll) => {
          const response = await getMysterySessionResponse(memoryReader(objects), () => roll);
          return (await response.json()).session.sessionId;
        }),
      );
      expect(picked).toEqual(["s01", "s02", "s03"]);
    });

    it("never lets a random pick be cached and reused for the next player", async () => {
      const response = await getMysterySessionResponse(memoryReader(pooledObjects()), () => 0);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
    });

    it("returns a 404 before any pipeline run has published a pool", async () => {
      const response = await getMysterySessionResponse(memoryReader(new Map()), () => 0);

      expect(response.status).toBe(404);
      expect((await response.json()).error).toBe("not_found");
    });

    it("returns a 500 when no reader is configured", async () => {
      const response = await getMysterySessionResponse(null, () => 0);
      expect(response.status).toBe(500);
      expect((await response.json()).error).toBe("server_misconfigured");
    });

    it("rejects a manifest with no usable ids rather than reading a garbage key", async () => {
      for (const sessionIds of [[], "s01", undefined]) {
        const objects = new Map([
          [MYSTERY_POOL_MANIFEST_KEY, JSON.stringify({ ...manifest, sessionIds })],
        ]);
        const response = await getMysterySessionResponse(memoryReader(objects), () => 0);

        expect(response.status).toBe(502);
        expect((await response.json()).error).toBe("schema_mismatch");
      }
    });

    it("rejects a manifest naming a slot outside the published set", async () => {
      const objects = new Map([
        [MYSTERY_POOL_MANIFEST_KEY, JSON.stringify({ ...manifest, sessionIds: ["../secrets"] })],
      ]);
      const response = await getMysterySessionResponse(memoryReader(objects), () => 0);

      expect(response.status).toBe(502);
      expect((await response.json()).error).toBe("schema_mismatch");
    });

    it("returns a 404 when the picked slot's own object has gone (a rotation mid-request)", async () => {
      const objects = pooledObjects();
      objects.delete(mysterySessionKey("s01"));
      const response = await getMysterySessionResponse(memoryReader(objects), () => 0);

      expect(response.status).toBe(404);
      expect((await response.json()).error).toBe("not_found");
    });

    it("returns a 502 for a picked session with no bars", async () => {
      const objects = pooledObjects();
      objects.set(mysterySessionKey("s01"), JSON.stringify({ ...mysterySession("s01"), bars: [] }));
      const response = await getMysterySessionResponse(memoryReader(objects), () => 0);

      expect(response.status).toBe(502);
      expect((await response.json()).error).toBe("schema_mismatch");
    });
  });

  describe("getMysteryRevealResponse", () => {
    it("resolves exactly one id, and answers with that id alone", async () => {
      const response = await getMysteryRevealResponse(memoryReader(pooledObjects()), "s02");

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual({
        sessionId: "s02",
        date: "2026-07-29",
        generatedAt: POOL_GENERATED_AT,
      });
      // One settlement earns one date -- never the whole id -> date map,
      // which would de-anonymise the rest of the pool in one request.
      expect(JSON.stringify(body)).not.toContain("2026-08-04");
      expect(JSON.stringify(body)).not.toContain("2026-07-20");
    });

    it("is never cached -- this response is the answer to the game", async () => {
      const response = await getMysteryRevealResponse(memoryReader(pooledObjects()), "s02");
      expect(response.headers.get("Cache-Control")).toBe("no-store");
    });

    it("rejects an id that isn't a real slot, before reading anything", async () => {
      const reader: ResultReader = { getObject: vi.fn() };
      const response = await getMysteryRevealResponse(reader, "../../mystery-index");

      expect(response.status).toBe(400);
      expect((await response.json()).error).toBe("invalid_session_id");
      expect(reader.getObject).not.toHaveBeenCalled();
    });

    it("rejects a missing id", async () => {
      const response = await getMysteryRevealResponse(memoryReader(pooledObjects()), null);
      expect(response.status).toBe(400);
      expect((await response.json()).error).toBe("invalid_session_id");
    });

    it("returns a 404 for a real slot the current index doesn't cover", async () => {
      const response = await getMysteryRevealResponse(memoryReader(pooledObjects()), "s09");

      expect(response.status).toBe(404);
      expect((await response.json()).error).toBe("not_found");
    });

    it("returns a 404 before any pipeline run has published an index", async () => {
      const response = await getMysteryRevealResponse(memoryReader(new Map()), "s01");
      expect(response.status).toBe(404);
      expect((await response.json()).error).toBe("not_found");
    });

    it("returns a 502 for a malformed index rather than a half-answer", async () => {
      for (const broken of [{ entries: "nope" }, { entries: [], generatedAt: 7 }]) {
        const objects = new Map([[MYSTERY_INDEX_KEY, JSON.stringify({ ...index, ...broken })]]);
        const response = await getMysteryRevealResponse(memoryReader(objects), "s01");

        expect(response.status).toBe(502);
        expect((await response.json()).error).toBe("schema_mismatch");
      }
    });

    it("returns a 500 when no reader is configured", async () => {
      const response = await getMysteryRevealResponse(null, "s01");
      expect(response.status).toBe(500);
      expect((await response.json()).error).toBe("server_misconfigured");
    });
  });
});
