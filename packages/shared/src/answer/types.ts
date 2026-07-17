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
 * A query's intent, resolved by the heuristic classifier (Phase 8) before the
 * model wakes up. This drives both routing (navigational redirects with zero
 * tokens; informational/transactional flow to the engine) and cache TTL choice.
 *   - `navigational`: the user wants to GO somewhere (a bang, a URL, a bare
 *     domain, a "site login" pattern). Resolves to a URL, never synthesized.
 *   - `informational`: the user wants an ANSWER. The default and common case.
 *   - `transactional`: the user wants to DO something (download, buy, convert).
 *     Returned as results with lighter synthesis and a short cache life.
 *   - `lexical` (Phase 10): a `?` define/translate lookup. Handled by the
 *     dictionary path in the chat route, so it never reaches the search engine;
 *     it appears here only so the classifier stays the single source of intent.
 */
export type Intent =
  | "navigational"
  | "informational"
  | "transactional"
  | "lexical";

/**
 * The intents the SEARCH engine and its cache operate on. `lexical` is served by
 * the dictionary path (Phase 10) and never reaches the search cache, so it is
 * excluded here — narrowing it out keeps the search cache's key and value types
 * honest rather than admitting an intent that can never be stored.
 */
export type SearchIntent = Exclude<Intent, "lexical">;

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
  /**
   * The classified intent (Phase 8). When present it drives cache TTL selection
   * and, together with a depth signal, the Brave→Tavily escalation. Absent reads
   * as `informational` so a Phase 7 caller (the tool passing only `query`) keeps
   * its exact behavior.
   */
  intent?: Intent;
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
  | "brave_low_quality"
  // Phase 8: the informational depth signal escalated Brave → Tavily advanced.
  | "intent_escalation"
  // Phase 8: served from the tiered cache — no backend round trip at all.
  | "cache_hit";
