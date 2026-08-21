// Local/manual CLI entry point: `node dist/index.js` (after a build) or
// `tsx src/index.ts` runs the pipeline once against a real S3 bucket
// (RESULTS_BUCKET env var) and exits. For the real nightly run, see
// lambda-handler.ts -- the actual entry point that infra/cdk's
// EventBridge -> Lambda wiring invokes on a schedule.

import { runNightlyPipeline } from "./run.js";

runNightlyPipeline().catch((error: unknown) => {
  console.error("[pipeline] run failed:", error);
  process.exitCode = 1;
});
