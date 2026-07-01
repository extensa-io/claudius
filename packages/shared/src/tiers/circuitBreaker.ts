import { settingsCol } from "../db/collections";
import type { GuestCircuitBreakerSettings } from "../db/schemas";
import { AppError } from "../errors";
import { guestSpendTodayUsd } from "../usage/aggregate";
import { loadGuestCircuitBreaker } from "./catalog";

/**
 * Guest circuit breaker — the live spend safety valve (Phase 4).
 *
 * Before any guest invocation we compare the day's aggregate guest spend to the
 * configured ceiling. Recomputing that aggregate on every guest message would be
 * wasteful, so the spend figure is cached in-process for ~60s: a burst of guest
 * traffic shares one aggregation, and the breaker still trips within a minute of
 * crossing the ceiling. The cache is per-instance, which is fine — a serverless
 * instance that never sees the spend just recomputes on its own first guest hit.
 */

const SPEND_CACHE_TTL_MS = 60_000;

let spendCache: { value: number; at: number } | null = null;

/** Test seam + admin-mutation hook: force the next check to recompute spend. */
export function invalidateGuestSpendCache(): void {
  spendCache = null;
}

async function cachedGuestSpendToday(now: number): Promise<number> {
  if (spendCache && now - spendCache.at < SPEND_CACHE_TTL_MS) {
    return spendCache.value;
  }
  const value = await guestSpendTodayUsd();
  spendCache = { value, at: now };
  return value;
}

const BUDGET_EXHAUSTED_MESSAGE =
  "The demo budget is exhausted for today. Please try again later.";
const GUEST_DISABLED_MESSAGE = "Guest access is currently disabled.";

/**
 * Assert a guest may invoke. Order:
 *   1. kill switch — the manual master off, blocks regardless of spend,
 *   2. already-tripped state — blocks until the daily reset,
 *   3. live spend vs ceiling — trips (and blocks) the first request that
 *      crosses the ceiling, then persists the tripped state for the rest.
 *
 * Throws an AppError with a user-safe message on any block; returns silently
 * when the guest may proceed.
 */
export async function assertGuestAllowed(now: number = Date.now()): Promise<void> {
  const breaker = await loadGuestCircuitBreaker();

  if (breaker.killSwitch) {
    throw new AppError("guest_access_disabled", GUEST_DISABLED_MESSAGE);
  }
  if (breaker.state === "tripped") {
    throw new AppError("circuit_breaker_tripped", BUDGET_EXHAUSTED_MESSAGE);
  }

  const spend = await cachedGuestSpendToday(now);
  if (spend >= breaker.dailyCeilingUsd) {
    await tripBreaker();
    throw new AppError("circuit_breaker_tripped", BUDGET_EXHAUSTED_MESSAGE);
  }
}

/** Flip the spend-based breaker to tripped (admin manual trip, or auto). */
export async function tripBreaker(now: Date = new Date()): Promise<void> {
  const settings = await settingsCol();
  await settings.updateOne(
    { _id: "guestCircuitBreaker" },
    { $set: { state: "tripped", trippedAt: now } },
  );
}

/** Reset the spend-based breaker to open (daily cron, or admin manual reset). */
export async function resetBreaker(): Promise<void> {
  const settings = await settingsCol();
  await settings.updateOne(
    { _id: "guestCircuitBreaker" },
    { $set: { state: "open", trippedAt: null } },
  );
  invalidateGuestSpendCache();
}

/** Toggle the manual guest kill switch. Never auto-reset — admin action only. */
export async function setGuestKillSwitch(on: boolean): Promise<void> {
  const settings = await settingsCol();
  await settings.updateOne(
    { _id: "guestCircuitBreaker" },
    { $set: { killSwitch: on } },
  );
}

/** Set the daily guest spend ceiling (USD). */
export async function setGuestDailyCeiling(usd: number): Promise<void> {
  const settings = await settingsCol();
  await settings.updateOne(
    { _id: "guestCircuitBreaker" },
    { $set: { dailyCeilingUsd: usd } },
  );
  invalidateGuestSpendCache();
}

export interface GuestBreakerView extends GuestCircuitBreakerSettings {
  /** Live guest spend for the current UTC day (uncached — admin panel read). */
  spendTodayUsd: number;
}

/** Everything the admin circuit-breaker panel shows: config + today's spend. */
export async function guestBreakerView(): Promise<GuestBreakerView> {
  const [breaker, spendTodayUsd] = await Promise.all([
    loadGuestCircuitBreaker(),
    guestSpendTodayUsd(),
  ]);
  return { ...breaker, spendTodayUsd };
}
