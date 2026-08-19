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
// Phase 10: dictionary mode (`?` define/translate).
export {
  parseDefineQuery,
  detectLanguage,
  otherLang,
  buildDictionaryMessages,
  dictionaryCacheKey,
  getDefaultDictionaryCacheStore,
  MemoryDictionaryCacheStore,
  MongoDictionaryCacheStore,
  TieredDictionaryCacheStore,
  DICTIONARY_TTL_SECONDS,
  type DictLang,
  type DictionaryValue,
  type DictionaryCacheStore,
  type DictionaryPromptMessages,
} from "./dictionary";
// Phase 13: quote mode (`$` stocks, indices, FX and crypto).
export {
  parseQuoteQuery,
  isCurrencyCode,
  resolveSymbol,
  resolveChange,
  renderQuote,
  renderConversion,
  quoteCacheKey,
  conversionCacheKey,
  quoteTtlSeconds,
  getDefaultQuoteCacheStore,
  MemoryQuoteCacheStore,
  MongoQuoteCacheStore,
  TieredQuoteCacheStore,
  QUOTE_TTL_OPEN_SECONDS,
  QUOTE_TTL_CLOSED_SECONDS,
  type QuoteQuery,
  type SymbolQuery,
  type ConvertQuery,
  type ResolvedSymbol,
  type QuoteChange,
  type ChangeWindow,
  type QuoteRender,
  type ConversionRender,
  type QuoteValue,
  type QuoteCacheStore,
} from "./quotes";
export { QUOTE_ALIASES, type QuoteAlias } from "./defaults";
// Phase 14: translate mode (`&` seven-language translation).
export {
  parseTranslateQuery,
  buildTranslateMessages,
  translateLangName,
  translationCacheKey,
  getDefaultTranslationCacheStore,
  MemoryTranslationCacheStore,
  MongoTranslationCacheStore,
  TieredTranslationCacheStore,
  TRANSLATE_LANGUAGES,
  TRANSLATE_LANG_CODES,
  DEFAULT_TARGET_LANG,
  TRANSLATION_TTL_SECONDS,
  type TranslateLang,
  type TranslateQuery,
  type TranslationValue,
  type TranslationCacheStore,
  type TranslatePromptMessages,
} from "./translate";
