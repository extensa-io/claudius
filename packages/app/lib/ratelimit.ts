import type { ObjectId } from "mongodb";
import { AppError, checkRateLimit } from "@claudius/shared";

/**
 * Per-route burst limits (Phase 4). These are an abuse backstop, deliberately
 * looser-feeling than they sound and entirely separate from tier daily caps: a
 * member can send 200 messages/day (the tier cap) but not 20 in ten seconds
 * (this). The window is short so a normal user never notices it.
 */
const LIMITS = {
  chat: { limit: 20, windowMs: 60_000 },
  upload: { limit: 10, windowMs: 60_000 },
} as const;

export type RateLimitKey = keyof typeof LIMITS;

/** Consume one unit of the user's window for `key`; throw if over the limit. */
export async function enforceRateLimit(
  userId: ObjectId,
  key: RateLimitKey,
): Promise<void> {
  const result = await checkRateLimit(userId, key, LIMITS[key]);
  if (!result.allowed) {
    const secs = Math.max(1, Math.ceil(result.retryAfterMs / 1000));
    throw new AppError(
      "rate_limited",
      `Too many requests. Please try again in ${secs}s.`,
    );
  }
}
