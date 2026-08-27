// The one human phrase per preset range, extracted out of ResultsPanel.tsx
// by issue #133 so the daily ritual's recap names the active range in
// exactly the words the page itself uses ("over the past week", not "1W").
//
// Each value is written to follow a preposition the caller supplies, since
// the same phrase has to read correctly after both "over" (the hero's
// description) and "Hindsight," (the recap's line).

import type { PresetRange } from "@hadiknowntrades/core";

export const RANGE_COPY: Record<PresetRange, string> = {
  "1W": "the past week",
  "1M": "the past month",
  "3M": "the past 3 months",
  "1Y": "the past year",
  "5Y": "the past 5 years",
  MAX: "all available history",
};
