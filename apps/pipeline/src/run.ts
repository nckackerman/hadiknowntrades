// Shared logic between the CLI entry point (index.ts, for local/manual
// runs) and the Lambda entry point (lambda-handler.ts, for the nightly
// EventBridge-triggered run, see infra/cdk) -- both just need to run
// the pipeline against a real S3 bucket and log a summary. The only
// difference is how each caller handles success/failure completion
// (process.exitCode vs. letting the error propagate to fail the Lambda
// invocation).

import { fetchDailyCloses, SP500_CONSTITUENTS } from "@hadiknowntrades/core";

import { runPipeline } from "./pipeline.js";
import { S3ResultStore } from "./s3-store.js";

export async function runNightlyPipeline(): Promise<void> {
  const bucket = process.env.RESULTS_BUCKET;
  if (!bucket) {
    throw new Error("RESULTS_BUCKET environment variable is required");
  }

  const summary = await runPipeline({
    tickers: SP500_CONSTITUENTS.map((c) => c.symbol),
    fetchDailyCloses,
    store: new S3ResultStore(bucket),
  });

  console.log(
    `[pipeline] wrote ${summary.results.length} results, skipped ${summary.skippedTickers.length} tickers`,
  );
  if (summary.skippedTickers.length > 0) {
    console.log(`[pipeline] skipped: ${summary.skippedTickers.join(", ")}`);
  }
}
