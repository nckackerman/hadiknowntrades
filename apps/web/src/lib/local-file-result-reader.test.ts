import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LocalFileResultReader } from "./local-file-result-reader";

describe("LocalFileResultReader", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "local-file-result-reader-test-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns the file's contents for a key that exists, relative to the reader's dir", async () => {
    await writeFile(path.join(dir, "1M.json"), '{"hello":"world"}', "utf-8");
    const reader = new LocalFileResultReader(dir);

    const body = await reader.getObject("1M.json");

    expect(body).toBe('{"hello":"world"}');
  });

  it("reads a nested key (e.g. results/custom/2024-01-10.json) the same way a real S3 key layout would", async () => {
    await mkdir(path.join(dir, "results", "custom"), { recursive: true });
    await writeFile(path.join(dir, "results", "custom", "2024-01-10.json"), "{}", "utf-8");
    const reader = new LocalFileResultReader(dir);

    const body = await reader.getObject("results/custom/2024-01-10.json");

    expect(body).toBe("{}");
  });

  it("returns null when the file doesn't exist (ENOENT), matching S3ResultReader's NoSuchKey behavior", async () => {
    const reader = new LocalFileResultReader(dir);

    const body = await reader.getObject("does-not-exist.json");

    expect(body).toBeNull();
  });

  it("propagates any other error instead of swallowing it", async () => {
    // A directory where a file read is attempted -- fails with EISDIR,
    // not ENOENT, so this should NOT be treated as "missing" the way a
    // real ENOENT is.
    await mkdir(path.join(dir, "a-directory"), { recursive: true });
    const reader = new LocalFileResultReader(dir);

    await expect(reader.getObject("a-directory")).rejects.toThrow();
  });
});
