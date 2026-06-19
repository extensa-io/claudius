import { ObjectId } from "mongodb";
import { usersCol, type Role } from "@claudius/shared";
import { resolveRole } from "./roles";

/**
 * Runs once per sign-in (from the jwt callback). The Auth.js adapter has
 * already created the bare user document (name/email/image); this fills in the
 * Claudius application fields. Role is recomputed every sign-in so an allowlist
 * change takes effect on the user's next login. The tier/usage fields are
 * seeded with $ifNull so we default them on first sign-in but never overwrite
 * values that later phases or an admin may have changed.
 */
export async function provisionUser(
  userId: string,
  email: string | null | undefined,
): Promise<Role> {
  const role = await resolveRole(email);
  const users = await usersCol();

  // Reset window for the daily message cap: 24h from first provisioning.
  const resetsAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

  await users.updateOne({ _id: new ObjectId(userId) }, [
    {
      $set: {
        role,
        allowedModels: { $ifNull: ["$allowedModels", null] },
        monthlyTokenBudget: { $ifNull: ["$monthlyTokenBudget", null] },
        status: { $ifNull: ["$status", "active"] },
        dailyMessageCount: {
          $ifNull: ["$dailyMessageCount", { count: 0, resetsAt }],
        },
      },
    },
  ]);

  return role;
}
