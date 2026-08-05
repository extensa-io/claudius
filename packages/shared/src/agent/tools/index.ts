import { retrieveDocumentsTool } from "./retrieveDocuments";
import { readUrlTool } from "./url/readUrl";
import { webSearchTool } from "./webSearch";

/**
 * The full tool set the agent *can* run. The ToolNode is built from this list,
 * so every tool here is executable. Which tools the model is actually offered on
 * a given turn is decided per-run (see graph.ts): retrieve_documents is only
 * bound when the conversation has attached documents, and read_url only for
 * members and admins, so the model never reaches for a tool it isn't allowed.
 */
export const tools = [webSearchTool, retrieveDocumentsTool, readUrlTool];

/** Tools available on every turn. */
export const baseTools = [webSearchTool];

/** Tools added only when the conversation has retrievable documents. */
export const documentTools = [retrieveDocumentsTool];

/** Tools added only for member/admin turns (guests never get URL fetching). */
export const urlTools = [readUrlTool];

/**
 * Decide which tools a single turn offers the model. Pure and exported so the
 * gating is directly assertable in tests — the guest/member split on read_url is
 * a role boundary (invariant #2), and a boundary that can only be verified by
 * reading the agent node is a boundary that can regress silently.
 *
 * Both flags come from server-resolved state (`canReadUrls` from the session
 * role, `hasDocuments` from a userId-scoped query), never from the client.
 */
export function selectBoundTools({
  hasDocuments,
  canReadUrls,
}: {
  hasDocuments: boolean;
  canReadUrls: boolean;
}): typeof tools {
  return [
    ...baseTools,
    ...(hasDocuments ? documentTools : []),
    ...(canReadUrls ? urlTools : []),
  ];
}

export {
  webSearchTool,
  type WebSearchResult,
  SEARCH_SOURCE_EVENT,
  type SearchSourceEvent,
} from "./webSearch";
export {
  retrieveDocumentsTool,
  type RetrievedChunk,
} from "./retrieveDocuments";
export {
  readUrlTool,
  type ReadUrlToolOutput,
  URL_READ_EVENT,
  type UrlReadEvent,
} from "./url/readUrl";
export {
  extractPages,
  extractReadable,
  type ExtractedPage,
  MAX_PAGE_CHARS,
} from "./url/extract";
