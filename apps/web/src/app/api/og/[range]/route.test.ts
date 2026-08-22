// Covers the route's own early-rejection guard (issue #33 follow-up,
// found in code review -- see route.tsx's own header comment for the
// full reasoning). Doesn't exercise a real render/S3 path: there's no
// RESULTS_BUCKET in this test process (same as every other test in this
// repo, see apps/web/CLAUDE.md), so a *canonical* range falls through to
// `getResultsResponse`'s own "no reader configured" 500 -- this test
// only needs to confirm canonical ranges reach that point (i.e. pass the
// guard) while non-canonical ones are rejected before it.

import { PRESET_RANGES } from "@hadiknowntrades/core";
import { describe, expect, it } from "vitest";

import { GET } from "./route";

function request(range: string): Promise<Response> {
  return GET(new Request("http://localhost/api/og/" + range), {
    params: Promise.resolve({ range }),
  });
}

describe("GET /api/og/[range]", () => {
  it("rejects a lowercase case variant of a valid range with 404, before doing any rendering work", async () => {
    const response = await request("max");

    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = await response.text();
    expect(body).toContain("max");
  });

  it("rejects mixed-case variants of every valid range", async () => {
    for (const range of PRESET_RANGES) {
      const response = await request(range.toLowerCase());
      expect(response.status).toBe(404);
    }
  });

  it("rejects an arbitrary/garbage range with 404 and no-store", async () => {
    const response = await request("not-a-range");

    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = await response.text();
    expect(body).toContain("not-a-range");
  });

  it("lets every exact-case canonical range past the guard (reaches getResultsResponse, not the guard's own 404)", async () => {
    for (const range of PRESET_RANGES) {
      const response = await request(range);
      // No RESULTS_BUCKET in this test process -- getResultsResponse's
      // own "server not configured" 500 (surfaced here as this route's
      // own plain-text error body, see route.tsx's own re-wrapping) is
      // proof this request passed the guard rather than being rejected
      // by it, which would be a 404 instead.
      expect(response.status).toBe(500);
      const body = await response.text();
      expect(body).toContain("not configured");
    }
  });
});
