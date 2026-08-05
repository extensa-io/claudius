import { z } from "zod";
import { zRole } from "./common";

/**
 * `settings` holds a handful of keyed singleton documents, each identified by a
 * string `_id`. They are global configuration, not user data: the allowlist of
 * member emails, the model catalog, per-role tier limits, and the guest
 * spend circuit breaker. The seed script (scripts/seed.ts) writes the defaults.
 */

/** _id: "allowlist" — emails that resolve to the `member` role at sign-in. */
export const AllowlistSettingsSchema = z.object({
  _id: z.literal("allowlist"),
  emails: z.array(z.string().email()),
});
export type AllowlistSettings = z.infer<typeof AllowlistSettingsSchema>;

/**
 * _id: "adminAllowlist" — emails that resolve to the `admin` role at sign-in
 * (Phase 4 follow-on). The bootstrap `ADMIN_EMAIL` env var always resolves to
 * admin and takes precedence over every list; this document is how additional,
 * revocable admins are granted without a redeploy. Admin here outranks the
 * member allowlist, so an email on both is an admin.
 */
export const AdminAllowlistSettingsSchema = z.object({
  _id: z.literal("adminAllowlist"),
  emails: z.array(z.string().email()),
});
export type AdminAllowlistSettings = z.infer<
  typeof AdminAllowlistSettingsSchema
>;

/** One entry in the model catalog. Pricing is per million tokens. */
export const ModelCatalogEntrySchema = z.object({
  id: z.string(),
  inferenceProfileId: z.string(),
  displayName: z.string(),
  inputPricePerMTok: z.number().nonnegative(),
  outputPricePerMTok: z.number().nonnegative(),
  roles: z.array(zRole),
  /**
   * Whether this model accepts image content blocks (Phase 12). Optional so
   * catalog documents written before Phase 12 still parse; absent reads as
   * false, so a model is never assumed to have vision. Resolved server-side and
   * surfaced through InvokeGrant — the client never asserts it, and an image
   * sent to a model without it is a rejected turn rather than a dropped image.
   */
  supportsImages: z.boolean().optional(),
});
export type ModelCatalogEntry = z.infer<typeof ModelCatalogEntrySchema>;

/** _id: "modelCatalog" — the Bedrock models Claudius may invoke. */
export const ModelCatalogSettingsSchema = z.object({
  _id: z.literal("modelCatalog"),
  models: z.array(ModelCatalogEntrySchema),
});
export type ModelCatalogSettings = z.infer<typeof ModelCatalogSettingsSchema>;

/** Per-role tier limits. */
export const TierSchema = z.object({
  dailyMessageCap: z.number().int().nonnegative(),
  memoryCap: z.number().int().nonnegative(),
  /**
   * Monthly token allowance (input + output) enforced as a soft-stop for the
   * tier (Phase 4). `null` means unlimited. A per-user `monthlyTokenBudget`
   * override on the user document supersedes this default when set.
   */
  monthlyTokenBudget: z.number().int().nonnegative().nullable(),
  features: z.array(z.string()),
  /**
   * Image-input policy for the tier (Phase 12). Lives here rather than as a
   * constant in the vision path so an admin can retune it in /admin/config
   * without a deploy, and — more importantly — so the guest tier is configured
   * off rather than special-cased in code: an ABSENT block means no image
   * service at all for that role. Optional for the same reason `customBangs`
   * and `cacheTtls` are: pre-migration `tiers` documents must still parse.
   */
  images: z
    .object({
      /** Images accepted on a single turn. */
      maxPerTurn: z.number().int().positive(),
      /**
       * Long-edge pixel target the client downscales to before upload, so the
       * oversized bytes never occupy Blob storage or request bandwidth. 1568px
       * is where Claude bills roughly 1600 input tokens per image; 2576px is the
       * high-resolution ceiling and costs ~3x that.
       */
      maxLongEdgePx: z.number().int().positive(),
      /**
       * What happens above `maxPerTurn`. "hard" refuses the turn; "warn" shows
       * the cost in the composer but proceeds — the admin is the person
       * diagnosing the app and occasionally needs to push past a limit
       * deliberately.
       */
      enforcement: z.enum(["hard", "warn"]),
    })
    .optional(),
});
export type Tier = z.infer<typeof TierSchema>;

/** The tier's image policy, or null when the role gets no image service. */
export type TierImagePolicy = NonNullable<Tier["images"]>;

/** _id: "tiers" — limits keyed by role. */
export const TiersSettingsSchema = z.object({
  _id: z.literal("tiers"),
  admin: TierSchema,
  member: TierSchema,
  guest: TierSchema,
});
export type TiersSettings = z.infer<typeof TiersSettingsSchema>;

/**
 * _id: "guestCircuitBreaker" — the guest tier's spend safety valve plus a
 * permanent kill switch.
 *
 * Two independent controls, deliberately separate (Phase 4):
 *   - `state`: the automatic, spend-based breaker. When cumulative guest spend
 *     for the UTC day crosses `dailyCeilingUsd`, it flips to "tripped" and guest
 *     model calls are refused. A daily cron resets it to "open".
 *   - `killSwitch`: a manual, admin-only master off for the entire guest tier.
 *     When true, guests are blocked at sign-in and invocation regardless of
 *     spend, and it is NEVER auto-reset — only an admin turns it back off.
 */
