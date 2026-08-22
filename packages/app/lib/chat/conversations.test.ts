import { ObjectId } from "mongodb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Conversation } from "@claudius/shared";

/**
 * Incognito creation, scratch-thread lifecycle, and the delete cascade. All of it
 * is pure control flow over the collection layer, so the collections are captured
 * rather than connected to.
 *
 * What is worth pinning here: incognito can only be set at creation (there is no
 * update path that touches it); a scratch thread's promotion to a real
 * conversation is one-way and never disturbs a guest's expiresAt; and a delete
 * removes the transcript and the files in an order where a mid-way failure still
 * leaves a retriable conversation, while deliberately leaving usage_events and
 * memories alone.
 */

const insertOne = vi.fn<
  (doc: Conversation) => Promise<{ insertedId: ObjectId }>
>(async () => ({ insertedId: new ObjectId() }));
const findOne = vi.fn<() => Promise<Conversation | null>>();
type Filter = Record<string, unknown>;
type Update = Record<string, Record<string, unknown> | undefined>;
const updateOne = vi.fn<
  (filter: Filter, update: Update) => Promise<{ matchedCount: number }>
>(async () => ({ matchedCount: 1 }));
const sweepFind = vi.fn<(filter: Filter) => Conversation[]>(() => []);
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
    updateOne,
    find: (filter: unknown) => ({
      limit: () => ({ toArray: async () => sweepFind(filter as Filter) }),
    }),
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

const {
  createConversation,
  deleteConversation,
  sweepExpiredThreads,
  touchConversation,
} = await import("./conversations");

const userId = new ObjectId();

beforeEach(() => {
  calls.length = 0;
  insertOne.mockClear();
  findOne.mockReset();
  deleteOne.mockClear();
  updateOne.mockClear();
  sweepFind.mockReset();
  sweepFind.mockReturnValue([]);
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

  it("dates a guest thread an hour past the 24h it is promised", async () => {
    // The extra hour is the sweep's exclusive window: it claims the thread one
    // hour before this date, so the guest still gets ~24h and the TTL index
    // never gets there first. See SWEEP_LOOKAHEAD_MS.
    await createConversation({ userId, role: "guest", modelId: "m" });
    const { expiresAt } = insertOne.mock.calls[0]![0];
    const hoursOut = (expiresAt!.getTime() - Date.now()) / 3_600_000;
    expect(hoursOut).toBeGreaterThan(24);
    expect(hoursOut).toBeLessThanOrEqual(25);
  });
});

describe("scratch threads", () => {
  const conversationId = new ObjectId();
  const touch = { userId, conversationId, preview: "p", modelId: "m" };

  it("omits scratchUntil on a normal new conversation", async () => {
    await createConversation({ userId, role: "member", modelId: "m" });
    expect("scratchUntil" in insertOne.mock.calls[0]![0]).toBe(false);
  });

  it("dates a new lookup thread roughly a day out", async () => {
    await createConversation({
      userId,
      role: "member",
      modelId: "m",
      scratch: true,
    });
    const { scratchUntil } = insertOne.mock.calls[0]![0];
    const hoursOut = (scratchUntil!.getTime() - Date.now()) / 3_600_000;
    expect(hoursOut).toBeGreaterThan(23);
    expect(hoursOut).toBeLessThanOrEqual(24);
  });

  it("gives a guest lookup thread both clocks", async () => {
    // expiresAt is the database-enforced guest TTL (invariant #4); scratchUntil
    // is what the sweep reads. They are independent on purpose.
    await createConversation({
      userId,
      role: "guest",
      modelId: "m",
      scratch: true,
    });
    const doc = insertOne.mock.calls[0]![0];
    expect(doc.expiresAt).toBeInstanceOf(Date);
    expect(doc.scratchUntil).toBeInstanceOf(Date);
  });

  it("pushes the clock forward on a further lookup, but only if already scratch", async () => {
    await touchConversation({ ...touch, scratch: true });
    const [filter, update] = updateOne.mock.calls[1]!;
    // The $exists guard is the whole safety property: a `?` typed into a
    // promoted thread must not re-arm the timer on a real conversation.
    expect(filter.scratchUntil).toEqual({ $exists: true });
    expect(update.$set!.scratchUntil).toBeInstanceOf(Date);
  });

  it("promotes the thread on a normal turn and never re-arms it", async () => {
    await touchConversation(touch);
    expect(updateOne).toHaveBeenCalledTimes(1);
    const [, update] = updateOne.mock.calls[0]!;
    expect(update.$unset).toEqual({ scratchUntil: "" });
    // Only scratchUntil goes: clearing expiresAt here would quietly turn a
    // guest's thread into permanent data.
    expect(update.$set).not.toHaveProperty("expiresAt");
    expect(update.$unset).not.toHaveProperty("expiresAt");
  });
});

describe("sweepExpiredThreads", () => {
  type SweepFilter = {
    $or: [{ scratchUntil: { $lte: Date } }, { expiresAt: { $lte: Date } }];
  };

  it("asks for lapsed scratch threads and guest threads nearing expiry", async () => {
    await sweepExpiredThreads();
    const filter = sweepFind.mock.calls[0]![0] as SweepFilter;
    const [scratch, guest] = filter.$or;
    expect(scratch.scratchUntil.$lte).toBeInstanceOf(Date);
    expect(guest.expiresAt.$lte).toBeInstanceOf(Date);
  });

  it("reaches a guest thread an hour before its stored expiry", async () => {
    // The whole point of the lookahead: the TTL reaper wakes every 60s, so a
    // date this sweep shares with it would go to the TTL, which skips the
    // cascade. Claiming the thread early keeps the sweep ahead.
    await sweepExpiredThreads();
    const filter = sweepFind.mock.calls[0]![0] as SweepFilter;
    const [scratch, guest] = filter.$or;
    const hoursAhead =
      (guest.expiresAt.$lte.getTime() - scratch.scratchUntil.$lte.getTime()) /
      3_600_000;
    expect(hoursAhead).toBeCloseTo(1, 3);
  });

  it("deletes each lapsed thread through the full cascade", async () => {
    const doomed = new ObjectId();
    sweepFind.mockReturnValue([{ _id: doomed, userId } as Conversation]);
    findOne.mockResolvedValue({ _id: doomed } as Conversation);

    const result = await sweepExpiredThreads();

    expect(result).toEqual({ deleted: 1, failed: 0 });
    // The point of the sweep over a TTL index: the checkpoints go too.
    expect(calls).toEqual(["documents", "jobs", "checkpoints", "conversation"]);
    expect(deleteThreadCheckpoints).toHaveBeenCalledWith(doomed.toString());
  });

  it("keeps going when one thread fails, and reports it", async () => {
    const bad = new ObjectId();
    const good = new ObjectId();
    sweepFind.mockReturnValue([
      { _id: bad, userId } as Conversation,
      { _id: good, userId } as Conversation,
    ]);
    // First delete finds nothing (a racing manual delete), so the cascade
    // throws; the second must still run.
    findOne
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ _id: good } as Conversation);

    expect(await sweepExpiredThreads()).toEqual({ deleted: 1, failed: 1 });
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
