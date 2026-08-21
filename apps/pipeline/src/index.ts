// Nightly precompute job entry point: fetches S&P 500 daily closes from
// Yahoo, runs the trade optimizer for each preset range, writes result
// JSON to S3. Invoked on a schedule once issue #6's infrastructure
// (EventBridge -> this) exists — not invoked against real AWS yet.

import { fetchDailyCloses, SP500_CONSTITUENTS } from "@hadiknowntrades/core";

import { runPipeline } from "./pipeline.js";
import { S3ResultStore } from "./s3-store.js";

async function main(): Promise<void> {
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

main().catch((error: unknown) => {
  console.error("[pipeline] run failed:", error);
  process.exitCode = 1;
});
