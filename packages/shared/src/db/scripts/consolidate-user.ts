/**
 * One-off manual trigger for the Phase 6 consolidation pass, for a single user by
 * email. The production path is the memory_consolidation worker job on the daily
 * cron; this is the same shared pass invoked directly, for running it before the
 * worker is deployed or for a targeted re-run. Mutates: merges near-duplicates
 * (supersededReason "merge") and prunes stale low-salience rows.
 *
 *   tsx --env-file=../../.env src/db/scripts/consolidate-user.ts <email>
 */
import { clientPromise } from "../client";
import { usersCol } from "../collections";
import { consolidateUserMemories } from "../../memory/consolidate";

async function main(): Promise<void> {
  const email = process.argv[2];
  if (!email) throw new Error("Usage: consolidate-user.ts <email>");

  const users = await usersCol();
  const user = await users.findOne({ email });
  if (!user?._id) throw new Error(`No user with email ${email}`);

  console.log(`Consolidating memories for ${email} (role=${user.role})...`);
  const summary = await consolidateUserMemories({ user });
  console.log(JSON.stringify(summary, null, 2));

  const client = await clientPromise;
  await client.close();
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
