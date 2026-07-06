import { z } from "zod";
import { SearchResultSchema } from "../../answer/types";

/**
 * `search_cache` backs the tiered answer-engine cache (Phase 8). It absorbs
 * repeat informational/transactional queries so the per-query cost of the
 * search path survives real use.
 *
 * INVARIANT #1 by construction: this store is GLOBAL and CONTENT-ONLY. The key
 * and value carry NO `userId` and NO user-specific content — only a normalized
 * query, the resolved intent, source params, and the public search results.
 * Two different users issuing the same query share the entry, and neither can
 * infer the other's activity, so the cache never becomes a cross-user inference
 * vector. The `userId` filter that guards every user-owned collection does not
 * apply here precisely because there is nothing user-owned to guard.
 *
 * `_id` is the cache key: a stable hash of (normalized query + intent + source
 * params), so a lookup is a primary-key hit and a write is an idempotent upsert.
 * `expiresAt` carries a per-document TTL (news-like minutes vs. evergreen weeks),
 * so entries reap themselves on their own intent-aware lifetime.
 */
export const SearchCacheEntrySchema = z.object({
  _id: z.string(), // the content hash — see cache.ts cacheKey()
  results: z.array(SearchResultSchema),
  source: z.enum(["brave", "tavily"]),
  intent: z.enum(["navigational", "informational", "transactional"]),
  createdAt: z.date(),
  expiresAt: z.date(),
});

export type SearchCacheEntry = z.infer<typeof SearchCacheEntrySchema>;
