import type { WithId } from "mongodb";
import type { Job } from "../db/schemas";
import { jobsCol } from "../db/collections";

/**
 * The claim + recovery primitives the worker relies on. Both are pure MongoDB
 * operations so a job's lifecycle is coordinated entirely through the database
 * (Phase 5's Mongo-as-bus constraint) with no external queue.
 */

/**
 * Atomically claim the oldest queued job: one `findOneAndUpdate` flips exactly
 * one queued job to running and hands it back. Because the read-and-write is a
 * single atomic op, two worker instances could race here and each would still
 * get a *different* job (or null) — never the same one twice. That is what makes
 * the single-worker design safe to scale later without changing this code.
 */
export async function claimNextJob(): Promise<WithId<Job> | null> {
  const col = await jobsCol();
  const claimed = await col.findOneAndUpdate(
    { status: "queued" },
    { $set: { status: "running", startedAt: new Date() } },
    { sort: { createdAt: 1 }, returnDocument: "after" },
  );
  return claimed ?? null;
}

/**
 * On boot, reclaim jobs left `running` by a previous process that was killed
 * mid-job: flip them back to `queued` and clear `startedAt` so they run again.
 * With a single worker, any job still `running` at startup is by definition
 * orphaned (this process just started, so it cannot own it). This is what
 * satisfies the "kill the worker mid-job and restart — no orphaned running job"
 * criterion; the extraction watermark and the research report's absence make the
 * re-run safe to repeat.
 */
export async function recoverStaleJobs(): Promise<number> {
  const col = await jobsCol();
  const res = await col.updateMany(
    { status: "running" },
    { $set: { status: "queued", startedAt: null } },
  );
  return res.modifiedCount;
}
