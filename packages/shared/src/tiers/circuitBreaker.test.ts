import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GuestCircuitBreakerSettings } from "../db/schemas";

const loadGuestCircuitBreaker = vi.fn<() => Promise<GuestCircuitBreakerSettings>>();
const guestSpendTodayUsd = vi.fn<() => Promise<number>>();
const updateOne = vi.fn();

vi.mock("../db/client", () => ({
  getDb: vi.fn(async () => ({})),
  clientPromise: Promise.resolve({}),
  DB_NAME: "claudius",
}));
vi.mock("./catalog", () => ({
  loadGuestCircuitBreaker: () => loadGuestCircuitBreaker(),
}));
vi.mock("../usage/aggregate", () => ({
  guestSpendTodayUsd: () => guestSpendTodayUsd(),
}));
vi.mock("../db/collections", () => ({
  settingsCol: vi.fn(async () => ({ updateOne })),
}));

const { assertGuestAllowed, invalidateGuestSpendCache } = await import(
  "./circuitBreaker"
);
import { isAppError } from "../errors";

function breaker(
  overrides: Partial<GuestCircuitBreakerSettings>,
): GuestCircuitBreakerSettings {
  return {
    _id: "guestCircuitBreaker",
    dailyCeilingUsd: 1,
    state: "open",
    trippedAt: null,
    killSwitch: false,
    ...overrides,
  };
}

async function codeOf(p: Promise<unknown>): Promise<string | null> {
  try {
    await p;
    return null;
  } catch (err) {
    return isAppError(err) ? err.code : "not-app-error";
  }
}

describe("assertGuestAllowed", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invalidateGuestSpendCache();
  });

  it("blocks with guest_access_disabled when the kill switch is on", async () => {
    loadGuestCircuitBreaker.mockResolvedValue(breaker({ killSwitch: true }));
    expect(await codeOf(assertGuestAllowed())).toBe("guest_access_disabled");
    expect(updateOne).not.toHaveBeenCalled();
  });

  it("blocks with circuit_breaker_tripped when already tripped", async () => {
    loadGuestCircuitBreaker.mockResolvedValue(breaker({ state: "tripped" }));
    expect(await codeOf(assertGuestAllowed())).toBe("circuit_breaker_tripped");
  });

  it("allows when spend is under the ceiling", async () => {
    loadGuestCircuitBreaker.mockResolvedValue(breaker({ dailyCeilingUsd: 1 }));
    guestSpendTodayUsd.mockResolvedValue(0.5);
    expect(await codeOf(assertGuestAllowed())).toBeNull();
    expect(updateOne).not.toHaveBeenCalled();
  });

  it("trips and blocks the request that crosses the ceiling", async () => {
    loadGuestCircuitBreaker.mockResolvedValue(breaker({ dailyCeilingUsd: 1 }));
    guestSpendTodayUsd.mockResolvedValue(1.2);
    expect(await codeOf(assertGuestAllowed())).toBe("circuit_breaker_tripped");
    // It persisted the trip so later guests are blocked without recomputing.
    expect(updateOne).toHaveBeenCalledWith(
      { _id: "guestCircuitBreaker" },
      expect.objectContaining({ $set: expect.objectContaining({ state: "tripped" }) }),
    );
  });

  it("caches spend so a burst shares one aggregation", async () => {
    loadGuestCircuitBreaker.mockResolvedValue(breaker({ dailyCeilingUsd: 10 }));
    guestSpendTodayUsd.mockResolvedValue(1);
    await assertGuestAllowed();
    await assertGuestAllowed();
    expect(guestSpendTodayUsd).toHaveBeenCalledTimes(1);
  });
});
