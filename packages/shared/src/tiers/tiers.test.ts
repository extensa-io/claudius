import { describe, expect, it } from "vitest";
import type { ModelCatalogEntry, User } from "../db/schemas";
import { isModelPermitted } from "./catalog";
import { startOfNextUtcDay } from "./dailyCap";

/**
 * These cover the two pieces of tier logic that are pure and easy to get subtly
 * wrong: the UTC reset boundary and the allowedModels-vs-role precedence. The
 * database-touching pieces (atomic increment, circuit breaker) are exercised
 * against live Atlas in manual verification.
 */

describe("startOfNextUtcDay", () => {
  it("rolls to the next midnight UTC mid-day", () => {
    const now = new Date("2026-06-21T15:30:00.000Z");
    expect(startOfNextUtcDay(now).toISOString()).toBe(
      "2026-06-22T00:00:00.000Z",
    );
  });

  it("advances a full day when already at midnight UTC", () => {
    const now = new Date("2026-06-21T00:00:00.000Z");
    expect(startOfNextUtcDay(now).toISOString()).toBe(
      "2026-06-22T00:00:00.000Z",
    );
  });

  it("crosses a month boundary", () => {
    const now = new Date("2026-06-30T23:59:59.000Z");
    expect(startOfNextUtcDay(now).toISOString()).toBe(
      "2026-07-01T00:00:00.000Z",
    );
  });

  it("crosses a year boundary", () => {
    const now = new Date("2026-12-31T12:00:00.000Z");
    expect(startOfNextUtcDay(now).toISOString()).toBe(
      "2027-01-01T00:00:00.000Z",
    );
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
    ...overrides,
  };
}

function makeEntry(overrides: Partial<ModelCatalogEntry>): ModelCatalogEntry {
  return {
    id: "sonnet",
    inferenceProfileId: "us.anthropic.claude-sonnet-4-6",
    displayName: "Claude Sonnet 4.6",
    inputPricePerMTok: 0,
    outputPricePerMTok: 0,
    roles: ["member", "admin"],
    ...overrides,
  };
}

describe("isModelPermitted", () => {
  it("allows a model whose roles include the user's role (allowedModels null)", () => {
    const user = makeUser({ role: "member", allowedModels: null });
    expect(isModelPermitted(user, makeEntry({ roles: ["member"] }))).toBe(true);
  });

  it("denies a model whose roles exclude the user's role (allowedModels null)", () => {
    const user = makeUser({ role: "guest", allowedModels: null });
    expect(
      isModelPermitted(user, makeEntry({ roles: ["member", "admin"] })),
    ).toBe(false);
  });

  it("a non-null allowedModels override supersedes the role check", () => {
    // Role would be denied by the catalog, but the explicit override grants it.
    const user = makeUser({ role: "guest", allowedModels: ["sonnet"] });
    expect(
      isModelPermitted(user, makeEntry({ id: "sonnet", roles: ["admin"] })),
    ).toBe(true);
  });

  it("a non-null allowedModels override denies models not in the list", () => {
    const user = makeUser({ role: "admin", allowedModels: ["sonnet"] });
    expect(
      isModelPermitted(user, makeEntry({ id: "opus", roles: ["admin"] })),
    ).toBe(false);
  });

  it("an empty allowedModels array denies everything", () => {
    const user = makeUser({ role: "admin", allowedModels: [] });
    expect(isModelPermitted(user, makeEntry({ roles: ["admin"] }))).toBe(false);
  });
});
