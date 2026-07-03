import { ObjectId } from "mongodb";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The worker takes over memory extraction unchanged: it reads the thread and
 * hands it to the SAME shared orchestrator the app used in Phase 3. These tests
 * pin that the job runner delegates to that orchestrator and reports back the
 * exact tallies it returns — the "identical results to Phase 3 fixtures" bar.
 */

const findUser = vi.fn();
const findConversation = vi.fn();
const loadThreadMessages = vi.fn();
const processConversationMemories = vi.fn();
const completeJob = vi.fn();
const appendJobProgress = vi.fn();
const isJobCancelled = vi.fn();

vi.mock("@claudius/shared", () => ({
  usersCol: vi.fn(async () => ({ findOne: findUser })),
  conversationsCol: vi.fn(async () => ({ findOne: findConversation })),
  loadThreadMessages: (...a: unknown[]) => loadThreadMessages(...a),
  processConversationMemories: (...a: unknown[]) =>
    processConversationMemories(...a),
  completeJob: (...a: unknown[]) => completeJob(...a),
  appendJobProgress: (...a: unknown[]) => appendJobProgress(...a),
  isJobCancelled: (...a: unknown[]) => isJobCancelled(...a),
}));

const { runMemoryExtractionJob } = await import("./run");

function job() {
  return {
    _id: new ObjectId(),
    userId: new ObjectId(),
    conversationId: new ObjectId(),
    type: "memory_extraction" as const,
    status: "running" as const,
    input: {},
    result: null,
    progress: [],
    error: null,
    createdAt: new Date(),
    startedAt: new Date(),
    finishedAt: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  isJobCancelled.mockResolvedValue(false);
});

describe("runMemoryExtractionJob", () => {
  it("completes the job with the orchestrator's exact tallies", async () => {
    findUser.mockResolvedValue({ _id: new ObjectId(), status: "active" });
    findConversation.mockResolvedValue({ _id: new ObjectId() });
    loadThreadMessages.mockResolvedValue([]);
    processConversationMemories.mockResolvedValue({
      status: "ok",
      created: 2,
      superseded: 1,
      skipped: 3,
      outcomes: [],
    });

    const j = job();
    await runMemoryExtractionJob(j);

    expect(processConversationMemories).toHaveBeenCalledOnce();
    expect(completeJob).toHaveBeenCalledWith(j._id, {
      created: 2,
      superseded: 1,
      skipped: 3,
      status: "ok",
    });
  });

  it("stops before any work when the job is already cancelled", async () => {
    isJobCancelled.mockResolvedValue(true);
    await runMemoryExtractionJob(job());
    expect(processConversationMemories).not.toHaveBeenCalled();
    expect(completeJob).not.toHaveBeenCalled();
  });

  it("no-op success for a disabled user (never reads their transcript)", async () => {
    findUser.mockResolvedValue({ _id: new ObjectId(), status: "disabled" });
    findConversation.mockResolvedValue({ _id: new ObjectId() });
    const j = job();
    await runMemoryExtractionJob(j);
    expect(loadThreadMessages).not.toHaveBeenCalled();
    expect(processConversationMemories).not.toHaveBeenCalled();
    expect(completeJob).toHaveBeenCalledWith(j._id, {
      created: 0,
      superseded: 0,
      skipped: 0,
      status: "skipped",
    });
  });
});
