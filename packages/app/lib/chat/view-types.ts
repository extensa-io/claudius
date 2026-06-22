/**
 * Client-safe view models. These mirror what the API returns but live in their
 * own module so client components can import them without pulling in any
 * server-only code (Mongo, @claudius/shared). The server's ConversationSummary
 * is structurally identical to this type.
 */

export interface ConversationSummary {
  id: string;
  title: string;
  modelId: string;
  archived: boolean;
  updatedAt: string;
  lastMessagePreview: string | null;
}

export interface ModelOption {
  id: string;
  displayName: string;
}

/** The shape the web_search tool returns, as parsed on the client for sources. */
export interface WebSearchToolOutput {
  results: Array<{ title: string; url: string; snippet: string }>;
}
