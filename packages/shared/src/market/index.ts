// Public surface of the market-data layer (Phase 13). Runtime-agnostic: a plain
// HTTPS client with no SDK, in line with the rest of the serverless stack.
export {
  fetchQuote,
  fetchExchangeRate,
  fetchDayAgoClose,
  isMarketDataConfigured,
  type InstrumentQuote,
  type ExchangeRate,
  type MarketResult,
  type MarketSuccess,
  type MarketFailure,
  type MarketFailureReason,
} from "./twelvedata";
