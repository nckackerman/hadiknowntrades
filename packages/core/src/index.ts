// Shared domain logic for Had I Known Trades: ticker universe, the Yahoo
// Finance data client, and the multi-ticker trade optimizer live here.

export { SP500_CONSTITUENTS } from "./sp500-constituents.js";
export type { SP500Constituent } from "./sp500-constituents.js";

export {
  fetchDailyCloses,
  toYahooSymbol,
  TickerNotFoundError,
  TransientFetchError,
} from "./yahoo-client.js";
export type { DailyClose } from "./yahoo-client.js";

export { fetchDailyClosesCached } from "./yahoo-client-cache.js";
