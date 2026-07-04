import type { ObjectId, UpdateFilter } from "mongodb";
import { jobsCol } from "../db/collections";
import type {
  Job,
  MemoryConsolidationJobResult,
  MemoryExtractionJobResult,
  ResearchJobResult,
} from "../db/schemas";

/**
 * The worker's write side of a job's lifecycle: append progress, and terminate
 * the job as done or failed. `complete`/`fail` are guarded on `status: running`
 * so a job the user cancelled mid-run (status already `cancelled`) is never
 * overwritten back to done/failed — cancellation wins.
 */

/** Append one progress entry. The UI polls the growing array for live updates. */
export async function appendJobProgress(
  jobId: ObjectId,
  entry: { step: string; detail: string },
): Promise<void> {
  const col = await jobsCol();
  await col.updateOne(
    { _id: jobId },
    { $push: { progress: { ...entry, at: new Date() } } },
  );
}

type JobResult =
  | ResearchJobResult
  | MemoryExtractionJobResult
  | MemoryConsolidationJobResult;

/** Mark a running job done with its result. No-op if it was cancelled first. */
export async function completeJob(
  jobId: ObjectId,
  result: JobResult,
): Promise<void> {
  const col = await jobsCol();
  // `result` is branch-specific (research vs memory), which the discriminated-
  // union collection type can't reconcile in a single $set. The value is
  // validated by its own schema at the call site, so we assert the update shape.
  const update = {
    $set: { status: "done", result, finishedAt: new Date() },
  } as unknown as UpdateFilter<Job>;
  await col.updateOne({ _id: jobId, status: "running" }, update);
}

/** Mark a running job failed with a user-safe reason. No-op if cancelled first. */
export async function failJob(jobId: ObjectId, error: string): Promise<void> {
  const col = await jobsCol();
  await col.updateOne(
    { _id: jobId, status: "running" },
    { $set: { status: "failed", error, finishedAt: new Date() } },
  );
}

/**
 * Whether a job has been cancelled. The worker calls this between steps so a
 * cancel lands within one step (the acceptance bar). One projected read.
 */
export async function isJobCancelled(jobId: ObjectId): Promise<boolean> {
  const col = await jobsCol();
  const doc = await col.findOne(
    { _id: jobId },
    { projection: { status: 1 } },
  );
  return doc?.status === "cancelled";
}
