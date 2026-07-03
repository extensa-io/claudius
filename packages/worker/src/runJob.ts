import type { WithId } from "mongodb";
import { failJob, isAppError, type Job } from "@claudius/shared";
import { log, errMsg } from "./log";
import { runMemoryExtractionJob } from "./memory/run";
import { runResearchJob } from "./research/run";

/**
 * Run one claimed job to completion, routing by type. A discriminated union means
 * the `type` switch narrows `input`/`result` with no casts. Any thrown error is
 * turned into a `failed` job with a user-safe message (AppError messages already
 * are; anything else gets a generic line) — the worker never crashes on one bad
 * job. A cancelled job returns from its runner without completing, so failJob's
 * `status: running` guard leaves the cancellation intact.
 */
export async function runJob(job: WithId<Job>): Promise<void> {
  log.info("running job", { jobId: job._id.toString(), type: job.type });
  try {
    switch (job.type) {
      case "research":
        await runResearchJob(job);
        break;
      case "memory_extraction":
        await runMemoryExtractionJob(job);
        break;
    }
  } catch (err) {
    const message = isAppError(err)
      ? err.message
      : "The job failed to complete.";
    log.error("job failed", {
      jobId: job._id.toString(),
      type: job.type,
      error: errMsg(err),
    });
    await failJob(job._id, message);
  }
}
