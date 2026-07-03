import { ObjectId } from "mongodb";
import { settingsCol, usageEventsCol, usersCol } from "../db/collections";
import type { Role } from "../db/schemas";
import { appEnv } from "../env";
import { AppError } from "../errors";
import { invalidateBudgetCache } from "../tiers/budget";
import {
  buildPriceMap,
  costUsd,
  startOfUtcMonth,
} from "../usage/aggregate";
import { loadModelCatalog } from "../tiers/catalog";

/**
 * Admin read/write over the `users` collection. These power the admin Users
 * panel. Note the invariant boundary (CLAUDE.md #6): admin sees a user's role,
 * status, and aggregate usage — never their conversation or memory *content*.
 */

export interface AdminUserRow {
  id: string;
  email: string;
  name: string | null;
  role: Role;
  status: "active" | "disabled";
  allowedModels: string[] | null;
  monthlyTokenBudget: number | null;
  dailyUsed: number;
  dailyCap: number;
  monthTokens: number;
  monthSpendUsd: number;
  memoryEnabled: boolean;
  /** True for the bootstrap ADMIN_EMAIL account: always admin, never demotable. */
  isEnvAdmin: boolean;
}

/** Whether an email is the non-revocable bootstrap admin from the env var. */
export function isEnvAdminEmail(email: string): boolean {
  return email.toLowerCase() === appEnv().ADMIN_EMAIL.toLowerCase();
}

/** All users with their current month usage and daily-cap consumption. */
export async function listUsersWithUsage(
  now: Date = new Date(),
): Promise<AdminUserRow[]> {
  const users = await usersCol();
  const userDocs = await users.find({}).sort({ role: 1, email: 1 }).toArray();

  const catalog = await loadModelCatalog();
  const prices = buildPriceMap(catalog);

  const settings = await settingsCol();
  const tiersDoc = await settings.findOne({ _id: "tiers" });
  const dailyCapFor = (role: Role): number =>
    tiersDoc && "admin" in tiersDoc ? tiersDoc[role].dailyMessageCap : 0;

  // One pass over this month's usage, grouped per user + model so each token
  // slice is priced at its own rate, then folded to a per-user total.
  const events = await usageEventsCol();
  const usageRows = (await events
    .aggregate([
      { $match: { timestamp: { $gte: startOfUtcMonth(now) } } },
      {
        $group: {
          _id: { userId: "$meta.userId", modelId: "$meta.modelId" },
          inputTokens: { $sum: "$inputTokens" },
          outputTokens: { $sum: "$outputTokens" },
        },
      },
    ])
    .toArray()) as Array<{
    _id: { userId: ObjectId; modelId: string };
    inputTokens: number;
    outputTokens: number;
  }>;

  const usageByUser = new Map<string, { tokens: number; spend: number }>();
  for (const r of usageRows) {
    const key = r._id.userId.toString();
    const entry = usageByUser.get(key) ?? { tokens: 0, spend: 0 };
    entry.tokens += r.inputTokens + r.outputTokens;
    entry.spend += costUsd(prices, r._id.modelId, r.inputTokens, r.outputTokens);
    usageByUser.set(key, entry);
  }

  return userDocs.map((u) => {
    const id = u._id!.toString();
    const usage = usageByUser.get(id) ?? { tokens: 0, spend: 0 };
    return {
      id,
      email: u.email,
      name: u.name ?? null,
      role: u.role,
      status: u.status,
      allowedModels: u.allowedModels,
      monthlyTokenBudget: u.monthlyTokenBudget,
      dailyUsed: u.dailyMessageCount?.count ?? 0,
      dailyCap: dailyCapFor(u.role),
      monthTokens: usage.tokens,
      monthSpendUsd: usage.spend,
      memoryEnabled: u.memoryEnabled ?? true,
      isEnvAdmin: isEnvAdminEmail(u.email),
    };
  });
}

