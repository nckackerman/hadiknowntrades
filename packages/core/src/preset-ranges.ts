// The five preset timeline windows the app supports (see README). Shared
// vocabulary between the nightly pipeline (which precomputes one result
// per range) and, later, the API/frontend (which serve/select by range).

export const PRESET_RANGES = ["1M", "3M", "1Y", "5Y", "MAX"] as const;

export type PresetRange = (typeof PRESET_RANGES)[number];

/**
 * The start date for a preset range, given the "as of" date (the most
 * recent day of data being used). Returns null for "MAX", meaning
 * unbounded — use all available history.
 */
export function presetRangeStartDate(range: PresetRange, asOf: Date): Date | null {
  const start = new Date(asOf);
  switch (range) {
    case "1M":
      start.setUTCMonth(start.getUTCMonth() - 1);
      return start;
    case "3M":
      start.setUTCMonth(start.getUTCMonth() - 3);
      return start;
    case "1Y":
      start.setUTCFullYear(start.getUTCFullYear() - 1);
      return start;
    case "5Y":
      start.setUTCFullYear(start.getUTCFullYear() - 5);
      return start;
    case "MAX":
      return null;
  }
}
