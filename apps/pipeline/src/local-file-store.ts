// Local filesystem-backed ResultStore, used by local-run.ts for
// populating a LOCAL_RESULTS_DIR directory -- see that file's own doc
// comment, and apps/web/CLAUDE.md's "Local development without AWS
// credentials" section, for the full workflow this is one half of.
// Mirrors s3-store.ts's shape exactly (same ResultStore interface,
// same "just translate putObject into a real write" scope) -- the only
// difference is the write target.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ResultStore } from "./pipeline.js";

export class LocalFileResultStore implements ResultStore {
  constructor(private readonly dir: string) {}

  async putObject(key: string, body: string): Promise<void> {
    const filePath = path.join(this.dir, key);
    // Keys are namespaced with real slashes (e.g. "results/custom/2024-
    // 01-10.json", see results-schema.ts) -- unlike S3, a real
    // filesystem needs those intermediate directories to exist before a
    // write, so this creates them on demand rather than requiring the
    // caller to pre-create the whole results/custom/ tree.
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, body, "utf-8");
  }

  /**
   * Reads a previously-written object back, or `null` if it doesn't
   * exist -- mirrors s3-store.ts's own `getObject` (same "genuinely new
   * capability as of issue #208" story). `ENOENT` (no such file -- the
   * expected outcome the first time `local-run.ts` ever writes a Lineup
   * history) becomes `null`; any other read error propagates.
   */
  async getObject(key: string): Promise<string | null> {
    try {
      return await readFile(path.join(this.dir, key), "utf-8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
      throw error;
    }
  }
}
