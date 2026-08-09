import { ObjectId } from "mongodb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Conversation } from "@claudius/shared";

/**
 * Incognito creation and the delete cascade. Both are pure control flow over the
 * collection layer, so the collections are captured rather than connected to.
 *
 * What is worth pinning here: the flag can only be set at creation (there is no
 * update path that touches it), and a delete removes the transcript and the
 * files, in an order where a mid-way failure still leaves a retriable
 * conversation, while deliberately leaving usage_events and memories alone.
 */

const insertOne = vi.fn<
  (doc: Conversation) => Promise<{ insertedId: ObjectId }>
>(async () => ({ insertedId: new ObjectId() }));
const findOne = vi.fn<() => Promise<Conversation | null>>();
const deleteOne = vi.fn(async () => ({ deletedCount: 1 }));
const deleteManyJobs = vi.fn(async () => ({ deletedCount: 0 }));
const deleteThreadCheckpoints = vi.fn(async () => {});
const deleteConversationDocuments = vi.fn(async () => {});
/** Every side effect in call order, so the cascade's ordering can be asserted. */
const calls: string[] = [];

vi.mock("@claudius/shared", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@claudius/shared")>()),
  conversationsCol: async () => ({
    insertOne,
    findOne,
    deleteOne: async (...args: unknown[]) => {
      calls.push("conversation");
      return deleteOne(...(args as []));
    },
  }),
  jobsCol: async () => ({
    deleteMany: async (...args: unknown[]) => {
      calls.push("jobs");
      return deleteManyJobs(...(args as []));
    },
  }),
  deleteThreadCheckpoints: async (...args: unknown[]) => {
    calls.push("checkpoints");
    return deleteThreadCheckpoints(...(args as []));
  },
}));

vi.mock("@/lib/documents", () => ({
  deleteConversationDocuments: async (...args: unknown[]) => {
    calls.push("documents");
    return deleteConversationDocuments(...(args as []));
  },
}));

const { createConversation, deleteConversation } = await import(
  "./conversations"
);

const userId = new ObjectId();

beforeEach(() => {
  calls.length = 0;
  insertOne.mockClear();
  findOne.mockReset();
  deleteOne.mockClear();
});

describe("createConversation", () => {
  it("omits the incognito key entirely on a normal conversation", async () => {
    await createConversation({ userId, role: "member", modelId: "m" });
    const doc = insertOne.mock.calls[0]![0];
    // Absent, not false: the extraction filter and the schema both depend on
    // there being exactly one shape for "not incognito".
    expect("incognito" in doc).toBe(false);
  });

  it("marks the conversation incognito when asked", async () => {
    await createConversation({
      userId,
      role: "member",
      modelId: "m",
      incognito: true,
    });
    const doc = insertOne.mock.calls[0]![0];
    expect(doc.incognito).toBe(true);
  });

  it("keeps the guest TTL alongside the flag", async () => {
    await createConversation({
      userId,
      role: "guest",
      modelId: "m",
      incognito: true,
    });
    const doc = insertOne.mock.calls[0]![0];
    expect(doc.expiresAt).toBeInstanceOf(Date);
  });
});

describe("deleteConversation", () => {
  const conversationId = new ObjectId();

  it("refuses an id that is not the caller's, touching nothing", async () => {
    // A conversation owned by someone else reads as missing, exactly as
    // getOwnedConversation does — the 404 must not reveal that it exists.
    findOne.mockResolvedValue(null);
    await expect(
      deleteConversation(userId, conversationId.toString()),
    ).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  it("refuses a malformed id without querying", async () => {
    await expect(deleteConversation(userId, "not-an-id")).rejects.toThrow();
    expect(findOne).not.toHaveBeenCalled();
  });

  it("removes children before the conversation row", async () => {
    findOne.mockResolvedValue({ _id: conversationId } as Conversation);
    await deleteConversation(userId, conversationId.toString());
    expect(calls).toEqual(["documents", "jobs", "checkpoints", "conversation"]);
  });

  it("deletes the thread's checkpoints, keyed by the conversation id", async () => {
    findOne.mockResolvedValue({ _id: conversationId } as Conversation);
    await deleteConversation(userId, conversationId.toString());
    expect(deleteThreadCheckpoints).toHaveBeenCalledWith(
      conversationId.toString(),
    );
  });

  it("scopes the jobs cleanup to the owner as well as the conversation", async () => {
    findOne.mockResolvedValue({ _id: conversationId } as Conversation);
    await deleteConversation(userId, conversationId.toString());
    expect(deleteManyJobs).toHaveBeenCalledWith({
      userId,
      conversationId,
    });
  });
});
