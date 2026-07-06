import { tavily } from "@tavily/core";
import { env } from "../env";
import type { SearchResult } from "./types";

/**
 * Tavily access for the answer engine (Phase 7).
 *
 * Tavily was the chat tool's original and only backend; the raw call is lifted
 * out of `agent/tools/webSearch.ts` into this plain function so the tool AND the
 * engine share ONE client and ONE key instead of each constructing their own.
 * In the new arrangement Tavily is the SECONDARY backend: it fires as a fallback
 * when Brave is exhausted, erroring, or times out, and as the reserved slot for
 * high-value queries that benefit from Tavily's cleaner extraction and
 * reranking. `content` is Tavily's extracted snippet; we rename it to `snippet`
 * at this boundary, matching the canonical shape.
 *
 * (The research worker still talks to Tavily directly in `worker/src/research`,
 * because deep research needs the two-step "search then extract" shape and a
 * different depth; that path is intentionally separate from this one.)
 */

const DEFAULT_MAX_RESULTS = 5;

// Lazily constructed so importing this module never forces a client (and an env
// read) at load; built on first use and reused after.
let client: ReturnType<typeof tavily> | null = null;
function getClient(): ReturnType<typeof tavily> {
  client ??= tavily({ apiKey: env.TAVILY_API_KEY });
  return client;
}

/**
 * One Tavily web search returning canonical hits. `depth` maps to Tavily's
 * search depth: "basic" for a plain fallback, "advanced" for the high-value
 * slot where the extra extraction quality is worth the cost.
 */
export async function tavilySearch(
  query: string,
  maxResults = DEFAULT_MAX_RESULTS,
  depth: "basic" | "advanced" = "basic",
): Promise<SearchResult[]> {
  const response = await getClient().search(query, {
    maxResults,
    searchDepth: depth,
  });
  return response.results.map((r) => ({
    title: r.title,
    url: r.url,
    snippet: r.content,
  }));
}
