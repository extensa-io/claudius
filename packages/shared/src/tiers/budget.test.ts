import { describe, expect, it, vi } from "vitest";

vi.mock("../db/client", () => ({
  getDb: vi.fn(async () => ({})),
  clientPromise: Promise.resolve({}),
  DB_NAME: "claudius",
}));

const { budgetLevelFor, effectiveBudget } = await import("./budget");
import type { Tier, User } from "../db/schemas";

/**
 * The member monthly-budget soft-stop, tested as pure logic. Acceptance: a
 * member at 100% is blocked; the 80% warning appears before that.
 */
describe("budgetLevelFor", () => {
  it("is ok well under the warning threshold", () => {
    expect(budgetLevelFor(500, 1000)).toBe("ok");
  });

  it("warns at exactly 80%", () => {
    expect(budgetLevelFor(800, 1000)).toBe("warn");
  });

  it("still warns just under 100%", () => {
    expect(budgetLevelFor(999, 1000)).toBe("warn");
  });

  it("blocks at exactly 100%", () => {
    expect(budgetLevelFor(1000, 1000)).toBe("blocked");
  });

  it("blocks over 100%", () => {
    expect(budgetLevelFor(1500, 1000)).toBe("blocked");
  });

  it("is always ok for an unlimited (null) budget", () => {
    expect(budgetLevelFor(1_000_000_000, null)).toBe("ok");
  });
});

function makeUser(overrides: Partial<User>): User {
  return {
    email: "u@example.com",
    role: "member",
    allowedModels: null,
    monthlyTokenBudget: null,
    dailyMessageCount: { count: 0, resetsAt: new Date() },
    status: "active",
    memoryEnabled: true,
    ...overrides,
  };
}

const tier: Tier = {
  dailyMessageCap: 200,
  memoryCap: 500,
  monthlyTokenBudget: 20_000_000,
  features: [],
};

describe("effectiveBudget", () => {
  it("uses the tier default when the user has no override", () => {
    expect(effectiveBudget(makeUser({ monthlyTokenBudget: null }), tier)).toBe(
      20_000_000,
    );
  });

  it("a per-user override supersedes the tier default", () => {
    expect(
      effectiveBudget(makeUser({ monthlyTokenBudget: 1000 }), tier),
    ).toBe(1000);
  });

  it("a per-user 0 override is honored (not treated as unset)", () => {
    expect(effectiveBudget(makeUser({ monthlyTokenBudget: 0 }), tier)).toBe(0);
  });
});
