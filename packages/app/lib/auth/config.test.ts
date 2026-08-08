import { describe, expect, it, vi } from "vitest";
import type { JWT } from "next-auth/jwt";

/**
 * The jwt callback refreshes role and status from the database on every request
 * so an admin's promote/disable takes effect without a re-login. These cover the
 * refresh itself and, more importantly, what happens when the database is
 * unreachable: the session must survive, because throwing here logs the user out
 * of the whole app over a transient blip.
 */

const findOne = vi.fn();
const usersCol = vi.fn(async () => ({ findOne }));

vi.mock("@claudius/shared", () => ({
  usersCol: () => usersCol(),
  loadGuestCircuitBreaker: vi.fn(),
}));
vi.mock("./provision", () => ({ provisionUser: vi.fn() }));
vi.mock("./roles", () => ({ resolveRole: vi.fn() }));

const { authConfig } = await import("./config");

const UID = "507f1f77bcf86cd799439011";

async function runJwt(token: JWT): Promise<JWT> {
  // The callback is always defined in authConfig; the cast narrows the optional
  // shape Auth.js declares for it.
  const jwt = authConfig.callbacks.jwt as (args: {
    token: JWT;
  }) => Promise<JWT>;
  return jwt({ token });
}

describe("jwt callback role refresh", () => {
  it("picks up a role change made since the token was issued", async () => {
    findOne.mockResolvedValue({ role: "admin", status: "active" });

    const token = await runJwt({ uid: UID, role: "member", status: "active" });

    expect(token.role).toBe("admin");
    expect(token.status).toBe("active");
  });

  it("keeps the token's role and status when the database is unreachable", async () => {
    findOne.mockRejectedValue(new Error("Server selection timed out"));

    const token = await runJwt({ uid: UID, role: "member", status: "active" });

    expect(token.role).toBe("member");
    expect(token.status).toBe("active");
  });

  it("does not throw when the database is unreachable", async () => {
    findOne.mockRejectedValue(new Error("Server selection timed out"));

    await expect(
      runJwt({ uid: UID, role: "member", status: "active" }),
    ).resolves.toBeDefined();
  });
});