export const GuestCircuitBreakerSettingsSchema = z.object({
  _id: z.literal("guestCircuitBreaker"),
  dailyCeilingUsd: z.number().nonnegative(),
  state: z.enum(["open", "tripped"]),
  trippedAt: z.date().nullable(),
  killSwitch: z.boolean(),
});
export type GuestCircuitBreakerSettings = z.infer<
  typeof GuestCircuitBreakerSettingsSchema
>;

/**
 * _id: "researchBudget" — the hard per-job ceilings for a deep-research run on
 * the worker (Phase 5). Research is unbounded by nature, so every job is capped
 * on four axes at once and stops at whichever it hits first: total web searches,
 * total pages fetched and read, cumulative model tokens, and wall-clock time.
 * Admin-tunable from the config panel, which is why they live in settings rather
 * than as code constants.
 */
export const ResearchBudgetSettingsSchema = z.object({
  _id: z.literal("researchBudget"),
  maxSearches: z.number().int().positive(),
  maxFetchedPages: z.number().int().positive(),
  maxTokens: z.number().int().positive(),
  wallClockMs: z.number().int().positive(),
});
export type ResearchBudgetSettings = z.infer<
  typeof ResearchBudgetSettingsSchema
>;

/**
 * A single personal bang: a `!token` shortcut that redirects a query to a site's
 * own search (Phase 8). `urlTemplate` carries a `{query}` placeholder that the
 * bang parser fills with the URL-encoded remainder of the input; a bang typed
 * with no query resolves to the template with an empty substitution (the site
 * home for most templates). Tokens are stored without the leading `!`.
 */
export const BangSchema = z.object({
  token: z.string().min(1),
  urlTemplate: z.string().url().or(z.string().startsWith("http")),
});
export type Bang = z.infer<typeof BangSchema>;

/**
 * Per-intent cache TTLs in seconds (Phase 8). The tiered cache keys entries by
 * intent and a freshness signal, so a news-like query reaps in minutes while an
 * evergreen fact survives for weeks:
 *   - `freshSeconds`: news-like / time-sensitive informational queries.
 *   - `evergreenSeconds`: stable informational queries (the common case).
 *   - `transactionalSeconds`: transactional queries (short — results churn).
 * Navigational queries are not cached (they resolve to a URL with no round trip).
 */
export const CacheTtlsSchema = z.object({
  freshSeconds: z.number().int().nonnegative(),
  evergreenSeconds: z.number().int().nonnegative(),
  transactionalSeconds: z.number().int().nonnegative(),
});
export type CacheTtls = z.infer<typeof CacheTtlsSchema>;

/**
 * _id: "search" — the answer engine's config (Phase 7 source selection, Phase 8
 * routing + caching).
 *
 * Brave is the primary web-search backend under its free monthly allowance;
 * Tavily is the fallback + high-value slot. These are non-Bedrock calls, so
 * their usage does NOT belong in `usage_events`; instead a lightweight monthly
 * counter lives here:
 *   - `braveMonthlyThreshold`: the free-tier query allowance. Once the month's
 *     `count` reaches it, selection switches to Tavily until the month rolls.
 *   - `braveUsage`: the running counter — `count` calls made in UTC month
 *     `month` ("YYYY-MM"). When a call lands in a new month, the count resets.
 *   - `highValueMinResults`: the quality-fallback gate. If Brave returns fewer
 *     than this many usable results, the engine retries the query on Tavily.
 *
 * Phase 8 adds admin-tunable routing/caching config so a threshold, a bang, or a
 * TTL takes effect without a redeploy:
 *   - `customBangs`: personal bangs merged over the built-in default table.
 *   - `escalationKeywords`: depth signals that escalate an informational query
 *     from Brave to Tavily advanced (e.g. "in depth", "compare", "comprehensive").
 *   - `cacheTtls`: the per-intent cache lifetimes above.
 * All three are optional so a Phase 7 document reads back valid before the Phase 8
 * migration fills them; loaders apply defaults for a missing field.
 */
export const SearchSettingsSchema = z.object({
  _id: z.literal("search"),
  braveMonthlyThreshold: z.number().int().nonnegative(),
  braveUsage: z.object({
    month: z.string().regex(/^\d{4}-\d{2}$/),
    count: z.number().int().nonnegative(),
  }),
  highValueMinResults: z.number().int().nonnegative(),
  customBangs: z.array(BangSchema).optional(),
  escalationKeywords: z.array(z.string().min(1)).optional(),
  cacheTtls: CacheTtlsSchema.optional(),
});
export type SearchSettings = z.infer<typeof SearchSettingsSchema>;

/** Any settings document, discriminated by its `_id`. */
export const SettingsSchema = z.discriminatedUnion("_id", [
  AllowlistSettingsSchema,
  AdminAllowlistSettingsSchema,
  ModelCatalogSettingsSchema,
  TiersSettingsSchema,
  GuestCircuitBreakerSettingsSchema,
  ResearchBudgetSettingsSchema,
  SearchSettingsSchema,
]);
export type Settings = z.infer<typeof SettingsSchema>;
