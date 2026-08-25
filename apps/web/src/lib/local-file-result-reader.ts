// Dev-only reader, gated behind the LOCAL_RESULTS_DIR env var (see
// ../app/api/results/route.ts and ../app/api/custom-anchors/route.ts) --
// never used in production, where RESULTS_BUCKET/S3ResultReader is the
// only real backing store. Lets local `next dev` serve real,
// current-schema results without a real S3 bucket, by reading the same
// results/{KEY}.json layout S3ResultReader expects from a local
// directory instead, populated by apps/pipeline's local-run.ts. See
// apps/web/CLAUDE.md's "Local development without AWS credentials"
// section for the full workflow.
//
// A permanent, committed tool -- this (and its LOCAL_RESULTS_DIR wiring
// in both API routes) used to be a throwaway pattern recreated from
// scratch every time someone needed real local data, which had already
// repeated at least three separate times (issues #45, #85, #75) before
// this file existed as a real, permanent one.

import { readFile } from "node:fs/promises";
import path from "node:path";

import type { ResultReader } from "./results-api";

export class LocalFileResultReader implements ResultReader {
  private readonly dir: string;
  constructor(dir: string) {
    this.dir = dir;
  }
  async getObject(key: string): Promise<string | null> {
    try {
      return await readFile(path.join(this.dir, key), "utf-8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
}
