// Shared logic between the CLI entry point (index.ts, for local/manual
// runs) and the Lambda entry point (lambda-handler.ts, for the nightly
// EventBridge-triggered run, see infra/cdk) -- both just need to run
// the pipeline against a real S3 bucket and log a summary. The only
// difference is how each caller handles success/failure completion
// (process.exitCode vs. letting the error propagate to fail the Lambda
// invocation).

import {
  fetchDailyCloses,
  fetchFiveMinuteBars,
  fetchIntraday1mBars,
  fetchIntradayBars,
  SP500_CONSTITUENTS,
} from "@hadiknowntrades/core";

import { runPipeline } from "./pipeline.js";
import { S3ResultStore } from "./s3-store.js";

export async function runNightlyPipeline(): Promise<void> {
  const bucket = process.env.RESULTS_BUCKET;
  if (!bucket) {
    throw new Error("RESULTS_BUCKET environment variable is required");
  }

  // Resolved once, up front, so the same "now" backs runPipeline's own
  // default asOf (passed through explicitly here rather than left
  // implicit) -- the anchor list runPipeline derives internally (issue
  // #75: customRangeAnchors(buildCalendar(windowFetch.history).dates,
  // asOf), computed from *this* asOf, not a second, potentially
  // disagreeing "now") must agree with the endDateString it derives from
  // the same value.
  const asOf = new Date();

  const summary = await runPipeline({
    tickers: SP500_CONSTITUENTS.map((c) => c.symbol),
    fetchDailyCloses,
    fetchIntradayBars,
    fetchFiveMinuteBars,
    fetchIntraday1mBars,
    store: new S3ResultStore(bucket),
    asOf,
    // The one real opt-in for issue #11's coarsened custom-date-range
    // feature -- runPipeline itself defaults computeCustomAnchors to
    // false (see RunPipelineOptions's own doc comment for why), so every
    // custom anchor result only ever gets computed/written because this
    // real nightly entry point explicitly asks for it here. Issue #75:
    // the actual anchor list is now derived *inside* runPipeline (it
    // needs the window path's own fetched history, not available yet at
    // this call site) -- this flag just turns that derivation on.
    computeCustomAnchors: true,
  });

  console.log(
    `[pipeline] wrote ${summary.results.length} preset results and ${summary.customResults.length} custom-anchor results, skipped ${summary.skippedTickers.length} tickers`,
  );
  if (summary.skippedTickers.length > 0) {
    console.log(`[pipeline] skipped: ${summary.skippedTickers.join(", ")}`);
  }
}
