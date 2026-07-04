import { ObjectId } from "mongodb";
import { jobsCol } from "../db/collections";
import {
  MemoryConsolidationJobSchema,
  MemoryExtractionJobSchema,
  ResearchJobSchema,
} from "../db/schemas";

/**
 * Enqueue helpers — the app (and the memory cron) insert work here; the worker
 * consumes it. An insert is all it takes: the worker either wakes on the change
 * stream or picks it up on the next poll. Every inserted job is validated
 * against JobSchema at this boundary so a malformed job never reaches the worker.
 */

export interface EnqueueResearchParams {
  userId: ObjectId;
  conversationId: ObjectId;
  question: string;
  modelId: string;
  /** Present when this run refines an earlier report. */
  refinement?: string;
  priorReport?: string;
  parentJobId?: string;
}

/** Insert a queued research job and return its id. Members/admins only (guests
 * are blocked upstream — research jobs never carry an expiresAt). */
export async function enqueueResearchJob(
  params: EnqueueResearchParams,
): Promise<ObjectId> {
  const job = ResearchJobSchema.parse({
    type: "research",
    userId: params.userId,
    conversationId: params.conversationId,
    status: "queued",
    input: {
      question: params.question,
      modelId: params.modelId,
      ...(params.refinement ? { refinement: params.refinement } : {}),
      ...(params.priorReport ? { priorReport: params.priorReport } : {}),
      ...(params.parentJobId ? { parentJobId: params.parentJobId } : {}),
    },
    result: null,
    progress: [],
    error: null,
    createdAt: new Date(),
    startedAt: null,
    finishedAt: null,
  });
  const col = await jobsCol();
  const res = await col.insertOne(job);
  return res.insertedId;
}

export interface EnqueueMemoryParams {
  userId: ObjectId;
  conversationId: ObjectId;
  /** Set for guest-owned conversations so the job is TTL-reaped like the rest
   * of that guest's ephemeral data. Omitted for members/admins. */
  expiresAt?: Date;
}

/**
 * Enqueue a memory-extraction job for one conversation, deduped: if a job for
 * this conversation is already queued or running, skip and return null. The cron
 * enqueues the full stale set on every run, so without this a slow worker would
 * accumulate duplicate extraction jobs for the same thread.
 */
export async function enqueueMemoryExtractionJob(
  params: EnqueueMemoryParams,
): Promise<ObjectId | null> {
  const col = await jobsCol();

  const existing = await col.findOne({
    type: "memory_extraction",
    conversationId: params.conversationId,
    status: { $in: ["queued", "running"] },
  });
  if (existing) return null;

  const job = MemoryExtractionJobSchema.parse({
    type: "memory_extraction",
    userId: params.userId,
    conversationId: params.conversationId,
    status: "queued",
    input: {},
    result: null,
    progress: [],
    error: null,
    createdAt: new Date(),
    startedAt: null,
    finishedAt: null,
    ...(params.expiresAt ? { expiresAt: params.expiresAt } : {}),
  });
  const res = await col.insertOne(job);
  return res.insertedId;
}

/**
 * Enqueue a per-user memory consolidation job (Phase 6), deduped: if one is
 * already queued or running for this user, skip and return null. The daily cron
 * enqueues the full memory-eligible set, so dedup keeps a slow worker from
 * stacking duplicate passes over the same store. Members/admins only — guest
 * memories are ephemeral (TTL), so there's nothing to consolidate.
 */
export async function enqueueMemoryConsolidationJob(
  userId: ObjectId,
): Promise<ObjectId | null> {
  const col = await jobsCol();

  const existing = await col.findOne({
    type: "memory_consolidation",
    userId,
    status: { $in: ["queued", "running"] },
  });
  if (existing) return null;

  const job = MemoryConsolidationJobSchema.parse({
    type: "memory_consolidation",
    userId,
    // No owning conversation: consolidation spans the whole store.
    conversationId: null,
    status: "queued",
    input: {},
    result: null,
    progress: [],
    error: null,
    createdAt: new Date(),
    startedAt: null,
    finishedAt: null,
  });
  const res = await col.insertOne(job);
  return res.insertedId;
}
