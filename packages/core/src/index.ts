// Shared domain logic for Had I Known Trades: ticker universe, the Yahoo
// Finance data client, and the multi-ticker trade optimizer live here.

export { SP500_CONSTITUENTS } from "./sp500-constituents.js";
export type { SP500Constituent } from "./sp500-constituents.js";

export {
  fetchDailyCloses,
  toYahooSymbol,
  BlockedError,
  TickerNotFoundError,
  UnexpectedResponseError,
  TransientFetchError,
} from "./yahoo-client.js";
export type { DailyClose } from "./yahoo-client.js";

// fetchDailyClosesCached is deliberately not re-exported here — it's a
// dev-only convenience, not part of the production API. Import it
// directly from another TS module in this workspace:
// `import { fetchDailyClosesCached } from "@hadiknowntrades/core/src/yahoo-client-cache.js"`.
// That resolves fine through this workspace's TS tooling (vitest, or
// whatever runs the pipeline once issue #5 lands), but NOT from a bare
// `node script.mjs` — there's no compiled .js output and no tsx/ts-node
// in this repo (yet) to make that work outside a TS-aware runtime.
