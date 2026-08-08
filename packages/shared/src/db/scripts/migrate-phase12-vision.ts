import { getClient } from "../client";
import { settingsCol } from "../collections";
import type { TierImagePolicy } from "../schemas";

/**
 * Phase 12 data migration. Idempotent, safe to re-run.
 *
 * Two fills, both guarded on absence so an admin's tuned value survives a re-run:
 *
 *   1. `settings.tiers.{member,admin}.images` — the per-role image policy. GUEST
 *      IS DELIBERATELY NOT FILLED. An absent block is how "no image service at
 *      all" is expressed, so leaving guest alone is the configuration, not an
 *      omission. Writing a guest block with a cap of 0 would be a worse design:
 *      it implies the feature exists for guests and is merely turned down.
 *
 *   2. `settings.modelCatalog.models[].supportsImages` — set true for the entries
 *      that accept image blocks. Absent reads as false everywhere, so a model
 *      missed here simply refuses images rather than failing at Bedrock.
 */

/** Members get the cheap resolution tier: a screenshot or a photographed receipt
 * reads fine at 1568px, which is where Claude bills ~1600 tokens per image. */
const MEMBER_IMAGES: TierImagePolicy = {
  maxPerTurn: 3,
  maxLongEdgePx: 1568,
  enforcement: "hard",
};

/** Admins get the high-resolution ceiling (~3x the tokens) for dense material
 * like a full-page table, and a warning instead of a refusal above the cap —
 * the admin is the person diagnosing the app and sometimes needs to push past it
 * deliberately. The warning makes the cost visible; it does not block. */
const ADMIN_IMAGES: TierImagePolicy = {
  maxPerTurn: 3,
  maxLongEdgePx: 2576,
  enforcement: "warn",
};

/**
 * Model families that accept image content blocks. Matched against the
 * INFERENCE PROFILE ID, not the catalog `id`: the catalog id is a short local
 * handle ("opus", "sonnet") that says nothing about the model generation, while
 * the profile id carries the family and version.
 */
const VISION_PROFILE_MATCHES = [
  "claude-opus-4",
  "claude-opus-5",
  "claude-sonnet-4",
  "claude-sonnet-5",
  "claude-haiku-4-5",
];

/**
 * Pass --recompute to re-evaluate entries that already carry the flag. The
 * default is to fill only what is absent, so a re-run never clobbers a value an
 * admin set by hand; --recompute is the escape hatch for correcting a bad fill.
 */
const RECOMPUTE = process.argv.includes("--recompute");

async function main(): Promise<void> {
  const settings = await settingsCol();

  // 1. Tier image policy, member and admin only.
  const tiers = await settings.findOne({ _id: "tiers" });
  if (!tiers) {
    console.error("settings.tiers is missing — run db:seed first.");
    process.exit(1);
  }
  for (const [role, policy] of [
    ["member", MEMBER_IMAGES],
    ["admin", ADMIN_IMAGES],
  ] as const) {
    const path = `${role}.images`;
    const res = await settings.updateOne(
      { _id: "tiers", [path]: { $exists: false } },
      { $set: { [path]: policy } },
    );
    console.log(
      `settings.tiers.${path}: ${res.modifiedCount > 0 ? "set" : "already present"}`,
    );
  }
  console.log(
    "settings.tiers.guest.images: intentionally left absent (no image service for guests)",
  );

  // 2. supportsImages on the catalog. Read-modify-write the whole array: the
  //    field is per-entry inside an array, and rewriting the array once is
  //    clearer than a positional update per matched id.
  const catalog = await settings.findOne({ _id: "modelCatalog" });
  if (!catalog || !("models" in catalog)) {
    console.error("settings.modelCatalog is missing — run db:seed first.");
    process.exit(1);
  }
  const models = catalog.models as Array<Record<string, unknown>>;
  let changed = 0;
  const updated = models.map((entry) => {
    if ("supportsImages" in entry && !RECOMPUTE) return entry;
    const profile = String(entry.inferenceProfileId ?? "");
    const supportsImages = VISION_PROFILE_MATCHES.some((m) =>
      profile.includes(m),
    );
    if (entry.supportsImages === supportsImages) return entry;
    changed += 1;
    return { ...entry, supportsImages };
  });
  if (changed > 0) {
    await settings.updateOne(
      { _id: "modelCatalog" },
      { $set: { models: updated } },
    );
  }
  console.log(
    `settings.modelCatalog: ${changed} entr${changed === 1 ? "y" : "ies"} given supportsImages`,
  );
  for (const entry of updated) {
    console.log(`  ${String(entry.id)}: supportsImages=${entry.supportsImages}`);
  }

  const client = await getClient();
  await client.close();
  console.log("Phase 12 migration complete.");
}

main().catch((error: unknown) => {
  console.error("Phase 12 migration failed:", error);
  process.exit(1);
});
