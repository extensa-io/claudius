import type { ObjectId, WithId } from "mongodb";
import { jobsCol } from "../db/collections";
import type { Job } from "../db/schemas";

/**
 * The app's read/control side of jobs. Every query filters by `userId`
 * (invariant #1): the status endpoint the client polls, the conversation's job
 * list, and the cancel action all scope to the owner, so no user can observe or
 * cancel another user's job.
 */

/** One job, only if it belongs to this user. Powers the polling status endpoint. */
export async function getJobForOwner(
  userId: ObjectId,
  jobId: ObjectId,
): Promise<WithId<Job> | null> {
  const col = await jobsCol();
  return col.findOne({ _id: jobId, userId });
}

/**
 * A conversation's jobs, newest first, owner-scoped. The chat UI uses this to
 * rehydrate research cards (with their final reports) when a conversation is
 * reopened. Capped because a thread accrues few research runs.
 */
export async function listConversationJobs(
  userId: ObjectId,
  conversationId: ObjectId,
  limit = 20,
): Promise<WithId<Job>[]> {
  const col = await jobsCol();
  return col
    .find({ userId, conversationId })
    .sort({ createdAt: -1 })
    .limit(limit)
    .toArray();
}

/**
 * Request cancellation of the user's own job. Only a queued or running job can
 * be cancelled; a finished one is left alone. Setting `status: cancelled` is the
 * whole protocol — the worker honors it between steps (see isJobCancelled), and
 * `finishedAt` is stamped now so a never-started (queued) job reads as closed.
 * Returns true when a job was actually transitioned.
 */
export async function requestJobCancel(
  userId: ObjectId,
  jobId: ObjectId,
): Promise<boolean> {
  const col = await jobsCol();
  const res = await col.updateOne(
    { _id: jobId, userId, status: { $in: ["queued", "running"] } },
    { $set: { status: "cancelled", finishedAt: new Date() } },
  );
  return res.modifiedCount > 0;
}
