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
  isJobCancelled,
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

  it("stamps a 30-day expiresAt on finished memory jobs only, without extending a guest's", async () => {
    // The retention rule can't be a plain value: it depends on the document's
    // own type and existing expiresAt, so the terminal write is a pipeline
    // update. Assert the expression, since the faked collection can't evaluate
    // it. See jobs/progress.ts for why research jobs are exempt.
    await completeJob(new ObjectId(), {
      created: 1,
      superseded: 0,
      skipped: 0,
      status: "ok",
    });
    const [, pipeline] = updateOne.mock.calls[0] ?? [];
    const set = pipeline[0].$set;
    const [condition, whenReapable, otherwise] = set.expiresAt.$cond;

    // Only the two memory types reap; research falls through to its own
    // (missing) expiresAt, which an aggregation $set omits rather than adds.
    expect(condition).toEqual({
      $in: ["$type", ["memory_extraction", "memory_consolidation"]],
    });
    expect(otherwise).toBe("$expiresAt");

    // $ifNull, not a bare date: a guest job already carries a short expiry from
    // enqueue and this must never push it out to 30 days.
    const [existing, fallback] = whenReapable.$ifNull;
    expect(existing).toBe("$expiresAt");
    const days = (fallback.getTime() - set.finishedAt.getTime()) / 86_400_000;
    expect(days).toBeCloseTo(30);
  });

  it("applies the same retention rule to a failed job", async () => {
    await failJob(new ObjectId(), "boom");
    const [, pipeline] = updateOne.mock.calls[0] ?? [];
    expect(pipeline[0].$set.expiresAt.$cond).toBeDefined();
  });

  it("treats a cancelled job as cancelled", async () => {
    findOne.mockResolvedValue({ status: "cancelled" });
    expect(await isJobCancelled(new ObjectId())).toBe(true);
  });

  it("treats a VANISHED job as cancelled", async () => {
    // Deleting a conversation deletes its jobs. Without this, an in-flight
    // research run would finish and append its report to the thread the user
    // just deleted, recreating checkpoints nothing points at.
    findOne.mockResolvedValue(null);
    expect(await isJobCancelled(new ObjectId())).toBe(true);
  });

  it("lets a running job keep going", async () => {
    findOne.mockResolvedValue({ status: "running" });
    expect(await isJobCancelled(new ObjectId())).toBe(false);
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
