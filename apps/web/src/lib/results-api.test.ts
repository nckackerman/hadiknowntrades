import {
  PRESET_RANGES,
  RESULTS_SCHEMA_VERSION,
  type PrecomputedResult,
} from "@hadiknowntrades/core";
import { describe, expect, it, vi } from "vitest";

import { getResultsResponse, isCanonicalRange, parseRange, type ResultReader } from "./results-api";

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
