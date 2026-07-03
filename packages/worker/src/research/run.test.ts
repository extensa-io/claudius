import { ObjectId } from "mongodb";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The research pipeline, with the model, web, and checkpoint all mocked. These
 * tests pin the orchestration contract: the happy path runs plan -> search ->
 * read -> decide -> synthesize and finishes by writing the report into the thread
 * and completing the job; a cancel before the first step stops it cold with no
 * model calls (the "cancel stops the job within one step" bar, at its extreme).
 */

const assertCanInvoke = vi.fn();
const invoke = vi.fn();
const buildChatModel = vi.fn();
const writeUsageEvent = vi.fn();
const appendJobProgress = vi.fn();
const completeJob = vi.fn();
const isJobCancelled = vi.fn();
const loadResearchBudget = vi.fn();

const searchWeb = vi.fn();
const extractPages = vi.fn();
const appendResearchToThread = vi.fn();

vi.mock("@claudius/shared", () => ({
  assertCanInvoke: (...a: unknown[]) => assertCanInvoke(...a),
  buildChatModel: (...a: unknown[]) => buildChatModel(...a),
  writeUsageEvent: (...a: unknown[]) => writeUsageEvent(...a),
  appendJobProgress: (...a: unknown[]) => appendJobProgress(...a),
  completeJob: (...a: unknown[]) => completeJob(...a),
  isJobCancelled: (...a: unknown[]) => isJobCancelled(...a),
  loadResearchBudget: (...a: unknown[]) => loadResearchBudget(...a),
}));
vi.mock("./tavily", () => ({
  searchWeb: (...a: unknown[]) => searchWeb(...a),
  extractPages: (...a: unknown[]) => extractPages(...a),
}));
vi.mock("../thread", () => ({
  appendResearchToThread: (...a: unknown[]) => appendResearchToThread(...a),
}));

const { runResearchJob } = await import("./run");

function job() {
  return {
    _id: new ObjectId(),
    userId: new ObjectId(),
    conversationId: new ObjectId(),
    type: "research" as const,
    status: "running" as const,
    input: { question: "What is vector quantization?", modelId: "sonnet" },
    result: null,
    progress: [],
    error: null,
    createdAt: new Date(),
    startedAt: new Date(),
    finishedAt: null,
  };
}

function modelReply(text: string) {
  return { text, usage_metadata: { input_tokens: 10, output_tokens: 20 } };
}

beforeEach(() => {
  vi.clearAllMocks();
  buildChatModel.mockReturnValue({ invoke });
  isJobCancelled.mockResolvedValue(false);
  assertCanInvoke.mockResolvedValue({
    inferenceProfileId: "profile",
    modelId: "sonnet",
  });
  loadResearchBudget.mockResolvedValue({
    maxSearches: 20,
    maxFetchedPages: 12,
    maxTokens: 400_000,
    wallClockMs: 600_000,
  });
  searchWeb.mockResolvedValue([
    { title: "VQ paper", url: "https://a.example/vq", snippet: "about vq" },
  ]);
  extractPages.mockResolvedValue([
    { url: "https://a.example/vq", text: "full text about vector quantization" },
  ]);
});

describe("runResearchJob", () => {
  it("runs the pipeline and completes with a cited report in the thread", async () => {
    invoke
      .mockResolvedValueOnce(modelReply('{"queries":["vector quantization"]}'))
      .mockResolvedValueOnce(modelReply('{"sufficient":true,"nextQueries":[]}'))
      .mockResolvedValueOnce(modelReply("# Report\nVQ is ... [1]\n## Sources\n[1] VQ paper — https://a.example/vq"));

    const j = job();
    await runResearchJob(j);

    expect(searchWeb).toHaveBeenCalled();
    expect(extractPages).toHaveBeenCalled();
    // A usage_events row per model call (plan + decide + synthesize).
    expect(writeUsageEvent).toHaveBeenCalledTimes(3);
    expect(writeUsageEvent.mock.calls[0]?.[0]).toMatchObject({
      purpose: "research",
    });
    expect(appendResearchToThread).toHaveBeenCalledWith(
      j.conversationId.toString(),
      j.input.question,
      expect.stringContaining("Report"),
      j._id.toString(),
    );
    const [, result] = completeJob.mock.calls[0] ?? [];
    expect(result.sources).toHaveLength(1);
    expect(result.pagesRead).toBe(1);
    expect(result.report).toContain("[1]");
  });

  it("a refine builds on the prior report and posts the instruction as the turn", async () => {
    invoke
      .mockResolvedValueOnce(modelReply('{"queries":["vq 2025 update"]}'))
      .mockResolvedValueOnce(modelReply('{"sufficient":true,"nextQueries":[]}'))
      .mockResolvedValueOnce(modelReply("# Updated report [1]\n## Sources\n[1] x — https://a.example/vq"));

    const j = {
      ...job(),
      input: {
        question: "What is vector quantization?",
        modelId: "sonnet",
        refinement: "add 2025 benchmarks",
        priorReport: "# Prior report\nVQ basics ...",
        parentJobId: "parent123",
      },
    };
    await runResearchJob(j);

    // The user turn written to the thread is the refinement instruction.
    expect(appendResearchToThread).toHaveBeenCalledWith(
      j.conversationId.toString(),
      "add 2025 benchmarks",
      expect.any(String),
      j._id.toString(),
    );
    expect(completeJob).toHaveBeenCalled();
  });

  it("stops cold when cancelled before the first step", async () => {
    isJobCancelled.mockResolvedValue(true);
    await runResearchJob(job());
    expect(assertCanInvoke).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
    expect(completeJob).not.toHaveBeenCalled();
    expect(appendResearchToThread).not.toHaveBeenCalled();
  });
});
