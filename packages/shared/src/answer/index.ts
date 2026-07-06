// Public surface of the answer engine (Phase 7 selection, Phase 8 routing +
// caching). Runtime-agnostic: no Next.js, React, or Auth.js dependencies, so the
// Phase 5 worker could reuse it later.
export { answerSearch } from "./search";
export { braveSearch, BraveSearchError } from "./brave";
export { tavilySearch } from "./tavily";
export {
  SearchResultSchema,
  type SearchResult,
  type SearchSource,
  type SelectionReason,
  type AnswerSearchRequest,
  type AnswerSearchResult,
  type Intent,
} from "./types";
// Phase 8: intent routing, bangs, and the tiered cache.
export {
  classifyIntent,
  isFresh,
  isHighValue,
  type IntentResult,
} from "./classify";
export {
  resolveBang,
  mergeBangs,
  hasBang,
  type BangResolution,
} from "./bangs";
export {
  cacheKey,
  ttlForIntent,
  MemoryCacheStore,
  MongoCacheStore,
  TieredCacheStore,
  getDefaultCacheStore,
  type CacheStore,
  type CacheValue,
  type CacheKeyParts,
} from "./cache";
export {
  DEFAULT_BANGS,
  DEFAULT_ESCALATION_KEYWORDS,
  DEFAULT_CACHE_TTLS,
} from "./defaults";
