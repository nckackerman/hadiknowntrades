import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LocalFileResultStore } from "./local-file-store.js";

describe("LocalFileResultStore", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "local-file-store-test-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("writes the body to a file at the given key, relative to the store's dir", async () => {
    const store = new LocalFileResultStore(dir);

    await store.putObject("results/1M.json", '{"hello":"world"}');

    const body = await readFile(path.join(dir, "results/1M.json"), "utf-8");
    expect(body).toBe('{"hello":"world"}');
  });

  it("creates intermediate directories that don't exist yet (e.g. results/custom/)", async () => {
    const store = new LocalFileResultStore(dir);

    await store.putObject("results/custom/2024-01-10.json", "{}");

    const body = await readFile(path.join(dir, "results/custom/2024-01-10.json"), "utf-8");
    expect(body).toBe("{}");
  });

  it("overwrites an existing file at the same key", async () => {
    const store = new LocalFileResultStore(dir);

    await store.putObject("results/1M.json", "first");
    await store.putObject("results/1M.json", "second");

    const body = await readFile(path.join(dir, "results/1M.json"), "utf-8");
    expect(body).toBe("second");
  });

  it("getObject reads back a previously-written body (issue #208)", async () => {
    const store = new LocalFileResultStore(dir);
    await store.putObject("results/lineup/history.json", '{"hello":"world"}');

    await expect(store.getObject("results/lineup/history.json")).resolves.toBe('{"hello":"world"}');
  });

  it("getObject returns null for a key that hasn't been written yet", async () => {
    const store = new LocalFileResultStore(dir);

    await expect(store.getObject("results/lineup/history.json")).resolves.toBeNull();
  });
});
