import { getClient } from "../client";
import { settingsCol } from "../collections";
import type { Bang, CacheTtls } from "../schemas";
import {
  DEFAULT_BANGS,
  DEFAULT_CACHE_TTLS,
  DEFAULT_ESCALATION_KEYWORDS,
} from "../../answer/defaults";

/**
 * Phase 8 data migration. Idempotent, safe to re-run.
 *
 * Phase 8 adds three admin-tunable fields to the existing `settings.search`
 * singleton (created by the Phase 7 migration/seed): the custom bang table, the
 * Tavily escalation keywords, and the per-intent cache TTLs. Each is filled ONLY
 * when absent, so a live document keeps any admin-tuned value on a re-run.
 *
 * The `search_cache` collection and its TTL index are created by `db:indexes`
 * (applyIndexes), so this migration touches settings only.
 */

const defaultBangs: Bang[] = DEFAULT_BANGS;
const defaultCacheTtls: CacheTtls = DEFAULT_CACHE_TTLS;
const defaultEscalation: string[] = DEFAULT_ESCALATION_KEYWORDS;

async function main(): Promise<void> {
  const settings = await settingsCol();
  const _id = "search" as const;

  const exists = await settings.findOne({ _id });
  if (!exists) {
    console.error(
      "settings.search is missing — run db:migrate:search (Phase 7) first.",
    );
    process.exit(1);
  }

  // Field-scoped fills, each guarded on absence so a re-run and an admin edit
  // both converge. We store the default bang table so it is visible and editable
  // in the admin panel; the engine still merges built-ins under custom bangs.
  const fills: Array<[string, unknown]> = [
    ["customBangs", defaultBangs],
    ["escalationKeywords", defaultEscalation],
    ["cacheTtls", defaultCacheTtls],
  ];
  for (const [path, value] of fills) {
    const res = await settings.updateOne(
      { _id, [path]: { $exists: false } },
      { $set: { [path]: value } },
    );
    console.log(
      `settings.search.${path}: ${res.modifiedCount > 0 ? "set" : "already present"}`,
    );
  }

  const client = await getClient();
  await client.close();
  console.log("Phase 8 migration complete.");
}

main().catch((error: unknown) => {
  console.error("Phase 8 migration failed:", error);
  process.exit(1);
});
