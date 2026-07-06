import { dispatchCustomEvent } from "@langchain/core/callbacks/dispatch";
import type { RunnableConfig } from "@langchain/core/runnables";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import {
  answerSearch,
  classifyIntent,
  getDefaultCacheStore,
} from "../../answer";
import { loadSearchSettings } from "../../tiers/catalog";
import { AppError } from "../../errors";

/**
 * Custom event the tool emits (via dispatchCustomEvent) carrying WHICH backend
 * served a search, so the UI can show a Brave/Tavily indicator. This rides the
 * same LangGraph streamEvents channel as `memories_used`, deliberately OUT of the
 * tool's output JSON: the model must not see which backend ran (it would start
 * saying "according to Brave"), and the output contract stays byte-identical.
 */
export const SEARCH_SOURCE_EVENT = "search_source";

export interface SearchSourceEvent {
  source: "brave" | "tavily";
  query: string;
  resultCount: number;
}

/**
 * The agent's web tool. As of Phase 7 its backend is the cost-tiered answer
 * engine (`answerSearch`) rather than a direct Tavily call: Brave serves the
 * query by default under its free monthly allowance, Tavily is the fallback and
 * high-value slot. The tool's OUTPUT CONTRACT is unchanged on purpose — it still
 * returns `JSON.stringify({ results })` with the exact `{ title, url, snippet }`
 * shape it always has — so the event bridge, the tool-activity cards, and the
 * `WebSearchToolOutput` view type are byte-compatible. Internals swapped; the
 * contract held.
 *
 * The engine reports which backend served the query and why; we log that line
 * (source only, never the query content) so "Tavily fires only as a fallback"
 * is verifiable, then discard it. The model sees only the results.
 */

const MAX_RESULTS = 5;

const webSearchSchema = z.object({
  query: z.string().describe("The search query to run against the web."),
});

// Retained as the tool's public result type so downstream view code that
// imports it keeps compiling; it is the same shape as the engine's SearchResult.
export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

export const webSearchTool = tool(
  async ({ query }, config: RunnableConfig): Promise<string> => {
    try {
      // Classify the query so the engine can pick the backend depth (Tavily
      // escalation on a depth signal) and the cache TTL by intent. The heavy
      // navigational/bang routing happens in the pre-graph interceptor; by the
      // time the model has CHOSEN to call this tool the query is informational
      // or transactional, so here classification only tunes depth + caching.
      const settings = await loadSearchSettings();
      const { intent, highValue } = classifyIntent(query, { settings });
      const { results, source, reason } = await answerSearch(
        {
          query,
          maxResults: MAX_RESULTS,
          intent,
          highValue,
        },
        {
          cache: getDefaultCacheStore(),
          // exactOptionalPropertyTypes: only pass cacheTtls when set, so the
          // engine falls back to its built-in defaults rather than `undefined`.
          ...(settings.cacheTtls ? { cacheTtls: settings.cacheTtls } : {}),
        },
      );
      // Log the backend decision (never the query text) so cost routing is
      // auditable. This is the "verifiable in logging" acceptance hook.
      console.log(`[web_search] served by ${source} (${reason})`);

      const shaped: WebSearchResult[] = results.map((r) => ({
        title: r.title,
        url: r.url,
        snippet: r.snippet,
      }));

      // Surface the backend to the UI OUT-OF-BAND (not in the tool output the
      // model reads), so the transcript can show a Brave/Tavily icon while the
      // model stays blind to which backend ran. The query rides along for the
      // tooltip; it never reaches the model via this channel either.
      const sourceEvent: SearchSourceEvent = {
        source,
        query,
        resultCount: shaped.length,
      };
      await dispatchCustomEvent(SEARCH_SOURCE_EVENT, sourceEvent, config);

      // Tool messages are strings; return JSON the model can read back and that
      // the UI can parse to render source links.
      return JSON.stringify({ results: shaped });
    } catch (error: unknown) {
      // Both backends unavailable. Return a clean, model-readable signal (empty
      // results + a note) instead of throwing into the graph, so the turn still
      // completes gracefully rather than failing the whole chat.
      const message =
        error instanceof AppError
          ? error.message
          : "Web search is temporarily unavailable.";
      console.log("[web_search] unavailable: both backends failed");
      return JSON.stringify({ results: [], error: message });
    }
  },
  {
    name: "web_search",
    description:
      "Search the web for current information. Returns the top results as title, url, and snippet. Use for recent events, releases, prices, or anything that may have changed since training.",
    schema: webSearchSchema,
  },
);
