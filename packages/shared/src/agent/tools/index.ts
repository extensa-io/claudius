import { webSearchTool } from "./webSearch";

/** The tools the agent is bound to. One in Phase 1; more arrive later. */
export const tools = [webSearchTool];

export { webSearchTool, type WebSearchResult } from "./webSearch";
