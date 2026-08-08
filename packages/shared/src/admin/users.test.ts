import { ObjectId } from "mongodb";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * setUserRole: the env admin cannot be demoted, and a role change syncs the
 * allowlists so it survives re-provision on sign-in. Test env sets
 * ADMIN_EMAIL=admin@example.com.
 */

const userFindOne = vi.fn();
const userUpdateOne = vi.fn();
const settingsUpdateOne = vi.fn();

vi.mock("../db/client", () => ({
  getDb: vi.fn(async () => ({})),
  getClient: () => Promise.resolve({}),
  DB_NAME: "claudius",
}));
vi.mock("../db/collections", () => ({
  usersCol: async () => ({ findOne: userFindOne, updateOne: userUpdateOne }),
  settingsCol: async () => ({ updateOne: settingsUpdateOne }),
  usageEventsCol: async () => ({ aggregate: () => ({ toArray: async () => [] }) }),
}));

const { setUserRole } = await import("./users");
import { isAppError } from "../errors";

async function codeOf(p: Promise<unknown>): Promise<string | null> {
  try {
    await p;
    return null;
  } catch (err) {
    return isAppError(err) ? err.code : "not-app-error";
  }
}

describe("setUserRole", () => {
  const id = new ObjectId();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("refuses to demote the bootstrap env admin", async () => {
    userFindOne.mockResolvedValue({ _id: id, email: "admin@example.com" });
    expect(await codeOf(setUserRole(id, "member"))).toBe("forbidden");
    expect(userUpdateOne).not.toHaveBeenCalled();
  });

  it("keeping the env admin as admin is allowed", async () => {
    userFindOne.mockResolvedValue({ _id: id, email: "admin@example.com" });
    expect(await codeOf(setUserRole(id, "admin"))).toBeNull();
  });

  it("promoting to admin grants the admin allowlist and revokes member", async () => {
    userFindOne.mockResolvedValue({ _id: id, email: "New@Example.com" });
    await setUserRole(id, "admin");
    // Grants adminAllowlist (lowercased), revokes member allowlist.
    expect(settingsUpdateOne).toHaveBeenCalledWith(
      { _id: "adminAllowlist" },
      expect.objectContaining({ $addToSet: { emails: "new@example.com" } }),
      { upsert: true },
    );
    expect(settingsUpdateOne).toHaveBeenCalledWith(
      { _id: "allowlist" },
      { $pull: { emails: "new@example.com" } },
    );
    expect(userUpdateOne).toHaveBeenCalledWith(
      { _id: id },
      { $set: { role: "admin" } },
    );
  });

  it("demoting to guest revokes both allowlists", async () => {
    userFindOne.mockResolvedValue({ _id: id, email: "ex@example.com" });
    await setUserRole(id, "guest");
    expect(settingsUpdateOne).toHaveBeenCalledWith(
      { _id: "allowlist" },
      { $pull: { emails: "ex@example.com" } },
    );
    expect(settingsUpdateOne).toHaveBeenCalledWith(
      { _id: "adminAllowlist" },
      { $pull: { emails: "ex@example.com" } },
    );
  });
});
