import type { WithId } from "mongodb";
import {
  appendJobProgress,
  completeJob,
  consolidateUserMemories,
  isJobCancelled,
  type MemoryConsolidationJob,
  usersCol,
} from "@claudius/shared";
import { log } from "../log";

/**
 * Cross-category consolidation (Phase 6), run on the worker for the same reason
 * extraction is: it's a periodic sweep over a user's whole store, off the request
 * path. The heavy lifting is the shared `consolidateUserMemories` heuristic (no
 * model call), so this runner is just lifecycle glue: load the user, run the
 * pass, record the tallies. The daily cron enqueues one of these per memory-
 * eligible user.
 */
export async function runMemoryConsolidationJob(
  job: WithId<MemoryConsolidationJob>,
): Promise<void> {
  const jobId = job._id;
  const { userId } = job;

  if (await isJobCancelled(jobId)) return;

  const users = await usersCol();
  const user = await users.findOne({ _id: userId });

  // A vanished/disabled user is a no-op success; the enqueuer already gates on
  // these, so this is defense in depth.
  if (!user || user.status === "disabled") {
    await completeJob(jobId, {
      clustersMerged: 0,
      memoriesMerged: 0,
      pruned: 0,
      status: "skipped",
    });
    return;
  }

  await appendJobProgress(jobId, {
    step: "consolidate",
    detail: "Merging near-duplicate memories and pruning stale ones",
  });

  const summary = await consolidateUserMemories({ user });

  await completeJob(jobId, {
    clustersMerged: summary.clustersMerged,
    memoriesMerged: summary.memoriesMerged,
    pruned: summary.pruned,
    status: summary.status,
  });
  log.info("memory consolidation job complete", {
    jobId: jobId.toString(),
    status: summary.status,
    clustersMerged: summary.clustersMerged,
    memoriesMerged: summary.memoriesMerged,
    pruned: summary.pruned,
  });
}
