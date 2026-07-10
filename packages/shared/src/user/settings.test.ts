import { ObjectId } from "mongodb";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Stub the collection accessor so these unit tests never open a Mongo
// connection; we assert on the arguments the store hands the driver.
const findOne = vi.fn();
const updateOne = vi.fn();

vi.mock("../db/collections", () => ({
  userSettingsCol: vi.fn(async () => ({ findOne, updateOne })),
}));

const { getUserSettings, updateUserSettings } = await import("./settings");

const userId = new ObjectId("507f1f77bcf86cd799439011");

beforeEach(() => {
  findOne.mockReset();
  updateOne.mockReset();
});

describe("getUserSettings", () => {
  it("returns the unset view when the user has no document", async () => {
    findOne.mockResolvedValue(null);
    expect(await getUserSettings(userId)).toEqual({
      preferredName: null,
      instructions: null,
      preferredModelId: null,
    });
  });

  it("returns stored fields, normalizing missing ones to null", async () => {
    findOne.mockResolvedValue({ _id: userId, preferredName: "Néstor" });
    expect(await getUserSettings(userId)).toEqual({
      preferredName: "Néstor",
      instructions: null,
      preferredModelId: null,
    });
  });

  it("returns the stored preferred model id", async () => {
    findOne.mockResolvedValue({
      _id: userId,
      preferredModelId: "claude-opus-4-8",
    });
    expect(await getUserSettings(userId)).toEqual({
      preferredName: null,
      instructions: null,
      preferredModelId: "claude-opus-4-8",
    });
  });
});

describe("updateUserSettings", () => {
  const now = new Date("2026-07-07T00:00:00Z");

  it("upserts, trims values, and stamps updatedAt", async () => {
    updateOne.mockResolvedValue({});
    findOne.mockResolvedValue({
      _id: userId,
      preferredName: "Néstor",
      instructions: "Be terse.",
    });

    await updateUserSettings(
      userId,
      { preferredName: "  Néstor  ", instructions: "Be terse." },
      now,
    );

    const [filter, update, options] = updateOne.mock.calls[0]!;
    expect(filter).toEqual({ _id: userId });
    expect(options).toEqual({ upsert: true });
    expect(update.$set.preferredName).toBe("Néstor");
    expect(update.$set.instructions).toBe("Be terse.");
    expect(update.$set.updatedAt).toBe(now);
  });

  it("clears a field when passed empty/whitespace", async () => {
    updateOne.mockResolvedValue({});
    findOne.mockResolvedValue({ _id: userId });

    await updateUserSettings(userId, { instructions: "   " }, now);

    const [, update] = updateOne.mock.calls[0]!;
    expect(update.$set.instructions).toBeNull();
    // An omitted field is left untouched rather than nulled.
    expect("preferredName" in update.$set).toBe(false);
  });

  it("leaves omitted fields out of the update entirely", async () => {
    updateOne.mockResolvedValue({});
    findOne.mockResolvedValue({ _id: userId });

    await updateUserSettings(userId, { preferredName: "Néstor" }, now);

    const [, update] = updateOne.mock.calls[0]!;
    expect("instructions" in update.$set).toBe(false);
    expect("preferredModelId" in update.$set).toBe(false);
  });

  it("persists the sticky model choice", async () => {
    updateOne.mockResolvedValue({});
    findOne.mockResolvedValue({
      _id: userId,
      preferredModelId: "claude-opus-4-8",
    });

    await updateUserSettings(
      userId,
      { preferredModelId: "claude-opus-4-8" },
      now,
    );

    const [, update] = updateOne.mock.calls[0]!;
    expect(update.$set.preferredModelId).toBe("claude-opus-4-8");
    expect("preferredName" in update.$set).toBe(false);
  });
});
