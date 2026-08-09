import { ObjectId } from "mongodb";
import {
  type User,
  conversationsCol,
  enqueueMemoryExtractionJob,
  usersCol,
} from "@claudius/shared";

/**
 * Phase 5: the app no longer RUNS memory extraction — it only enqueues it. The
 * heavy checkpointer read + model pass moved to the Railway worker; both triggers
 * (the daily Vercel cron and the sign-in lazy pass) now just insert a
 * `memory_extraction` job per stale conversation, and the worker does the work
 * off the request path. Enqueue is cheap and I/O-light, so it comfortably fits a
 * serverless function even for a large batch.
 */

// Guest-owned jobs are TTL-reaped like the rest of a guest's ephemeral data.
// A day is far longer than the worker needs to drain them.
const GUEST_JOB_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * A conversation needs extraction when it has never been processed or has been
 * touched since it last was — identical to the Phase 3 staleness test.
 */
function staleFilter(): Record<string, unknown> {
  return {
    // Incognito threads are never extracted from, no matter how stale they look.
    // `$ne: true` rather than `{ $exists: false }` so it matches every
    // conversation written before the field existed, without a backfill.
    incognito: { $ne: true },
    $or: [
      { extraction: { $exists: false } },
      { $expr: { $gt: ["$updatedAt", "$extraction.lastRunAt"] } },
    ],
  };
}

function jobParamsFor(user: User, conversationId: ObjectId) {
  return user.role === "guest"
    ? {
        userId: user._id!,
        conversationId,
        expiresAt: new Date(Date.now() + GUEST_JOB_TTL_MS),
      }
    : { userId: user._id!, conversationId };
}

export interface EnqueueResult {
  enqueued: number;
}

/**
 * Enqueue extraction for one user's stale conversations. Called on sign-in (via
 * `after()`), bounded small; the daily cron catches the rest. The enqueuer dedupes
 * against jobs already queued/running for a conversation, so overlapping triggers
 * never pile up duplicate work.
 */
export async function enqueueUserMemories(
  userId: ObjectId,
  limit = 10,
): Promise<EnqueueResult> {
  const users = await usersCol();
  const user = await users.findOne({ _id: userId });
  if (!user || user.status === "disabled" || user.memoryEnabled === false) {
    return { enqueued: 0 };
  }

  const convCol = await conversationsCol();
  const stale = await convCol
    .find({ userId, ...staleFilter() })
    .sort({ updatedAt: -1 })
    .limit(limit)
    .toArray();

  let enqueued = 0;
  for (const conversation of stale) {
    const id = await enqueueMemoryExtractionJob(
      jobParamsFor(user, conversation._id!),
    );
    if (id) enqueued += 1;
  }
  return { enqueued };
}

/**
 * The cron batch: enqueue extraction for stale conversations across all users.
 * Memory-off / disabled users are skipped without touching their data. Bounded,
 * but generously — enqueuing is cheap, and the worker paces the actual model work.
 */
export async function enqueueAllStale(limit = 100): Promise<EnqueueResult> {
  const convCol = await conversationsCol();
  const stale = await convCol
    .find(staleFilter())
    .sort({ updatedAt: -1 })
    .limit(limit)
    .toArray();

  const users = await usersCol();
  const userCache = new Map<string, User | null>();
  let enqueued = 0;

  for (const conversation of stale) {
    const key = conversation.userId.toString();
    let user = userCache.get(key);
    if (user === undefined) {
      user = await users.findOne({ _id: conversation.userId });
      userCache.set(key, user);
    }
    if (!user || user.status === "disabled" || user.memoryEnabled === false) {
      continue;
    }
    const id = await enqueueMemoryExtractionJob(
      jobParamsFor(user, conversation._id!),
    );
    if (id) enqueued += 1;
  }
  return { enqueued };
}
