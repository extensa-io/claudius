import { z } from "zod";
import { zObjectId } from "./common";

/**
 * `jobs` is the coordination layer between the Vercel app and the Railway worker
 * (Phase 5). The app inserts a job; the worker claims it, runs it off the
 * request path, and streams progress back by appending to the same document.
 * MongoDB is the entire bus — there is no queue product, deliberately (it is the
 * editorial point of this phase): a change stream on inserts wakes the worker,
 * an atomic findOneAndUpdate is the claim, and a TTL index reaps guest jobs.
 *
 * Two job types share one collection, discriminated by `type`:
 *   - "research": a long-running deep-research run (member/admin only).
 *   - "memory_extraction": the Phase 3 extraction sweep, moved off Vercel cron.
 *
 * The shared lifecycle fields (status, progress, timestamps) are identical
 * across both; only `input` and `result` differ, which is exactly what a
 * discriminated union models — narrowing on `type` gives the worker the right
 * input and result shapes with no casts.
 */

/** One append-only progress entry the worker writes as a job advances. */
export const JobProgressEntrySchema = z.object({
  /** A short machine-ish label, e.g. "search", "read", "synthesize". */
  step: z.string(),
  /** A human line for the UI, e.g. "Reading source 4 of 9". */
  detail: z.string(),
  at: z.date(),
});
export type JobProgressEntry = z.infer<typeof JobProgressEntrySchema>;

export const JobStatusSchema = z.enum([
  "queued",
  "running",
  "done",
  "failed",
  "cancelled",
]);
export type JobStatus = z.infer<typeof JobStatusSchema>;

/** A numbered source cited in a research report. */
export const ResearchSourceSchema = z.object({
  n: z.number().int().positive(),
  title: z.string(),
  url: z.string(),
});
export type ResearchSource = z.infer<typeof ResearchSourceSchema>;

/** What a research job needs to run: the question and which model to reason with. */
export const ResearchJobInputSchema = z.object({
  question: z.string().min(1),
  modelId: z.string().min(1),
});

/** A finished research report: markdown with inline [n] citations + the sources. */
export const ResearchJobResultSchema = z.object({
  report: z.string(),
  sources: z.array(ResearchSourceSchema),
  searchesRun: z.number().int().nonnegative(),
  pagesRead: z.number().int().nonnegative(),
});
export type ResearchJobResult = z.infer<typeof ResearchJobResultSchema>;

/** A memory-extraction job carries no extra input; the conversation is enough. */
export const MemoryExtractionJobInputSchema = z.object({});

/** Extraction counts, mirroring the Phase 3 ExtractionSummary tallies. */
export const MemoryExtractionJobResultSchema = z.object({
  created: z.number().int().nonnegative(),
  superseded: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  status: z.string(),
});
export type MemoryExtractionJobResult = z.infer<
  typeof MemoryExtractionJobResultSchema
>;

// Fields every job carries, regardless of type. Spread into each variant so the
// discriminated union stays honest (one `type` literal per branch) without a
// separate base type the union members would have to intersect.
//
// `_id` is deliberately NOT part of the schema. A discriminated-union collection
// type makes the driver's insert typing reject an optional `_id` on the document
// (it can't reconcile the union's shared id), so we let reads carry `_id` via the
// driver's `WithId<Job>` and keep the insert shape id-free. Validation still
// covers every field that actually varies between the two job types.
const baseJobFields = {
  userId: zObjectId,
  // The conversation a job belongs to. Research appends its report here; memory
  // extraction reads this thread's transcript. Never null in Phase 5.
  conversationId: zObjectId,
  status: JobStatusSchema,
  progress: z.array(JobProgressEntrySchema),
  error: z.string().nullable(),
  createdAt: z.date(),
  startedAt: z.date().nullable(),
  finishedAt: z.date().nullable(),
  /**
   * Guest-owned jobs (memory extraction on an ephemeral guest conversation)
   * carry expiresAt for the TTL index, mirroring the invariant on conversations
   * and memories. Member/admin jobs omit it and are kept. Guests never create
   * research jobs, so a research job never has this field.
   */
  expiresAt: z.date().optional(),
} as const;

export const ResearchJobSchema = z.object({
  ...baseJobFields,
  type: z.literal("research"),
  input: ResearchJobInputSchema,
  result: ResearchJobResultSchema.nullable(),
});

export const MemoryExtractionJobSchema = z.object({
  ...baseJobFields,
  type: z.literal("memory_extraction"),
  input: MemoryExtractionJobInputSchema,
  result: MemoryExtractionJobResultSchema.nullable(),
});

export const JobSchema = z.discriminatedUnion("type", [
  ResearchJobSchema,
  MemoryExtractionJobSchema,
]);
export type Job = z.infer<typeof JobSchema>;
export type ResearchJob = z.infer<typeof ResearchJobSchema>;
export type MemoryExtractionJob = z.infer<typeof MemoryExtractionJobSchema>;
export type JobType = Job["type"];
