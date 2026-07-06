import { z } from "zod";

/**
 * The answer engine's shared types (Phase 7).
 *
 * The engine sits behind the chat agent's single `web_search` tool and picks a
 * backend (Brave primary, Tavily fallback + high-value) per request. Its result
 * shape is deliberately the SAME `{ title, url, snippet }` the tool has always
 * returned, so swapping the backend leaves the tool's output contract, the event
 * bridge, and the tool-activity cards byte-compatible.
 */

/** One search hit in the canonical shape the tool and UI already speak. */
export const SearchResultSchema = z.object({
  title: z.string(),
  url: z.string(),
  snippet: z.string(),
});
export type SearchResult = z.infer<typeof SearchResultSchema>;

/** Which backend actually served a request. Used for logging and selection. */
export type SearchSource = "brave" | "tavily";

/**
 * A search request into the engine. `query` is the only required field. The
 * optional signals shape source selection without changing the tool's own
 * schema:
 *   - `maxResults`: soft cap on returned hits (defaults per backend).
 *   - `highValue`: an explicit depth signal. When true, the engine routes
 *     straight to Tavily (clean extraction + reranking) instead of Brave. This
 *     is the hook Phase 8's intent router drives; in Phase 7 it is off by
 *     default and only set by callers that already know the query is high value.
 */
export interface AnswerSearchRequest {
  query: string;
  maxResults?: number;
  highValue?: boolean;
}

/**
 * The engine's result: the hits plus which backend served them and why. The
 * `source`/`reason` fields never reach the model or the UI (the tool discards
 * them and returns only `results`); they exist for server-side logging so the
 * acceptance criterion "Tavily fires only as a fallback, verifiable in logging"
 * is checkable.
 */
export interface AnswerSearchResult {
  results: SearchResult[];
  source: SearchSource;
  reason: SelectionReason;
}

/** Why the engine chose the backend it did — one line, log-friendly. */
export type SelectionReason =
  | "brave_primary"
  | "brave_quota_exhausted"
  | "brave_error"
  | "high_value_gate"
  | "brave_low_quality";
