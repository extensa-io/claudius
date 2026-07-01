import { settingsCol } from "../db/collections";
import {
  AllowlistSettingsSchema,
  type ModelCatalogEntry,
  ModelCatalogSettingsSchema,
  type Tier,
  TiersSettingsSchema,
} from "../db/schemas";
import { AppError } from "../errors";

/**
 * Admin editors over the `settings` singletons. Each writer validates the
 * incoming shape against the same Zod schema that guards reads, so the admin UI
 * can never persist a malformed catalog or tier document that would later throw
 * deep inside the enforcement path.
 */

export async function getAllowlist(): Promise<string[]> {
  const settings = await settingsCol();
  const doc = await settings.findOne({ _id: "allowlist" });
  return doc && "emails" in doc ? doc.emails : [];
}

export async function addAllowlistEmail(email: string): Promise<void> {
  const normalized = email.trim().toLowerCase();
  const check = AllowlistSettingsSchema.shape.emails.element.safeParse(normalized);
  if (!check.success) {
    throw new AppError("invalid_input", "That is not a valid email address.");
  }
  const settings = await settingsCol();
  await settings.updateOne(
    { _id: "allowlist" },
    { $addToSet: { emails: normalized }, $setOnInsert: { _id: "allowlist" } },
    { upsert: true },
  );
}

export async function removeAllowlistEmail(email: string): Promise<void> {
  const normalized = email.trim().toLowerCase();
  const settings = await settingsCol();
  await settings.updateOne(
    { _id: "allowlist" },
    { $pull: { emails: normalized } },
  );
}

export async function getAdminAllowlist(): Promise<string[]> {
  const settings = await settingsCol();
  const doc = await settings.findOne({ _id: "adminAllowlist" });
  return doc && "emails" in doc ? doc.emails : [];
}

export async function addAdminEmail(email: string): Promise<void> {
  const normalized = email.trim().toLowerCase();
  const check = AllowlistSettingsSchema.shape.emails.element.safeParse(normalized);
  if (!check.success) {
    throw new AppError("invalid_input", "That is not a valid email address.");
  }
  const settings = await settingsCol();
  await settings.updateOne(
    { _id: "adminAllowlist" },
    { $addToSet: { emails: normalized }, $setOnInsert: { _id: "adminAllowlist" } },
    { upsert: true },
  );
}

export async function removeAdminEmail(email: string): Promise<void> {
  const normalized = email.trim().toLowerCase();
  const settings = await settingsCol();
  await settings.updateOne(
    { _id: "adminAllowlist" },
    { $pull: { emails: normalized } },
  );
}

export async function updateModelCatalog(
  models: ModelCatalogEntry[],
): Promise<void> {
  const parsed = ModelCatalogSettingsSchema.safeParse({
    _id: "modelCatalog",
    models,
  });
  if (!parsed.success) {
    throw new AppError("invalid_input", "Invalid model catalog.");
  }
  const settings = await settingsCol();
  await settings.updateOne(
    { _id: "modelCatalog" },
    { $set: { models: parsed.data.models } },
    { upsert: true },
  );
}

export interface TiersInput {
  admin: Tier;
  member: Tier;
  guest: Tier;
}

export async function updateTiers(tiers: TiersInput): Promise<void> {
  const parsed = TiersSettingsSchema.safeParse({ _id: "tiers", ...tiers });
  if (!parsed.success) {
    throw new AppError("invalid_input", "Invalid tier configuration.");
  }
  const settings = await settingsCol();
  const { admin, member, guest } = parsed.data;
  await settings.updateOne(
    { _id: "tiers" },
    { $set: { admin, member, guest } },
    { upsert: true },
  );
}
