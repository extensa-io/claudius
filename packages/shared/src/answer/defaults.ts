import type { Bang, CacheTtls } from "../db/schemas";

/**
 * Built-in defaults for the Phase 8 routing + caching config. These live in code
 * (not only in settings) so the engine has sane behavior before the migration
 * runs and so a wiped `search` document still resolves. The admin panel edits the
 * settings copies; the engine merges the stored `customBangs` OVER this table, so
 * an admin can override a built-in or add their own without losing the defaults.
 */

/**
 * The default bang table. `{query}` is replaced with the URL-encoded remainder
 * of the input; a bang with no query substitutes empty (most sites land on a
 * near-home search). Kept small and unsurprising — DuckDuckGo-style shortcuts a
 * developer reaches for. Admins add personal bangs via settings.
 */
export const DEFAULT_BANGS: Bang[] = [
  { token: "g", urlTemplate: "https://www.google.com/search?q={query}" },
  { token: "k", urlTemplate: "https://kagi.com/search?q={query}" },
  { token: "gh", urlTemplate: "https://github.com/search?q={query}&type=repositories" },
  { token: "w", urlTemplate: "https://en.wikipedia.org/w/index.php?search={query}" },
  { token: "so", urlTemplate: "https://stackoverflow.com/search?q={query}" },
  { token: "yt", urlTemplate: "https://www.youtube.com/results?search_query={query}" },
  { token: "npm", urlTemplate: "https://www.npmjs.com/search?q={query}" },
  { token: "mdn", urlTemplate: "https://developer.mozilla.org/en-US/search?q={query}" },
  { token: "docs", urlTemplate: "https://www.mongodb.com/docs/search/?q={query}" },
  { token: "maps", urlTemplate: "https://www.google.com/maps/search/{query}" },
];

/**
 * Depth signals that escalate an informational query from Brave to Tavily
 * advanced (clean extraction + reranking is worth the cost when the user is
 * clearly asking for something thorough). Matched case-insensitively as
 * substrings of the normalized query.
 */
export const DEFAULT_ESCALATION_KEYWORDS: string[] = [
  "in depth",
  "in-depth",
  "deep dive",
  "comprehensive",
  "detailed",
  "compare",
  "comparison",
  "vs",
  "versus",
  "pros and cons",
  "research",
  "analysis",
  "explain in detail",
];

/**
 * Per-intent cache lifetimes. Evergreen is the informational default (facts
 * rarely change within a week); fresh is the short life for news-like queries;
 * transactional churns fastest (prices, availability). Navigational is never
 * cached (it resolves to a URL with no round trip), so it has no TTL here.
 */
export const DEFAULT_CACHE_TTLS: CacheTtls = {
  freshSeconds: 15 * 60, // 15 minutes — news-like / time-sensitive
  evergreenSeconds: 7 * 24 * 60 * 60, // 7 days — stable facts (the common case)
  transactionalSeconds: 60 * 60, // 1 hour — prices/availability churn
};
