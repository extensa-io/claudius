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
 *
 * A terminal write also decides how long the finished job is kept, by stamping
 * the same `expiresAt` field the TTL index already watches. Retention is a
 * property of the type, not of the owner:
 *
 *   - The two memory job types are an audit trail and nothing reads them once
 *     they finish (the claim query and the enqueue dedup both look only at
 *     queued/running work, and the UI lists only active jobs), so they reap
 *     after 30 days. They are also the only types that grow on a schedule
 *     rather than on a user action, which is what made this worth doing.
 *   - Research jobs are kept forever. The report text itself lives in the
 *     conversation's checkpoint, but `result.sources` exists ONLY here, and the
 *     refine path reads the parent job's question and report — so expiring an
 *     old research job would silently disable Refine on a report the user can
 *     still see. A handful of documents is not worth that.
 */

const FINISHED_MEMORY_JOB_TTL_DAYS = 30;

/** Job types whose finished documents are safe to reap (see the note above). */
const REAPABLE_TYPES: ReadonlyArray<Job["type"]> = [
  "memory_extraction",
  "memory_consolidation",
];

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

/**
 * The `expiresAt` expression shared by both terminal writes.
 *
 * It has to be an aggregation expression rather than a plain value because the
 * decision depends on the document being updated: the caller knows the result
 * shape but the retention rule keys off `type`, and we want one round trip that
 * both finishes the job and schedules its own reaping.
 *
 * `$ifNull` is the important part. A guest's extraction job already carries a
 * short `expiresAt` from enqueue, tied to the rest of that guest's ephemeral
 * data, and this must never extend it to 30 days. For a research job the
 * expression evaluates to the missing `$expiresAt`, and an aggregation `$set`
 * skips a field whose value is missing — so the field is never added at all.
 */
function reapExpression(now: Date): Record<string, unknown> {
  const reapAt = new Date(
    now.getTime() + FINISHED_MEMORY_JOB_TTL_DAYS * 24 * 60 * 60 * 1000,
  );
  return {
    $cond: [
      { $in: ["$type", REAPABLE_TYPES] },
      { $ifNull: ["$expiresAt", reapAt] },
      "$expiresAt",
    ],
  };
}

/** Mark a running job done with its result. No-op if it was cancelled first. */
export async function completeJob(
  jobId: ObjectId,
  result: JobResult,
): Promise<void> {
  const col = await jobsCol();
  const now = new Date();
  // `result` is branch-specific (research vs memory), which the discriminated-
  // union collection type can't reconcile in a single $set. The value is
  // validated by its own schema at the call site, so we assert the update shape.
  // `$literal` keeps the result object a value, not an expression, now that this
  // is a pipeline update.
  const update = [
    {
      $set: {
        status: "done",
        result: { $literal: result },
        finishedAt: now,
        expiresAt: reapExpression(now),
      },
    },
  ] as unknown as UpdateFilter<Job>;
  await col.updateOne({ _id: jobId, status: "running" }, update);
}

/** Mark a running job failed with a user-safe reason. No-op if cancelled first. */
export async function failJob(jobId: ObjectId, error: string): Promise<void> {
  const col = await jobsCol();
  const now = new Date();
  // A failed job is reaped on the same rule as a successful one: the memory
  // types are an audit trail either way, and a failed research run still holds
  // the progress trail that explains what went wrong.
  const update = [
    {
      $set: {
        status: "failed",
        error,
        finishedAt: now,
        expiresAt: reapExpression(now),
      },
    },
  ] as unknown as UpdateFilter<Job>;
  await col.updateOne({ _id: jobId, status: "running" }, update);
}

/**
 * Whether a job has been cancelled. The worker calls this between steps so a
 * cancel lands within one step (the acceptance bar). One projected read.
 *
 * A job that has VANISHED counts as cancelled. Deleting a conversation removes
 * its jobs, and a research run already in flight would otherwise finish and
 * append its report to a thread the user deleted — recreating checkpoints that
 * no conversation points at. Nothing else deletes a job mid-run, so treating
 * "gone" as "stop" has no other caller to surprise.
 */
export async function isJobCancelled(jobId: ObjectId): Promise<boolean> {
  const col = await jobsCol();
  const doc = await col.findOne(
    { _id: jobId },
    { projection: { status: 1 } },
  );
  return doc === null || doc.status === "cancelled";
}
