import { tavily } from "@tavily/core";
import { env } from "@claudius/shared";

/**
 * Tavily access for the research worker: search (find candidate sources) and
 * extract (fetch and read the full text of a chosen page). The chat agent's
 * web_search tool (in shared) is a shallow one-shot; deep research needs the
 * two-step "find, then read" shape and deeper search, so the worker talks to
 * Tavily directly rather than through the bound tool.
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

export interface PageContent {
  url: string;
  /** The extracted full text, truncated to keep synthesis within token budget. */
  text: string;
}

// Per-page character cap so one long page can't blow the synthesis token budget.
const MAX_PAGE_CHARS = 12_000;

/**
 * Fetch and extract the readable text of one or more pages. Tavily returns a
 * `rawContent` string per successful URL; failures are dropped silently (a dead
 * link should never fail the whole job). The client's field naming has varied
 * across versions, so we read both camel and snake case defensively.
 */
export async function extractPages(urls: string[]): Promise<PageContent[]> {
  if (urls.length === 0) return [];
  const response = await getClient().extract(urls, {});
  const results = (response.results ?? []) as Array<{
    url: string;
    rawContent?: string;
    raw_content?: string;
  }>;
  return results
    .map((r) => ({
      url: r.url,
      text: (r.rawContent ?? r.raw_content ?? "").slice(0, MAX_PAGE_CHARS),
    }))
    .filter((p) => p.text.length > 0);
}
