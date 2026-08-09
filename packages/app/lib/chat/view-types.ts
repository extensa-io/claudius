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
  /** Started as an incognito thread: no memories, no authored instructions. */
  incognito: boolean;
}

export interface ModelOption {
  id: string;
  displayName: string;
  /** Whether the model accepts images (Phase 12), from the catalog entry. The
   * composer uses it to explain why attaching is unavailable on this model; the
   * server re-checks it, so this is presentation only. */
  supportsImages: boolean;
}

/**
 * The signed-in role's image policy, or null when the role gets no image service
 * (guests). Mirrors TierImagePolicy in shared. Advisory to the client — it
 * resizes and counts here because it is cheap to do so — and authoritative on
 * the server, which re-checks both.
 */
export interface ImagePolicyView {
  maxPerTurn: number;
  maxLongEdgePx: number;
  enforcement: "hard" | "warn";
}

/** An attached document as the client renders it (chip + status). Mirrors the
 * server's DocumentView in app/lib/documents.ts. */
export interface DocumentView {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  status: "uploaded" | "parsed" | "embedded" | "ready" | "failed";
  failureReason: string | null;
}

/** The shape retrieve_documents returns, parsed on the client for citations. */
export interface RetrieveToolOutput {
  results: Array<{
    text: string;
    documentName: string;
    location: string | null;
  }>;
}

/** The shape the web_search tool returns, as parsed on the client for sources. */
export interface WebSearchToolOutput {
  results: Array<{ title: string; url: string; snippet: string }>;
}

/** The shape read_url returns, parsed on the client for the "read a page" card. */
export interface ReadUrlToolOutput {
  url: string;
  kind: "github" | "web";
  title?: string;
  content?: string;
  error?: string;
}
