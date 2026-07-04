import {
  enqueueMemoryConsolidationJob,
  usersCol,
} from "@claudius/shared";

/**
 * Phase 6: the app enqueues one per-user memory consolidation job per eligible
 * user; the Railway worker runs the (model-free) heuristic pass off the request
 * path. Only members and admins are eligible — guest memories are ephemeral (TTL)
 * and not worth consolidating. Memory-off and disabled users are skipped without
 * touching their data. Enqueue dedupes against a job already queued/running for a
 * user, so overlapping cron runs never stack duplicate passes.
 */
export interface ConsolidationEnqueueResult {
  enqueued: number;
}

export async function enqueueAllConsolidation(
  limit = 500,
): Promise<ConsolidationEnqueueResult> {
  const users = await usersCol();
  const eligible = await users
    .find({
      role: { $in: ["member", "admin"] },
      status: { $ne: "disabled" },
      memoryEnabled: { $ne: false },
    })
    .limit(limit)
    .toArray();

  let enqueued = 0;
  for (const user of eligible) {
    const id = await enqueueMemoryConsolidationJob(user._id!);
    if (id) enqueued += 1;
  }
  return { enqueued };
}
