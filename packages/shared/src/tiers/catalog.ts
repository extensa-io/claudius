import type { ObjectId } from "mongodb";
import { settingsCol, usersCol } from "../db/collections";
import type {
  GuestCircuitBreakerSettings,
  ModelCatalogEntry,
  ResearchBudgetSettings,
  Role,
  Tier,
  User,
} from "../db/schemas";
import { AppError } from "../errors";

/**
 * Read helpers over the `settings` singletons and the catalog. Keeping the
 * `_id`-keyed lookups behind named functions means the discriminated-union
 * narrowing (find by `_id`, then confirm the right variant) happens in exactly
 * one place per document instead of at every call site.
 */

export async function loadModelCatalog(): Promise<ModelCatalogEntry[]> {
  const settings = await settingsCol();
  const doc = await settings.findOne({ _id: "modelCatalog" });
  // The discriminated union means a document found by this _id is the catalog,
  // but we guard the field access so a malformed/missing doc fails loudly.
  if (!doc || !("models" in doc)) {
    throw new AppError("internal", "Model catalog is not configured.");
  }
  return doc.models;
}

export function findModelEntry(
  catalog: ModelCatalogEntry[],
  modelId: string,
): ModelCatalogEntry | undefined {
  return catalog.find((m) => m.id === modelId);
}

/** Per-role tier limits (daily cap, memory cap, feature flags). */
export async function loadTier(role: Role): Promise<Tier> {
  const settings = await settingsCol();
  const doc = await settings.findOne({ _id: "tiers" });
  if (!doc || !("admin" in doc)) {
    throw new AppError("internal", "Tier configuration is missing.");
  }
  return doc[role];
}

export async function loadGuestCircuitBreaker(): Promise<GuestCircuitBreakerSettings> {
  const settings = await settingsCol();
  const doc = await settings.findOne({ _id: "guestCircuitBreaker" });
  if (!doc || !("state" in doc)) {
    throw new AppError("internal", "Circuit breaker is not configured.");
  }
  // The `in` guard narrows the variant's own fields, but WithId keeps `_id`
  // typed as the full settings union, so we reconstruct a clean document.
  const { dailyCeilingUsd, state, trippedAt, killSwitch } = doc;
  return {
    _id: "guestCircuitBreaker",
    dailyCeilingUsd,
    state,
    trippedAt,
    // Pre-Phase-4 breaker docs have no killSwitch until the migration runs;
    // treat a missing flag as off so an un-migrated deployment stays open.
    killSwitch: killSwitch ?? false,
  };
}

/** The per-job research ceilings (Phase 5). Missing doc fails loudly. */
export async function loadResearchBudget(): Promise<ResearchBudgetSettings> {
  const settings = await settingsCol();
  const doc = await settings.findOne({ _id: "researchBudget" });
  if (!doc || !("maxSearches" in doc)) {
    throw new AppError("internal", "Research budget is not configured.");
  }
  const { maxSearches, maxFetchedPages, maxTokens, wallClockMs } = doc;
  return {
    _id: "researchBudget",
    maxSearches,
    maxFetchedPages,
    maxTokens,
    wallClockMs,
  };
}

/**
 * Whether a user may invoke a given catalog model. `allowedModels: null` means
 * "inherit the tier default" — fall back to the model's `roles` list. A
 * non-null array is an explicit per-user override that supersedes the role
 * check entirely (the model must still exist in the catalog to be invokable).
 */
export function isModelPermitted(user: User, entry: ModelCatalogEntry): boolean {
  if (user.allowedModels !== null) {
    return user.allowedModels.includes(entry.id);
  }
  return entry.roles.includes(user.role);
}

/**
 * The set of models a specific user may actually select, honoring both their
 * role and any per-user `allowedModels` override. This is what populates the
 * model selector so the UI never offers a model `assertCanInvoke` would reject.
 */
export async function getUsableModels(
  userId: ObjectId,
): Promise<ModelCatalogEntry[]> {
  const users = await usersCol();
  const user = await users.findOne({ _id: userId });
  if (!user) {
    throw new AppError("unauthorized", "Your account could not be found.");
  }
  const catalog = await loadModelCatalog();
  return catalog.filter((entry) => isModelPermitted(user, entry));
}
