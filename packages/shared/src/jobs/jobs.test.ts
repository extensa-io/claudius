import { ObjectId } from "mongodb";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The jobs lifecycle is thin by design (Mongo is the bus), so these tests pin the
 * INVARIANTS the worker and app rely on: the atomic claim shape, the owner filter
 * on every app-facing read/control, cancellation-safe termination, and enqueue
 * dedup. The collection is faked; we assert the queries, not the driver.
 */

const findOne = vi.fn();
const findOneAndUpdate = vi.fn();
const insertOne = vi.fn();
const updateOne = vi.fn();
const updateMany = vi.fn();
const find = vi.fn();

vi.mock("../db/collections", () => ({
  jobsCol: vi.fn(async () => ({
    findOne,
    findOneAndUpdate,
    insertOne,
    updateOne,
    updateMany,
    find,
  })),
}));

const {
  enqueueMemoryExtractionJob,
  claimNextJob,
  recoverStaleJobs,
  completeJob,
  failJob,
  requestJobCancel,
  getJobForOwner,
} = await import("./index");

beforeEach(() => {
  vi.clearAllMocks();
  insertOne.mockResolvedValue({ insertedId: new ObjectId() });
  updateOne.mockResolvedValue({ modifiedCount: 1 });
  updateMany.mockResolvedValue({ modifiedCount: 0 });
});

describe("enqueueMemoryExtractionJob", () => {
  it("dedupes: returns null when a queued/running job already exists", async () => {
    findOne.mockResolvedValue({ _id: new ObjectId() });
    const result = await enqueueMemoryExtractionJob({
      userId: new ObjectId(),
      conversationId: new ObjectId(),
    });
    expect(result).toBeNull();
    expect(insertOne).not.toHaveBeenCalled();
    // The dedup query is scoped to this conversation and the active statuses.
    expect(findOne).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "memory_extraction",
        status: { $in: ["queued", "running"] },
      }),
    );
  });

  it("inserts when none is active, and a guest job carries expiresAt", async () => {
    findOne.mockResolvedValue(null);
    const expiresAt = new Date();
    const id = await enqueueMemoryExtractionJob({
      userId: new ObjectId(),
      conversationId: new ObjectId(),
      expiresAt,
    });
    expect(id).not.toBeNull();
    const inserted = insertOne.mock.calls[0]?.[0];
    expect(inserted.status).toBe("queued");
    expect(inserted.expiresAt).toEqual(expiresAt);
  });

  it("omits expiresAt for members (no TTL on member jobs)", async () => {
    findOne.mockResolvedValue(null);
    await enqueueMemoryExtractionJob({
      userId: new ObjectId(),
      conversationId: new ObjectId(),
    });
    const inserted = insertOne.mock.calls[0]?.[0];
    expect("expiresAt" in inserted).toBe(false);
  });
});

describe("claimNextJob", () => {
  it("atomically flips the oldest queued job to running", async () => {
    const job = { _id: new ObjectId(), status: "running" };
    findOneAndUpdate.mockResolvedValue(job);
    const claimed = await claimNextJob();
    expect(claimed).toBe(job);
    const [filter, update, options] = findOneAndUpdate.mock.calls[0] ?? [];
    expect(filter).toEqual({ status: "queued" });
    expect(update.$set.status).toBe("running");
    expect(update.$set.startedAt).toBeInstanceOf(Date);
    expect(options).toMatchObject({
      sort: { createdAt: 1 },
      returnDocument: "after",
    });
  });

  it("returns null when nothing is queued", async () => {
    findOneAndUpdate.mockResolvedValue(null);
    expect(await claimNextJob()).toBeNull();
  });
});

describe("recoverStaleJobs", () => {
  it("resets orphaned running jobs back to queued on boot", async () => {
    updateMany.mockResolvedValue({ modifiedCount: 3 });
    const n = await recoverStaleJobs();
    expect(n).toBe(3);
    const [filter, update] = updateMany.mock.calls[0] ?? [];
    expect(filter).toEqual({ status: "running" });
    expect(update.$set).toEqual({ status: "queued", startedAt: null });
  });
});

describe("terminal transitions are cancellation-safe", () => {
  it("completeJob only touches a still-running job", async () => {
    await completeJob(new ObjectId(), {
      report: "r",
      sources: [],
      searchesRun: 1,
      pagesRead: 1,
    });
    const filter = updateOne.mock.calls[0]?.[0];
    expect(filter.status).toBe("running");
  });

  it("failJob only touches a still-running job", async () => {
    await failJob(new ObjectId(), "boom");
    const filter = updateOne.mock.calls[0]?.[0];
    expect(filter.status).toBe("running");
  });
});

describe("owner scoping (invariant #1)", () => {
  it("requestJobCancel filters by userId and only cancellable statuses", async () => {
    const userId = new ObjectId();
    await requestJobCancel(userId, new ObjectId());
    const [filter, update] = updateOne.mock.calls[0] ?? [];
    expect(filter.userId).toBe(userId);
    expect(filter.status).toEqual({ $in: ["queued", "running"] });
    expect(update.$set.status).toBe("cancelled");
  });

  it("getJobForOwner filters by userId", async () => {
    const userId = new ObjectId();
    findOne.mockResolvedValue(null);
    await getJobForOwner(userId, new ObjectId());
    expect(findOne).toHaveBeenCalledWith(
      expect.objectContaining({ userId }),
    );
  });
});
