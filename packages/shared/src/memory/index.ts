// The memory subsystem (Phase 3). Extraction/dedup/caps/retrieval logic lives
// here in `shared` so the Phase 4 worker reuses it; only Next.js-bound triggers
// and UI live in the app package.

export {
  type MemoryCandidate,
  MemoryCandidateSchema,
  ExtractionOutputSchema,
  type RetrievedMemory,
  type PersistOutcome,
  type ExtractionSummary,
} from "./types";
export { extractCandidates, CONFIDENCE_THRESHOLD } from "./extract";
export { persistCandidate } from "./persist";
export { retrieveMemories } from "./retrieve";
export { processConversationMemories } from "./process";
export {
  type MemorySort,
  type MemoryView,
  type SupersededRef,
  type MemorySettings,
  type ListMemoriesOptions,
  listMemories,
  getSupersessionChain,
  editMemory,
  deleteMemory,
  getMemorySettings,
  setMemoryEnabled,
} from "./store";
