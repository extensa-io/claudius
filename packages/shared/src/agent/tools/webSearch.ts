import { tool } from "@langchain/core/tools";
import { tavily } from "@tavily/core";
import { z } from "zod";
import { env } from "../../env";

/**
 * The agent's single tool in Phase 1: a thin wrapper over Tavily's search API.
 *
 * We hand-roll the tool rather than pull a prebuilt one so the output shape is
 * exactly what the spec calls for — title, url, snippet — and nothing else. The
 * model sees a compact, predictable structure, and the chat UI can render the
 * same shape as a "sources" affordance. Tavily's `content` field is the
 * extracted snippet; we rename it to `snippet` at this boundary.
 */

const MAX_RESULTS = 5;

const webSearchSchema = z.object({
  query: z.string().describe("The search query to run against the web."),
});

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

// Lazily constructed so importing the tool never forces a client (and an env
// read) at module load; the client is built on first use and reused after.
let client: ReturnType<typeof tavily> | null = null;
function getClient(): ReturnType<typeof tavily> {
  client ??= tavily({ apiKey: env.TAVILY_API_KEY });
  return client;
}

export const webSearchTool = tool(
  async ({ query }): Promise<string> => {
    const response = await getClient().search(query, {
      maxResults: MAX_RESULTS,
      searchDepth: "basic",
    });

    const results: WebSearchResult[] = response.results.map((r) => ({
      title: r.title,
      url: r.url,
      snippet: r.content,
    }));

    // Tool messages are strings; return JSON the model can read back and that
    // the UI can parse to render source links.
    return JSON.stringify({ results });
  },
  {
    name: "web_search",
    description:
      "Search the web for current information. Returns the top results as title, url, and snippet. Use for recent events, releases, prices, or anything that may have changed since training.",
    schema: webSearchSchema,
  },
);
