import { z } from "zod";
import { zObjectId } from "./common";

/**
 * `rate_limits` backs a per-user sliding-window limiter (Phase 4), an abuse
 * backstop distinct from the tier's daily message cap. One document per
 * (userId, key) pair — where `key` names the protected action, e.g. "chat" or
 * "upload" — holds the timestamps of recent hits.
 *
 * The array is bounded: each hit pushes `now` and `$slice`s the array to the
 * last N entries, so storage stays O(limit) and the window check is "is the
 * oldest of the last N hits still inside the window?". `updatedAt` carries a TTL
 * so idle limiter rows are reaped automatically.
 */
export const RateLimitSchema = z.object({
  _id: zObjectId.optional(),
  userId: zObjectId,
  key: z.string(),
  hits: z.array(z.date()),
  updatedAt: z.date(),
});

export type RateLimit = z.infer<typeof RateLimitSchema>;
