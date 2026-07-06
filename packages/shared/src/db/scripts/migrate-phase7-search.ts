import { clientPromise } from "../client";
import { settingsCol } from "../collections";
import type { SearchSettings } from "../schemas";
import { utcMonthMarker } from "../../tiers/catalog";

/**
 * Phase 7 data migration. Idempotent, safe to re-run.
 *
 * The seed writes new singletons only with `$setOnInsert`, so a production
 * database that predates Phase 7 never gains the `search` document from a
 * redeploy of the app. This migration bootstraps it in place with the same
 * defaults, and (defensively) fills any individual field an older partial
 * document might be missing, without clobbering an admin-tuned value.
 *
 * `braveUsage` is a nested counter, so it is filled as a whole object only when
 * absent — never overwritten, since that would reset a live month's count.
 */

const DEFAULT: SearchSettings = {
  _id: "search",
  braveMonthlyThreshold: 1800,
  braveUsage: { month: utcMonthMarker(), count: 0 },
  highValueMinResults: 3,
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
    `settings.search: ${
      upsert.upsertedCount > 0 ? "created" : "already present"
    }`,
  );

  // Field-scoped fills for a document that exists but predates a field, each
  // guarded on absence so a re-run and an admin edit both converge. braveUsage
  // is filled only when wholly absent so a live month's count is never reset.
  const scalarDefaults: Array<[string, number]> = [
    ["braveMonthlyThreshold", DEFAULT.braveMonthlyThreshold],
    ["highValueMinResults", DEFAULT.highValueMinResults],
  ];
  for (const [path, value] of scalarDefaults) {
    const res = await settings.updateOne(
      { _id, [path]: { $exists: false } },
      { $set: { [path]: value } },
    );
    if (res.modifiedCount > 0) {
      console.log(`settings.search.${path}: set to ${value}`);
    }
  }

  const usageRes = await settings.updateOne(
    { _id, braveUsage: { $exists: false } },
    { $set: { braveUsage: DEFAULT.braveUsage } },
  );
  if (usageRes.modifiedCount > 0) {
    console.log(
      `settings.search.braveUsage: initialized to ${DEFAULT.braveUsage.month} / 0`,
    );
  }

  const client = await clientPromise;
  await client.close();
  console.log("Phase 7 migration complete.");
}

main().catch((error: unknown) => {
  console.error("Phase 7 migration failed:", error);
  process.exit(1);
});