export interface UpdateUserPatch {
  status?: "active" | "disabled" | undefined;
  allowedModels?: string[] | null | undefined;
  monthlyTokenBudget?: number | null | undefined;
}

/**
 * Apply an admin edit to a user's non-role fields. Validates any model override
 * against the catalog so an admin can't grant a model that doesn't exist.
 * Invalidates the budget cache so a budget change takes effect on the user's
 * next request rather than after the 60s TTL. Role changes go through
 * `setUserRole`, which also keeps the allowlists in sync.
 */
export async function updateUser(
  userId: ObjectId,
  patch: UpdateUserPatch,
): Promise<void> {
  const users = await usersCol();
  const user = await users.findOne({ _id: userId });
  if (!user) throw new AppError("not_found", "User not found.");

  const set: Record<string, unknown> = {};
  if (patch.status !== undefined) set.status = patch.status;
  if (patch.monthlyTokenBudget !== undefined) {
    set.monthlyTokenBudget = patch.monthlyTokenBudget;
  }
  if (patch.allowedModels !== undefined) {
    if (patch.allowedModels !== null) {
      const catalog = await loadModelCatalog();
      const known = new Set(catalog.map((m) => m.id));
      const unknown = patch.allowedModels.filter((m) => !known.has(m));
      if (unknown.length > 0) {
        throw new AppError(
          "invalid_input",
          `Unknown model id(s): ${unknown.join(", ")}.`,
        );
      }
    }
    set.allowedModels = patch.allowedModels;
  }

  if (Object.keys(set).length === 0) return;
  await users.updateOne({ _id: userId }, { $set: set });
  invalidateBudgetCache(userId);
}

/**
 * Change a user's role durably. The role on the user document alone isn't
 * enough: `provisionUser` recomputes role from `resolveRole` on every sign-in,
 * so a role that isn't backed by an allowlist entry would be undone at next
 * login. This keeps the two admin/member allowlists in sync with the target
 * role so the change survives re-provision:
 *
 *   - admin  -> add to adminAllowlist, remove from member allowlist
 *   - member -> add to member allowlist, remove from adminAllowlist
 *   - guest  -> remove from both
 *
 * The bootstrap `ADMIN_EMAIL` account resolves to admin from the env var, which
 * outranks every list, so it cannot be demoted — attempting it is rejected
 * rather than silently reverted on the next sign-in.
 */
export async function setUserRole(userId: ObjectId, role: Role): Promise<void> {
  const users = await usersCol();
  const user = await users.findOne({ _id: userId });
  if (!user) throw new AppError("not_found", "User not found.");

  if (isEnvAdminEmail(user.email) && role !== "admin") {
    throw new AppError(
      "forbidden",
      "The bootstrap admin (ADMIN_EMAIL) cannot be demoted.",
    );
  }

  const settings = await settingsCol();
  const email = user.email.toLowerCase();

  const grant = async (list: "allowlist" | "adminAllowlist"): Promise<void> => {
    await settings.updateOne(
      { _id: list },
      { $addToSet: { emails: email }, $setOnInsert: { _id: list } },
      { upsert: true },
    );
  };
  const revoke = async (list: "allowlist" | "adminAllowlist"): Promise<void> => {
    await settings.updateOne({ _id: list }, { $pull: { emails: email } });
  };

  if (role === "admin") {
    await grant("adminAllowlist");
    await revoke("allowlist");
  } else if (role === "member") {
    await grant("allowlist");
    await revoke("adminAllowlist");
  } else {
    await revoke("allowlist");
    await revoke("adminAllowlist");
  }

  await users.updateOne({ _id: userId }, { $set: { role } });
  invalidateBudgetCache(userId);
}

/** Promote a guest (or member) to member. Thin wrapper over `setUserRole`. */
export async function promoteToMember(userId: ObjectId): Promise<void> {
  await setUserRole(userId, "member");
}
