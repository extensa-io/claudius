import { clientPromise, getDb } from "../client";
import { applyIndexes } from "../indexes";

/**
 * Entry point for `npm run db:indexes`. Idempotent: safe to run on every deploy.
 */
async function main(): Promise<void> {
  const db = await getDb();
  const { created, skipped } = await applyIndexes(db);

  console.log(`Indexes applied to database "${db.databaseName}".`);
  if (created.length > 0) console.log(`  created/ensured: ${created.join(", ")}`);
  if (skipped.length > 0) console.log(`  skipped (already present): ${skipped.join(", ")}`);

  const client = await clientPromise;
  await client.close();
}

main().catch((error: unknown) => {
  console.error("Failed to apply indexes:", error);
  process.exit(1);
});
