import { clientPromise } from "../client";
import { settingsCol } from "../collections";
import {
  type AllowlistSettings,
  type GuestCircuitBreakerSettings,
  type ModelCatalogSettings,
  type TiersSettings,
} from "../schemas";

/**
 * Entry point for `npm run db:seed`. Writes the default settings singletons.
 *
 * Idempotent by design: each document is upserted with $setOnInsert, so the
 * first run creates it and later runs never clobber values an admin has since
 * edited (e.g. emails added to the allowlist, confirmed model pricing).
 *
 * The model catalog uses real Bedrock cross-region inference profile IDs.
 * Per-million-token prices are placeholders (-1) for Nestor to confirm against
 * current AWS Bedrock pricing before they drive any billing logic.
 */

const PRICE_TO_CONFIRM = -1;

const modelCatalog: ModelCatalogSettings = {
  _id: "modelCatalog",
  models: [
    {
      id: "haiku",
      inferenceProfileId: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
      displayName: "Claude Haiku 4.5",
      inputPricePerMTok: PRICE_TO_CONFIRM,
      outputPricePerMTok: PRICE_TO_CONFIRM,
      roles: ["guest", "member", "admin"],
    },
    {
      id: "sonnet",
      inferenceProfileId: "us.anthropic.claude-sonnet-4-6",
      displayName: "Claude Sonnet 4.6",
      inputPricePerMTok: PRICE_TO_CONFIRM,
      outputPricePerMTok: PRICE_TO_CONFIRM,
      roles: ["member", "admin"],
    },
    {
      id: "opus",
      inferenceProfileId: "us.anthropic.claude-opus-4-8",
      displayName: "Claude Opus 4.8",
      inputPricePerMTok: PRICE_TO_CONFIRM,
      outputPricePerMTok: PRICE_TO_CONFIRM,
      roles: ["admin"],
    },
  ],
};

const allowlist: AllowlistSettings = {
  _id: "allowlist",
  emails: [],
};

const tiers: TiersSettings = {
  _id: "tiers",
  guest: { dailyMessageCap: 10, memoryCap: 20, features: ["chat", "memory"] },
  member: {
    dailyMessageCap: 200,
    memoryCap: 500,
    features: ["chat", "files", "memory", "research"],
  },
  admin: {
    dailyMessageCap: 1000,
    memoryCap: 5000,
    features: ["chat", "files", "memory", "research", "admin"],
  },
};

const guestCircuitBreaker: GuestCircuitBreakerSettings = {
  _id: "guestCircuitBreaker",
  dailyCeilingUsd: 1,
  state: "open",
  trippedAt: null,
};

async function main(): Promise<void> {
  const col = await settingsCol();
  const docs = [allowlist, modelCatalog, tiers, guestCircuitBreaker];

  for (const doc of docs) {
    const { _id, ...rest } = doc;
    const result = await col.updateOne(
      { _id },
      { $setOnInsert: rest },
      { upsert: true },
    );
    const action = result.upsertedCount > 0 ? "created" : "already present";
    console.log(`  settings.${_id}: ${action}`);
  }

  const client = await clientPromise;
  await client.close();
  console.log("Seed complete.");
}

main().catch((error: unknown) => {
  console.error("Failed to seed settings:", error);
  process.exit(1);
});
