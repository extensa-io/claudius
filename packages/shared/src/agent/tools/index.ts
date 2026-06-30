import { retrieveDocumentsTool } from "./retrieveDocuments";
import { webSearchTool } from "./webSearch";

/**
 * The full tool set the agent *can* run. The ToolNode is built from this list,
 * so every tool here is executable. Which tools the model is actually offered on
 * a given turn is decided per-run (see graph.ts): retrieve_documents is only
 * bound when the conversation has attached documents, so the model never reaches
 * for document search on a plain chat.
 */
export const tools = [webSearchTool, retrieveDocumentsTool];

/** Tools available on every turn. */
export const baseTools = [webSearchTool];

/** Tools added only when the conversation has retrievable documents. */
export const documentTools = [retrieveDocumentsTool];

export { webSearchTool, type WebSearchResult } from "./webSearch";
export {
  retrieveDocumentsTool,
  type RetrievedChunk,
} from "./retrieveDocuments";
