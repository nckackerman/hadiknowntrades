// The JSON schema for one preset range's precomputed result -- the
// contract between apps/pipeline (which writes one of these per range to
// S3 as `results/{RANGE}.json`, see apps/pipeline/src/pipeline.ts) and
// apps/web's thin results API (which reads it back and serves it to the
// frontend, see apps/web/src/lib/results-api.ts). Lives here rather than
// in apps/pipeline so both sides import the exact same type instead of
// each maintaining their own copy of the shape.

import type { PresetRange } from "./preset-ranges";
import type { Trade } from "./optimizer";

/** Bumped whenever the shape of PrecomputedResult changes in a way a reader needs to know about. */
export const RESULTS_SCHEMA_VERSION = 1;

export interface PrecomputedResult {
  schemaVersion: number;
  range: PresetRange;
  generatedAt: string;
  /** The most recent trading date actually found in the fetched data -- a fact about the data, which can lag the requested `endDate` (e.g. if the pipeline runs before the latest close is posted). */
  dataAsOf: string;
  startDate: string | null;
  /** The requested "as of" boundary for this run -- see dataAsOf for what data was actually available. */
  endDate: string;
  startingCapital: number;
  endingBalance: number;
  trades: Trade[];
  universeSize: number;
  skippedTickers: string[];
}
