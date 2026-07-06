import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { answerSearch } from "../../answer";
import { AppError } from "../../errors";

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
  async ({ query }): Promise<string> => {
    try {
      const { results, source, reason } = await answerSearch({
        query,
        maxResults: MAX_RESULTS,
      });
      // Log the backend decision (never the query text) so cost routing is
      // auditable. This is the "verifiable in logging" acceptance hook.
      console.log(`[web_search] served by ${source} (${reason})`);

      const shaped: WebSearchResult[] = results.map((r) => ({
        title: r.title,
        url: r.url,
        snippet: r.snippet,
      }));
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
