// Read side of the S3-backed results store. Pairs with
// apps/pipeline/src/s3-store.ts's write side (S3ResultStore) -- both
// speak the same key convention (results/{RANGE}.json, see
// apps/pipeline/CLAUDE.md) and the same bucket env var (RESULTS_BUCKET,
// see route.ts). Kept in apps/web rather than packages/core since this is
// the API's own I/O concern (an S3 client wrapper), not shared domain
// logic -- unlike PrecomputedResult (packages/core/src/results-schema.ts),
// which both sides of the S3 contract need to agree on.
//
// Not exercised against a real bucket yet: that requires the AWS
// infrastructure from issue #6.

import { GetObjectCommand, NoSuchKey, S3Client } from "@aws-sdk/client-s3";

import type { ResultReader } from "./results-api";

export class S3ResultReader implements ResultReader {
  constructor(
    private readonly bucket: string,
    private readonly client: S3Client = new S3Client({}),
  ) {}

  async getObject(key: string): Promise<string | null> {
    try {
      const response = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      const body = await response.Body?.transformToString("utf-8");
      return body ?? null;
    } catch (error) {
      if (error instanceof NoSuchKey) return null;
      throw error;
    }
  }
}
