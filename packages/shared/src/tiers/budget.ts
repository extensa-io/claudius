import type { ObjectId } from "mongodb";
import { usersCol } from "../db/collections";
import type { Tier, User } from "../db/schemas";
import { AppError } from "../errors";
import { userMonthTokensUsed } from "../usage/aggregate";
import { loadTier } from "./catalog";

/**
 * Member monthly token budget — a soft-stop, not metering (Phase 4).
 *
 * "Soft-stop" because token counts are only known *after* a call completes: we
 * block the next invocation once the running month-to-date total has crossed the
 * budget, rather than pre-reserving tokens. Admins are always exempt. The
 * effective budget is the user's per-user override if set, else the tier
 * default; `null` at either level means unlimited.
 *
 * Month-to-date tokens are cached per user for ~60s so a chat burst shares one
 * aggregation, mirroring the circuit breaker's spend cache.
 */

const USED_CACHE_TTL_MS = 60_000;
const WARN_RATIO = 0.8;

const usedCache = new Map<string, { value: number; at: number }>();

export function invalidateBudgetCache(userId?: ObjectId): void {
  if (userId) usedCache.delete(userId.toString());
  else usedCache.clear();
}

async function cachedMonthTokens(userId: ObjectId, now: number): Promise<number> {
  const key = userId.toString();
  const hit = usedCache.get(key);
  if (hit && now - hit.at < USED_CACHE_TTL_MS) return hit.value;
  const value = await userMonthTokensUsed(userId);
  usedCache.set(key, { value, at: now });
  return value;
}

/** Effective monthly budget: per-user override, else tier default (null = ∞). */
export function effectiveBudget(user: User, tier: Tier): number | null {
  return user.monthlyTokenBudget ?? tier.monthlyTokenBudget;
}

export interface BudgetStatus {
  /** False for admins and any unlimited (null) budget — no banner, no block. */
  limited: boolean;
  budget: number | null;
  used: number;
  /** used / budget, or null when unlimited. */
  ratio: number | null;
  level: "ok" | "warn" | "blocked";
}

/**
 * The soft-stop ladder as a pure function: unlimited -> ok, at/over budget ->
 * blocked, at or past the warning ratio -> warn, else ok. Exported so the exact
 * 80%/100% boundaries can be unit-tested without a database.
 */
export function budgetLevelFor(
  used: number,
  budget: number | null,
): "ok" | "warn" | "blocked" {
  if (budget === null) return "ok";
  if (used >= budget) return "blocked";
  const ratio = budget === 0 ? 1 : used / budget;
  return ratio >= WARN_RATIO ? "warn" : "ok";
}

function statusFrom(user: User, tier: Tier, used: number): BudgetStatus {
  const budget = user.role === "admin" ? null : effectiveBudget(user, tier);
  if (budget === null) {
    return { limited: false, budget: null, used, ratio: null, level: "ok" };
  }
  const ratio = budget === 0 ? 1 : used / budget;
  return { limited: true, budget, used, ratio, level: budgetLevelFor(used, budget) };
}

/** Budget status for the hot path — caller already holds user + tier. */
export async function monthlyBudgetStatus(
  user: User,
  tier: Tier,
  now: number = Date.now(),
): Promise<BudgetStatus> {
  const used = await cachedMonthTokens(user._id!, now);
  return statusFrom(user, tier, used);
}

/** Budget status by id, loading user + tier — for the app's warning banner. */
export async function getMonthlyBudgetStatus(
  userId: ObjectId,
): Promise<BudgetStatus> {
  const users = await usersCol();
  const user = await users.findOne({ _id: userId });
  if (!user) {
    throw new AppError("unauthorized", "Your account could not be found.");
  }
  const tier = await loadTier(user.role);
  return monthlyBudgetStatus(user, tier);
}

/** Throw when a member has reached 100% of their monthly budget. */
export async function assertWithinMonthlyBudget(
  user: User,
  tier: Tier,
): Promise<void> {
  const status = await monthlyBudgetStatus(user, tier);
  if (status.limited && status.level === "blocked") {
    throw new AppError(
      "monthly_budget_reached",
      "You've reached your monthly usage budget. Please contact an administrator to continue.",
    );
  }
}
