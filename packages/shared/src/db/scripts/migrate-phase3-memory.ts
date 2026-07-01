import { clientPromise } from "../client";
import { settingsCol, usersCol } from "../collections";

/**
 * Phase 3 data migration. Idempotent, safe to re-run.
 *
 * The seed script only writes settings with `$setOnInsert`, so a `tiers`
 * document that already exists in production is never updated by re-seeding.
 * This migration therefore updates the live singletons in place:
 *
 *   1. Give guests a real memory allowance (`memoryCap` 0 -> 20) and add the
 *      "memory" feature flag, so guest memory can be tested for cap/eviction.
 *   2. Backfill `memoryEnabled: true` on existing users that predate the field.
 *      `provisionUser` sets it on next sign-in, but retrieval and extraction read
 *      it now, and a missing field would read as "off" until the user logs in
 *      again — the backfill makes memory work for existing users immediately.
 */
async function main(): Promise<void> {
  const settings = await settingsCol();

  const tiersResult = await settings.updateOne(
    { _id: "tiers" },
    {
      $set: {
        "guest.memoryCap": 20,
      },
      $addToSet: {
        "guest.features": "memory",
      },
    },
  );
  console.log(
    `settings.tiers.guest: ${
      tiersResult.modifiedCount > 0
        ? "updated (memoryCap=20, +memory feature)"
        : "already current (or missing — run db:seed first)"
    }`,
  );

  const users = await usersCol();
  const usersResult = await users.updateMany(
    { memoryEnabled: { $exists: false } },
    { $set: { memoryEnabled: true } },
  );
  console.log(
    `users.memoryEnabled backfill: ${usersResult.modifiedCount} updated`,
  );

  const client = await clientPromise;
  await client.close();
  console.log("Phase 3 migration complete.");
}

main().catch((error: unknown) => {
  console.error("Phase 3 migration failed:", error);
  process.exit(1);
});
