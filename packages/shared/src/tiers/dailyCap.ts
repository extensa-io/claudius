import type { ObjectId } from "mongodb";
import { usersCol } from "../db/collections";

/**
 * Midnight UTC at the start of the day *after* `now`. The daily message cap
 * resets on the UTC calendar boundary (spec: "daily cap with UTC reset"), so a
 * user's allowance refills at 00:00 UTC regardless of their local timezone.
 */
export function startOfNextUtcDay(now: Date): Date {
  return new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() + 1,
      0,
      0,
      0,
      0,
    ),
  );
}

/**
 * Atomically consume one unit of the user's daily message allowance.
 *
 * Two database operations, each atomic, together race-safe:
 *
 *   1. Reset-if-expired: zero the counter and push `resetsAt` to the next UTC
 *      midnight, but only when the stored window has already lapsed. The filter
 *      on `resetsAt <= now` plus moving it into the future means exactly one
 *      concurrent request wins the reset; the rest see a future window and skip.
 *   2. Guarded increment: `$inc` the counter only while it is still below the
 *      cap. Because the filter and the increment are a single atomic update,
 *      two concurrent requests can never both push the count past `cap` — the
 *      classic check-then-act race is collapsed into one operation.
 *
 * Returns whether the allowance was consumed. `false` means the cap is reached
 * and no Bedrock call should be made.
 */
export async function consumeDailyMessage(
  userId: ObjectId,
  cap: number,
  now: Date = new Date(),
): Promise<boolean> {
  const users = await usersCol();

  await users.updateOne(
    { _id: userId, "dailyMessageCount.resetsAt": { $lte: now } },
    {
      $set: {
        "dailyMessageCount.count": 0,
        "dailyMessageCount.resetsAt": startOfNextUtcDay(now),
      },
    },
  );

  const updated = await users.findOneAndUpdate(
    { _id: userId, "dailyMessageCount.count": { $lt: cap } },
    { $inc: { "dailyMessageCount.count": 1 } },
    { returnDocument: "after" },
  );

  return updated !== null;
}
