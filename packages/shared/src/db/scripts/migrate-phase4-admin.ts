import { getClient } from "../client";
import { settingsCol } from "../collections";

/**
 * Phase 4 data migration. Idempotent, safe to re-run.
 *
 * The seed only writes settings with `$setOnInsert`, so singletons that already
 * exist in production keep their old shape. This migration adds the Phase 4
 * fields to the live documents in place:
 *
 *   1. `tiers.<role>.monthlyTokenBudget` — the per-tier monthly token soft-stop.
 *      Only set where the field is missing, so an admin-tuned value is never
 *      clobbered. Guest/admin default to null (unlimited; guests are bounded by
 *      the breaker, admins are exempt); member gets a generous ceiling.
 *   2. `guestCircuitBreaker.killSwitch` — the manual guest master off, defaulted
 *      to false only when absent.
 *
 * Each `$set` is guarded by an `$exists: false` filter on the specific field so
 * re-runs and partial prior runs both converge without overwriting live values.
 */

const MEMBER_MONTHLY_TOKEN_BUDGET = 20_000_000;

async function main(): Promise<void> {
  const settings = await settingsCol();

  // Field-scoped upserts: one updateOne per field, filtered on the field being
  // absent, so we never overwrite a value an admin has since edited.
  const budgetDefaults: Array<[string, number | null]> = [
    ["guest.monthlyTokenBudget", null],
    ["member.monthlyTokenBudget", MEMBER_MONTHLY_TOKEN_BUDGET],
    ["admin.monthlyTokenBudget", null],
  ];

  for (const [path, value] of budgetDefaults) {
    const res = await settings.updateOne(
      { _id: "tiers", [path]: { $exists: false } },
      { $set: { [path]: value } },
    );
    console.log(
      `settings.tiers.${path}: ${
        res.modifiedCount > 0 ? `set to ${value}` : "already present"
      }`,
    );
  }

  const breakerRes = await settings.updateOne(
    { _id: "guestCircuitBreaker", killSwitch: { $exists: false } },
    { $set: { killSwitch: false } },
  );
  console.log(
    `settings.guestCircuitBreaker.killSwitch: ${
      breakerRes.modifiedCount > 0 ? "set to false" : "already present"
    }`,
  );

  // Bootstrap the admin allowlist singleton (empty). The bootstrap ADMIN_EMAIL
  // env var remains the non-revocable admin; this list holds additional ones.
  const adminAllowlistRes = await settings.updateOne(
    { _id: "adminAllowlist" },
    { $setOnInsert: { emails: [] } },
    { upsert: true },
  );
  console.log(
    `settings.adminAllowlist: ${
      adminAllowlistRes.upsertedCount > 0 ? "created (empty)" : "already present"
    }`,
  );

  const client = await getClient();
  await client.close();
  console.log("Phase 4 migration complete.");
}

main().catch((error: unknown) => {
  console.error("Phase 4 migration failed:", error);
  process.exit(1);
});
