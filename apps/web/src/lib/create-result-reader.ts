// Shared reader-selection logic for both results/route.ts and
// custom-anchors/route.ts -- previously hand-duplicated verbatim in
// each file (a real code-review finding: a future change to this
// precedence, or a third reader type, edited in one route and not the
// other would silently desync the two). Both routes call this once, at
// module load time, to build their own module-level reader.
//
// LOCAL_RESULTS_DIR (checked first) is a dev-only escape hatch for local
// `next dev` without real AWS credentials -- see
// local-file-result-reader.ts's own doc comment and apps/web/CLAUDE.md's
// "Local development without AWS credentials" section. Never set in any
// real deployment, where RESULTS_BUCKET is the only configured reader.
import { LocalFileResultReader } from "./local-file-result-reader";
import type { ResultReader } from "./results-api";
import { S3ResultReader } from "./s3-result-reader";

export function createResultReader(): ResultReader | null {
  const localResultsDir = process.env.LOCAL_RESULTS_DIR;
  if (localResultsDir) return new LocalFileResultReader(localResultsDir);

  const bucket = process.env.RESULTS_BUCKET;
  if (bucket) return new S3ResultReader(bucket);

  return null;
}
