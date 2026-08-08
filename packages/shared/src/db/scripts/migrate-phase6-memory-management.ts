import { getClient } from "../client";
import { memoriesCol, usersCol } from "../collections";
import { reclassifyUserMemories } from "../../memory/reclassify";

/**
 * Phase 6 data migration. Idempotent, safe to re-run.
 *
 * Phase 3 stored memories with no `importance`, but the always-on profile and
 * salience-weighted retrieval rank by it. This migration gives every existing
 * memory a real score:
 *
 *   1. Reclassify: a cheap owner-scoped Haiku pass assigns a 0..1 importance to
 *      each un-scored memory, on the same rubric extraction now uses. It only
 *      touches rows where `importance` is missing, so a re-run is a no-op.
 *   2. Fallback backfill: any row the reclassify skipped or failed on (model
 *      error, parse gap) gets a neutral 0.5, so no active memory is left without
 *      the field. Neutral is honest — retrieval treats 0.5 as no salience nudge.
 *
 * The presence of the `importance` field is the "done" marker, which is what
 * makes step 1 idempotent: after step 2 fills the stragglers, a second run finds
 * nothing un-scored and makes no model call at all.
 *
 * Guests are skipped: their memories are ephemeral (24h TTL), not worth a model
 * call, and TTL-reaped before they'd matter.
 */
async function main(): Promise<void> {
  const users = await usersCol();
  const memories = await memoriesCol();

  // Step 1: reclassify un-scored memories, one eligible user at a time.
  const eligible = await users
    .find({ role: { $in: ["member", "admin"] } })
    .toArray();

  let totalReclassified = 0;
  for (const user of eligible) {
    const { reclassified } = await reclassifyUserMemories({ user });
    if (reclassified > 0) {
      totalReclassified += reclassified;
      console.log(
        `user ${user.email}: reclassified ${reclassified} memories`,
      );
    }
  }
  console.log(`Reclassified ${totalReclassified} memories total.`);

  // Step 2: neutral fallback for anything still un-scored (guests, skipped rows,
  // or reclassify gaps), so every memory carries importance for retrieval.
  const fallback = await memories.updateMany(
    { importance: { $exists: false } },
    { $set: { importance: 0.5 } },
  );
  console.log(
    `Neutral-backfilled ${fallback.modifiedCount} remaining memories to importance 0.5.`,
  );

  const client = await getClient();
  await client.close();
  console.log("Phase 6 migration complete.");
}

main().catch((error: unknown) => {
  console.error("Phase 6 migration failed:", error);
  process.exit(1);
});
