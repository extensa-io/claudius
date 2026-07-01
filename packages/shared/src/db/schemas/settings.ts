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
});
export type Tier = z.infer<typeof TierSchema>;

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

/** Any settings document, discriminated by its `_id`. */
export const SettingsSchema = z.discriminatedUnion("_id", [
  AllowlistSettingsSchema,
  AdminAllowlistSettingsSchema,
  ModelCatalogSettingsSchema,
  TiersSettingsSchema,
  GuestCircuitBreakerSettingsSchema,
]);
export type Settings = z.infer<typeof SettingsSchema>;
