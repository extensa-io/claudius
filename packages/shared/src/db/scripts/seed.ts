import { clientPromise } from "../client";
import { settingsCol } from "../collections";
import {
  type AdminAllowlistSettings,
  type AllowlistSettings,
  type GuestCircuitBreakerSettings,
  type ModelCatalogSettings,
  type ResearchBudgetSettings,
  type SearchSettings,
  type TiersSettings,
} from "../schemas";
import { utcMonthMarker } from "../../tiers/catalog";
import {
  DEFAULT_BANGS,
  DEFAULT_CACHE_TTLS,
  DEFAULT_ESCALATION_KEYWORDS,
} from "../../answer/defaults";

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

const adminAllowlist: AdminAllowlistSettings = {
  _id: "adminAllowlist",
  emails: [],
};

const tiers: TiersSettings = {
  _id: "tiers",
  guest: {
    dailyMessageCap: 10,
    memoryCap: 20,
    // Guests are already bounded by the daily message cap and the spend breaker,
    // so their monthly token budget is left unlimited (null) — the breaker, not
    // a per-guest token count, is the guest tier's cost control.
    monthlyTokenBudget: null,
    features: ["chat", "memory"],
  },
  member: {
    dailyMessageCap: 200,
    memoryCap: 500,
    // A generous monthly ceiling that a normal member never reaches; it exists
    // as a runaway-cost soft-stop, not a rationing mechanism.
    monthlyTokenBudget: 20_000_000,
    features: ["chat", "files", "memory", "research"],
  },
  admin: {
    dailyMessageCap: 1000,
    memoryCap: 5000,
    // Admins are exempt from budget enforcement in code; null documents that.
    monthlyTokenBudget: null,
    features: ["chat", "files", "memory", "research", "admin"],
  },
};

const guestCircuitBreaker: GuestCircuitBreakerSettings = {
  _id: "guestCircuitBreaker",
  dailyCeilingUsd: 1,
  state: "open",
  trippedAt: null,
  killSwitch: false,
};

// Deep-research ceilings (Phase 5). Deliberately generous enough to satisfy the
// "15+ searches" acceptance case while still bounding a runaway job on four
// axes. Admin-tunable in the config panel afterward.
const researchBudget: ResearchBudgetSettings = {
  _id: "researchBudget",
  maxSearches: 40,
  maxFetchedPages: 25,
  maxTokens: 1_000_000,
  wallClockMs: 20 * 60 * 1000, // 20 minutes, far past Vercel's 60s function cap.
};

// Answer-engine search config (Phase 7). Brave is primary under its free
// monthly allowance; Tavily is the fallback + high-value slot. The threshold is
// conservative (well under Brave's free 2,000/month) so the switch to Tavily is
// exercised long before the real quota bites. The usage counter starts at zero
// for the current UTC month and rolls over automatically thereafter.
const search: SearchSettings = {
  _id: "search",
  braveMonthlyThreshold: 1800,
  braveUsage: { month: utcMonthMarker(), count: 0 },
  highValueMinResults: 3,
  // Phase 8 routing + caching defaults (see answer/defaults.ts). Seeded so a
  // fresh database has the full config; the Phase 8 migration backfills these
  // into a live Phase 7 document without touching the counter.
  customBangs: DEFAULT_BANGS,
  escalationKeywords: DEFAULT_ESCALATION_KEYWORDS,
  cacheTtls: DEFAULT_CACHE_TTLS,
};

async function main(): Promise<void> {
  const col = await settingsCol();
  const docs = [
    allowlist,
    adminAllowlist,
    modelCatalog,
    tiers,
    guestCircuitBreaker,
    researchBudget,
    search,
  ];

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
