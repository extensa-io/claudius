import { tavily } from "@tavily/core";
import { env, extractPages as sharedExtractPages } from "@claudius/shared";

/**
 * Tavily access for the research worker: search (find candidate sources) and
 * extract (fetch and read the full text of a chosen page). The chat agent's
 * web_search tool (in shared) is a shallow one-shot; deep research needs the
 * two-step "find, then read" shape and deeper search, so the worker talks to
 * Tavily's SEARCH directly rather than through the bound tool.
 *
 * Extraction is NOT duplicated here: as of Phase 11 the single Tavily-extract
 * implementation lives in `@claudius/shared` (read_url needs it on the request
 * path too), and `extractPages` below is a thin re-export so both runtimes share
 * one fetch/read behavior and one truncation budget.
 */

let client: ReturnType<typeof tavily> | null = null;
function getClient(): ReturnType<typeof tavily> {
  client ??= tavily({ apiKey: env.TAVILY_API_KEY });
  return client;
}

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

/** One web search, returning compact hits. `advanced` depth for research quality. */
export async function searchWeb(
  query: string,
  maxResults = 6,
): Promise<SearchHit[]> {
  const response = await getClient().search(query, {
    maxResults,
    searchDepth: "advanced",
  });
  return response.results.map((r) => ({
    title: r.title,
    url: r.url,
    snippet: r.content,
  }));
}

/**
 * A fetched page's readable text. Re-exported from shared (Phase 11): the
 * research synthesis reads `url` and `text`; shared also carries a `title` the
 * worker ignores, which is structurally compatible.
 */
export type PageContent = { url: string; text: string };

/**
 * Fetch and extract the readable text of one or more pages, via the single
 * shared Tavily-extract implementation. Failures are dropped silently there (a
 * dead link should never fail the whole job).
 */
export const extractPages = sharedExtractPages;
