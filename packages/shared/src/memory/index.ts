// The memory subsystem (Phase 3). Extraction/dedup/caps/retrieval logic lives
// here in `shared` so the Phase 4 worker reuses it; only Next.js-bound triggers
// and UI live in the app package.

export {
  type MemoryCandidate,
  MemoryCandidateSchema,
  ExtractionOutputSchema,
  type RetrievedMemory,
  type MemorySource,
  type PersistOutcome,
  type ExtractionSummary,
} from "./types";
export { extractCandidates, CONFIDENCE_THRESHOLD } from "./extract";
export { persistCandidate } from "./persist";
export { retrieveMemories, getProfileMemories } from "./retrieve";
export { processConversationMemories } from "./process";
export {
  consolidateUserMemories,
  type ConsolidationSummary,
} from "./consolidate";
export {
  type MemorySort,
  type MemoryView,
  type SupersededRef,
  type MemorySettings,
  type ListMemoriesOptions,
  listMemories,
  getSupersessionChain,
  editMemory,
  setImportance,
  deleteMemory,
  getMemorySettings,
  setMemoryEnabled,
} from "./store";
