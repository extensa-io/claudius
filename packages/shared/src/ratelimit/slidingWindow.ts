import type { ObjectId, UpdateFilter } from "mongodb";
import { rateLimitsCol } from "../db/collections";
import type { RateLimit } from "../db/schemas";

/**
 * A per-user sliding-window rate limiter backed by Mongo (Phase 4). This is an
 * abuse backstop, deliberately separate from the tier's daily message cap: the
 * daily cap is a product limit (how much a plan includes), this is a burst limit
 * (how fast anyone may hammer a route), so both can apply to the same request.
 *
 * Each check does two small ops on the (userId, key) document:
 *   1. prune hits older than the window and read what remains,
 *   2. if the survivors are already at the limit, deny; otherwise record the hit.
 *
 * Pruning on every call keeps storage bounded to at most `limit` timestamps.
 * The tiny gap between the count and the push can let a hair over `limit`
 * through under heavy concurrency, which is fine for a backstop — it never lets
 * an unbounded flood through, and the TTL index reaps idle rows.
 */

export interface RateLimitOptions {
  limit: number;
  windowMs: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  /** Milliseconds until the oldest in-window hit expires (only when denied). */
  retryAfterMs: number;
}

export async function checkRateLimit(
  userId: ObjectId,
  key: string,
  { limit, windowMs }: RateLimitOptions,
  now: Date = new Date(),
): Promise<RateLimitResult> {
  const col = await rateLimitsCol();
  const windowStart = new Date(now.getTime() - windowMs);

  // 1. Drop expired hits and read the survivors in one atomic update.
  // The driver's $pull typing can't express a range condition ($lt) on a Date[]
  // element, so we assert the update shape. The query itself is valid MongoDB.
  const pruneUpdate = {
    $pull: { hits: { $lt: windowStart } },
    $set: { updatedAt: now },
    $setOnInsert: { userId, key },
  } as unknown as UpdateFilter<RateLimit>;
  const pruned = await col.findOneAndUpdate({ userId, key }, pruneUpdate, {
    upsert: true,
    returnDocument: "after",
  });

  const hits = pruned?.hits ?? [];
  if (hits.length >= limit) {
    const oldest = hits[0]?.getTime() ?? now.getTime();
    return {
      allowed: false,
      remaining: 0,
      retryAfterMs: Math.max(0, oldest + windowMs - now.getTime()),
    };
  }

  // 2. Under the limit: record this hit.
  await col.updateOne({ userId, key }, { $push: { hits: now } });
  return {
    allowed: true,
    remaining: limit - hits.length - 1,
    retryAfterMs: 0,
  };
}
