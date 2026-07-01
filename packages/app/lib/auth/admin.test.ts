import { describe, expect, it, vi } from "vitest";

/**
 * The admin API gate (acceptance: a non-admin requesting any /admin route or API
 * receives 404 or 403). We assert the thrown AppError code; the route wrapper
 * maps it to the HTTP status. Non-admins get not_found (404) so the admin
 * surface doesn't even confirm it exists.
 */

const authMock = vi.fn();
vi.mock("./index", () => ({ auth: () => authMock() }));
vi.mock("next/navigation", () => ({ notFound: vi.fn() }));

const { requireAdminApi } = await import("./admin");
import { isAppError } from "@claudius/shared";

async function codeOf(p: Promise<unknown>): Promise<string | null> {
  try {
    await p;
    return null;
  } catch (err) {
    return isAppError(err) ? err.code : "not-app-error";
  }
}

describe("requireAdminApi", () => {
  it("is unauthorized (401) when signed out", async () => {
    authMock.mockResolvedValue(null);
    expect(await codeOf(requireAdminApi())).toBe("unauthorized");
  });

  it("is not_found (404) for a member", async () => {
    authMock.mockResolvedValue({ user: { id: "1", role: "member" } });
    expect(await codeOf(requireAdminApi())).toBe("not_found");
  });

  it("is not_found (404) for a guest", async () => {
    authMock.mockResolvedValue({ user: { id: "1", role: "guest" } });
    expect(await codeOf(requireAdminApi())).toBe("not_found");
  });

  it("resolves the session for an admin", async () => {
    const session = { user: { id: "1", role: "admin" } };
    authMock.mockResolvedValue(session);
    await expect(requireAdminApi()).resolves.toBe(session);
  });
});
