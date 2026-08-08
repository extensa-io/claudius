import { getClient } from "../client";
import { settingsCol } from "../collections";
import type { ResearchBudgetSettings } from "../schemas";

/**
 * Phase 5 data migration. Idempotent, safe to re-run.
 *
 * The seed writes new singletons only with `$setOnInsert`, so a production
 * database that predates Phase 5 never gains the `researchBudget` document from
 * a redeploy of the app. This migration bootstraps it in place with the same
 * defaults, and (defensively) fills any individual field an older partial
 * document might be missing, without clobbering an admin-tuned value.
 *
 * No `jobs` backfill is needed: the collection is created on first insert and
 * its indexes are applied by `db:indexes`.
 */

const DEFAULT: ResearchBudgetSettings = {
  _id: "researchBudget",
  maxSearches: 40,
  maxFetchedPages: 25,
  maxTokens: 1_000_000,
  wallClockMs: 20 * 60 * 1000,
};

async function main(): Promise<void> {
  const settings = await settingsCol();

  const { _id, ...fields } = DEFAULT;
  const upsert = await settings.updateOne(
    { _id },
    { $setOnInsert: fields },
    { upsert: true },
  );
  console.log(
    `settings.researchBudget: ${
      upsert.upsertedCount > 0 ? "created" : "already present"
    }`,
  );

  // Field-scoped fills for a document that exists but predates a field, each
  // guarded on absence so a re-run and an admin edit both converge.
  const fieldDefaults: Array<[string, number]> = [
    ["maxSearches", DEFAULT.maxSearches],
    ["maxFetchedPages", DEFAULT.maxFetchedPages],
    ["maxTokens", DEFAULT.maxTokens],
    ["wallClockMs", DEFAULT.wallClockMs],
  ];
  for (const [path, value] of fieldDefaults) {
    const res = await settings.updateOne(
      { _id, [path]: { $exists: false } },
      { $set: { [path]: value } },
    );
    if (res.modifiedCount > 0) {
      console.log(`settings.researchBudget.${path}: set to ${value}`);
    }
  }

  const client = await getClient();
  await client.close();
  console.log("Phase 5 migration complete.");
}

main().catch((error: unknown) => {
  console.error("Phase 5 migration failed:", error);
  process.exit(1);
});
