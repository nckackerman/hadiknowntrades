// Real S3-backed ResultStore, used by index.ts for the actual nightly
// run. Kept separate from pipeline.ts so the pipeline's own logic stays
// testable with a plain in-memory store (see pipeline.test.ts) — this
// file's only job is translating ResultStore.putObject into an S3 call.
//
// Not exercised against a real bucket yet: that requires the AWS
// infrastructure from issue #6.

import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

import type { ResultStore } from "./pipeline.js";

export class S3ResultStore implements ResultStore {
  constructor(
    private readonly bucket: string,
    private readonly client: S3Client = new S3Client({}),
  ) {}

  async putObject(key: string, body: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: "application/json",
      }),
    );
  }

  /**
   * Reads a previously-written object back, or `null` if it doesn't
   * exist -- the Lineup's own repeat-avoidance history (issue #208) is
   * the first caller. `NoSuchKey` (a real, expected outcome the very
   * first time this key is ever read, before any run has written it) is
   * the one error this deliberately swallows into `null`; any other
   * failure (a real permissions/network problem) propagates, same as
   * `putObject` already does.
   */
  async getObject(key: string): Promise<string | null> {
    try {
      const response = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return (await response.Body?.transformToString()) ?? null;
    } catch (error) {
      if (error instanceof Error && error.name === "NoSuchKey") return null;
      throw error;
    }
  }
}
