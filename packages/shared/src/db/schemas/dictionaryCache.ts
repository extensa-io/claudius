import { z } from "zod";

/**
 * `dictionary_cache` backs Phase 10 dictionary mode. A leading `?` define/
 * translate lookup produces a structured Markdown entry; this store absorbs
 * repeats so a word looked up twice costs no model call.
 *
 * INVARIANT #1 by construction: GLOBAL and CONTENT-ONLY, exactly like
 * `search_cache`. The key and value carry NO `userId` and NO user-specific
 * content — only the (public) dictionary entry and the detected direction. Two
 * users looking up the same word share the entry and neither can infer the
 * other's activity, so the `userId` filter that guards every user-owned
 * collection does not apply: there is nothing user-owned to guard.
 *
 * It is a SEPARATE collection from `search_cache` because the value is a
 * Markdown entry, not a `SearchResult[]`. `_id` is the cache key (a hash of the
 * normalized term + direction), so a lookup is a primary-key hit and a write an
 * idempotent upsert. `expiresAt` carries an evergreen TTL — a definition is
 * stable — reaped by the same per-document TTL pattern.
 */
export const DictionaryCacheEntrySchema = z.object({
  _id: z.string(), // the content hash — see dictionary.ts dictionaryCacheKey()
  markdown: z.string(),
  sourceLang: z.enum(["en", "es"]),
  createdAt: z.date(),
  expiresAt: z.date(),
});

export type DictionaryCacheEntry = z.infer<typeof DictionaryCacheEntrySchema>;
