import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Role resolution precedence (Phase 4 follow-on): env ADMIN_EMAIL >
 * adminAllowlist > member allowlist > guest. The test env sets
 * ADMIN_EMAIL=admin@example.com (see vitest.config.ts).
 */

let adminDoc: { _id: "adminAllowlist"; emails: string[] } | null = null;
let memberDoc: { _id: "allowlist"; emails: string[] } | null = null;

const findOne = vi.fn(async ({ _id }: { _id: string }) => {
  if (_id === "adminAllowlist") return adminDoc;
  if (_id === "allowlist") return memberDoc;
  return null;
});

// Keep the real env (so ADMIN_EMAIL loads); override only settingsCol.
vi.mock("@claudius/shared", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@claudius/shared")>()),
  settingsCol: async () => ({ findOne }),
}));

const { resolveRole } = await import("./roles");

describe("resolveRole", () => {
  beforeEach(() => {
    adminDoc = { _id: "adminAllowlist", emails: [] };
    memberDoc = { _id: "allowlist", emails: [] };
    findOne.mockClear();
  });

  it("defaults to guest with no email", async () => {
    expect(await resolveRole(null)).toBe("guest");
  });

  it("the env ADMIN_EMAIL resolves to admin", async () => {
    expect(await resolveRole("admin@example.com")).toBe("admin");
  });

  it("the env admin wins even without hitting the lists", async () => {
    // Case-insensitive, and short-circuits before reading settings.
    expect(await resolveRole("ADMIN@example.com")).toBe("admin");
    expect(findOne).not.toHaveBeenCalled();
  });

  it("an email on the admin allowlist resolves to admin", async () => {
    adminDoc = { _id: "adminAllowlist", emails: ["boss@example.com"] };
    expect(await resolveRole("boss@example.com")).toBe("admin");
  });

  it("admin allowlist outranks the member allowlist", async () => {
    adminDoc = { _id: "adminAllowlist", emails: ["dual@example.com"] };
    memberDoc = { _id: "allowlist", emails: ["dual@example.com"] };
    expect(await resolveRole("dual@example.com")).toBe("admin");
  });

  it("an email only on the member allowlist resolves to member", async () => {
    memberDoc = { _id: "allowlist", emails: ["m@example.com"] };
    expect(await resolveRole("m@example.com")).toBe("member");
  });

  it("an unknown email resolves to guest", async () => {
    expect(await resolveRole("nobody@example.com")).toBe("guest");
  });
});
