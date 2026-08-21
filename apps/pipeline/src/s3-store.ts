// Real S3-backed ResultStore, used by index.ts for the actual nightly
// run. Kept separate from pipeline.ts so the pipeline's own logic stays
// testable with a plain in-memory store (see pipeline.test.ts) — this
// file's only job is translating ResultStore.putObject into an S3 call.
//
// Not exercised against a real bucket yet: that requires the AWS
// infrastructure from issue #6.

import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

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
}
