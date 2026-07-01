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
 * dropped so small talk never becomes a memory.
 */
export const MemoryCandidateSchema = z.object({
  content: z.string().trim().min(3).max(500),
  category: MemoryCategorySchema,
  confidence: z.number().min(0).max(1),
});
export type MemoryCandidate = z.infer<typeof MemoryCandidateSchema>;

/** The raw JSON contract we ask the extraction model to return. */
export const ExtractionOutputSchema = z.object({
  memories: z.array(MemoryCandidateSchema),
});

/** A memory as retrieved for a chat turn (and surfaced in the "used" chip). */
export interface RetrievedMemory {
  id: string;
  content: string;
  category: MemoryCategory;
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
