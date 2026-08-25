import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createResultReader } from "./create-result-reader";
import { LocalFileResultReader } from "./local-file-result-reader";
import { S3ResultReader } from "./s3-result-reader";

describe("createResultReader", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.LOCAL_RESULTS_DIR;
    delete process.env.RESULTS_BUCKET;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns null when neither env var is set", () => {
    expect(createResultReader()).toBeNull();
  });

  it("returns an S3ResultReader when only RESULTS_BUCKET is set", () => {
    process.env.RESULTS_BUCKET = "my-bucket";

    expect(createResultReader()).toBeInstanceOf(S3ResultReader);
  });

  it("returns a LocalFileResultReader when only LOCAL_RESULTS_DIR is set", () => {
    process.env.LOCAL_RESULTS_DIR = "/tmp/some-dir";

    expect(createResultReader()).toBeInstanceOf(LocalFileResultReader);
  });

  it("prefers LOCAL_RESULTS_DIR when both env vars are set", () => {
    process.env.LOCAL_RESULTS_DIR = "/tmp/some-dir";
    process.env.RESULTS_BUCKET = "my-bucket";

    expect(createResultReader()).toBeInstanceOf(LocalFileResultReader);
  });
});
