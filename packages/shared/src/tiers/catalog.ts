import type { ObjectId } from "mongodb";
import { settingsCol, usersCol } from "../db/collections";
import type {
  GuestCircuitBreakerSettings,
  ModelCatalogEntry,
  ResearchBudgetSettings,
  Role,
  SearchSettings,
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

/** The current UTC month as a "YYYY-MM" marker for the Brave free-tier counter. */
export function utcMonthMarker(now: Date = new Date()): string {
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

/**
 * The answer-engine search config (Phase 7). Missing doc fails loudly, matching
 * the other singleton loaders. The `braveUsage` marker is returned as-stored;
 * source selection normalizes a stale month to a zero count in-memory so a
 * read never has to write, and `recordBraveCall` does the durable rollover.
 */
export async function loadSearchSettings(): Promise<SearchSettings> {
  const settings = await settingsCol();
  const doc = await settings.findOne({ _id: "search" });
  if (!doc || !("braveMonthlyThreshold" in doc)) {
    throw new AppError("internal", "Search settings are not configured.");
  }
  const { braveMonthlyThreshold, braveUsage, highValueMinResults } = doc;
  return {
    _id: "search",
    braveMonthlyThreshold,
    braveUsage,
    highValueMinResults,
  };
}

/**
 * The count of Brave calls already made in the current UTC month, treating a
 * stored marker from a past month as zero (the month has rolled; the durable
 * reset happens lazily on the next `recordBraveCall`). This is what source
 * selection compares against `braveMonthlyThreshold`.
 */
export function braveCountThisMonth(
  usage: SearchSettings["braveUsage"],
  now: Date = new Date(),
): number {
  return usage.month === utcMonthMarker(now) ? usage.count : 0;
}

/**
 * Record one Brave call against the free-tier allowance. A single atomic
 * update handles the month rollover: if the stored marker is not the current
 * UTC month, we reset the marker and set the count to 1; otherwise we increment
 * in place. Two competing updates in the same month both increment (the counter
 * is a spend guard, not an exact-once ledger, so a benign over-count is fine and
 * a lost increment is not possible). Returns the new in-month count.
 */
export async function recordBraveCall(now: Date = new Date()): Promise<number> {
  const settings = await settingsCol();
  const month = utcMonthMarker(now);

  // Same-month path: bump the existing counter.
  const bumped = await settings.findOneAndUpdate(
    { _id: "search", "braveUsage.month": month },
    { $inc: { "braveUsage.count": 1 } },
    { returnDocument: "after" },
  );
  if (bumped && "braveUsage" in bumped) {
    return bumped.braveUsage.count;
  }

  // Rollover path: the stored marker is a different (past) month, so reset it.
  // Guarded on the month NOT already being current so a racing rollover can't
  // clobber a fresh count back to 1.
  const rolled = await settings.findOneAndUpdate(
    { _id: "search", "braveUsage.month": { $ne: month } },
    { $set: { "braveUsage.month": month, "braveUsage.count": 1 } },
    { returnDocument: "after" },
  );
  if (rolled && "braveUsage" in rolled) {
    return rolled.braveUsage.count;
  }

  // The rollover lost the race to a concurrent writer that already created the
  // current month; fall through to a plain increment against it.
  const after = await settings.findOneAndUpdate(
    { _id: "search", "braveUsage.month": month },
    { $inc: { "braveUsage.count": 1 } },
    { returnDocument: "after" },
  );
  if (after && "braveUsage" in after) {
    return after.braveUsage.count;
  }
  throw new AppError("internal", "Search settings are not configured.");
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
