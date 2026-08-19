import { z } from "zod";

/**
 * `translation_cache` backs Phase 14 translate mode. A leading `&` translation
 * produces a structured Markdown entry; this store absorbs repeats so a phrase
 * translated twice costs no model call.
 *
 * INVARIANT #1 by construction: GLOBAL and CONTENT-ONLY, exactly like
 * `search_cache` and `dictionary_cache`. The key and value carry NO `userId` and
 * NO user-specific content — only the translation entry and its direction. Two
 * users translating the same phrase share the entry and neither can infer the
 * other's activity, so the `userId` filter that guards every user-owned
 * collection does not apply: there is nothing user-owned to guard.
 *
 * `sourceLang` records `auto` when the user let the model detect the source,
 * rather than the language it turned out to be. That is deliberate: the key is
 * computed BEFORE the call, so an auto lookup and an equivalent explicit one are
 * separate buckets, and storing the detected language here would make the
 * document disagree with its own `_id`.
 */
const LANG = z.enum(["en", "es", "it", "pt", "fr", "de", "el"]);

export const TranslationCacheEntrySchema = z.object({
  _id: z.string(), // the content hash — see translate.ts translationCacheKey()
  markdown: z.string(),
  sourceLang: z.union([LANG, z.literal("auto")]),
  targetLang: LANG,
  createdAt: z.date(),
  expiresAt: z.date(),
});

export type TranslationCacheEntry = z.infer<typeof TranslationCacheEntrySchema>;
