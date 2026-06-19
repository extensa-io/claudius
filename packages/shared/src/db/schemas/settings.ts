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
 * _id: "guestCircuitBreaker" — a global kill switch for the guest tier. When
 * cumulative guest spend crosses `dailyCeilingUsd`, the breaker trips and guest
 * model calls are refused until it is reset.
 */
export const GuestCircuitBreakerSettingsSchema = z.object({
  _id: z.literal("guestCircuitBreaker"),
  dailyCeilingUsd: z.number().nonnegative(),
  state: z.enum(["open", "tripped"]),
  trippedAt: z.date().nullable(),
});
export type GuestCircuitBreakerSettings = z.infer<
  typeof GuestCircuitBreakerSettingsSchema
>;

/** Any settings document, discriminated by its `_id`. */
export const SettingsSchema = z.discriminatedUnion("_id", [
  AllowlistSettingsSchema,
  ModelCatalogSettingsSchema,
  TiersSettingsSchema,
  GuestCircuitBreakerSettingsSchema,
]);
export type Settings = z.infer<typeof SettingsSchema>;
