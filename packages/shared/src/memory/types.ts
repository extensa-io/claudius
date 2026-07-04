import { z } from "zod";
import { MemoryCategorySchema, type MemoryCategory } from "../db/schemas";

/**
 * Shared shapes for the memory subsystem. Kept in one leaf module so both the
 * extraction/persistence side and the retrieval/UI side agree on the types, and
 * so nothing here imports the graph or the collections (no cycles).
 */

/**
 * A candidate memory as the extraction model proposes it, before dedup and
 * persistence. `confidence` is the model's own 0..1 estimate that this is a
 * durable, worth-remembering fact about the user; low-confidence candidates are
 * dropped so small talk never becomes a memory. `importance` (Phase 6) is a
 * separate 0..1 axis: how central this is to who the user is (identity facts
 * high, incidental details low). It drives salience-weighted retrieval and the
 * always-on profile, and is distinct from confidence — a fact can be certain but
 * minor, or defining but softly implied.
 */
export const MemoryCandidateSchema = z.object({
  content: z.string().trim().min(3).max(500),
  category: MemoryCategorySchema,
  confidence: z.number().min(0).max(1),
  // Default 0.5 (neutral) so an older extraction prompt or a model that omits
  // the field still yields a valid, mid-salience candidate rather than dropping.
  importance: z.number().min(0).max(1).default(0.5),
});
export type MemoryCandidate = z.infer<typeof MemoryCandidateSchema>;

/** The raw JSON contract we ask the extraction model to return. */
export const ExtractionOutputSchema = z.object({
  memories: z.array(MemoryCandidateSchema),
});

/**
 * Where a memory that grounded a turn came from (Phase 6). `profile` is the
 * always-on resident identity block, injected every turn regardless of vector
 * score; `retrieved` is the salience-weighted vector match for this turn. The
 * "used N memories" chip splits the two so the user sees which is which.
 */
export type MemorySource = "profile" | "retrieved";

/** A memory as retrieved for a chat turn (and surfaced in the "used" chip). */
export interface RetrievedMemory {
  id: string;
  content: string;
  category: MemoryCategory;
  /** Set when the memory is surfaced to the UI; omitted internally. */
  source?: MemorySource;
}

/** What persisting a single candidate did — drives the extraction summary. */
export type PersistOutcome =
  | { action: "created"; memoryId: string; content: string; category: MemoryCategory }
  | {
      action: "superseded";
      memoryId: string;
      supersededId: string;
      content: string;
      previousContent: string;
      category: MemoryCategory;
    }
  | { action: "skipped"; reason: "duplicate" };

export interface ExtractionSummary {
  status: "ok" | "disabled" | "no_allowance" | "up_to_date" | "no_content";
  created: number;
  superseded: number;
  skipped: number;
  outcomes: PersistOutcome[];
}
