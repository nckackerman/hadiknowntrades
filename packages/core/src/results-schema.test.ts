import { describe, expect, it } from "vitest";

import { resultKey } from "./results-schema";

describe("resultKey", () => {
  it("builds the results/{RANGE}.json key for a preset range", () => {
    expect(resultKey("1M")).toBe("results/1M.json");
    expect(resultKey("MAX")).toBe("results/MAX.json");
  });
});
