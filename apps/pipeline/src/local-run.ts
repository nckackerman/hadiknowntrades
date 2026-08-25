// Local/manual CLI entry point for populating a LOCAL_RESULTS_DIR
// directory with real pipeline output -- lets apps/web's `next dev`
// serve real, current-schema results without any real AWS credentials.
// See apps/web/CLAUDE.md's "Local development without AWS credentials"
// section for the full workflow (this is the write side; apps/web's
// local-file-result-reader.ts, plus both API routes' LOCAL_RESULTS_DIR
// branches, are the read side).
//
// A permanent, committed tool -- this used to be a throwaway script
// recreated from scratch every time someone needed real local data (see
// e.g. apps/web/CLAUDE.md's issue #45/#75 notes on the technique), which
// had already repeated at least three separate times (issues #45, #85,
// #75) before this file existed. Run via `pnpm run local-run` (this
// package's own script).
//
// Deliberately a smaller ticker universe than the real nightly run
// (LOCAL_TICKER_COUNT, default 20) -- real Yahoo network calls against
// the full ~503-ticker S&P 500 universe would make this slow for a
// workflow that only needs *some* real, varied trade data to develop
// against locally, not the actual production result. Always opts into
// computeCustomAnchors so the custom start-date picker has a real
// manifest + anchor results to read too, not just the 6 preset ranges.

import {
  fetchDailyCloses,
  fetchFiveMinuteBars,
  fetchIntraday1mBars,
  fetchIntradayBars,
  SP500_CONSTITUENTS,
} from "@hadiknowntrades/core";

import { LocalFileResultStore } from "./local-file-store.js";
import { runPipeline } from "./pipeline.js";

const dir = process.env.LOCAL_RESULTS_DIR;
if (!dir) {
  console.error("[local-run] LOCAL_RESULTS_DIR environment variable is required");
  process.exit(1);
}

// Parsed and validated up front, not trusted as a bare Number() result --
// a non-numeric value would otherwise silently become NaN
// (SP500_CONSTITUENTS.slice(0, NaN) is []), and a negative value would
// silently keep nearly the whole universe (slice's negative-index
// semantics), both defeating this flag's "small, real ticker sample for
// speed" purpose with no indication anything is wrong.
const rawTickerCount = process.env.LOCAL_TICKER_COUNT ?? "20";
const tickerCount = Number(rawTickerCount);
if (!Number.isInteger(tickerCount) || tickerCount <= 0) {
  console.error(
    `[local-run] LOCAL_TICKER_COUNT must be a positive integer, got ${JSON.stringify(rawTickerCount)}`,
  );
  process.exit(1);
}

async function main(resultsDir: string): Promise<void> {
  const tickers = SP500_CONSTITUENTS.slice(0, tickerCount).map((c) => c.symbol);

  const summary = await runPipeline({
    tickers,
    fetchDailyCloses,
    fetchIntradayBars,
    fetchFiveMinuteBars,
    fetchIntraday1mBars,
    store: new LocalFileResultStore(resultsDir),
    computeCustomAnchors: true,
  });

  console.log(
    `[local-run] wrote ${summary.results.length} preset results and ${summary.customResults.length} custom-anchor results to ${resultsDir}, skipped ${summary.skippedTickers.length} tickers`,
  );
}

main(dir).catch((error: unknown) => {
  console.error("[local-run] run failed:", error);
  process.exitCode = 1;
});
